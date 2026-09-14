import { createDraft } from '../../../services/image-service'
import {
  aiGenerationFailure,
  aiGenerationErrorMessage,
  createAiGeneration,
  downloadAiOutput,
  getAiGeneration,
  isAiOutputImageAvailable,
  type AiGeneration,
  type AiGenerationFailure,
} from '../../../services/ai-generation-service'
import {
  clearAiGenerationSession,
  createIdempotencyKey,
  loadAiGenerationSession,
  saveAiGenerationSession,
  type AiGenerationSession,
} from '../../../services/ai-generation-session'
import { ApiError, type PublicErrorAction } from '../../../services/http-client'

export type AiGenerationFlowPageState =
  | 'loading'
  | 'uploading'
  | 'submitting'
  | 'queued'
  | 'processing'
  | 'downloading'
  | 'converting'
  | 'failed'

export type AiGenerationFlowRetryMode = 'generation' | 'query' | 'download' | 'converting'

export interface AiGenerationFlowState {
  pageState: AiGenerationFlowPageState
  stateTitle: string
  stateDescription: string
  statusMessage: string
  waitingLong: boolean
  retryMode: AiGenerationFlowRetryMode
  showPurchase: boolean
  retryable: boolean
  action: PublicErrorAction
}

export interface AiGenerationFlowCallbacks {
  onStateChange: (state: AiGenerationFlowState) => void
  onSourceImage?: (sourceImagePath: string) => void
  onDraftReady: (draft: Awaited<ReturnType<typeof createDraft>>) => Promise<void>
}

const POLL_INTERVAL_MS = 4_000
const LONG_WAIT_MS = 60_000
const NETWORK_BACKOFF_MS = [8_000, 15_000, 30_000] as const

/**
 * AI 任务的轮询、输出下载和 Standard Pattern Engine 转换共用流程。
 * 页面只负责展示状态和承接最终草稿，避免不同入口各自维护一套状态机。
 */
export class AiGenerationFlow {
  private state: AiGenerationFlowState = {
    pageState: 'loading',
    stateTitle: '正在恢复 AI 任务',
    stateDescription: '正在读取本地任务记录',
    statusMessage: '',
    waitingLong: false,
    retryMode: 'generation',
    showPurchase: false,
    retryable: true,
    action: 'RETRY',
  }

  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private longWaitTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private submitting = false
  private processing = false
  private destroyed = false
  private hidden = false
  private started = false
  private finished = false
  private resumeAfterRequest = false
  private requestSequence = 0
  private networkFailureCount = 0
  private session: AiGenerationSession | null = null
  private lastGeneration: AiGeneration | null = null

  constructor(private readonly callbacks: AiGenerationFlowCallbacks) {}

  onShow(): void {
    this.hidden = false
    if (this.destroyed || this.finished) return
    if (!this.started) {
      this.started = true
      void this.resumeSession()
    } else if (this.state.pageState === 'failed' && !this.resumeAfterRequest) {
      return
    } else if (this.resumeAfterRequest || (!this.polling && !this.submitting && !this.processing && this.pollTimer === null)) {
      this.resumeAfterRequest = false
      void this.resumeSession()
    }
  }

  onHide(): void {
    this.hidden = true
    this.clearPollTimer()
    this.clearLongWaitTimer()
    this.requestSequence += 1
    if (this.polling || this.submitting || this.processing) this.resumeAfterRequest = true
  }

  destroy(): void {
    this.destroyed = true
    this.hidden = true
    this.clearPollTimer()
    this.clearLongWaitTimer()
    this.requestSequence += 1
    this.resumeAfterRequest = false
  }

  async retry(): Promise<void> {
    if (!this.state.retryable || this.polling || this.submitting || this.processing || this.destroyed) return
    if (this.state.retryMode === 'generation') {
      await this.retryGeneration()
      return
    }
    if (this.state.retryMode === 'query') {
      const session = loadAiGenerationSession()
      if (session?.jobId) {
        this.session = session
        this.setPageStateFromSession(session)
        void this.queryAiGeneration(session.jobId)
      }
      return
    }
    if (this.lastGeneration) {
      void this.completeGeneration(this.lastGeneration, ++this.requestSequence)
    } else {
      await this.resumeSession()
    }
  }

  private async resumeSession(): Promise<void> {
    if (this.destroyed || this.hidden || this.polling || this.submitting || this.processing || this.finished) return
    const session = this.session ?? loadAiGenerationSession()
    if (!session) {
      this.setFailure('没有找到可恢复的 AI 任务，请返回首页重新开始', 'generation', null)
      return
    }
    this.session = session
    this.callbacks.onSourceImage?.(session.sourceImagePath)
    if (session.status === 'failed') {
      this.setFailure('AI 生成失败，请重试', 'generation', null)
      return
    }
    if (session.status === 'creating' && session.inputFileId && !session.jobId) {
      await this.retryGeneration()
      return
    }
    if (!session.jobId) {
      this.setFailure('任务尚未创建，请返回首页重试', 'generation', null)
      return
    }
    this.setPageStateFromSession(session)
    await this.queryAiGeneration(session.jobId)
  }

