import { DEFAULT_PATTERN_SETTINGS } from '../../config/product'
import { chooseSourceImage, createDraft, createPendingDraft, prepareImageForContentSecurity } from '../../services/image-service'
import { checkImageContent } from '../../services/content-security-service'
import { ApiError } from '../../services/http-client'
import {
  aiGenerationErrorMessage,
  createAiGeneration,
  DEFAULT_AI_OPTIONS,
  uploadAiInput,
} from '../../services/ai-generation-service'
import {
  createIdempotencyKey,
  loadAiGenerationSession,
  saveAiGenerationSession,
  type AiGenerationSession,
} from '../../services/ai-generation-session'
import type { PatternSettings } from '../../models/pattern'
import { appStore } from '../../store/app-store'

/** 生成模式 */
type GenerationMode = 'standard' | 'ai'
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
  /** 预留：未来 AI 额度消耗，当前阶段不使用 */
  quotaCost: number
}

interface SampleImage {
  src: string
  mode: GenerationMode
  label: string
  alt: string
}

const GENERATION_MODES: GenerationModeOption[] = [
  {
    id: 'standard',
    title: '标准模式',
    tipTitle: '快速模式',
    tips: ['快速转换，免费使用，适合日常生成'],
    icon: '/assets/icons/mode-standard.svg',
    badge: '',
    quotaCost: 0,
  },
  {
    id: 'ai',
    title: 'Ai 模式',
    tipTitle: 'AI模式',
    tips: ['当前生成结果由人工智能生成', 'AI 优化细节，效果更精致，更接近原图'],
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
    aiInputImagePath: '',
    settings: { ...DEFAULT_PATTERN_SETTINGS, width: 64, height: 64, colorLimit: 32 },
    sizeOptions: [32, 48, 64, 96, 128],
    colorOptions: [16, 32, 64, 96],
    choosing: false,
    generating: false,
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

  onShow() {
    // tab 高亮由 page-layout selected-tab 属性管理
  },

  onUnload() {
    currentUploadRequestId += 1
  },

  selectMode(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.mode as GenerationMode
    if (mode === this.data.generationMode) return
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
      uploadStatus: 'uploading',
      uploadProgress: -1,
      currentStep: 1,
    })

    try {
      const securityImagePath = await prepareImageForContentSecurity(sourceImagePath)
      if (requestId !== currentUploadRequestId) return
      this.setData({ aiInputImagePath: securityImagePath })
      await checkImageContent(securityImagePath, (progress) => {
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
      aiInputImagePath: '',
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
      await this.startAiCreating()
      return
    }

    // 标准模式：保持现有完整生成流程
    this.setData({ generating: true, currentStep: 3 })
    wx.showLoading({ title: '正在生成', mask: true })

    try {
      const draft = await createDraft(this.data.sourceImagePath, this.data.settings)
      appStore.setCurrentDraft(draft)
      wx.navigateTo({ url: '/pages-sub/editor/index' })
    } catch (error) {
      console.error('生成拼豆图失败', error)
      wx.showToast({ title: '生成失败，请重试', icon: 'none' })
      this.setData({ currentStep: 2 })
    } finally {
      wx.hideLoading()
      this.setData({ generating: false })
    }
  },

  async startAiCreating(): Promise<void> {
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

    this.setData({ generating: true, currentStep: 3, uploadStatus: 'uploading', uploadProgress: -1 })
    const existingSession = loadAiGenerationSession()
    if (
      existingSession
      && existingSession.sourceImagePath === this.data.sourceImagePath
      && existingSession.jobId
      && (existingSession.status === 'processing' || existingSession.status === 'succeeded')
    ) {
      try {
        await openAiEditor(existingSession)
      } catch (error) {
        wx.showToast({ title: aiGenerationErrorMessage(error), icon: 'none' })
      } finally {
        this.setData({ generating: false, uploadStatus: 'success', uploadProgress: -1, currentStep: 2 })
      }
      return
    }
    let session = loadReusableAiSession(this.data.sourceImagePath, this.data.settings)
    if (!session) {
      session = {
        idempotencyKey: createIdempotencyKey(),
        jobId: null,
        inputFileId: null,
        sourceImagePath: this.data.sourceImagePath,
        outputImagePath: '',
        settings: { ...this.data.settings } as PatternSettings,
        ...DEFAULT_AI_OPTIONS,
        status: 'uploading',
        createdAt: Date.now(),
      }
    } else {
      session = { ...session, status: session.inputFileId ? 'creating' : 'uploading' }
    }
    try {
      saveAiGenerationSession(session)
    } catch (error) {
      this.setData({ generating: false, uploadStatus: 'success', uploadProgress: -1, currentStep: 2 })
      wx.showToast({ title: aiGenerationErrorMessage(error), icon: 'none' })
      return
    }

    try {
      if (!session.inputFileId) {
        const aiInputImagePath = this.data.aiInputImagePath || await prepareImageForContentSecurity(this.data.sourceImagePath)
        const uploaded = await uploadAiInput(aiInputImagePath, (progress) => {
          this.setData({ uploadProgress: progress })
        })
        session = { ...session, inputFileId: uploaded.id, status: 'creating' }
        saveAiGenerationSession(session)
      }

      const inputFileId = session.inputFileId
      if (!inputFileId) {
        this.setData({ generating: false, uploadStatus: 'success', uploadProgress: -1, currentStep: 2 })
        wx.showToast({ title: '输入图片已失效，请重新上传', icon: 'none' })
        return
      }
      const generation = await createAiGeneration({
        inputFileId,
        style: session.style,
        detailLevel: session.detailLevel,
        backgroundMode: session.backgroundMode,
        idempotencyKey: session.idempotencyKey,
      })
      saveAiGenerationSession({
        ...session,
        jobId: generation.id,
        status: generation.status === 'succeeded' ? 'succeeded' : 'processing',
      })
      const activeSession = loadAiGenerationSession()
      if (!activeSession) throw new ApiError('AI 任务会话保存失败，请稍后重试', { code: 'INVALID_RESPONSE' })
      this.setData({ uploadStatus: 'success', uploadProgress: -1 })
      await openAiEditor(activeSession)
    } catch (error) {
      logHomeError('ai_generation_start_failed', error)
      this.setData({ generating: false, uploadStatus: 'success', uploadProgress: -1, currentStep: 2 })
      if (error instanceof ApiError && error.code === 'QUOTA_INSUFFICIENT') {
        showAiQuotaModal()
        return
      }
      wx.showToast({ title: aiGenerationErrorMessage(error), icon: 'none', duration: 2_000 })
    } finally {
      this.setData({ generating: false })
    }
  },
})

