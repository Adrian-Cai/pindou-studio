import { createDraft } from '../../services/image-service'
import {
  aiGenerationErrorMessage,
  createAiGeneration,
  downloadAiOutput,
  getAiGeneration,
  isAiOutputImageAvailable,
  type AiGeneration,
} from '../../services/ai-generation-service'
import {
  clearAiGenerationSession,
  createIdempotencyKey,
  loadAiGenerationSession,
  saveAiGenerationSession,
  type AiGenerationSession,
} from '../../services/ai-generation-session'
import { ApiError } from '../../services/http-client'
import { appStore } from '../../store/app-store'

type PageState = 'loading' | 'uploading' | 'submitting' | 'queued' | 'processing' | 'downloading' | 'converting' | 'failed' | 'success'
type RetryMode = 'generation' | 'query' | 'download' | 'converting'

const POLL_INTERVAL_MS = 4_000
const LONG_WAIT_MS = 60_000
const NETWORK_BACKOFF_MS = [8_000, 15_000, 30_000] as const

Page({
  data: {
    pageState: 'loading' as PageState,
    stateTitle: '正在恢复 AI 任务',
    stateDescription: '正在读取本地任务记录',
    statusMessage: '',
    sourceImagePath: '',
    sourceImageError: false,
    uploadProgress: -1,
    waitingLong: false,
    showPurchase: false,
    retryMode: 'generation' as RetryMode,
  },

  _pollTimer: null as ReturnType<typeof setTimeout> | null,
  _longWaitTimer: null as ReturnType<typeof setTimeout> | null,
  _polling: false,
  _processing: false,
  _destroyed: false,
  _hidden: false,
  _shownOnce: false,
  _resumeAfterRequest: false,
  _requestSequence: 0,
  _networkFailureCount: 0,
  _session: null as AiGenerationSession | null,
  _lastGeneration: null as AiGeneration | null,

  onShow() {
    this._hidden = false
    if (this._destroyed) return
    if (!this._shownOnce) {
      this._shownOnce = true
      void this.resumeSession()
    } else if (this._polling) {
      this._resumeAfterRequest = true
    } else if (this._processing) {
      this._resumeAfterRequest = true
    } else {
      void this.resumeSession()
    }
  },

  onHide() {
    this._hidden = true
    this._clearPollTimer()
    this._clearLongWaitTimer()
    this._requestSequence += 1
    if (this._polling || this._processing) this._resumeAfterRequest = true
  },

  onUnload() {
    this._destroyed = true
    this._hidden = true
    this._clearPollTimer()
    this._clearLongWaitTimer()
    this._requestSequence += 1
    this._resumeAfterRequest = false
  },

  async resumeSession(): Promise<void> {
    if (this._destroyed || this._hidden || this._polling || this._processing) return
    const session = this._session ?? loadAiGenerationSession()
    if (!session) {
      this._setFailure('没有找到可恢复的 AI 任务，请返回首页重新开始', 'generation')
      return
    }
    this._session = session
    this.setData({ sourceImagePath: session.sourceImagePath, sourceImageError: false })
    if (!session.jobId) {
      this._setFailure('任务尚未创建，请返回首页重试', 'generation')
      return
    }
    this._setPageStateFromSession(session)
    await this.queryAiGeneration(session.jobId)
  },

  async queryAiGeneration(jobId: string): Promise<void> {
    if (this._destroyed || this._hidden) return
    if (this._polling) {
      this._resumeAfterRequest = true
      return
    }
    this._polling = true
    const requestSequence = ++this._requestSequence
    try {
      const generation = await getAiGeneration(jobId)
      if (this._isStale(requestSequence)) return
      this._networkFailureCount = 0
      this._lastGeneration = generation
      await this._handleGeneration(generation, requestSequence)
    } catch (error) {
      if (this._isStale(requestSequence)) return
      if (error instanceof ApiError && error.code === 'NETWORK_ERROR') {
        this._networkFailureCount += 1
        this.setData({ statusMessage: '网络暂时不可用，正在稍后重试', retryMode: 'query' })
        this._schedulePoll(this._networkBackoff())
      } else {
        this._setFailure(aiGenerationErrorMessage(error), 'query')
      }
    } finally {
      this._polling = false
      if (this._resumeAfterRequest && !this._hidden && !this._destroyed && !this._processing) {
        this._resumeAfterRequest = false
        void this.queryAiGeneration(jobId)
      }
    }
  },

  async _handleGeneration(generation: AiGeneration, requestSequence: number): Promise<void> {
    if (generation.status === 'queued' || generation.status === 'processing') {
      const session = this._requireSession()
      this._session = { ...session, status: 'processing' }
      saveAiGenerationSession(this._session)
      const queued = generation.status === 'queued'
      this.setData({
        pageState: queued ? 'queued' : 'processing',
        stateTitle: queued ? '任务已排队' : 'AI 正在优化图片',
        stateDescription: queued ? '正在等待 AI 开始处理' : '请保持页面开启或稍后回来查看',
        statusMessage: '',
        showPurchase: false,
        retryMode: 'generation',
      })
      this._scheduleLongWait()
      this._schedulePoll(POLL_INTERVAL_MS)
      return
    }

    if (generation.status === 'failed' || generation.status === 'canceled') {
      this._session = { ...this._requireSession(), status: 'failed' }
      saveAiGenerationSession(this._session)
      this._setFailure(
        generation.status === 'canceled' ? '任务已结束，请重新生成' : aiGenerationErrorMessage(generation),
        'generation',
        generation.errorCode === 'QUOTA_INSUFFICIENT',
      )
      return
    }

    await this._completeGeneration(generation, requestSequence)
  },

  async _completeGeneration(generation: AiGeneration, requestSequence: number): Promise<void> {
    if (!generation.outputFile || this._processing) return
    this._processing = true
    this._clearPollTimer()
    this._clearLongWaitTimer()
    try {
      const session = this._requireSession()
      let outputImagePath = session.outputImagePath
      if (!outputImagePath || !(await isAiOutputImageAvailable(outputImagePath))) {
        if (this._isStale(requestSequence)) return
        this.setData({ pageState: 'downloading', stateTitle: '正在获取生成结果', stateDescription: '正在读取 AI 输出图片', statusMessage: '', retryMode: 'download' })
        outputImagePath = await downloadAiOutput(generation.outputFile.url)
        this._session = { ...session, outputImagePath, status: 'succeeded' }
        saveAiGenerationSession(this._session)
      }
      if (this._isStale(requestSequence)) return

      this.setData({ pageState: 'converting', stateTitle: '正在转换为拼豆图纸', stateDescription: '正在使用标准图案引擎生成网格', statusMessage: '', retryMode: 'converting' })
      const draft = await createDraft(outputImagePath, session.settings)
      if (this._destroyed || this._hidden) return
      await appStore.setCurrentDraft(draft)
      await redirectToEditor()
      clearAiGenerationSession()
    } catch (error) {
      if (this._destroyed) return
      const retryMode: RetryMode = error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.code === 'AI_OUTPUT_INVALID')
        ? 'download'
        : 'converting'
      this._setFailure(aiGenerationErrorMessage(error), retryMode)
    } finally {
      this._processing = false
      if (this._resumeAfterRequest && !this._destroyed && !this._hidden) {
        this._resumeAfterRequest = false
        void this.resumeSession()
      }
    }
  },

  async retry(): Promise<void> {
    if (this._polling || this._processing) return
    if (this.data.retryMode === 'generation') {
      await this.retryGeneration()
      return
    }
    if (this.data.retryMode === 'query') {
      const session = loadAiGenerationSession()
      if (session?.jobId) {
        this._session = session
        this._setPageStateFromSession(session)
        void this.queryAiGeneration(session.jobId)
      }
      return
    }
    if (this._lastGeneration) {
      void this._completeGeneration(this._lastGeneration, ++this._requestSequence)
    } else {
      await this.resumeSession()
    }
  },

  async retryGeneration(): Promise<void> {
    if (this._polling || this._processing) return
    const previous = loadAiGenerationSession()
    if (!previous?.inputFileId) {
      this.backHome()
      return
    }
    const session: AiGenerationSession = {
      ...previous,
      jobId: null,
      outputImagePath: '',
      idempotencyKey: previous.jobId ? createIdempotencyKey() : previous.idempotencyKey,
      status: 'creating',
    }
    this._session = session
    saveAiGenerationSession(session)
    this._clearPollTimer()
    this._clearLongWaitTimer()
    this.setData({ pageState: 'submitting', stateTitle: '正在创建 AI 任务', stateDescription: '正在提交新的生成请求', statusMessage: '', showPurchase: false, waitingLong: false, retryMode: 'generation' })
    try {
      const inputFileId = session.inputFileId
      if (!inputFileId) {
        this._setFailure('输入图片已失效，请返回首页重新上传', 'generation')
        return
      }
      const generation = await createAiGeneration({
        inputFileId,
        style: session.style,
        detailLevel: session.detailLevel,
        backgroundMode: session.backgroundMode,
        idempotencyKey: session.idempotencyKey,
      })
      this._session = { ...session, jobId: generation.id, status: generation.status === 'succeeded' ? 'succeeded' : 'processing' }
      saveAiGenerationSession(this._session)
      this._lastGeneration = generation
      await this._handleGeneration(generation, ++this._requestSequence)
    } catch (error) {
      if (this._destroyed) return
      this._setFailure(aiGenerationErrorMessage(error), 'generation', error instanceof ApiError && error.code === 'QUOTA_INSUFFICIENT')
    }
  },

  purchaseAiGeneration(): void {
    wx.navigateTo({ url: '/pages-sub/recharge/index' })
  },

  backHome(): void {
    this._clearPollTimer()
    this._clearLongWaitTimer()
    this._requestSequence += 1
    wx.switchTab({ url: '/pages/home/index' })
  },

  handleImageError(): void {
    this.setData({ sourceImageError: true })
  },

  _setPageStateFromSession(session: AiGenerationSession): void {
    if (session.status === 'uploading') this.setData({ pageState: 'uploading', stateTitle: '正在上传图片', stateDescription: '请稍候，不要关闭页面' })
    else if (session.status === 'creating') this.setData({ pageState: 'submitting', stateTitle: '正在创建 AI 任务', stateDescription: '正在提交生成请求' })
    else if (session.status === 'succeeded') this.setData({ pageState: 'converting', stateTitle: '正在转换为拼豆图纸', stateDescription: '正在使用标准图案引擎生成网格' })
    else if (session.jobId) this.setData({ pageState: 'processing', stateTitle: 'AI 正在优化图片', stateDescription: '请保持页面开启或稍后回来查看' })
  },

  _setFailure(message: string, retryMode: RetryMode, showPurchase = false): void {
    this._clearPollTimer()
    this._clearLongWaitTimer()
    this.setData({ pageState: 'failed', stateTitle: retryMode === 'converting' ? '转换失败' : 'AI 生成失败', stateDescription: message, statusMessage: '', retryMode, showPurchase, waitingLong: false })
  },

  _schedulePoll(delay: number): void {
    this._clearPollTimer()
    if (this._destroyed || this._hidden || this._processing) return
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null
      const jobId = this._session?.jobId ?? loadAiGenerationSession()?.jobId
      if (jobId) void this.queryAiGeneration(jobId)
    }, delay)
  },

  _scheduleLongWait(): void {
    if (this.data.waitingLong || this._longWaitTimer !== null || this._destroyed || this._hidden) return
    this._longWaitTimer = setTimeout(() => {
      this._longWaitTimer = null
      if (!this._destroyed && !this._hidden && !this._processing) this.setData({ waitingLong: true })
    }, LONG_WAIT_MS)
  },

  _networkBackoff(): number {
    return NETWORK_BACKOFF_MS[Math.min(this._networkFailureCount - 1, NETWORK_BACKOFF_MS.length - 1)] ?? POLL_INTERVAL_MS
  },

  _isStale(requestSequence: number): boolean {
    return requestSequence !== this._requestSequence || this._destroyed || this._hidden
  },

  _requireSession(): AiGenerationSession {
    const session = this._session ?? loadAiGenerationSession()
    if (!session) throw new Error('AI 任务会话不存在')
    this._session = session
    return session
  },

  _clearPollTimer(): void {
    if (this._pollTimer !== null) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  },

  _clearLongWaitTimer(): void {
    if (this._longWaitTimer !== null) {
      clearTimeout(this._longWaitTimer)
      this._longWaitTimer = null
    }
  },
})

function redirectToEditor(): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.redirectTo({
      url: '/pages-sub/editor/index',
      success: () => resolve(),
      fail: () => reject(new ApiError('编辑器打开失败，请稍后重试', { code: 'NAVIGATION_ERROR' })),
    })
  })
}
