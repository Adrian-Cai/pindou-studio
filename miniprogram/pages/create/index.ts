import { DEFAULT_PATTERN_SETTINGS } from '../../config/product'
import { chooseSourceImage, createDraft, persistImage, prepareImageForContentSecurity } from '../../services/image-service'
import { checkImageContent } from '../../services/content-security-service'
import { ApiError } from '../../services/http-client'
import type { GenerationMode } from '../../models/pattern'
import type { AiGenerationStyle } from '../../services/ai-generation-service'
import { appStore } from '../../store/app-store'
import { aiTaskManager } from '../../services/ai-generation-manager'
import { createTextGeneration } from '../../services/text-generation-service'
import { createIdempotencyKey } from '../../services/ai-task-store'
import { requireLoggedInSession } from '../../services/session-service'

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
}

const GENERATION_MODES: GenerationModeOption[] = [
  {
    id: 'standard',
    title: '标准模式',
    tipTitle: '快速模式',
    tips: ['快速转换，免费使用，适合日常生成'],
    icon: '/assets/icons/mode-standard.svg',
    badge: '',
  },
  {
    id: 'ai',
    title: 'AI 风格转换',
    tipTitle: 'AI 模式',
    tips: ['当前生成结果由人工智能生成', 'AI 优化细节，效果更精致，更接近原图'],
    icon: '/assets/icons/mode-ai-sparkle.svg',
    badge: '更精致',
  },
]

const AI_STYLE_OPTIONS: { id: AiGenerationStyle; label: string; icon: string; exampleImage: string }[] = [
  {
    id: 'kawaii',
    label: 'Q版',
    icon: '/assets/samples/home-ai-kawaii.jpg',
    exampleImage: '/assets/samples/home-ai-kawaii.jpg',
  },
  {
    id: 'cartoon',
    label: '卡通插画',
    icon: '/assets/icons/palette-grid.svg',
    exampleImage: '/assets/samples/home-ai-cartoon.jpg',
  },
  {
    id: 'minimal',
    label: '极简插画',
    icon: '/assets/icons/iconsax/gallery.svg',
    exampleImage: '/assets/samples/home-ai-minimal.jpg',
  },
]

