import { DEFAULT_PATTERN_SETTINGS } from '../../config/product'
import { chooseSourceImage, createDraft, prepareImageForContentSecurity } from '../../services/image-service'
import { checkImageContent } from '../../services/content-security-service'
import { ApiError } from '../../services/http-client'
import { appStore } from '../../store/app-store'

/** 页面内容区左右内边距（rpx），与 .page 的 padding 保持一致 */
const PAGE_HORIZONTAL_PADDING_RPX = 40
/** 预览区域最大宽度（rpx），不超过页面内容区 */
const MAX_PREVIEW_WIDTH_RPX = 750 - PAGE_HORIZONTAL_PADDING_RPX * 2
/** 预览区域最大高度（rpx） */
const MAX_PREVIEW_HEIGHT_RPX = 480

/** 生成模式 */
type GenerationMode = 'standard' | 'ai'

interface GenerationModeOption {
  id: GenerationMode
  title: string
  description: string
  /** 「模式说明」区块使用的完整说明文案（仅展示，不参与业务判断） */
  note: string
  icon: string
  badge: string
  /** 预留：未来 AI 额度消耗，当前阶段不使用 */
  quotaCost: number
}

interface SampleImage {
  src: string
  mode: GenerationMode
  label: string
  alt: string
}

interface PreviewImageLoadEvent extends WechatMiniprogram.BaseEvent {
  detail: { width: number; height: number }
}

const GENERATION_MODES: GenerationModeOption[] = [
  {
    id: 'standard',
    title: '标准模式',
    description: '快速转换，免费使用',
    note: '快速转换，免费使用，适合日常生成',
    icon: '/assets/icons/mode-standard.svg',
    badge: '',
    quotaCost: 0,
  },
  {
    id: 'ai',
    title: 'AI 精致模式',
    description: 'AI 优化细节，更接近原图',
    note: 'AI 优化细节，效果更精致，更接近原图',
    icon: '/assets/icons/mode-ai-sparkle.svg',
    badge: '更精致',
    quotaCost: 1,
  },
]

