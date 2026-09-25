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
    /** 本次购买的幂等键：成功或明确取消前一直复用，避免重复下单。 */
    paymentIdempotencyKey: '',
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
      this.setData({
        packages,
        packagesLoading: false,
        packageMessage: packages.length > 0 ? '' : '暂无可购买的 AI 生成套餐',
        selected: 0,
        selectedPrice: packages[0]?.price ?? '',
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
    this.setData({ selected: index, selectedPrice: selectedPackage.price })
  },

  openPaidServiceAgreement() {
    wx.navigateTo({ url: '/packages/account/privacy-document/index?key=paid-service' })
  },

  async purchase() {
    const selectedPackage = this.data.packages[this.data.selected]
    if (!selectedPackage || this.data.paymentLoading) return

    // 幂等键绑定「这一次购买意图」：失败重试复用同一个键（服务端据此去重），
    // 用户主动取消才清掉 —— 每次现造一个会让去重形同虚设，重复下单即重复扣款。
    const idempotencyKey = this.data.paymentIdempotencyKey || createPaymentIdempotencyKey()
    this.setData({ paymentLoading: true, paymentIdempotencyKey: idempotencyKey })
    try {
      const created = await payForAiGenerationPackage(selectedPackage.id, idempotencyKey)
      this.setData({ paymentLoading: false, paymentIdempotencyKey: '' })
      wx.navigateTo({
        url: `/packages/payment/payment-success/index?orderId=${encodeURIComponent(created.orderId)}`,
      })
    } catch (error) {
      if (isWechatPaymentCancelled(error)) {
        this.setData({ paymentIdempotencyKey: '' })
        wx.showToast({ title: '已取消支付', icon: 'none' })
      } else if (isWechatPaymentOrderClosed(error)) {
        // 微信侧这张单已经关了（-15012）或单号撞了（-15002）：原样重试仍会撞同一个
        // 单号，必须换一个幂等键开新单。
        this.setData({ paymentIdempotencyKey: '' })
        wx.showModal({
          title: '支付未完成',
          content: paymentErrorMessage(error),
          showCancel: false,
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
