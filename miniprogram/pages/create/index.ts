import { DEFAULT_PATTERN_SETTINGS } from '../../config/product'
import { chooseSourceImage, createDraft, persistImage, prepareImageForContentSecurity } from '../../services/image-service'
import { checkImageContent } from '../../services/content-security-service'
import { ApiError } from '../../services/http-client'
import type { GenerationMode, PatternDraft } from '../../models/pattern'
import type { AiGenerationStyle } from '../../services/ai-generation-service'
import { appStore } from '../../store/app-store'
import { aiTaskManager } from '../../services/ai-generation-manager'
import {
  consumeTextGeneration,
  createTextGeneration,
  fetchTextGenerationOptions,
  fetchTextInspirations,
  getTextGeneration,
  loadTextGenerationImage,
  textGenerationFailureMessage,
  type TextGeneration,
} from '../../services/text-generation-service'
import {
  clearTextTaskId,
  readInspirationCache,
  readTextTaskId,
  writeInspirationCache,
  writeTextTaskId,
} from '../../services/text-generation-store'
import { authStore } from '../../store/auth-store'
import { createIdempotencyKey } from '../../services/ai-task-store'
import { requireLoggedInSession } from '../../services/session-service'

type UploadStatus = 'empty' | 'uploading' | 'checking' | 'success' | 'rejected' | 'error'

/** 文生图结果的四种页面内状态：无任务 / 生成中 / 成功 / 失败。 */
type TextTaskPhase = 'idle' | 'pending' | 'succeeded' | 'failed'

