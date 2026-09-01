import { appStore } from '../../store/app-store'
import { authStore } from '../../store/auth-store'

Page({
  data: {
    packageLabel: '加购 3 次',
    amount: '9.9',
    quota: 0,
  },

  onLoad() {
    const cachedQuota = authStore.getSnapshot().profile?.quota.remaining
      ?? appStore.getSnapshot().downloadQuota
    this.setData({ quota: cachedQuota })
    void this.refreshServerQuota()
  },

  async refreshServerQuota() {
    const quota = await authStore.refreshQuota()
    if (!quota) return
    appStore.setDownloadQuota(quota.remaining)
    this.setData({ quota: quota.remaining })
  },

  returnProfile() {
    wx.switchTab({ url: '/pages/profile/index' })
  },

  openDownloads() {
    wx.navigateTo({ url: '/pages-sub/downloads/index' })
  },
})
