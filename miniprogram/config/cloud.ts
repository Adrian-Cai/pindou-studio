let initialized = false

export function initCloud(): void {
  if (initialized) return
  if (!wx.cloud || typeof wx.cloud.init !== 'function') {
    throw new Error('当前基础库不支持微信云开发')
  }

  wx.cloud.init({ traceUser: true })
  initialized = true
}
