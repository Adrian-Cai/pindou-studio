import { DEFAULT_PATTERN_SETTINGS } from '../../config/product'
import { chooseSourceImage, createDraft, persistImage, prepareImageForContentSecurity } from '../../services/image-service'
import { checkImageContent } from '../../services/content-security-service'
import { ApiError } from '../../services/http-client'
import type { GenerationMode } from '../../models/pattern'
import { appStore } from '../../store/app-store'
import { aiTaskManager } from '../../services/ai-generation-manager'

type UploadStatus = 'empty' | 'uploading' | 'checking' | 'success' | 'rejected' | 'error'

let currentUploadRequestId = 0

interface GenerationModeOption {
  id: GenerationMode
  title: string
  /** 生成方式提示面板使用的标题和说明文案 */
  tipTitle: string
  tips: string[]
  icon: string
  badge: string
  enabled: boolean
  /** 预留：未来 AI 额度消耗，当前阶段不使用 */
  quotaCost: number
}

interface SampleImage {
  src: string
  mode: GenerationMode
  label: string
  alt: string
}

// AI 模式正式开放时改为 true，即可恢复首页选择和启动链路。
const AI_MODE_ENABLED = true

const GENERATION_MODES: GenerationModeOption[] = [
  {
    id: 'standard',
    title: '标准模式',
    tipTitle: '快速模式',
    tips: ['快速转换，免费使用，适合日常生成'],
    icon: '/assets/icons/mode-standard.svg',
    badge: '',
    enabled: true,
    quotaCost: 0,
  },
  {
    id: 'ai',
    title: 'Ai 模式',
    tipTitle: 'AI模式',
    tips: ['当前生成结果由人工智能生成', 'AI 优化细节，效果更精致，更接近原图'],
    icon: '/assets/icons/mode-ai-sparkle.svg',
    badge: '更精致',
    enabled: AI_MODE_ENABLED,
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
    label: 'Ai 模式',
    alt: 'Ai 模式示例作品一',
  },
  {
    src: '/assets/samples/home-sample-ai-2.webp',
    mode: 'ai',
    label: 'Ai 模式',
    alt: 'Ai 模式示例作品二',
  },
]

const GENERATION_STEPS = [
  { id: 1, label: '上传图片' },
  { id: 2, label: '选择模式' },
  { id: 3, label: '生成图纸' },
]

