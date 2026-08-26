import { DEFAULT_PATTERN_SETTINGS } from '../../config/product'
import { chooseSourceImage, createDraft } from '../../services/image-service'
import { appStore } from '../../store/app-store'

/** 预览区域最大高度（rpx） */
const MAX_PREVIEW_HEIGHT_RPX = 480
/** rpx 转 px 的基准：750rpx = 屏幕宽度 */
const RPX_RATIO = wx.getSystemInfoSync().windowWidth / 750

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
    this.getTabBar()?.setData({ selected: 0 })
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
   * 使用 canvas createImage 读取尺寸，与 image-service 保持一致，避免 wx.getImageInfo 失败。
   * 若加载失败，返回保守的默认尺寸，不中断上传流程。
   */
  _calcPreviewSize(
    imagePath: string,
  ): Promise<{ previewWidth: number; previewHeight: number }> {
    /** 兜底：正方形，受最大高度约束后为 480×480 */
    const fallback = { previewWidth: 480, previewHeight: 480 }
    return new Promise((resolve) => {
      const canvas = wx.createOffscreenCanvas({ type: '2d', width: 1, height: 1 })
      const img = canvas.createImage() as WechatMiniprogram.Image
      img.onload = () => {
        const imgW = img.width
        const imgH = img.height
        if (!imgW || !imgH) {
          resolve(fallback)
          return
        }
        const imgWRpx = imgW / RPX_RATIO
        const imgHRpx = imgH / RPX_RATIO
        // 最大宽度 = 750rpx（全屏）减去页面左右 padding（各 40rpx）
        const maxW = 750 - 80
        const maxH = MAX_PREVIEW_HEIGHT_RPX
        const scale = Math.min(maxW / imgWRpx, maxH / imgHRpx, 1)
        resolve({
          previewWidth: Math.round(imgWRpx * scale),
          previewHeight: Math.round(imgHRpx * scale),
        })
      }
      img.onerror = () => {
        console.warn('[home] canvas image load fail, using fallback size')
        resolve(fallback)
      }
      img.src = imagePath
    })
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
