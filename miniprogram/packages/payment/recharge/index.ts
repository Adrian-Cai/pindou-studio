/**
 * 充值页（/packages/payment/recharge）：展示 AI 生成次数套餐并发起购买。
 *
 * 职责：onShow 读取并刷新当前 AI 额度；拉取可购买套餐列表；选中套餐后调支付、
 *       支付成功跳支付结果页（带上 orderId 轮询）。不做下单/验签逻辑——委托 payment-service。
 * 调用方：tabBar「我的」内的「充值」入口。
 * 关键点：支付被用户取消只提示“已取消”，其他错误弹窗展示；finally 兜底复位 loading。
 */
import { authStore } from '../../../store/auth-store'
import {
  createPaymentIdempotencyKey,
  fetchAiGenerationPackages,
  getMaxPendingOrdersMessage,
  getPaidPaymentOrderId,
  isMaxPendingOrdersReached,
  isPaymentOrderExpired,
  isWechatPaymentCancelled,
  isWechatPaymentOrderClosed,
  payForAiGenerationPackage,
  paymentErrorMessage,
  type AiGenerationPackage,
} from '../../../services/payment-service'

Page({
  data: {
    packages: [] as AiGenerationPackage[],
    packagesLoading: false,
    packageMessage: '',
    selected: 0,
    selectedPrice: '',
    quota: 0,
    dailyFreeQuota: 0,
    dailyFreeRemaining: 0,
    paymentLoading: false,
    /** 本次购买的幂等键：支付未确认结束时持续复用，避免重复下单。 */
    paymentIdempotencyKey: '',
    paymentIdempotencyPackageId: '',
  },

  /** 订单页「重新购买」带进来的套餐 id：仅用于预选，不携带任何旧订单语义。 */
  preselectPackageId: '',

  onLoad(options?: Record<string, string | undefined>) {
    this.preselectPackageId = options?.packageId?.trim() ?? ''
  },

  onShow() {
    const aiQuota = authStore.getSnapshot().profile?.quota.aiGeneration
    this.setData({
      quota: aiQuota?.remaining ?? 0,
      dailyFreeQuota: aiQuota?.dailyFree ?? 0,
      dailyFreeRemaining: Math.max(0, (aiQuota?.dailyFree ?? 0) - (aiQuota?.usedToday ?? 0)),
    })
    void this.refreshQuota()
    void this.refreshPackages()
  },

  async refreshQuota() {
    const quota = await authStore.refreshAiQuota()
    if (quota) {
      const aiQuota = quota.aiGeneration
      this.setData({
        quota: aiQuota.remaining,
        dailyFreeQuota: aiQuota.dailyFree,
        dailyFreeRemaining: Math.max(0, aiQuota.dailyFree - aiQuota.usedToday),
      })
    }
  },

  async refreshPackages() {
    this.setData({ packagesLoading: true, packageMessage: '' })
    try {
      const packages = await fetchAiGenerationPackages()
      const currentPackageId = this.data.packages[this.data.selected]?.id
      const currentSelection = currentPackageId
        ? packages.findIndex((item) => item.id === currentPackageId)
        : -1
      // 从订单页「重新购买」带进来的套餐只做预选：它不携带任何旧订单语义，
      // 找不到或没带就回落到第一个套餐，不打断正常购买流程。
      const preselected = this.preselectPackageId
        ? packages.findIndex((item) => item.id === this.preselectPackageId)
        : -1
      const selected = currentSelection >= 0 ? currentSelection : preselected >= 0 ? preselected : 0
      const selectedPackage = packages[selected]
      const preservePaymentAttempt = selectedPackage?.id === this.data.paymentIdempotencyPackageId
      this.setData({
        packages,
        packagesLoading: false,
        packageMessage: packages.length > 0 ? '' : '暂无可购买的 AI 生成套餐',
        selected,
        selectedPrice: selectedPackage?.price ?? '',
        paymentIdempotencyKey: preservePaymentAttempt ? this.data.paymentIdempotencyKey : '',
        paymentIdempotencyPackageId: preservePaymentAttempt ? this.data.paymentIdempotencyPackageId : '',
      })
    } catch {
      this.setData({
        packages: [],
        packagesLoading: false,
        packageMessage: '套餐加载失败，请稍后重试',
        selectedPrice: '',
      })
    }
  },

  selectPackage(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index)
    const selectedPackage = this.data.packages[index]
    if (!selectedPackage) return
    this.setData({
      selected: index,
      selectedPrice: selectedPackage.price,
      paymentIdempotencyKey: selectedPackage.id === this.data.paymentIdempotencyPackageId ? this.data.paymentIdempotencyKey : '',
      paymentIdempotencyPackageId: selectedPackage.id === this.data.paymentIdempotencyPackageId ? this.data.paymentIdempotencyPackageId : '',
    })
  },

  openPaidServiceAgreement() {
    wx.navigateTo({ url: '/packages/account/privacy-document/index?key=paid-service' })
  },

  async purchase() {
    const selectedPackage = this.data.packages[this.data.selected]
    if (!selectedPackage || this.data.paymentLoading) return

    // 同一套餐的取消与重试复用业务订单幂等键；服务端仅在微信确认前一尝试已关闭后才签发新尝试。
    const idempotencyKey = selectedPackage.id === this.data.paymentIdempotencyPackageId
      ? this.data.paymentIdempotencyKey || createPaymentIdempotencyKey()
      : createPaymentIdempotencyKey()
    this.setData({
      paymentLoading: true,
      paymentIdempotencyKey: idempotencyKey,
      paymentIdempotencyPackageId: selectedPackage.id,
    })
    try {
      const created = await payForAiGenerationPackage(selectedPackage.id, idempotencyKey)
      this.setData({ paymentLoading: false, paymentIdempotencyKey: '', paymentIdempotencyPackageId: '' })
      wx.navigateTo({
        url: `/packages/payment/payment-success/index?orderId=${encodeURIComponent(created.orderId)}`,
      })
    } catch (error) {
      const paidOrderId = getPaidPaymentOrderId(error)
      if (paidOrderId) {
        this.setData({ paymentIdempotencyKey: '', paymentIdempotencyPackageId: '' })
        wx.navigateTo({
          url: `/packages/payment/payment-success/index?orderId=${encodeURIComponent(paidOrderId)}`,
        })
      } else if (isWechatPaymentCancelled(error)) {
        wx.showToast({ title: '已取消支付', icon: 'none' })
      } else if (isWechatPaymentOrderClosed(error)) {
        // 保留业务订单幂等键；下一次创建请求会先查微信，再为已关闭尝试签发新单号。
        wx.showModal({
          title: '支付未完成',
          content: '微信已关闭这次支付，请再次点击继续当前订单',
          showCancel: false,
        })
      } else if (isPaymentOrderExpired(error)) {
        this.setData({ paymentIdempotencyKey: '', paymentIdempotencyPackageId: '' })
        wx.showModal({ title: '订单已关闭', content: paymentErrorMessage(error), showCancel: false })
      } else if (isMaxPendingOrdersReached(error)) {
        // 上限是服务端保护策略，在这里重试只会一直被拒；出路在订单页
        this.setData({ paymentIdempotencyKey: '', paymentIdempotencyPackageId: '' })
        wx.showModal({
          title: '待支付订单过多',
          content: getMaxPendingOrdersMessage(error),
          confirmText: '去我的订单',
          cancelText: '知道了',
          success: (result) => {
            if (result.confirm) wx.navigateTo({ url: '/packages/payment/orders/index' })
          },
        })
      } else {
        // 其余失败保留同一个键，让用户「再试一次」仍归属同一笔
        wx.showModal({
          title: '支付未完成',
          content: paymentErrorMessage(error),
          showCancel: false,
        })
      }
    } finally {
      if (this.data.paymentLoading) this.setData({ paymentLoading: false })
    }
  },
})