Page({
  data: {
    sourceImagePath: '',
    contentSecurityImagePath: '',
    securityCheckId: '',
    settings: { ...DEFAULT_PATTERN_SETTINGS, width: 64, height: 64, colorLimit: 32 },
    sizeOptions: [32, 48, 64, 96, 128],
    colorOptions: [16, 32, 64, 96],
    choosing: false,
    generating: false,
    /** AI 任务入队中的防抖标记：不阻塞页面，只挡住重复点击 */
    submitting: false,
    /** 未完成的 AI 任务数，用于顶部胶囊入口 */
    activeAiTaskCount: 0,
    uploadStatus: 'empty' as UploadStatus,
    /** -1 表示上传 SDK 尚未提供真实进度 */
    uploadProgress: -1,
    currentStep: 1,
    generationSteps: GENERATION_STEPS,
    /** 当前选中的生成方式 */
    generationMode: 'standard' as GenerationMode,
    /** 是否展开生成方式说明 */
    generationTipsOpen: false,
    /** 生成方式选项列表（数据驱动渲染，避免 UI 写死） */
    generationModes: GENERATION_MODES,
    /** 示例图片列表 */
    sampleImages: SAMPLE_IMAGES,
  },

  _unsubscribeAiTasks: null as (() => void) | null,

  onShow() {
    // tab 高亮由 page-layout selected-tab 属性管理；从编辑器返回时恢复当前草稿模式，重置按钮状态确保不阻塞后续操作。
    const draftMode = appStore.getSnapshot().currentDraft?.generationMode
    const generationMode = draftMode === 'ai' && !AI_MODE_ENABLED
      ? 'standard'
      : draftMode ?? this.data.generationMode
    this.setData({
      generating: false,
      submitting: false,
      currentStep: this.data.uploadStatus === 'success' ? 2 : 1,
      generationMode,
    })
    if (!this._unsubscribeAiTasks) {
      this._unsubscribeAiTasks = aiTaskManager.subscribeAll(() => this.refreshAiTaskBadge())
    }
    this.refreshAiTaskBadge()
  },

  onHide() {
    this._unsubscribeAiTasks?.()
    this._unsubscribeAiTasks = null
  },

  onUnload() {
    currentUploadRequestId += 1
    this._unsubscribeAiTasks?.()
    this._unsubscribeAiTasks = null
  },

  refreshAiTaskBadge() {
    this.setData({ activeAiTaskCount: aiTaskManager.getActiveCount() })
  },

  openAiTasks() {
    wx.switchTab({ url: '/pages/projects/index' })
  },

  selectMode(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.mode as GenerationMode
    const modeOption = this.data.generationModes.find((item) => item.id === mode)
    if (!modeOption?.enabled || mode === this.data.generationMode) return
    this.setData({ generationMode: mode })
  },

  toggleGenerationTips() {
    this.setData({ generationTipsOpen: !this.data.generationTipsOpen })
  },

  async chooseImage() {
    if (this.data.choosing || this.data.uploadStatus === 'uploading' || this.data.uploadStatus === 'checking') return
    this.setData({ choosing: true })

    let sourceImagePath: string | null = null
    try {
      sourceImagePath = await chooseSourceImage()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('cancel')) {
        logHomeError('choose_image_failed', error)
        wx.showToast({
          title: imageErrorMessage(error),
          icon: 'none',
        })
      }
      this.setData({ choosing: false })
      return
    }

    this.setData({ choosing: false })
    if (!sourceImagePath) return

    const requestId = ++currentUploadRequestId
    this.setData({
      sourceImagePath,
      contentSecurityImagePath: '',
      securityCheckId: '',
      uploadStatus: 'uploading',
      uploadProgress: -1,
      currentStep: 1,
    })

    try {
      const securityImagePath = await prepareImageForContentSecurity(sourceImagePath)
      if (requestId !== currentUploadRequestId) return
      this.setData({ contentSecurityImagePath: securityImagePath })
      const securityCheck = await checkImageContent(securityImagePath, (progress) => {
        if (requestId !== currentUploadRequestId) return
        if (progress >= 100) {
          this.setData({ uploadStatus: 'checking', uploadProgress: -1 })
          return
        }
        this.setData({ uploadProgress: progress })
      })
      if (requestId !== currentUploadRequestId) return
      this.setData({
        uploadStatus: 'checking',
        uploadProgress: -1,
      })
      this.setData({
        uploadStatus: 'success',
        securityCheckId: securityCheck.checkId,
        currentStep: 2,
      })
    } catch (error) {
      if (requestId !== currentUploadRequestId) return
      const rejected = error instanceof ApiError && error.code === 'CONTENT_RISKY'
      logHomeError('image_security_check_failed', error)
      this.setData({
        uploadStatus: rejected ? 'rejected' : 'error',
        uploadProgress: -1,
        currentStep: 1,
      })
    }
  },

  handlePreviewError() {
    currentUploadRequestId += 1
    this.setData({
      sourceImagePath: '',
      contentSecurityImagePath: '',
      securityCheckId: '',
      uploadStatus: 'error',
      uploadProgress: -1,
      currentStep: 1,
    })
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
    if (this.data.uploadStatus !== 'success') {
      wx.showToast({
        title: this.data.uploadStatus === 'uploading' || this.data.uploadStatus === 'checking'
          ? '图片正在检测，请稍候'
          : '请先通过图片安全检测',
        icon: 'none',
      })
      return
    }

    if (this.data.generationMode === 'ai') {
      if (!AI_MODE_ENABLED) {
        this.setData({ generationMode: 'standard' })
        wx.showToast({ title: 'AI模式暂未开放', icon: 'none' })
        return
      }
      await this.startAiCreating()
      return
    }

    // 标准模式：保持独立生成，不清除后台正在运行的 AI 任务。
    this.setData({ generating: true, currentStep: 3 })
    wx.showLoading({ title: '正在生成', mask: true })

    try {
      const draft = await createDraft(this.data.sourceImagePath, this.data.settings, 'standard')
      appStore.setCurrentDraft(draft)
      wx.navigateTo({ url: '/packages/editor/index' })
    } catch (error) {
      console.error('生成拼豆图失败', error)
      wx.showToast({ title: '生成失败，请重试', icon: 'none' })
      this.setData({ currentStep: 2 })
    } finally {
      wx.hideLoading()
      this.setData({ generating: false })
    }
  },

  /**
   * AI 模式：只负责把任务丢进队列——立刻返回、不跳转、不阻塞下一张图。
   * 任务进度沉淀到作品页的占位卡片，由 aiTaskManager 在后台驱动。
   */
  async startAiCreating(): Promise<void> {
    if (this.data.submitting) return
    if (!this.data.sourceImagePath) {
      wx.showToast({ title: '请先上传图片', icon: 'none' })
      return
    }
    if (this.data.uploadStatus !== 'success') {
      wx.showToast({
        title: this.data.uploadStatus === 'uploading' || this.data.uploadStatus === 'checking'
          ? '图片正在检测，请稍候'
          : '请先通过图片安全检测',
        icon: 'none',
      })
      return
    }

    this.setData({ submitting: true })
    try {
      // 选图临时路径在 App 重启后会失效，永久化后才能保证封面不白图、重试可用
      const sourceImagePath = await persistImage(this.data.sourceImagePath)
      const inputImagePath = this.data.contentSecurityImagePath
        ? await persistImage(this.data.contentSecurityImagePath)
        : undefined

      await aiTaskManager.createTask({
        sourceImagePath,
        inputImagePath,
        securityCheckId: this.data.securityCheckId,
        settings: { ...this.data.settings },
      })

      wx.showToast({ title: '已加入生成队列', icon: 'none', duration: 1500 })
      this.resetUploadState()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : 'AI 任务创建失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  /** 清空选图状态，让用户可以立刻选下一张图继续生成。 */
  resetUploadState() {
    currentUploadRequestId += 1
    this.setData({
      sourceImagePath: '',
      contentSecurityImagePath: '',
      securityCheckId: '',
      uploadStatus: 'empty',
      uploadProgress: -1,
      currentStep: 1,
    })
  },
})

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