  private async queryAiGeneration(jobId: string): Promise<void> {
    if (this.destroyed || this.hidden || this.finished) return
    if (this.polling) {
      this.resumeAfterRequest = true
      return
    }
    this.polling = true
    const requestSequence = ++this.requestSequence
    try {
      const generation = await getAiGeneration(jobId)
      if (this.isStale(requestSequence)) return
      this.networkFailureCount = 0
      this.lastGeneration = generation
      await this.handleGeneration(generation, requestSequence)
    } catch (error) {
      if (this.isStale(requestSequence)) return
      if (error instanceof ApiError && error.code === 'NETWORK_ERROR') {
        this.networkFailureCount += 1
        this.updateState({ statusMessage: '网络暂时不可用，正在稍后重试', retryMode: 'query' })
        this.schedulePoll(this.networkBackoff())
      } else {
        this.setFailure(aiGenerationErrorMessage(error), 'query', aiGenerationFailure(error))
      }
    } finally {
      this.polling = false
      if (this.resumeAfterRequest && !this.hidden && !this.destroyed && !this.processing && !this.finished) {
        this.resumeAfterRequest = false
        void this.queryAiGeneration(jobId)
      }
    }
  }

  private async handleGeneration(generation: AiGeneration, requestSequence: number): Promise<void> {
    if (generation.status === 'queued' || generation.status === 'processing') {
      const session = this.requireSession()
      this.session = { ...session, status: 'processing' }
      saveAiGenerationSession(this.session)
      const queued = generation.status === 'queued'
      this.updateState({
        pageState: queued ? 'queued' : 'processing',
        stateTitle: queued ? '任务已排队' : 'AI 正在优化图片',
        stateDescription: queued ? '正在等待 AI 开始处理' : '图片完成优化后将继续生成拼豆图',
        statusMessage: '',
        showPurchase: false,
        retryMode: 'generation',
      })
      this.scheduleLongWait()
      this.schedulePoll(POLL_INTERVAL_MS)
      return
    }

    if (generation.status === 'failed' || generation.status === 'canceled') {
      this.session = { ...this.requireSession(), status: 'failed' }
      saveAiGenerationSession(this.session)
      const failure = generation.status === 'canceled'
        ? canceledFailure()
        : generation.failure ?? aiGenerationFailure(generation)
      this.setFailure(
        generation.status === 'canceled' ? '任务已结束，请重新生成' : aiGenerationErrorMessage(generation),
        'generation',
        failure,
      )
      return
    }

    await this.completeGeneration(generation, requestSequence)
  }

  private async completeGeneration(generation: AiGeneration, requestSequence: number): Promise<void> {
    if (!generation.outputFile || this.processing) return
    this.processing = true
    this.clearPollTimer()
    this.clearLongWaitTimer()
    try {
      const session = this.requireSession()
      let outputImagePath = session.outputImagePath
      if (!outputImagePath || !(await isAiOutputImageAvailable(outputImagePath))) {
        if (this.isStale(requestSequence)) return
        this.updateState({
          pageState: 'downloading',
          stateTitle: '正在获取生成结果',
          stateDescription: '正在读取 AI 优化图片',
          statusMessage: '',
          retryMode: 'download',
        })
        outputImagePath = await downloadAiOutput(generation.outputFile.url)
        this.session = { ...session, outputImagePath, status: 'succeeded' }
        saveAiGenerationSession(this.session)
      }
      if (this.isStale(requestSequence)) return

      this.updateState({
        pageState: 'converting',
        stateTitle: '正在生成拼豆图',
        stateDescription: 'AI 优化完成，正在使用标准图案引擎生成网格',
        statusMessage: '',
        retryMode: 'converting',
      })
      const draft = await createDraft(outputImagePath, session.settings, 'ai')
      if (this.isStale(requestSequence)) return
      await this.callbacks.onDraftReady(draft)
      clearAiGenerationSession()
      this.finished = true
    } catch (error) {
      if (this.isStale(requestSequence)) return
      const retryMode: AiGenerationFlowRetryMode = error instanceof ApiError
        && (error.code === 'NETWORK_ERROR' || error.code === 'AI_OUTPUT_INVALID')
        ? 'download'
        : 'converting'
      this.setFailure(aiGenerationErrorMessage(error), retryMode, aiGenerationFailure(error))
    } finally {
      this.processing = false
      if (this.resumeAfterRequest && !this.destroyed && !this.hidden && !this.finished) {
        this.resumeAfterRequest = false
        void this.resumeSession()
      }
    }
  }