/** 服务端没有精确进度，按固定间隔轮询任务状态。 */
const TEXT_TASK_POLL_INTERVAL_MS = 2_000
/** 「换一换」连点冷却：灵感单次都要真实调用文本模型，防止误触重复消耗 token。 */
const INSPIRATION_COOLDOWN_MS = 3_000
const TEXT_IMAGE_SIZE_ORDER = ['1024x1024', '1280x1280', '1280x720', '720x1280']
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
    inspirations: [] as { title: string; prompt: string }[],
    inspirationLoading: false,
    inspirationError: '',
    /** 灵感图在本页的展示状态：不再跳转独立结果页，原地渲染生成结果。 */
    textTaskPhase: 'idle' as TextTaskPhase,
    textTaskStatusText: '',
    textTaskSize: '',
    textTaskPrompt: '',
    /** 失败原因或「图片已生成但加载失败」的提示 */
    textTaskError: '',
    textTaskImagePath: '',
    textTaskImageLoading: false,
    textTaskConverting: false,
    textSizes: [] as string[],
    textSizeOptions: [] as { value: string; ratio: string; resolution: string; previewWidth: number; previewHeight: number }[],
    textSize: '',
    textOptionsLoading: false,
    textOptionsError: '',
    textCost: 1,
    aiRemaining: null as number | null,
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
  /** 当前页面上正在跟踪的文生图任务；空串表示本页没有任务 */
  _textTaskId: '',
  _textTaskTimer: 0 as ReturnType<typeof setTimeout>,
  _textTaskBusy: false,
  /** 上次灵感真实生成的时间，用于「换一换」冷却与缓存有效期判断 */
  _inspirationFetchedAt: 0,

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
    if (this.data.creationSource === 'text') void this.loadTextMode()
  },

  onHide() {
    this._visible = false
    this.stopTextTaskPolling()
  },

  onUnload() {
    this._visible = false
    currentUploadRequestId += 1
    this.stopTextTaskPolling()
  },

  selectCreationSource(event: WechatMiniprogram.TouchEvent) {
    if (this.data.creatingText) return
    const source = event.currentTarget.dataset.source as 'image' | 'text'
    if (source === this.data.creationSource) return
    this.setData({ creationSource: source })
    if (source === 'text') void this.loadTextMode()
  },

  async loadTextMode() {
    // 灵感每次都要真实调用文本模型：先吃本地缓存，只有缓存缺失/过期才请求，
    // 避免「每次进入创作页都烧一次 token」。
    if (!this.applyCachedInspirations()) void this.refreshInspirations()
    void this.restoreTextTask()
    void authStore.refreshAiQuota().then(quota => {
      if (this._visible) this.setData({ aiRemaining: quota?.aiGeneration.remaining ?? null })
    }).catch(() => this.setData({ aiRemaining: null }))
    this.setData({ textOptionsLoading: true, textOptionsError: '' })
    try {
      const options = await fetchTextGenerationOptions()
      if (!this._visible) return
      const textSizes = options.sizes.slice().sort((left, right) => TEXT_IMAGE_SIZE_ORDER.indexOf(left) - TEXT_IMAGE_SIZE_ORDER.indexOf(right))
      const textSize = textSizes.includes(this.data.textSize) ? this.data.textSize : options.defaultSize
      const textSizeOptions = textSizes.map(value => {
        const [width, height] = value.split('x').map(Number)
        const maxSide = Math.max(width, height)
        const scale = width > 0 && height > 0 ? 38 / maxSide : 0
        return {
          value,
          ratio: width === height ? '1:1' : width > height ? '16:9' : '9:16',
          resolution: width === height ? `${width}²` : `${width}×${height}`,
          previewWidth: scale ? Math.round(width * scale) : 36,
          previewHeight: scale ? Math.round(height * scale) : 36,
        }
      })
      this.setData({ textSizes, textSizeOptions, textSize, textCost: options.cost })
    } catch {
      if (this._visible) this.setData({ textOptionsError: '尺寸配置读取失败，点击重试', textSizes: [], textSizeOptions: [] })
    } finally {
      if (this._visible) this.setData({ textOptionsLoading: false })
    }
  },

  /** 用本地缓存的灵感填充页面；缓存缺失或过期时返回 false，由调用方请求真实 AI。 */
  applyCachedInspirations(): boolean {
    const cached = readInspirationCache()
    if (!cached) return false
    this._inspirationFetchedAt = cached.fetchedAt
    this.setData({ inspirations: cached.items, inspirationError: '' })
    return true
  },

  async refreshInspirations() {
    if (this.data.inspirationLoading) return
    // 连点冷却：灵感单次都要真实消耗 token，刚换过就先复用当前结果
    if (this.data.inspirations.length && Date.now() - this._inspirationFetchedAt < INSPIRATION_COOLDOWN_MS) {
      wx.showToast({ title: '刚换过灵感，稍后再试', icon: 'none' })
      return
    }
    this.setData({ inspirationLoading: true, inspirationError: '' })
    try {
      const inspirations = await fetchTextInspirations()
      this._inspirationFetchedAt = Date.now()
      writeInspirationCache(inspirations)
      if (this._visible) this.setData({ inspirations })
    } catch (error) {
      if (this._visible) this.setData({ inspirationError: error instanceof Error ? error.message : '灵感获取失败，请点击换一换重试' })
    } finally {
      this.setData({ inspirationLoading: false })
    }
  },

  useInspiration(event: WechatMiniprogram.TouchEvent) {
    if (this.data.creatingText) return
    const item = this.data.inspirations[Number(event.currentTarget.dataset.index)]
    if (item) this.setData({ prompt: item.prompt, promptLength: Array.from(item.prompt).length })
  },

  clearPrompt() {
    if (!this.data.creatingText) this.setData({ prompt: '', promptLength: 0 })
  },

  selectTextSize(event: WechatMiniprogram.TouchEvent) {
    const size = String(event.currentTarget.dataset.size)
    if (this.data.textSizes.includes(size) && !this.data.creatingText) {
      this.setData({ textSize: size })
    }
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

  /**
   * 提交文生图任务后**不跳页**：结果直接渲染在本页预留的展示位里，
   * 页面轮询任务状态，失败也不丢描述。
   */
  async startTextGeneration() {
    if (this.data.creatingText || this.data.submitting) return
    if (this.data.textTaskPhase === 'pending') {
      wx.showToast({ title: '灵感图正在生成，请稍候', icon: 'none' })
      return
    }
    if (!hasAiLogin()) return
    if (!this.data.textSizes.includes(this.data.textSize) || this.data.textOptionsLoading) {
      wx.showToast({ title: '请先加载并选择图片尺寸', icon: 'none' })
      return
    }
    const prompt = this.data.prompt.trim().normalize('NFC')
    const length = Array.from(prompt).length
    if (length < 1 || length > 500) {
      wx.showToast({ title: '描述需要填写 1 到 500 个字', icon: 'none' })
      return
    }
    this.setData({ creatingText: true })
    try {
      const task = await createTextGeneration(prompt, createIdempotencyKey(), this.data.textSize)
      // 换任务即换展示位：先清掉上一张图，避免新任务未出图时还挂着旧结果
      this.setData({ textTaskImagePath: '', textTaskError: '' })
      this.applyTextTask(task)
      writeTextTaskId(task.id)
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '文生图任务创建失败，请重试', icon: 'none' })
    } finally {
      this.setData({ creatingText: false })
    }
  },

  /** 用最新任务快照刷新页面状态；生成中自动续排轮询，成功则去取图。 */
  applyTextTask(task: TextGeneration) {
    const phase: TextTaskPhase = task.status === 'succeeded'
      ? 'succeeded'
      : task.status === 'failed' ? 'failed' : 'pending'
    this._textTaskId = task.id
    this.setData({
      textTaskPhase: phase,
      textTaskPrompt: task.prompt,
      textTaskSize: task.size,
      textTaskStatusText: task.status === 'queued' ? '正在排队生成灵感图' : 'AI 正在生成灵感图',
      textTaskError: task.status === 'failed' ? textGenerationFailureMessage(task.errorCode) : '',
    })
    if (phase === 'pending') {
      this.scheduleTextTaskPolling()
      return
    }
    this.stopTextTaskPolling()
    if (phase === 'succeeded') void this.loadTextTaskImage(task)
  },

  /** 只读取不创建：任务过期或被清理时回到空展示位，不打扰用户。 */
  async fetchTextTask() {
    if (!this._textTaskId || this._textTaskBusy) return
    const jobId = this._textTaskId
    this._textTaskBusy = true
    try {
      const task = await getTextGeneration(jobId)
      if (this._textTaskId !== jobId) return
      this.applyTextTask(task)
    } catch (error) {
      if (this._textTaskId !== jobId) return
      if (error instanceof ApiError && (error.statusCode === 404 || error.code === 'NOT_FOUND')) {
        this.clearTextTask()
        return
      }
      if (this._visible) this.setData({ textTaskError: error instanceof Error ? error.message : '任务读取失败，请重试' })
      // 网络抖动不该让预览永远卡在「生成中」：仍在生成中就继续轮询
      if (this.data.textTaskPhase === 'pending') this.scheduleTextTaskPolling()
    } finally {
      this._textTaskBusy = false
    }
  },

  refreshTextTask() {
    void this.fetchTextTask()
  },

  scheduleTextTaskPolling() {
    this.stopTextTaskPolling()
    this._textTaskTimer = setTimeout(() => void this.fetchTextTask(), TEXT_TASK_POLL_INTERVAL_MS)
  },

  stopTextTaskPolling() {
    if (this._textTaskTimer) clearTimeout(this._textTaskTimer)
    this._textTaskTimer = 0 as ReturnType<typeof setTimeout>
  },

  /**
   * 重新进入创作页时恢复本机最近一次文生图任务。
   * 用户在生成中途离开（或返回首页）后再进来，仍能在展示位看到结果。
   */
  async restoreTextTask() {
    if (this._textTaskId) {
      if (this.data.textTaskPhase === 'pending') this.scheduleTextTaskPolling()
      return
    }
    const jobId = readTextTaskId()
    if (!jobId) return
    this._textTaskId = jobId
    // 已经渲染过结果的展示位不闪回「生成中」，静默核对即可
    if (this.data.textTaskPhase === 'idle') {
      this.setData({ textTaskPhase: 'pending', textTaskStatusText: '正在读取生成进度', textTaskError: '' })
    }
    await this.fetchTextTask()
  },

  /** 回到空展示位，并清掉本地任务记录。 */
  clearTextTask() {
    this._textTaskId = ''
    this.stopTextTaskPolling()
    clearTextTaskId()
    this.setData({
      textTaskPhase: 'idle',
      textTaskStatusText: '',
      textTaskPrompt: '',
      textTaskSize: '',
      textTaskError: '',
      textTaskImagePath: '',
      textTaskImageLoading: false,
    })
  },

  async loadTextTaskImage(task: TextGeneration) {
    if (this.data.textTaskImagePath || !task.outputFile) return
    const jobId = task.id
    this.setData({ textTaskImageLoading: true, textTaskError: '' })
    try {
      const path = await loadTextGenerationImage(task)
      if (this._textTaskId !== jobId) return
      this.setData({ textTaskImagePath: path, textTaskError: '' })
    } catch {
      if (this._textTaskId !== jobId) return
      this.setData({ textTaskError: '灵感图已经生成，但图片加载失败。点「重新读取」再试，不会重复扣额度。' })
    } finally {
      if (this._textTaskId === jobId) this.setData({ textTaskImageLoading: false })
    }
  },

  /** 失败重试或再抽一张：沿用同一段描述和尺寸，成功后覆盖展示位。 */
  async retryTextGeneration() {
    if (this.data.creatingText || this.data.textTaskPhase === 'pending') return
    if (!hasAiLogin()) return
    const prompt = (this.data.textTaskPrompt || this.data.prompt).trim().normalize('NFC')
    if (!prompt) {
      wx.showToast({ title: '请先填写描述', icon: 'none' })
      return
    }
    const size = this.data.textSizes.includes(this.data.textTaskSize) ? this.data.textTaskSize : this.data.textSize
    if (!this.data.textSizes.includes(size)) {
      wx.showToast({ title: '图片尺寸暂不可用，请重新选择', icon: 'none' })
      return
    }
    this.setData({ creatingText: true })
    try {
      const task = await createTextGeneration(prompt, createIdempotencyKey(), size)
      this.setData({ textTaskImagePath: '', textTaskError: '' })
      this.applyTextTask(task)
      writeTextTaskId(task.id)
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '重新生成失败，请重试', icon: 'none' })
    } finally {
      this.setData({ creatingText: false })
    }
  },

  /** 确认参考图：走与独立结果页一致的标准拼豆转换与草稿落地。 */
  async createPatternFromTextTask() {
    const source = this.data.textTaskImagePath
    if (this.data.textTaskPhase !== 'succeeded' || !source || this.data.textTaskConverting) return
    const jobId = this._textTaskId
    const sourcePrompt = this.data.textTaskPrompt
    this.setData({ textTaskConverting: true })
    wx.showLoading({ title: '正在生成拼豆图', mask: true })
    try {
      const draft: PatternDraft = {
        ...await createDraft(source, DEFAULT_PATTERN_SETTINGS, 'standard'),
        creationSource: 'text',
        sourcePrompt,
      }
      await appStore.saveLocalDraft(draft, false)
      await appStore.setCurrentDraft(draft)
      try {
        await consumeTextGeneration(jobId)
      } catch (error) {
        console.warn('文生图任务已生成草稿，但恢复任务标记失败', error)
      }
      wx.navigateTo({ url: '/packages/editor/index' })
    } catch (error) {
      console.error('文生图参考图转拼豆失败', error)
      wx.showToast({ title: error instanceof Error ? error.message : '拼豆图生成失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ textTaskConverting: false })
    }
  },

  previewTextGeneration() {
    const path = this.data.textTaskImagePath
    if (path) wx.previewImage({ urls: [path] })
  },

  handleTextTaskImageError(event: WechatMiniprogram.TouchEvent) {
    if (event.currentTarget.dataset.src !== this.data.textTaskImagePath) return
    this.setData({
      textTaskImagePath: '',
      textTaskImageLoading: false,
      textTaskError: '灵感图已经生成，但图片无法显示。点「重新读取」再试，不会重复扣额度。',
    })
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
