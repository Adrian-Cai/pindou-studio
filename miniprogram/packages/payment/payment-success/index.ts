/**
 * 支付结果页：支付完成后跳转到此页确认权益是否到账。
 *
 * 职责：轮询订单状态并刷新 AI 生成额度，把结果渲染成「成功 / 处理中 / 失败」三态之一。
 * 调用方：packages/payment/recharge 拉起微信支付成功后跳转，路由 /packages/payment/payment-success?orderId=xxx。
 * 关键点：微信支付回调与前端跳转存在时序差，回调可能晚于本页加载，因此这里做最多 6 次、
 *         每次间隔 1 秒的轮询；只有订单变为 paid 才判定成功，failed/closed/refunded 判定失败，
 *         6 次仍未出结果时落到 pending，提示用户去「我的」查看，避免误报支付失败。
 */
import { authStore } from '../../../store/auth-store'
import { fetchOrders } from '../services/order-service'

/** 页面三态：loading 等待首次查询 / paid 已到账 / pending 超时未确认 / failed 明确失败。 */
type PaymentResultState = 'loading' | 'paid' | 'pending' | 'failed'

Page({
  data: {
    packageLabel: 'AI 生成次数',
    amount: '--',
    quota: 0,
    paymentState: 'loading' as PaymentResultState,
    paymentMessage: '',
  },

  onLoad(options?: Record<string, string | undefined>) {
    const orderId = options?.orderId?.trim() ?? ''
    if (!orderId) {
      this.setData({
        paymentState: 'failed',
        paymentMessage: '缺少支付订单信息，请到“我的订单”查看支付状态',
      })
      return
    }

    const cachedQuota = authStore.getSnapshot().profile?.quota.aiGeneration.remaining ?? 0
    this.setData({ quota: cachedQuota })
    void this.loadPaymentResult(orderId)
  },

  async loadPaymentResult(orderId: string) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const [quotaResponse, ordersResponse] = await Promise.all([
          authStore.refreshAiQuota(),
          fetchOrders({ page: 1, pageSize: 20 }),
        ])
        const quota = quotaResponse?.aiGeneration ?? authStore.getSnapshot().profile?.quota.aiGeneration
        const order = ordersResponse.items.find((item) => item.id === orderId)
        if (quota) this.setData({ quota: quota.remaining })
        if (order) {
          this.setData({
            packageLabel: order.packageLabel,
            amount: formatFen(order.priceFen),
          })
          if (order.status === 'paid') {
            this.setData({ paymentState: 'paid' })
            return
          }
          if (order.status === 'failed' || order.status === 'closed' || order.status === 'refunded') {
            this.setData({
              paymentState: 'failed',
              paymentMessage: `订单状态：${orderStatusLabel(order.status)}`,
            })
            return
          }
        }
      } catch (error) {
        if (attempt === 5) {
          this.setData({
            paymentState: 'failed',
            paymentMessage: error instanceof Error ? error.message : '支付结果查询失败，请稍后到“我的订单”查看',
          })
          return
        }
      }
      if (attempt < 5) await wait(1_000)
    }
    this.setData({
      paymentState: 'pending',
      paymentMessage: '支付已提交，权益到账可能需要几秒，请稍后到“我的”查看',
    })
  },

  returnProfile() {
    wx.switchTab({ url: '/pages/profile/index' })
  },

  returnHome() {
    wx.switchTab({ url: '/pages/home/index' })
  },
})

/** 分转元：服务端金额一律以「分」存储，展示时除以 100 并保留两位小数。 */
function formatFen(priceFen: number): string {
  return (priceFen / 100).toFixed(2)
}

function orderStatusLabel(status: 'failed' | 'closed' | 'refunded'): string {
  return status === 'failed' ? '支付失败' : status === 'closed' ? '已关闭' : '已退款'
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
