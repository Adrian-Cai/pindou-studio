Page({
  openCreation(event: WechatMiniprogram.TouchEvent) {
    const source = event.currentTarget.dataset.source === 'text' ? 'text' : 'image'
    wx.navigateTo({
      url: `/pages/create/index?source=${source}`,
      fail: (error) => {
        console.error('打开创作页失败', error.errMsg)
        wx.showToast({ title: '创作页打开失败，请重试', icon: 'none' })
      },
    })
  },
})
