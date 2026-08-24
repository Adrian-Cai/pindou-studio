import { DEFAULT_PATTERN_SETTINGS } from '../../config/product'
import {
  chooseSourceImage,
  createDraft,
  UnsupportedImageFormatError,
} from '../../services/image-service'
import { appStore } from '../../store/app-store'

Page({
  data: {
    sourceImagePath: '',
    settings: { ...DEFAULT_PATTERN_SETTINGS, width: 64, height: 64, colorLimit: 32 },
    sizeOptions: [32, 48, 64, 96, 128],
    colorOptions: [16, 32, 64, 96],
    choosing: false,
  },

  async chooseImage() {
    if (this.data.choosing) return
    this.setData({ choosing: true })
    try {
      const sourceImagePath = await chooseSourceImage()
      if (sourceImagePath) this.setData({ sourceImagePath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof UnsupportedImageFormatError) {
        wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
      } else if (!message.includes('cancel')) {
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

  startCreating() {
    if (!this.data.sourceImagePath) return
    const draft = createDraft(this.data.sourceImagePath, this.data.settings)
    appStore.setCurrentDraft(draft)
    wx.navigateTo({ url: '/pages/editor/index' })
  },
})