  private async retryGeneration(): Promise<void> {
    const previous = loadAiGenerationSession()
    if (!previous?.inputFileId) {
      this.setFailure('输入图片已失效，请返回首页重新上传', 'generation', null)
      return
    }
    const inputFileId = previous.inputFileId
    const session: AiGenerationSession = {
      ...previous,
      inputFileId,
      jobId: null,
      outputImagePath: '',
      idempotencyKey: previous.jobId ? createIdempotencyKey() : previous.idempotencyKey,
      status: 'creating',
    }
    this.session = session
    saveAiGenerationSession(session)
    this.clearPollTimer()
    this.clearLongWaitTimer()
    this.updateState({
      pageState: 'submitting',
      stateTitle: '正在创建 AI 任务',
      stateDescription: '正在提交新的生成请求',
      statusMessage: '',
      showPurchase: false,
      waitingLong: false,
      retryMode: 'generation',
    })
    this.submitting = true
    try {
      const generation = await createAiGeneration({
        inputFileId,
        style: session.style,
        detailLevel: session.detailLevel,
        backgroundMode: session.backgroundMode,
        idempotencyKey: session.idempotencyKey,
      })
      this.session = {
        ...session,
        jobId: generation.id,
        status: generation.status === 'succeeded' ? 'succeeded' : 'processing',
      }
      saveAiGenerationSession(this.session)
      this.lastGeneration = generation
      await this.handleGeneration(generation, ++this.requestSequence)
    } catch (error) {
      if (this.destroyed || this.hidden) return
      this.setFailure(aiGenerationErrorMessage(error), 'generation', aiGenerationFailure(error))
    } finally {
      this.submitting = false
      if (this.resumeAfterRequest && !this.destroyed && !this.hidden && !this.finished) {
        this.resumeAfterRequest = false
        void this.resumeSession()
      }
    }
  }

  private setPageStateFromSession(session: AiGenerationSession): void {
    if (session.status === 'uploading') {
      this.updateState({ pageState: 'uploading', stateTitle: '正在上传图片', stateDescription: '请稍候，不要关闭页面' })
    } else if (session.status === 'creating') {
      this.updateState({ pageState: 'submitting', stateTitle: '正在创建 AI 任务', stateDescription: '正在提交生成请求' })
    } else if (session.status === 'succeeded') {
      this.updateState({ pageState: 'converting', stateTitle: '正在生成拼豆图', stateDescription: '正在使用标准图案引擎生成网格' })
    } else if (session.jobId) {
      this.updateState({ pageState: 'processing', stateTitle: 'AI 正在优化图片', stateDescription: '图片完成优化后将继续生成拼豆图' })
    }
  }

  private setFailure(
    message: string,
    retryMode: AiGenerationFlowRetryMode,
    failure: AiGenerationFailure | null,
  ): void {
    this.clearPollTimer()
    this.clearLongWaitTimer()
    const resolvedFailure = failure ?? aiGenerationFailure({ errorCode: 'AI_GENERATION_FAILED' })!
    const action = resolvedFailure.action
    const retryable = resolvedFailure.retryable && action === 'RETRY'
    let stateTitle: string
    if (retryMode === 'converting') {
      stateTitle = '拼豆图生成失败'
    } else if (action === 'USE_STANDARD_MODE') {
      stateTitle = 'AI 生成暂时不可用'
    } else {
      stateTitle = 'AI 生成失败'
    }
    this.updateState({
      pageState: 'failed',
      stateTitle,
      stateDescription: message,
      statusMessage: '',
      retryMode,
      showPurchase: action === 'VIEW_BENEFITS',
      retryable,
      action,
      waitingLong: false,
    })
  }

  private updateState(next: Partial<AiGenerationFlowState>): void {
    this.state = { ...this.state, ...next }
    this.callbacks.onStateChange({ ...this.state })
  }

  private schedulePoll(delay: number): void {
    this.clearPollTimer()
    if (this.destroyed || this.hidden || this.processing || this.finished) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      const jobId = this.session?.jobId ?? loadAiGenerationSession()?.jobId
      if (jobId) void this.queryAiGeneration(jobId)
    }, delay)
  }

  private scheduleLongWait(): void {
    if (this.state.waitingLong || this.longWaitTimer !== null || this.destroyed || this.hidden) return
    this.longWaitTimer = setTimeout(() => {
      this.longWaitTimer = null
      if (!this.destroyed && !this.hidden && !this.processing && !this.finished) this.updateState({ waitingLong: true })
    }, LONG_WAIT_MS)
  }

  private networkBackoff(): number {
    return NETWORK_BACKOFF_MS[Math.min(this.networkFailureCount - 1, NETWORK_BACKOFF_MS.length - 1)] ?? POLL_INTERVAL_MS
  }

  private isStale(requestSequence: number): boolean {
    return requestSequence !== this.requestSequence || this.destroyed || this.hidden || this.finished
  }

  private requireSession(): AiGenerationSession {
    const session = this.session ?? loadAiGenerationSession()
    if (!session) throw new Error('AI 任务会话不存在')
    this.session = session
    return session
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  private clearLongWaitTimer(): void {
    if (this.longWaitTimer !== null) {
      clearTimeout(this.longWaitTimer)
      this.longWaitTimer = null
    }
  }
}

function canceledFailure(): AiGenerationFailure {
  return {
    code: 'AI_GENERATION_FAILED',
    message: '任务已结束，请重新生成',
    category: 'INTERNAL',
    retryable: true,
    action: 'RETRY',
  }
}
