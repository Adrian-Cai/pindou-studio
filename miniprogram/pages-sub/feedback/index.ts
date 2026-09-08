import { FEEDBACK_CATEGORIES } from '../../config/profile'

Page({
  data: {
    categories: FEEDBACK_CATEGORIES,
    categoryIndex: 0,
    content: '',
    contact: '',
    images: [] as string[],
    submitting: false,
  },

  selectCategory(event: WechatMiniprogram.TouchEvent) {
    this.setData({ categoryIndex: Number(event.currentTarget.dataset.index) })
  },

  changeContent(event: WechatMiniprogram.Input) {
    this.setData({ content: event.detail.value })
  },

  changeContact(event: WechatMiniprogram.Input) {
    this.setData({ contact: event.detail.value })
  },

  chooseImages() {
    const count = 5 - this.data.images.length
    if (count <= 0) return
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: ({ tempFiles }) => {
        const images = [...this.data.images, ...tempFiles.map((item) => item.tempFilePath)].slice(0, 5)
        this.setData({ images })
      },
    })
  },

  previewImage(event: WechatMiniprogram.TouchEvent) {
    const current = String(event.currentTarget.dataset.src)
    wx.previewImage({ current, urls: this.data.images })
  },

  removeImage(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({ images: this.data.images.filter((_, itemIndex) => itemIndex !== index) })
  },

  submit() {
    if (this.data.content.trim().length < 5) {
      wx.showToast({ title: '请至少填写 5 个字', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    wx.showModal({
      title: '反馈内容已保存',
      content: '反馈接口尚未配置，当前内容仅保留在页面中，接入服务后即可正式提交',
      showCancel: false,
      complete: () => this.setData({ submitting: false }),
    })
  },
})
