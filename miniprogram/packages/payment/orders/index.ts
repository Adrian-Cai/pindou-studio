/**
 * 我的订单页：按状态筛选展示订单，待支付订单提供倒计时、继续支付与取消。
 *
 * 职责：拉取订单并做展示层状态机（待支付/支付状态确认中/已支付/已关闭），
 *       待支付卡片每秒刷新倒计时；继续支付/取消一律走服务端，不拿本地缓存判断。
 * 调用方：账户页「我的订单」入口，路由 /packages/payment/orders。
 * 关键点：
 * - 倒计时基于服务端下发的 serverTime 校准时钟偏差，本机时间不可信；
 * - 待支付订单超过 expires_at 后**不由前端改成已关闭**——服务端还没向微信核实，
 *   此时展示「支付状态确认中」，刷新后以服务端最新状态为准（可能变已支付）；
 * - 「继续支付」= 继续当前订单（服务端复核后重发支付参数）；「重新购买」= 跳充值页
 *   创建全新订单。两者业务含义不同，绝不能混用；
 * - 放在 onShow 而非 onLoad 拉取，从支付页返回时能立刻看到最新订单。
 */
import type { OrderItem, OrderStatus } from '../../../models/order'
import { cancelPendingOrder, fetchOrders } from '../services/order-service'
import { ApiError } from '../../../services/http-client'
import {
  continueOrderPayment,
  getPaidPaymentOrderId,
  isPaymentOrderExpired,
  isWechatPaymentCancelled,
  isWechatPaymentOrderClosed,
  paymentErrorMessage,
} from '../../../services/payment-service'
import { hasCloudSession } from '../../../services/work-service'
import { isQqEnvironment } from '../../../config/platform'

type OrdersLoadState = 'loading' | 'ready' | 'error' | 'unauthorized'
/** 状态筛选 Tab：全部 / 待支付 / 已支付 / 已关闭（failed、refunded 仅在「全部」出现）。 */
type OrderTab = 'all' | 'pending' | 'paid' | 'closed'

/**
 * 卡片展示阶段：
 * counting   待支付且仍在有效期内（倒计时 + 继续支付/取消）
 * confirming 超过支付截止时间但服务端尚未核实关闭（无按钮，防止重复支付）
 * settled    其余终态（已支付/已关闭/失败/退款）
 */
type OrderPhase = 'counting' | 'confirming' | 'settled'

interface OrderView {
  id: string
  packageId: string | null
  packageLabel: string
  priceFen: number
  status: OrderStatus
  /** 支付截止时间的毫秒时间戳；0 表示未知（旧服务端不下发），此时不做倒计时。 */
  expiresAtMs: number
  statusLabel: string
  statusClass: string
  amountText: string
  createdAtText: string
  paidAtText: string
  orderSuffix: string
  phase: OrderPhase
  countdownText: string
  canPay: boolean
  canRepurchase: boolean
  isConfirming: boolean
}

/** 订单状态到中文文案的映射，与 models/order 的 OrderStatus 一一对应。 */
const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '待支付',
  paid: '已支付',
  failed: '支付失败',
  closed: '已关闭',
  refunded: '已退款',
}

/** 超时未核实订单的状态文案：它不是「已关闭」，用户可能其实已付款。 */
const CONFIRMING_LABEL = '支付状态确认中'
const CONFIRMING_CLASS = 'order-status--confirming'

/** 空列表文案随 Tab 变化，避免「全部空」和「待支付空」长得一样让用户困惑。 */
const EMPTY_TEXT: Record<OrderTab, { title: string; desc: string }> = {
  all: { title: '暂无订单', desc: '购买 AI 生成次数后，订单会显示在这里' },
  pending: { title: '没有待支付订单', desc: '当前没有需要支付的订单' },
  paid: { title: '暂无已支付订单', desc: '支付成功的订单会显示在这里' },
  closed: { title: '暂无已关闭订单', desc: '超时未支付的订单会显示在这里' },
}

/** 倒计时归零后服务端需要一点时间核实/关闭订单，稍候自动刷新一次。 */
const CONFIRM_REFRESH_DELAY_MS = 4_000

