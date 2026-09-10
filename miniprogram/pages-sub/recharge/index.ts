import { authStore } from '../../store/auth-store'
import { fetchAiGenerationPackages, type AiGenerationPackage } from '../../services/payment-service'

Page({
  data: {
    packages: [] as AiGenerationPackage[],
    packagesLoading: false,
    packageMessage: '',
    selected: 0,
    quota: 0,
  },

  onShow() {
    this.setData({ quota: authStore.getSnapshot().profile?.quota.aiGeneration.remaining ?? 0 })
    void this.refreshQuota()
    void this.refreshPackages()
  },

  async refreshQuota() {
    const quota = await authStore.refreshAiQuota()
    if (quota) this.setData({ quota: quota.aiGeneration.remaining })
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

  purchase() {
    if (this.data.packages.length === 0) return
    wx.showModal({
      title: '支付能力尚未接入',
      content: 'AI 生成次数套餐页面已经完成，待商户号、正式定价和付费服务协议确认后，再调用微信支付并跳转支付成功页',
      showCancel: false,
    })
  },
})
