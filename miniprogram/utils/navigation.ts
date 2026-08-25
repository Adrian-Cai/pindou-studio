export interface CustomNavigationMetrics {
  statusBarHeight: number
  navigationBarHeight: number
  topBarHeight: number
  windowHeight: number
  menuButtonReserve: number
}

export function getCustomNavigationMetrics(): CustomNavigationMetrics {
  const windowInfo = wx.getWindowInfo()
  const menuButton = wx.getMenuButtonBoundingClientRect()
  const statusBarHeight = windowInfo.statusBarHeight
  const capsuleTopGap = Math.max(0, menuButton.top - statusBarHeight)
  const navigationBarHeight = capsuleTopGap * 2 + menuButton.height

  return {
    statusBarHeight,
    navigationBarHeight,
    topBarHeight: statusBarHeight + navigationBarHeight,
    windowHeight: windowInfo.windowHeight,
    menuButtonReserve: Math.max(16, windowInfo.windowWidth - menuButton.left + 8),
  }
}

export function navigateBackOrHome() {
  if (getCurrentPages().length > 1) {
    wx.navigateBack()
    return
  }
  wx.switchTab({ url: '/pages/home/index' })
}
