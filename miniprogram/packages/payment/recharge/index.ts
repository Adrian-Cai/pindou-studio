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
  fetchAiGenerationPackages,
  isWechatPaymentCancelled,
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
    quota: 0,
    dailyFreeQuota: 0,
    dailyFreeRemaining: 0,
    purchasedQuota: 0,
    paymentLoading: false,
  },

  onShow() {
    const aiQuota = authStore.getSnapshot().profile?.quota.aiGeneration
    this.setData({
      quota: aiQuota?.remaining ?? 0,
      dailyFreeQuota: aiQuota?.dailyFree ?? 0,
      dailyFreeRemaining: Math.max(0, (aiQuota?.dailyFree ?? 0) - (aiQuota?.usedToday ?? 0)),
      purchasedQuota: aiQuota?.purchased ?? 0,
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
        purchasedQuota: aiQuota.purchased,
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
      })
    } catch {
      this.setData({
        packages: [],
        packagesLoading: false,
        packageMessage: '套餐加载失败，请稍后重试',
      })
    }
  },

  selectPackage(event: WechatMiniprogram.TouchEvent) {
    this.setData({ selected: Number(event.currentTarget.dataset.index) })
  },

  openPaidServiceAgreement() {
    wx.navigateTo({ url: '/packages/account/privacy-document/index?key=paid-service' })
  },

  async purchase() {
    const selectedPackage = this.data.packages[this.data.selected]
    if (!selectedPackage || this.data.paymentLoading) return

    this.setData({ paymentLoading: true })
    try {
      const created = await payForAiGenerationPackage(selectedPackage.id)
      this.setData({ paymentLoading: false })
      wx.navigateTo({
        url: `/packages/payment/payment-success/index?orderId=${encodeURIComponent(created.orderId)}`,
      })
    } catch (error) {
      if (isWechatPaymentCancelled(error)) {
        wx.showToast({ title: '已取消支付', icon: 'none' })
      } else {
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
