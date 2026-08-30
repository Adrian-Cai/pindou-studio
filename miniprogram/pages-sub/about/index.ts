Page({
  openItem(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    if (id === 'privacy') {
      wx.navigateTo({ url: '/pages-sub/privacy/index' })
      return
    }
    if (id === 'support') {
      wx.navigateTo({ url: '/pages-sub/feedback/index' })
      return
    }
    const messages: Record<string, string> = {
      features: '支持图片转换、拼豆编辑、材料统计与施工图查看。',
      agreement: '用户协议内容待正式发布。',
      update: '当前已是最新版本。',
    }
    wx.showModal({ title: '拼豆制作工具', content: messages[id] ?? '', showCancel: false })
  },
})
