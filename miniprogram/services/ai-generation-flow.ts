import { createDraft, prepareImageForContentSecurity } from './image-service'
import {
  aiGenerationFailure,
  aiGenerationErrorMessage,
  createAiGeneration,
  downloadAiOutput,
  getAiGeneration,
  isAiOutputImageAvailable,
  uploadAiInput,
  type AiGeneration,
  type AiGenerationFailure,
} from './ai-generation-service'
import {
  clearAiGenerationSession,
  createIdempotencyKey,
  loadAiGenerationSession,
  saveAiGenerationSession,
  type AiGenerationSession,
} from './ai-generation-session'
import { ApiError, type PublicErrorAction } from './http-client'

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

/** 状态机向页面/后台回调的钩子：状态变化、源图就绪、草稿生成完成。 */
export interface AiGenerationFlowCallbacks {
  onStateChange: (state: AiGenerationFlowState) => void
  onSourceImage?: (sourceImagePath: string) => void
  onDraftReady: (draft: Awaited<ReturnType<typeof createDraft>>) => Promise<void>
}

/** 构造参数：回调钩子 + 是否允许切后台后继续轮询（allowBackground）。 */
export type AiGenerationFlowOptions = AiGenerationFlowCallbacks & {
  allowBackground?: boolean
}

const POLL_INTERVAL_MS = 4_000
const LONG_WAIT_MS = 60_000
const NETWORK_BACKOFF_MS = [8_000, 15_000, 30_000] as const

