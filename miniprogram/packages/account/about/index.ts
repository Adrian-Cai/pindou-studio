Page({
  openItem(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id)
    if (id === 'paid-service') {
      wx.navigateTo({ url: '/packages/account/privacy-document/index?key=paid-service' })
      return
    }
    if (id === 'agreement') {
      wx.navigateTo({ url: '/packages/account/privacy-document/index?key=user-agreement' })
      return
    }
    if (id === 'privacy') {
      wx.navigateTo({ url: '/packages/account/privacy/index' })
      return
    }
    if (id === 'support') {
      wx.navigateTo({ url: '/packages/account/feedback/index' })
      return
    }
    const messages: Record<string, string> = {
      features: '支持图片转换、拼豆编辑、材料统计与施工图查看',
      update: '当前已是最新版本',
    }
    // 未知 id（dataset 缺值或新条目忘了配文案）不能拿空串弹框：
    // 用户会看到一个只有标题、没有内容的对话框，看起来像「加载失败」。
    // 没文案就不弹，比弹一个空壳好。
    const content = messages[id]
    if (!content) return
    wx.showModal({ title: '拼豆制作工具', content, showCancel: false })
  },
})