function loadReusableAiSession(sourceImagePath: string, settings: PatternSettings) {
  const session = loadAiGenerationSession()
  if (
    !session
    || session.sourceImagePath !== sourceImagePath
    || session.jobId
    || session.status !== 'creating'
    || !session.inputFileId
    || session.settings.width !== settings.width
    || session.settings.height !== settings.height
    || session.settings.colorLimit !== settings.colorLimit
    || session.settings.brand !== settings.brand
  ) return null
  return session
}

function createIdempotentNavigationError(): ApiError {
  return new ApiError('任务页面打开失败，请稍后重试', { code: 'NAVIGATION_ERROR' })
}

async function openAiEditor(session: AiGenerationSession): Promise<void> {
  await appStore.setCurrentDraft(createPendingDraft(session.sourceImagePath, session.settings))
  await navigateToEditor()
}

function navigateToEditor(): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.navigateTo({
      url: '/pages-sub/editor/index',
      success: () => resolve(),
      fail: () => reject(createIdempotentNavigationError()),
    })
  })
}

function showAiQuotaModal(): void {
  wx.showModal({
    title: 'AI 生成次数不足',
    content: '购买 AI 生成次数后，可以继续使用当前图片生成。',
    confirmText: '购买次数',
    cancelText: '稍后再说',
    success: ({ confirm }) => {
      if (confirm) wx.navigateTo({ url: '/pages-sub/recharge/index' })
    },
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
