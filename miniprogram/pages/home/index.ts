import { DEFAULT_PATTERN_SETTINGS } from '../../config/product'
import { chooseSourceImage, createDraft } from '../../services/image-service'
import { appStore } from '../../store/app-store'

/** 页面内容区左右内边距（rpx），与 .page 的 padding 保持一致 */
const PAGE_HORIZONTAL_PADDING_RPX = 40
/** 预览区域最大宽度（rpx），不超过页面内容区 */
const MAX_PREVIEW_WIDTH_RPX = 750 - PAGE_HORIZONTAL_PADDING_RPX * 2
/** 预览区域最大高度（rpx） */
const MAX_PREVIEW_HEIGHT_RPX = 480

Page({
  data: {
    sourceImagePath: '',
    /** 预览容器宽度（rpx），0 表示未计算 */
    previewWidth: 0,
    /** 预览容器高度（rpx），0 表示未计算 */
    previewHeight: 0,
    settings: { ...DEFAULT_PATTERN_SETTINGS, width: 64, height: 64, colorLimit: 32 },
    sizeOptions: [32, 48, 64, 96, 128],
    colorOptions: [16, 32, 64, 96],
    choosing: false,
    generating: false,
  },

  onShow() {
    // tab 高亮由 page-layout selected-tab 属性管理
  },

  async chooseImage() {
    if (this.data.choosing) return
    this.setData({ choosing: true })
    try {
      const sourceImagePath = await chooseSourceImage()
      if (sourceImagePath) {
        const { previewWidth, previewHeight } = await this._calcPreviewSize(sourceImagePath)
        this.setData({ sourceImagePath, previewWidth, previewHeight })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('cancel')) {
        wx.showToast({ title: '图片读取失败', icon: 'none' })
      }
    } finally {
      this.setData({ choosing: false })
    }
  },

  /**
   * 根据原图尺寸计算受最大宽高约束的预览尺寸（rpx）。
   * 只在真实尺寸读取成功后展示图片，避免读取失败时用正方形兜底导致图片变形。
   */
  async _calcPreviewSize(
    imagePath: string,
  ): Promise<{ previewWidth: number; previewHeight: number }> {
    const { width: imageWidth, height: imageHeight } = await getImageInfo(imagePath)
    if (!imageWidth || !imageHeight) {
      throw new Error('图片尺寸无效')
    }

    const windowWidth = wx.getWindowInfo().windowWidth
    if (!windowWidth) {
      throw new Error('无法读取页面尺寸')
    }

    // 将图片像素换算为 rpx，再按最大宽度和最大高度等比缩放。
    const imageWidthRpx = imageWidth * (750 / windowWidth)
    const imageHeightRpx = imageHeight * (750 / windowWidth)
    const scale = Math.min(
      MAX_PREVIEW_WIDTH_RPX / imageWidthRpx,
      MAX_PREVIEW_HEIGHT_RPX / imageHeightRpx,
      1,
    )

    return {
      previewWidth: Math.max(1, Math.round(imageWidthRpx * scale)),
      previewHeight: Math.max(1, Math.round(imageHeightRpx * scale)),
    }
  },

  clearImage() {
    this.setData({ sourceImagePath: '', previewWidth: 0, previewHeight: 0 })
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

function getImageInfo(imagePath: string): Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: imagePath,
      success: resolve,
      fail: reject,
    })
  })
}
