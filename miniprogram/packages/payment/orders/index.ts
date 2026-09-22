/**
 * 我的订单页：展示当前用户的充值订单列表。
 *
 * 职责：拉取订单并做展示层格式化（状态文案、金额、时间、订单号尾号），失败时提供重试入口。
 * 调用方：账户页「我的订单」入口，路由 /packages/payment/orders。
 * 关键点：放在 onShow 而非 onLoad，这样从支付页返回时能立刻看到最新订单；
 *         未登录直接落到 unauthorized 态，不发请求。
 */
import type { OrderItem, OrderStatus } from '../../../models/order'
import { fetchOrders } from '../services/order-service'
import { hasCloudSession } from '../../../services/work-service'

type OrdersLoadState = 'loading' | 'ready' | 'error' | 'unauthorized'
type OrderView = OrderItem & {
  statusLabel: string
  statusClass: string
  amountText: string
  createdAtText: string
  paidAtText: string
  orderSuffix: string
}

/** 订单状态到中文文案的映射，与 models/order 的 OrderStatus 一一对应。 */
const statusLabels: Record<OrderStatus, string> = {
  pending: '待支付',
  paid: '支付成功',
  failed: '支付失败',
  closed: '已关闭',
  refunded: '已退款',
}

Page({
  data: {
    loadState: 'loading' as OrdersLoadState,
    orders: [] as OrderView[],
    errorMessage: '',
  },

  onShow() {
    if (!hasCloudSession()) {
      this.setData({ loadState: 'unauthorized', orders: [], errorMessage: '' })
      return
    }
    void this.loadOrders()
  },

  async loadOrders() {
    this.setData({ loadState: 'loading', errorMessage: '' })
    try {
      const response = await fetchOrders({ page: 1, pageSize: 20 })
      this.setData({
        loadState: 'ready',
        orders: response.items.map(toOrderView),
      })
    } catch (error) {
      console.error('读取订单失败', error)
      this.setData({
        loadState: 'error',
        errorMessage: error instanceof Error ? error.message : '订单加载失败，请稍后重试',
      })
    }
  },

  retry() {
    void this.loadOrders()
  },

  openProfile() {
    wx.switchTab({ url: '/pages/profile/index' })
  },
})

/**
 * 订单转展示模型：补上状态文案、状态样式类、金额与时间的格式化文本。
 * 订单号只展示后 8 位（orderSuffix），避免长 id 撑破列表。
 */
function toOrderView(order: OrderItem): OrderView {
  return {
    ...order,
    statusLabel: statusLabels[order.status],
    statusClass: `order-status--${order.status}`,
    amountText: `¥ ${formatFen(order.priceFen)}`,
    createdAtText: formatDateTime(order.createdAt),
    paidAtText: order.paidAt ? formatDateTime(order.paidAt) : '',
    orderSuffix: order.id.slice(-8),
  }
}

function formatFen(priceFen: number): string {
  return (priceFen / 100).toFixed(2)
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  const datePart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const timePart = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${datePart} ${timePart}`
}