const SAMPLE_IMAGES: SampleImage[] = [
  {
    src: '/assets/samples/home-sample-standard-1.webp',
    mode: 'standard',
    label: '标准模式',
    alt: '标准模式示例作品一',
  },
  {
    src: '/assets/samples/home-sample-standard-2.webp',
    mode: 'standard',
    label: '标准模式',
    alt: '标准模式示例作品二',
  },
  {
    src: '/assets/samples/home-sample-ai-1.webp',
    mode: 'ai',
    label: 'AI 精致模式',
    alt: 'AI 精致模式示例作品一',
  },
  {
    src: '/assets/samples/home-sample-ai-2.webp',
    mode: 'ai',
    label: 'AI 精致模式',
    alt: 'AI 精致模式示例作品二',
  },
]

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
    /** 当前选中的生成方式 */
    generationMode: 'standard' as GenerationMode,
    /** 生成方式选项列表（数据驱动渲染，避免 UI 写死） */
    generationModes: GENERATION_MODES,
    /** 示例图片列表 */
    sampleImages: SAMPLE_IMAGES,
  },

  onShow() {
    // tab 高亮由 page-layout selected-tab 属性管理
  },

  selectMode(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.mode as GenerationMode
    if (mode === this.data.generationMode) return
    this.setData({ generationMode: mode })
  },

  async chooseImage() {
    if (this.data.choosing) return
    this.setData({ choosing: true })
    try {
      const sourceImagePath = await chooseSourceImage()
      if (sourceImagePath) {
        wx.showLoading({ title: '正在安全检测', mask: true })
        try {
          let securityImagePath: string
          try {
            securityImagePath = await prepareImageForContentSecurity(sourceImagePath)
          } catch (error) {
            logHomeError('image_prepare_failed', error)
            throw error
          }
          await checkImageContent(securityImagePath)
        } finally {
          wx.hideLoading()
        }
        this.setData({
          sourceImagePath,
          previewWidth: MAX_PREVIEW_WIDTH_RPX,
          previewHeight: MAX_PREVIEW_HEIGHT_RPX,
        })
        try {
          const { previewWidth, previewHeight } = await this._calcPreviewSize(sourceImagePath)
          this.setData({ previewWidth, previewHeight })
        } catch (error) {
          // 部分开发者工具临时路径无法调用 getImageInfo，等待 <image> bindload 返回真实尺寸。
          console.warn('图片尺寸接口不可用，改用图片加载事件计算预览', error)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('cancel')) {
        logHomeError('choose_image_failed', error)
        wx.showToast({
          title: imageErrorMessage(error),
          icon: 'none',
        })
      }
    } finally {
      this.setData({ choosing: false })
    }
  },

  handlePreviewLoad(event: PreviewImageLoadEvent) {
    const { width, height } = event.detail
    const size = this._previewSizeFromDimensions(width, height)
    if (size) this.setData(size)
  },

  handlePreviewError() {
    this.clearImage()
    wx.showToast({ title: '图片无法读取，请换一张重试', icon: 'none' })
  },

  /**
   * 根据原图尺寸计算受最大宽高约束的预览尺寸（rpx）。
   * 优先读取原图尺寸；开发者工具不支持临时路径时由图片加载事件补充真实尺寸。
   */
  async _calcPreviewSize(
    imagePath: string,
  ): Promise<{ previewWidth: number; previewHeight: number }> {
    const { width: imageWidth, height: imageHeight } = await getImageInfo(imagePath)
    if (!imageWidth || !imageHeight) {
      throw new Error('图片尺寸无效')
    }

    const size = this._previewSizeFromDimensions(imageWidth, imageHeight)
    if (!size) throw new Error('无法读取页面尺寸')
    return size
  },

  _previewSizeFromDimensions(
    imageWidth: number,
    imageHeight: number,
  ): { previewWidth: number; previewHeight: number } | null {
    if (!imageWidth || !imageHeight) return null
    const windowWidth = wx.getWindowInfo().windowWidth
    if (!windowWidth) {
      return null
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

    // AI 精致模式暂未上线，明确提示用户，不伪执行标准流程
    if (this.data.generationMode === 'ai') {
      wx.showToast({ title: 'AI 精致模式即将上线，敬请期待', icon: 'none', duration: 2000 })
      return
    }

    // 标准模式：保持现有完整生成流程
    this.setData({ generating: true })
    wx.showLoading({ title: '正在生成', mask: true })

    try {
      const draft = await createDraft(this.data.sourceImagePath, this.data.settings)
      appStore.setCurrentDraft(draft)
      wx.navigateTo({ url: '/pages-sub/editor/index' })
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

function imageErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return '上传失败，请稍后重试'
  if (error.statusCode === 502 || error.statusCode === 503) {
    return '图片安全检测暂时不可用，请稍后重试'
  }
  switch (error.code) {
    case 'UNSUPPORTED_IMAGE':
      return '仅支持 JPG、PNG、WEBP 格式'
    case 'IMAGE_DECODE_ERROR':
      return '图片无法读取，请换一张重试'
    case 'NETWORK_ERROR':
      return '网络连接失败，请检查网络后重试'
    case 'CONTENT_RISKY':
      return '你发布的内容含违规信息，请修改后重试'
    case 'CONTENT_SECURITY_UNAVAILABLE':
    case 'WECHAT_CONTENT_SECURITY_UNAVAILABLE':
    case 'WECHAT_CONTENT_SECURITY_ERROR':
    case 'WECHAT_CONTENT_SECURITY_INVALID_RESPONSE':
      return '图片安全检测暂时不可用，请稍后重试'
    case 'API_CONFIGURATION_ERROR':
      return '当前服务配置异常，请稍后重试'
    case 'UNAUTHORIZED':
    case 'TOKEN_EXPIRED':
    case 'WX_LOGIN_FAILED':
    case 'CONTENT_SECURITY_IDENTITY_UNAVAILABLE':
      return '登录状态异常，请重新尝试'
    default:
      return '上传失败，请稍后重试'
  }
}

function logHomeError(event: string, error: unknown): void {
  const metadata = error instanceof ApiError
    ? { name: error.name, code: error.code, statusCode: error.statusCode, requestId: error.requestId }
    : { name: error instanceof Error ? error.name : 'UnknownError', code: null, statusCode: null, requestId: null }
  console.error(event, metadata)
}