/**
 * AI 任务的轮询、输出下载和 Standard Pattern Engine 转换共用流程。
 * 页面只负责展示状态和承接最终草稿，避免不同入口各自维护一套状态机。
 *
 * 注意：本文件必须位于主包，app.ts 启动时会通过 ai-generation-manager 引用，
 * 放在分包内会导致主包无法 require。
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
  private callbacks: AiGenerationFlowCallbacks
  private readonly allowBackground: boolean

  constructor(options: AiGenerationFlowOptions) {
    this.callbacks = options
    this.allowBackground = Boolean(options.allowBackground)
  }

  /** 启动流程：等价触发一次 onShow，从本地会话恢复任务。 */
  start(): void {
    this.onShow()
  }

  getState(): AiGenerationFlowState {
    return { ...this.state }
  }

  /** 页面挂载时接管展示：合并回调并立即回放当前状态与源图。 */
  attachView(callbacks: Partial<AiGenerationFlowCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks }
    callbacks.onStateChange?.({ ...this.state })
    const sourceImagePath = this.session?.sourceImagePath ?? loadAiGenerationSession()?.sourceImagePath
    if (sourceImagePath) {
      callbacks.onSourceImage?.(sourceImagePath)
    }
  }

  /** 页面/后台重新可见时调用：恢复轮询或重续被中断的请求。 */
  onShow(): void {
    this.hidden = false
    if (this.destroyed || this.finished) return
    if (!this.started) {
      // 首次进入：从本地会话恢复任务
      this.started = true
      void this.resumeSession()
    } else if (this.state.pageState === 'failed' && !this.resumeAfterRequest) {
      // 已失败且非主动重试：保持失败态，不自动续跑
      return
    } else if (this.resumeAfterRequest || (!this.polling && !this.submitting && !this.processing && this.pollTimer === null)) {
      // 之前被中断（切后台）或空闲：续跑
      this.resumeAfterRequest = false
      void this.resumeSession()
    }
  }

  onHide(): void {
    if (this.allowBackground) return
    this.hidden = true
    this.clearPollTimer()
    this.clearLongWaitTimer()
    this.requestSequence += 1
    if (this.polling || this.submitting || this.processing) this.resumeAfterRequest = true
  }

  /** 彻底销毁流程（任务取消/页面卸载且无需后台续跑时调用）。 */
  destroy(): void {
    this.destroyed = true
    this.hidden = true
    this.clearPollTimer()
    this.clearLongWaitTimer()
    // 使所有在途请求回调失效
    this.requestSequence += 1
    this.resumeAfterRequest = false
  }

  /** 用户点击重试：依据当前 retryMode 选择续跑环节（重新生成/查询/下载或转换）。 */
  async retry(): Promise<void> {
    // 不可重试、或已有流程在跑、或已销毁时忽略
    if (!this.state.retryable || this.polling || this.submitting || this.processing || this.destroyed) return
    if (this.state.retryMode === 'generation') {
      // 任务尚未提交成功：从上传/提交环节重来
      await this.retryGeneration()
      return
    }
    if (this.state.retryMode === 'query') {
      // 查询阶段失败：用已有 jobId 重新轮询
      const session = loadAiGenerationSession()
      if (session?.jobId) {
        this.session = session
        this.setPageStateFromSession(session)
        void this.queryAiGeneration(session.jobId)
      }
      return
    }
    // 下载/转换阶段失败：复用上次成功的 generation 直接重跑后续
    if (this.lastGeneration) {
      void this.completeGeneration(this.lastGeneration, ++this.requestSequence)
    } else {
      await this.resumeSession()
    }
  }

  private async resumeSession(): Promise<void> {
    if (this.destroyed || (!this.allowBackground && this.hidden) || this.polling || this.submitting || this.processing || this.finished) return
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
    if ((session.status === 'uploading' && !session.inputFileId)
      || (session.status === 'creating' && session.inputFileId && !session.jobId)) {
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
    if (this.destroyed || (!this.allowBackground && this.hidden) || this.finished) return
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
      if (this.resumeAfterRequest && (this.allowBackground || !this.hidden) && !this.destroyed && !this.processing && !this.finished) {
        this.resumeAfterRequest = false
        void this.queryAiGeneration(jobId)
      }
    }
  }

  /** 根据查询结果做状态迁移：排队/处理中则继续轮询；失败/取消则报错；成功则进入下载+转换。 */
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

  /** 任务成功后的收尾：下载产物（已下载则复用）→ 标准图案引擎转换 → 回调草稿就绪。 */
  private async completeGeneration(generation: AiGeneration, requestSequence: number): Promise<void> {
    if (!generation.outputFile || this.processing) return
    this.processing = true
    this.clearPollTimer()
    this.clearLongWaitTimer()
    try {
      const session = this.requireSession()
      let outputImagePath = session.outputImagePath
      // 本地尚无产物，或已下载文件损坏：重新下载
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
      // 用输出图生成标准拼豆网格 draft（ai 模式）
      const draft = await createDraft(outputImagePath, session.settings, 'ai')
      if (this.isStale(requestSequence)) return
      await this.callbacks.onDraftReady(draft)
      clearAiGenerationSession()
      this.finished = true
    } catch (error) {
      if (this.isStale(requestSequence)) return
      // 网络/产物损坏走下载重试；其余（转换失败等）走转换重试
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

  /** 从上传/提交环节重跑整个生成：复用已上传文件则跳过上传，新任务换用新幂等键。 */
  private async retryGeneration(): Promise<void> {
    const previous = loadAiGenerationSession()
    if (!previous) {
      this.setFailure('输入图片已失效，请返回首页重新上传', 'generation', null)
      return
    }
    let inputFileId = previous.inputFileId
    const session: AiGenerationSession = {
      ...previous,
      inputFileId,
      jobId: null,
      outputImagePath: '',
      // 已有 jobId 说明之前提交过，重试必须用新幂等键防止服务端重复建单
      idempotencyKey: previous.jobId ? createIdempotencyKey() : previous.idempotencyKey,
      status: inputFileId ? 'creating' : 'uploading',
    }
    this.session = session
    saveAiGenerationSession(session)
    this.clearPollTimer()
    this.clearLongWaitTimer()
    this.updateState({
      pageState: inputFileId ? 'submitting' : 'uploading',
      stateTitle: inputFileId ? '正在创建 AI 任务' : '正在上传图片',
      stateDescription: inputFileId ? '正在提交新的生成请求' : '正在准备 AI 输入图片',
      statusMessage: '',
      showPurchase: false,
      waitingLong: false,
      retryMode: 'generation',
    })
    const requestSequence = ++this.requestSequence
    this.submitting = true
    try {
      if (!inputFileId) {
        // 没有已上传文件：先用内容安全处理后的图重新上传
        const inputImagePath = session.inputImagePath || await prepareImageForContentSecurity(session.sourceImagePath)
        if (this.isStale(requestSequence)) return
        const uploaded = await uploadAiInput(inputImagePath, session.securityCheckId)
        if (this.isStale(requestSequence)) return
        inputFileId = uploaded.id
        this.session = { ...session, inputFileId, status: 'creating' }
        saveAiGenerationSession(this.session)
        this.updateState({
          pageState: 'submitting',
          stateTitle: '正在创建 AI 任务',
          stateDescription: '正在提交新的生成请求',
        })
      }
      if (!inputFileId) throw new ApiError('输入图片已失效，请重新上传', { code: 'IMAGE_DECODE_ERROR' })
      const generation = await createAiGeneration({
        inputFileId,
        style: session.style,
        detailLevel: session.detailLevel,
        backgroundMode: session.backgroundMode,
        idempotencyKey: session.idempotencyKey,
      })
      if (this.isStale(requestSequence)) return
      this.session = {
        ...(this.session ?? session),
        jobId: generation.id,
        status: generation.status === 'succeeded' ? 'succeeded' : 'processing',
      }
      saveAiGenerationSession(this.session)
      this.lastGeneration = generation
      await this.handleGeneration(generation, requestSequence)
    } catch (error) {
      if (this.destroyed || (!this.allowBackground && this.hidden)) return
      this.setFailure(aiGenerationErrorMessage(error), 'generation', aiGenerationFailure(error))
    } finally {
      this.submitting = false
      if (this.resumeAfterRequest && !this.destroyed && (this.allowBackground || !this.hidden) && !this.finished) {
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

  /** 进入失败态：清零计时器，按 failure 的 action/retryable 决定展示「重试/买次数/切标准模式」。 */
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
    if (this.destroyed || (!this.allowBackground && this.hidden) || this.processing || this.finished) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      const jobId = this.session?.jobId ?? loadAiGenerationSession()?.jobId
      if (jobId) void this.queryAiGeneration(jobId)
    }, delay)
  }

  private scheduleLongWait(): void {
    if (this.state.waitingLong || this.longWaitTimer !== null || this.destroyed || (!this.allowBackground && this.hidden)) return
    this.longWaitTimer = setTimeout(() => {
      this.longWaitTimer = null
      if (!this.destroyed && (this.allowBackground || !this.hidden) && !this.processing && !this.finished) this.updateState({ waitingLong: true })
    }, LONG_WAIT_MS)
  }

  private networkBackoff(): number {
    return NETWORK_BACKOFF_MS[Math.min(this.networkFailureCount - 1, NETWORK_BACKOFF_MS.length - 1)] ?? POLL_INTERVAL_MS
  }

  private isStale(requestSequence: number): boolean {
    return requestSequence !== this.requestSequence || this.destroyed || (!this.allowBackground && this.hidden) || this.finished
  }

  /** 取得当前会话（内存优先，回退读本地）；缺失则抛错，调用方应已确保存在。 */
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
