Page({
  openItem(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    if (id === 'paid-service') {
      wx.navigateTo({ url: '/pages-sub/privacy-document/index?key=paid-service' })
      return
    }
    if (id === 'agreement') {
      wx.navigateTo({ url: '/pages-sub/privacy-document/index?key=user-agreement' })
      return
    }
    if (id === 'privacy') {
      wx.navigateTo({ url: '/pages-sub/privacy/index' })
      return
    }
    if (id === 'support') {
      wx.navigateTo({ url: '/pages-sub/feedback/index' })
      return
    }
    const messages: Record<string, string> = {
      features: '支持图片转换、拼豆编辑、材料统计与施工图查看',
      update: '当前已是最新版本',
    }
    wx.showModal({ title: '拼豆制作工具', content: messages[id] ?? '', showCancel: false })
  },
})
