Page({
  data: {
    packageLabel: '加购 3 次',
    amount: '9.9',
    quota: 5,
  },

  onLoad(options: Record<string, string | undefined>) {
    this.setData({
      packageLabel: options.packageLabel || this.data.packageLabel,
      amount: options.amount || this.data.amount,
      quota: Number(options.quota) || this.data.quota,
    })
  },

  returnProfile() {
    wx.switchTab({ url: '/pages/profile/index' })
  },

  openDownloads() {
    wx.navigateTo({ url: '/pages-sub/downloads/index' })
  },
})
