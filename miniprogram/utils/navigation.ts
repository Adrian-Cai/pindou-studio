export function navigateBackOrHome() {
  if (getCurrentPages().length > 1) {
    wx.navigateBack()
    return
  }
  wx.switchTab({ url: '/pages/home/index' })
}
