import { authStore } from '../../store/auth-store'

Page({
  data: {
    packageLabel: 'AI 精致生成 30 次',
    amount: '9.9',
    quota: 0,
  },

  onLoad() {
    const cachedQuota = authStore.getSnapshot().profile?.quota.aiGeneration.remaining ?? 0
    this.setData({ quota: cachedQuota })
    void this.refreshAiQuota()
  },

  async refreshAiQuota() {
    const response = await authStore.refreshAiQuota()
    const quota = response?.aiGeneration ?? authStore.getSnapshot().profile?.quota.aiGeneration
    if (quota) this.setData({ quota: quota.remaining })
  },

  returnProfile() {
    wx.switchTab({ url: '/pages/profile/index' })
  },

  returnHome() {
    wx.switchTab({ url: '/pages/home/index' })
  },
})
