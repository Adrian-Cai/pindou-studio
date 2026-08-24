Page({
  data: {
    saveHistory: true,
    analytics: false,
  },

  changeHistory(event: WechatMiniprogram.SwitchChange) {
    this.setData({ saveHistory: event.detail.value })
  },

  changeAnalytics(event: WechatMiniprogram.SwitchChange) {
    this.setData({ analytics: event.detail.value })
  },

  clearLocalData() {
    wx.showModal({
      title: '清除本地数据',
      content: '作品记录和设置会从当前设备移除。基础框架暂不执行清除，待账号体系接入后统一实现。',
      showCancel: false,
    })
  },
})