Page({
  data: {
    loadState: 'loading' as OrdersLoadState,
    activeTab: 'all' as OrderTab,
    /** 当前 Tab 过滤后的列表（倒计时补丁直接按 orders[i] 路径打点）。 */
    orders: [] as OrderView[],
    /** 服务端统计的 pending 订单数，与「最多 5 个」上限同口径。 */
    pendingCount: 0,
    emptyTitle: EMPTY_TEXT.all.title,
    emptyDesc: EMPTY_TEXT.all.desc,
    errorMessage: '',
    /** 任一支付动作进行中：防重复拉起，也挡住倒计时触发的自动刷新。 */
    actionLoading: false,
    readOnly: false,
  },

  /** 全量订单（未过滤），切 Tab 只做内存过滤不重新请求。 */
  allOrders: [] as OrderView[],
  /** serverTime - 本机时间：倒计时一律用「本机时间 + 偏差」与 expiresAt 比较。 */
  clockSkewMs: 0,
  /** 定时器句柄；初值 0 是因为 clearInterval 的类型不接受 undefined。 */
  countdownTimer: 0 as ReturnType<typeof setInterval>,
  confirmRefreshTimer: 0 as ReturnType<typeof setTimeout>,

  onShow() {
    this.setData({ readOnly: isQqEnvironment() })
    if (!hasCloudSession()) {
      this.setData({ loadState: 'unauthorized', orders: [], errorMessage: '' })
      return
    }
    void this.loadOrders()
  },

  onHide() {
    this.stopTimers()
  },

  onUnload() {
    this.stopTimers()
  },

  async loadOrders(options: { silent?: boolean } = {}) {
    if (!options.silent) {
      this.setData({ loadState: 'loading', errorMessage: '' })
    }
    try {
      const response = await fetchOrders({ page: 1, pageSize: 50 })
      const localNow = Date.now()
      const serverNow = response.serverTime ? Date.parse(response.serverTime) : NaN
      this.clockSkewMs = Number.isFinite(serverNow) ? serverNow - localNow : 0
      this.allOrders = response.items.map((item) => toOrderView(
        item,
        localNow + this.clockSkewMs,
        this.data.readOnly,
      ))
      this.setData({
        loadState: 'ready',
        pendingCount: response.pendingCount,
        orders: this.filterOrders(this.data.activeTab),
        emptyTitle: EMPTY_TEXT[this.data.activeTab].title,
        emptyDesc: EMPTY_TEXT[this.data.activeTab].desc,
        errorMessage: '',
      })
      this.startCountdown()
    } catch (error) {
      console.error('读取订单失败', error)
      if (options.silent) {
        // 静默刷新失败不打断当前视图：留一条轻提示即可
        wx.showToast({ title: '订单刷新失败，请稍后重试', icon: 'none' })
        return
      }
      this.stopTimers()
      this.setData({
        loadState: 'error',
        errorMessage: error instanceof Error ? error.message : '订单加载失败，请稍后重试',
      })
    }
  },

  retry() {
    void this.loadOrders()
  },

  refreshOrders() {
    if (this.data.actionLoading) return
    void this.loadOrders({ silent: true })
  },

  switchTab(event: WechatMiniprogram.TouchEvent) {
    const tab = String(event.currentTarget.dataset.tab ?? '') as OrderTab
    if (tab !== 'all' && tab !== 'pending' && tab !== 'paid' && tab !== 'closed') return
    if (tab === this.data.activeTab) return
    this.setData({
      activeTab: tab,
      orders: this.filterOrders(tab),
      emptyTitle: EMPTY_TEXT[tab].title,
      emptyDesc: EMPTY_TEXT[tab].desc,
    })
  },

  filterOrders(tab: OrderTab): OrderView[] {
    if (tab === 'all') return [...this.allOrders]
    if (tab === 'pending') return this.allOrders.filter((item) => item.status === 'pending')
    if (tab === 'paid') return this.allOrders.filter((item) => item.status === 'paid')
    return this.allOrders.filter((item) => item.status === 'closed')
  },

  startCountdown() {
    this.stopTimers()
    const hasCounting = this.data.orders.some((item) => item.phase === 'counting')
    if (!hasCounting) return
    this.countdownTimer = setInterval(() => this.tickCountdown(), 1_000)
  },

  stopTimers() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
      this.countdownTimer = 0
    }
    if (this.confirmRefreshTimer) {
      clearTimeout(this.confirmRefreshTimer)
      this.confirmRefreshTimer = 0
    }
  },

  /** 每秒刷新倒计时文本；归零的卡片切到「支付状态确认中」并安排一次静默刷新。 */
  tickCountdown() {
    const nowMs = Date.now() + this.clockSkewMs
    const patch: Record<string, unknown> = {}
    let anyExpired = false
    this.data.orders.forEach((view, index) => {
      if (view.phase !== 'counting' || !view.expiresAtMs) return
      const remainingMs = view.expiresAtMs - nowMs
      if (remainingMs <= 0) {
        anyExpired = true
        patch[`orders[${index}].phase`] = 'confirming'
        patch[`orders[${index}].statusLabel`] = CONFIRMING_LABEL
        patch[`orders[${index}].statusClass`] = CONFIRMING_CLASS
        patch[`orders[${index}].countdownText`] = ''
        patch[`orders[${index}].canPay`] = false
        patch[`orders[${index}].isConfirming`] = true
        return
      }
      const text = formatCountdown(remainingMs)
      if (text !== view.countdownText) patch[`orders[${index}].countdownText`] = text
    })
    if (Object.keys(patch).length > 0) this.setData(patch)
    // 有订单刚过期：给服务端几秒核实，然后静默刷新拿真实状态（可能变已支付/已关闭）
    if (anyExpired) this.scheduleConfirmRefresh()
  },

  scheduleConfirmRefresh() {
    if (this.confirmRefreshTimer) return
    this.confirmRefreshTimer = setTimeout(() => {
      this.confirmRefreshTimer = 0
      this.refreshOrders()
    }, CONFIRM_REFRESH_DELAY_MS)
  },

  /**
   * 继续支付当前订单。
   *
   * 服务端会复核归属/状态并查询微信：未关单沿用原商户单号重新拉起，
   * 已付的跳结果页，已关的刷新列表。用户在微信面板取消不算失败——订单保留在待支付里。
   */
  async continuePayment(event: WechatMiniprogram.TouchEvent) {
    if (this.data.readOnly) return
    const orderId = String(event.currentTarget.dataset.id ?? '')
    const view = this.data.orders.find((item) => item.id === orderId)
    if (!view?.canPay || this.data.actionLoading) return
    this.setData({ actionLoading: true })
    wx.showLoading({ title: '正在发起支付', mask: true })
    try {
      const created = await continueOrderPayment(orderId)
      wx.hideLoading()
      this.setData({ actionLoading: false })
      wx.navigateTo({
        url: `/packages/payment/payment-success/index?orderId=${encodeURIComponent(created.orderId)}`,
      })
    } catch (error) {
      wx.hideLoading()
      this.setData({ actionLoading: false })
      this.handlePaymentActionError(error)
    }
  },

  /** 取消订单：服务端核实微信状态后才关闭；已付订单会照常发货并提示。 */
  async cancelOrder(event: WechatMiniprogram.TouchEvent) {
    if (this.data.readOnly) return
    const orderId = String(event.currentTarget.dataset.id ?? '')
    const view = this.data.orders.find((item) => item.id === orderId)
    if (!view?.canPay || this.data.actionLoading) return
    const confirmed = await wx.showModal({
      title: '取消订单',
      content: '确定取消这个待支付订单吗？取消后需要重新下单。',
      confirmText: '取消订单',
      cancelText: '再想想',
    })
    if (!confirmed.confirm) return
    this.setData({ actionLoading: true })
    wx.showLoading({ title: '正在取消', mask: true })
    try {
      await cancelPendingOrder(orderId)
      wx.hideLoading()
      this.setData({ actionLoading: false })
      wx.showToast({ title: '订单已取消', icon: 'none' })
    } catch (error) {
      wx.hideLoading()
      this.setData({ actionLoading: false })
      this.handlePaymentActionError(error)
      return
    }
    void this.loadOrders({ silent: true })
  },

  /**
   * 重新购买：跳充值页并预选原套餐。
   *
   * 这里**不传旧订单号**——重新购买意味着创建全新订单，与「继续支付」
   * （恢复当前订单）是两条互斥的路径。
   */
  repurchase(event: WechatMiniprogram.TouchEvent) {
    if (this.data.readOnly) return
    const orderId = String(event.currentTarget.dataset.id ?? '')
    const view = this.data.orders.find((item) => item.id === orderId)
    const packageId = view?.packageId?.trim()
    wx.navigateTo({
      url: packageId
        ? `/packages/payment/recharge/index?packageId=${encodeURIComponent(packageId)}`
        : '/packages/payment/recharge/index',
    })
  },

  /** 继续支付/取消共用的失败处理：以服务端错误码区分去向。 */
  handlePaymentActionError(error: unknown) {
    const paidOrderId = getPaidPaymentOrderId(error)
    if (paidOrderId) {
      // 动作期间发现订单其实已支付：跳结果页确认权益到账
      wx.navigateTo({
        url: `/packages/payment/payment-success/index?orderId=${encodeURIComponent(paidOrderId)}`,
      })
      return
    }
    if (isWechatPaymentCancelled(error)) {
      // 用户取消 ≠ 订单关闭：订单保留在待支付列表，可再次继续支付
      wx.showToast({ title: '已取消支付，订单保留', icon: 'none' })
      return
    }
    if (isWechatPaymentOrderClosed(error)) {
      wx.showToast({ title: '本次微信支付已关闭，可在倒计时结束前再次点击继续支付', icon: 'none' })
    } else if (isPaymentOrderExpired(error)) {
      wx.showToast({ title: '订单已关闭，可重新购买', icon: 'none' })
    } else if (isPaymentStatusConfirming(error)) {
      wx.showToast({ title: '支付状态确认中，请稍后刷新', icon: 'none' })
    } else {
      wx.showToast({ title: paymentErrorMessage(error), icon: 'none' })
    }
    void this.loadOrders({ silent: true })
  },

  openProfile() {
    wx.switchTab({ url: '/pages/profile/index' })
  },
})

