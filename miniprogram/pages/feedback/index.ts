Page({
  data: {
    categories: ['功能建议', '生成效果', '下载问题', '其他'],
    categoryIndex: 0,
    content: '',
    contact: '',
  },

  changeCategory(event: WechatMiniprogram.PickerChange) {
    this.setData({ categoryIndex: Number(event.detail.value) })
  },

  changeContent(event: WechatMiniprogram.Input) {
    this.setData({ content: event.detail.value })
  },

  changeContact(event: WechatMiniprogram.Input) {
    this.setData({ contact: event.detail.value })
  },

  submit() {
    if (this.data.content.trim().length < 5) {
      wx.showToast({ title: '请再多写一点', icon: 'none' })
      return
    }
    wx.showModal({
      title: '反馈内容已就绪',
      content: '反馈提交接口尚未配置，接入后这里会直接提交。',
      showCancel: false,
    })
  },
})
