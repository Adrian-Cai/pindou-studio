import { DEFAULT_PATTERN_SETTINGS } from '../../config/product'
import { chooseSourceImage, createDraft } from '../../services/image-service'
import { appStore } from '../../store/app-store'

Page({
  data: {
    sourceImagePath: '',
    settings: { ...DEFAULT_PATTERN_SETTINGS, width: 64, height: 64, colorLimit: 32 },
    sizeOptions: [32, 48, 64, 96, 128],
    colorOptions: [16, 32, 64, 96],
    choosing: false,
    generating: false,
  },

  async chooseImage() {
    if (this.data.choosing) return
    this.setData({ choosing: true })
    try {
      const sourceImagePath = await chooseSourceImage()
      if (sourceImagePath) this.setData({ sourceImagePath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('cancel')) {
        wx.showToast({ title: '图片读取失败', icon: 'none' })
      }
    } finally {
      this.setData({ choosing: false })
    }
  },

  clearImage() {
    this.setData({ sourceImagePath: '' })
  },

  selectSize(event: WechatMiniprogram.TouchEvent) {
    const size = Number(event.currentTarget.dataset.value)
    this.setData({
      'settings.width': size,
      'settings.height': size,
    })
  },

  selectColor(event: WechatMiniprogram.TouchEvent) {
    this.setData({ 'settings.colorLimit': Number(event.currentTarget.dataset.value) })
  },

  async startCreating() {
    if (this.data.generating) return
    if (!this.data.sourceImagePath) {
      wx.showToast({ title: '请先上传图片', icon: 'none' })
      return
    }

    this.setData({ generating: true })
    wx.showLoading({ title: '正在生成', mask: true })

    try {
      const draft = await createDraft(this.data.sourceImagePath, this.data.settings)
      appStore.setCurrentDraft(draft)
      wx.navigateTo({ url: '/pages/editor/index' })
    } catch (error) {
      console.error('生成拼豆图失败', error)
      wx.showToast({ title: '生成失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ generating: false })
    }
  },
})