function isPaymentStatusConfirming(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'PAYMENT_STATUS_CONFIRMING'
}

/**
 * 订单转展示模型：补状态文案、样式类、金额/时间格式化与按钮可见性。
 *
 * pending 订单的三种展示：
 * - 有 expiresAt 且未到期 → counting（倒计时 + 操作按钮）；
 * - 有 expiresAt 但已到期 → confirming（服务端尚未核实，不显示任何按钮）；
 * - 无 expiresAt（旧服务端）→ 退回普通待支付展示，操作仍可用（服务端会兜底校验）。
 */
function toOrderView(order: OrderItem, nowMs: number, readOnly: boolean): OrderView {
  const expiresAtMsRaw = order.expiresAt ? Date.parse(order.expiresAt) : NaN
  const expiresAtMs = Number.isFinite(expiresAtMsRaw) ? expiresAtMsRaw : 0
  const remainingMs = expiresAtMs ? expiresAtMsRaw - nowMs : NaN
  const counting = order.status === 'pending' && expiresAtMs > 0 && remainingMs > 0
  const confirming = order.status === 'pending' && expiresAtMs > 0 && remainingMs <= 0
  return {
    id: order.id,
    packageId: order.packageId,
    packageLabel: order.packageLabel,
    priceFen: order.priceFen,
    status: order.status,
    expiresAtMs,
    statusLabel: confirming ? CONFIRMING_LABEL : STATUS_LABELS[order.status] ?? String(order.status ?? ''),
    statusClass: confirming ? CONFIRMING_CLASS : `order-status--${order.status}`,
    amountText: `¥ ${formatFen(order.priceFen)}`,
    createdAtText: formatDateTime(order.createdAt),
    paidAtText: order.paidAt ? formatDateTime(order.paidAt) : '',
    orderSuffix: String(order.id ?? '').slice(-8),
    phase: counting ? 'counting' : confirming ? 'confirming' : 'settled',
    countdownText: counting ? formatCountdown(remainingMs) : '',
    canPay: !readOnly && order.status === 'pending' && !confirming,
    canRepurchase: !readOnly && order.status === 'closed',
    isConfirming: confirming,
  }
}

function formatFen(priceFen: number): string {
  // 金额是有限数才格式化：NaN 会渲染成刺眼的「¥ NaN」，
  // 比留空更容易让用户以为自己付错了钱。
  if (typeof priceFen !== 'number' || !Number.isFinite(priceFen)) return '0.00'
  return (priceFen / 100).toFixed(2)
}

/** 倒计时文本（mm:ss），向上取整到秒并钳在 0 以上，避免出现 -0:01。 */
function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  // 非法日期会输出 'NaN-NaN-NaN NaN:NaN'，直接空串交给列表展示「—」
  if (Number.isNaN(date.getTime())) return ''
  const datePart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const timePart = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${datePart} ${timePart}`
}
