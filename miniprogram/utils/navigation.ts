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
  // 这两个 API 在个别机型/低版本基础库上会返回字段为 undefined 的对象。
  // 直接进算术会把 NaN 灌进所有派生量：导航栏高度变成 NaN，
  // 于是所有按此定位的顶部元素全部跑位，而且不报错、看不出根因。
  // 这里统一收敛成有限数；拿不到就用经验默认值顶上，宁可差几像素也不能 NaN。
  const statusBarHeight = toFiniteOr(windowInfo.statusBarHeight, 20)
  const menuButtonTop = toFiniteOr(menuButton.top, statusBarHeight)
  const menuButtonHeight = toFiniteOr(menuButton.height, 32)
  const menuButtonLeft = toFiniteOr(menuButton.left, 0)
  const windowHeight = toFiniteOr(windowInfo.windowHeight, 667)
  const windowWidth = toFiniteOr(windowInfo.windowWidth, 375)
  const capsuleTopGap = Math.max(0, menuButtonTop - statusBarHeight)
  const navigationBarHeight = capsuleTopGap * 2 + menuButtonHeight

  return {
    statusBarHeight,
    navigationBarHeight,
    topBarHeight: statusBarHeight + navigationBarHeight,
    windowHeight,
    menuButtonReserve: Math.max(16, windowWidth - menuButtonLeft + 8),
  }
}

/** 把可能是 undefined / NaN / null 的值收敛成有限数，收不到就用兜底值。 */
function toFiniteOr(value: number | undefined | null, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function navigateBackOrHome() {
  if (getCurrentPages().length > 1) {
    wx.navigateBack()
    return
  }
  wx.switchTab({ url: '/pages/home/index' })
}
