Page({
  openHelp() {
    wx.navigateTo({ url: '/packages/account/help/index' })
  },
  openFeedback() {
    wx.navigateTo({ url: '/packages/account/feedback/index' })
  },
  openPrivacy() {
    wx.navigateTo({ url: '/packages/account/privacy/index' })
  },
  openAbout() {
    wx.navigateTo({ url: '/packages/account/about/index' })
  },
})