Page({
  data: {
    sourceImagePath: '',
    creationSource: 'image' as 'image' | 'text',
    prompt: '',
    promptLength: 0,
    creatingText: false,
    contentSecurityImagePath: '',
    securityCheckId: '',
    settings: { ...DEFAULT_PATTERN_SETTINGS, width: 64, height: 64, colorLimit: 32 },
    sizeOptions: [32, 48, 64, 96, 128],
    colorOptions: [16, 32, 64, 96],
    choosing: false,
    generating: false,
    /** AI 任务入队中的防抖标记：不阻塞页面，只挡住重复点击 */
    submitting: false,
    uploadStatus: 'empty' as UploadStatus,
    /** -1 表示上传 SDK 尚未提供真实进度 */
    uploadProgress: -1,
    /** 当前选中的生成方式 */
    generationMode: 'standard' as GenerationMode,
    /** AI 风格默认使用 Q 版；任务创建后由任务快照保存。 */
    aiStyle: 'kawaii' as AiGenerationStyle,
    aiStyles: AI_STYLE_OPTIONS,
    /** 是否展开生成方式说明 */
    generationTipsOpen: false,
    /** 生成方式选项列表（数据驱动渲染，避免 UI 写死） */
    generationModes: GENERATION_MODES,
  },

  _visible: false,

  onLoad(query: { source?: string }) {
    if (query.source === 'text') this.setData({ creationSource: 'text' })
  },

  onShow() {
    this._visible = true
    // 保留本次创作的图片、参数和模式；旧草稿或后台任务不能改写当前选择。
    this.setData({
      generating: false,
      submitting: false,
    })
  },

  onHide() {
    this._visible = false
  },

  onUnload() {
    this._visible = false
    currentUploadRequestId += 1
  },

  selectMode(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.mode as GenerationMode
    if (mode === this.data.generationMode) return
    if (mode === 'ai' && !hasAiLogin()) return
    this.setData({ generationMode: mode })
  },

  selectAiStyle(event: WechatMiniprogram.TouchEvent) {
    const style = event.currentTarget.dataset.style as AiGenerationStyle
    if (!AI_STYLE_OPTIONS.some((item) => item.id === style) || style === this.data.aiStyle) return
    this.setData({ aiStyle: style })
  },

  changePrompt(event: WechatMiniprogram.Input) {
    const prompt = event.detail.value
    this.setData({ prompt, promptLength: Array.from(prompt).length })
  },

  async startTextGeneration() {
    if (this.data.creatingText || this.data.submitting) return
    if (!hasAiLogin()) return
    const prompt = this.data.prompt.trim().normalize('NFC')
    const length = Array.from(prompt).length
    if (length < 1 || length > 500) {
      wx.showToast({ title: '描述需要填写 1 到 500 个字', icon: 'none' })
      return
    }
    this.setData({ creatingText: true })
    try {
      const task = await createTextGeneration(prompt, createIdempotencyKey())
      wx.navigateTo({ url: `/packages/ai-generation/text/index?taskId=${encodeURIComponent(task.id)}&from=home` })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '文生图任务创建失败，请重试', icon: 'none' })
    } finally {
      this.setData({ creatingText: false })
    }
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
        logCreationError('choose_image_failed', error)
        wx.showToast({
          title: error instanceof ApiError ? error.message : '上传失败，请稍后重试',
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
      })
    } catch (error) {
      if (requestId !== currentUploadRequestId) return
      const rejected = error instanceof ApiError && error.code === 'CONTENT_RISKY'
      logCreationError('image_security_check_failed', error)
      this.setData({
        uploadStatus: rejected ? 'rejected' : 'error',
        uploadProgress: -1,
      })
    }
  },

  removeImage() {
    if (this.data.choosing || this.data.uploadStatus === 'empty') return
    currentUploadRequestId += 1
    this.setData({
      sourceImagePath: '',
      contentSecurityImagePath: '',
      securityCheckId: '',
      uploadStatus: 'empty',
      uploadProgress: -1,
    })
  },

  handlePreviewError() {
    currentUploadRequestId += 1
    this.setData({
      sourceImagePath: '',
      contentSecurityImagePath: '',
      securityCheckId: '',
      uploadStatus: 'error',
      uploadProgress: -1,
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
    if (this.data.generating || this.data.submitting) return
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

    // 标准模式：保持独立生成，不清除后台正在运行的 AI 任务。
    this.setData({ generating: true })
    wx.showLoading({ title: '正在生成', mask: true })

    try {
      const draft = await createDraft(this.data.sourceImagePath, this.data.settings, 'standard')
      appStore.setCurrentDraft(draft)
      wx.navigateTo({ url: '/packages/editor/index' })
    } catch (error) {
      console.error('生成拼豆图失败', error)
      wx.showToast({ title: '生成失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ generating: false })
    }
  },

  /**
   * AI 模式：任务入队后进入生成页，复用进度动效与失败操作。
   * 任务仍由 aiTaskManager 驱动，离开创作页后不阻塞新的创作流程。
   */
  async startAiCreating(): Promise<void> {
    if (this.data.submitting) return
    if (!hasAiLogin()) return
    this.setData({ submitting: true })
    // 固定本次提交的输入，避免异步保存期间用户换图或调参串到同一任务。
    const { sourceImagePath: selectedImagePath, contentSecurityImagePath, securityCheckId, aiStyle } = this.data
    const settings = { ...this.data.settings }
    try {
      // 选图临时路径在 App 重启后会失效，永久化后才能保证封面不白图、重试可用
      const sourceImagePath = await persistImage(selectedImagePath)
      const inputImagePath = contentSecurityImagePath
        ? await persistImage(contentSecurityImagePath)
        : undefined

      const taskId = await aiTaskManager.createTask({
        sourceImagePath,
        inputImagePath,
        securityCheckId,
        style: aiStyle,
        settings,
      })
      if (!this._visible) return
      await new Promise<void>((resolve) => {
        wx.navigateTo({
          url: `/packages/ai-generation/index?taskId=${encodeURIComponent(taskId)}&from=home`,
          fail: () => wx.showToast({ title: '生成页打开失败，可到作品页查看任务', icon: 'none' }),
          complete: () => resolve(),
        })
      })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : 'AI 任务创建失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }

  },
})

function logCreationError(event: string, error: unknown): void {
  const metadata = error instanceof ApiError
    ? { name: error.name, code: error.code, statusCode: error.statusCode, requestId: error.requestId }
    : { name: error instanceof Error ? error.name : 'UnknownError', code: null, statusCode: null, requestId: null }
  console.error(event, metadata)
}

function hasAiLogin(): boolean {
  try {
    requireLoggedInSession()
    return true
  } catch {
    wx.showToast({ title: '请先登录后使用 AI 功能', icon: 'none' })
    return false
  }
}
