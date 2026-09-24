/**
 * AI 生成任务的接口封装：上传输入图、创建/查询任务、下载产物，以及错误码到中文提示的映射。
 *
 * 职责：封装小程序端对 /api/ai/generations 等接口的请求与响应解析；把服务端/网络错误码
 *       统一翻译成用户可读文案（aiGenerationErrorMessage）。不负责状态机与轮询（见 ai-generation-flow）、
 *       本地任务持久化（见 ai-task-store）、也不负责页面展示。
 * 调用方：ai-generation-flow（生成主流程）、content-security-service（传入 securityCheckId）、AI 生成页 packages/ai-generation。
 * 关键点：所有网络异常统一收口为 NETWORK_ERROR；错误码先经 normalizeFailureCode 归一化，
 *       aiGenerationFailure / failureDefinition / retryActionFor 都只认归一化后的码，
 *       新增错误码在这三处 + aiGenerationErrorMessage 一并补充（文案两处必须一致）。
 */
import { buildAiFileUrl } from '../config/api'
import {
  ApiError,
  apiRequest,
  apiUploadFile,
  type PublicErrorAction,
  type PublicErrorCategory,
} from './http-client'
import { ensureLoggedInSession } from './session-service'
import { parseAiGeneration } from './ai-generation-parser'

/** AI 生成任务的生命周期状态；succeeded / failed / canceled 为终态。 */
export type AiGenerationStatus =
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'

/** 生成风格：自然 / 卡通 / 极简。 */
export type AiGenerationStyle = 'natural' | 'cartoon' | 'minimal'
/** 细节丰富程度。 */
export type AiGenerationDetailLevel = 'low' | 'medium' | 'high'
/** 背景处理方式：保留 / 简化 / 去除。 */
export type AiGenerationBackgroundMode = 'keep' | 'simplify' | 'remove'
/** 输入图片允许的内容类型。 */
export type AiInputContentType = 'image/jpeg' | 'image/png' | 'image/webp'
/** 输出图片允许的内容类型。 */
export type AiOutputContentType = 'image/jpeg' | 'image/png' | 'image/webp'

/** 服务端返回的生成结果文件（已成功的产物）。 */
export interface AiOutputFile {
  id: string
  url: string
  contentType: AiOutputContentType
  size: number
}

export interface AiGenerationFailure {
  code: string
  message: string
  category: PublicErrorCategory
  retryable: boolean
  action: PublicErrorAction
}

export interface AiInputFile {
  id: string
  type: 'ai_input'
  url: string
  contentType: AiInputContentType
  size: number
  createdAt: string
}

export interface AiGeneration {
  id: string
  generationMode: 'ai'
  status: AiGenerationStatus
  inputFileId: string
  outputFile: AiOutputFile | null
  style: AiGenerationStyle
  detailLevel: AiGenerationDetailLevel
  backgroundMode: AiGenerationBackgroundMode
  failure: AiGenerationFailure | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

/** 创建 AI 生成任务的入参；idempotencyKey 用于服务端防重复提交。 */
export interface CreateAiGenerationRequest {
  inputFileId: string
  style: AiGenerationStyle
  detailLevel: AiGenerationDetailLevel
  backgroundMode: AiGenerationBackgroundMode
  idempotencyKey: string
}

/** 创建任务时未显式传参使用的默认生成选项（风格/细节/背景）。 */
export const DEFAULT_AI_OPTIONS = {
  style: 'natural',
  detailLevel: 'medium',
  backgroundMode: 'simplify',
} as const

export { parseAiGeneration }

export async function uploadAiInput(
  filePath: string,
  securityCheckId?: string,
  onProgress?: (progress: number) => void,
): Promise<AiInputFile> {
  if (!filePath.trim()) throw new ApiError('图片路径无效', { code: 'IMAGE_DECODE_ERROR' })
  try {
    const session = await ensureLoggedInSession()
    const response = await apiUploadFile<unknown>({
      path: '/api/files/upload',
      filePath,
      name: 'file',
      formData: securityCheckId
        ? { type: 'ai_input', securityCheckId }
        : { type: 'ai_input' },
      token: session.token,
      timeoutMs: 60_000,
      onProgress,
    })
    return parseAiInputFile(response)
  } catch (error) {
    throw asApiError(error, '图片上传失败，请检查网络后重试', 'NETWORK_ERROR')
  }
}

export async function createAiGeneration(
  input: CreateAiGenerationRequest,
): Promise<AiGeneration> {
  assertCreateInput(input)
  try {
    const session = await ensureLoggedInSession()
    const response = await apiRequest<unknown>({
      path: '/api/ai/generations',
      method: 'POST',
      token: session.token,
      headers: { 'Idempotency-Key': input.idempotencyKey },
      data: {
        inputFileId: input.inputFileId,
        style: input.style,
        detailLevel: input.detailLevel,
        backgroundMode: input.backgroundMode,
      },
      timeoutMs: 15_000,
    })
    return parseAiGeneration(response)
  } catch (error) {
    throw asApiError(error, 'AI 任务创建失败，请稍后重试', 'NETWORK_ERROR')
  }
}

/**
 * 按 jobId 查询单个 AI 生成任务的最新状态（轮询调用）。
 * @param jobId 任务标识，格式必须为 aijob_ 前缀
 * @returns 最新的 AiGeneration
 * @throws ApiError jobId 非法或网络失败
 */
export async function getAiGeneration(jobId: string): Promise<AiGeneration> {
  assertJobId(jobId)
  try {
    const session = await ensureLoggedInSession()
    const response = await apiRequest<unknown>({
      path: `/api/ai/generations/${encodeURIComponent(jobId)}`,
      token: session.token,
      timeoutMs: 15_000,
    })
    return parseAiGeneration(response)
  } catch (error) {
    throw asApiError(error, 'AI 任务查询失败，请稍后重试', 'NETWORK_ERROR')
  }
}

export function downloadAiOutput(outputUrl: string): Promise<string> {
  let url: string
  try {
    url = buildAiFileUrl(outputUrl)
  } catch {
    return Promise.reject(new ApiError('AI 返回的图片无法使用', { code: 'AI_OUTPUT_INVALID' }))
  }

  return new Promise<string>((resolve, reject) => {
    wx.downloadFile({
      url,
      // 下载生成产物超时 60s
      timeout: 60_000,
      success: (response) => {
        if (response.statusCode !== 200 || !response.tempFilePath) {
          reject(new ApiError('AI 返回的图片无法使用', {
            statusCode: response.statusCode,
            code: 'AI_OUTPUT_INVALID',
          }))
          return
        }
        isAiOutputImageAvailable(response.tempFilePath).then((available) => {
          if (available) resolve(response.tempFilePath)
          else reject(new ApiError('AI 返回的图片无法使用', { code: 'AI_OUTPUT_INVALID' }))
        })
      },
      fail: (error) => {
        const rawMessage = typeof error?.errMsg === 'string' ? error.errMsg : ''
        reject(new ApiError('获取 AI 结果失败，请检查网络后重试', {
          code: 'NETWORK_ERROR',
          details: rawMessage ? { rawMessage } : {},
        }))
      },
    })
  })
}

/**
 * 校验本地图片路径是否能被微信识别为有效图片（用于判断已下载产物是否损坏）。
 * @param filePath 本地图片路径（空串直接返回 false）
 * @returns true 表示图片可读取
 */
export function isAiOutputImageAvailable(filePath: string): Promise<boolean> {
  if (!filePath.trim()) return Promise.resolve(false)
  return new Promise((resolve) => {
    wx.getImageInfo({
      src: filePath,
      success: () => resolve(true),
      fail: () => resolve(false),
    })
  })
}

/**
 * 把任意错误（ApiError 或服务端 failure）映射成给用户看的中文文案。
 *
 * 入口先把错误码过一遍 `normalizeFailureCode`，因此这里**只写归一化后的码**，
 * 原始别名（如 AI_PROVIDER_TIMEOUT / AI_OUTPUT_INVALID）不要在此列 —— 否则
 * 同一个错误会因为「走了 failure 对象」还是「走了裸 ApiError」两条路径，
 * 落到不同 case 上，用户看到两句互相矛盾的提示。
 */
export function aiGenerationErrorMessage(error: unknown): string {
  const failure = aiGenerationFailure(error)
  const rawCode = failure?.code ?? errorCode(error)
  const code = rawCode ? normalizeFailureCode(rawCode) : null
  switch (code) {
    case 'USER_AI_QUOTA_EXHAUSTED':
      return 'AI 生成次数不足，请购买次数'
    case 'AI_SERVICE_UNAVAILABLE':
      return '当前暂时无法完成 AI 生成\n请稍后再试，本次不会消耗生成次数'
    case 'AI_SERVICE_BUSY':
      return 'AI 生成服务繁忙，请稍后重试'
    case 'AI_TIMEOUT':
      return 'AI 生成超时，请稍后重试'
    case 'AI_RESULT_INVALID':
      return 'AI 生成结果不可用，请重新生成'
    case 'INVALID_IMAGE':
      return '当前图片暂不支持生成，请重新选择一张图片'
    case 'CONTENT_REJECTED':
      return '当前图片内容不支持生成，请重新选择一张图片'
    case 'AI_GENERATION_FAILED':
      return 'AI 生成失败，请稍后重试'
    case 'AI_INPUT_FILE_UNAVAILABLE':
      // 与 failureDefinition 同码的 message 保持一致（那里写「重新选择图片」）：
      // 用户侧的下一步动作是换图，不是抽象的「重新上传」。
      return '输入图片已失效，请重新选择图片'
    case 'CONTENT_SECURITY_CHECK_INVALID':
      return '图片检测结果已失效，请重新选择图片'
    case 'IMAGE_TOO_LARGE':
      return '图片过大，请更换图片'
    case 'RATE_LIMITED':
      return '请求过于频繁，请稍后重试'
    // 以下三个原始码保留独立文案：它们各自的说明对用户有不同意义，
    // 归一到通用类目会把「格式不支持」和「文件读不出来」说成同一句话。
    case 'UNSUPPORTED_IMAGE':
      return '仅支持 JPG、PNG、WEBP'
    case 'IMAGE_DECODE_ERROR':
      return '图片无法读取，请更换图片'
    case 'AI_TASK_EXPIRED':
      return '任务已过期，请重新生成'
    case 'NETWORK_ERROR':
      return '网络连接失败，请检查网络'
    case 'UNAUTHORIZED':
    case 'TOKEN_EXPIRED':
      return '登录状态已失效，请重新登录'
    case 'INVALID_RESPONSE':
      return '服务返回数据异常'
    case 'INVALID_INPUT':
      return 'AI 任务参数无效'
    default:
      return failure?.message || (error instanceof Error ? error.message : 'AI 生成失败，请稍后重试')
  }
}

export function aiGenerationFailure(error: unknown): AiGenerationFailure | null {
  if (isRecord(error) && isRecord(error.failure)) {
    const failure = parseFailure(error.failure)
    // 服务端给的码也过一遍归一化：它可能吐别名。统一后 failure.code 才只有一个取值空间，
    // 下游（重试动作判定、列表页文案）不必自己再猜这份码是不是已经规整过
    if (failure) return { ...failure, code: normalizeFailureCode(failure.code) }
  }
  // 已经是失败定义形态的裸对象：本地落库的 task.failure 就长这样，作品卡片的正文
  // （applyTaskToWorkItem 写下的 failureMessage）也是拿它去取文案。缺这一条时
  // 它对任何码都返回 null，于是列表页永远显示兜底那句「AI 生成失败，请稍后重试」，
  // 补再多 failureDefinition 也照不出来。parseFailure 要求字段齐全，
  // 不会把普通对象误认成失败。
  if (isRecord(error) && typeof error.code === 'string') {
    const failure = parseFailure(error)
    if (failure) return { ...failure, code: normalizeFailureCode(failure.code) }
  }
  // retryable 必须是真正的布尔：category/action 齐全但 retryable 缺失（undefined）时，
  // 走上面的 structured 分支会产出违反 AiGenerationFailure 契约的对象
  if (error instanceof ApiError && error.category && error.action && typeof error.retryable === 'boolean') {
    return {
      code: normalizeFailureCode(error.code),
      message: error.message,
      category: error.category,
      retryable: error.retryable,
      action: error.action,
    }
  }
  const code = errorCode(error)
  if (!code) return null
  const normalizedCode = normalizeFailureCode(code)
  const definition = failureDefinition(normalizedCode)
  return definition ? { code: normalizedCode, ...definition } : null
}

function parseAiInputFile(value: unknown): AiInputFile {
  if (!isRecord(value) || !isRecord(value.file)) throw invalidResponse()
  const file = value.file
  if (
    !nonEmptyString(file.id)
    || file.type !== 'ai_input'
    || !nonEmptyString(file.url)
    || !isAiInputContentType(file.contentType)
    || !isNonNegativeInteger(file.size)
    || !isIsoTime(file.createdAt)
  ) throw invalidResponse()
  return {
    id: file.id,
    type: 'ai_input',
    url: file.url.trim(),
    contentType: file.contentType,
    size: file.size,
    createdAt: file.createdAt,
  }
}

function assertCreateInput(input: CreateAiGenerationRequest): void {
  if (
    !nonEmptyString(input.inputFileId)
    || !nonEmptyString(input.idempotencyKey)
    || !isStyle(input.style)
    || !isDetailLevel(input.detailLevel)
    || !isBackgroundMode(input.backgroundMode)
  ) throw new ApiError('AI 任务参数无效', { code: 'INVALID_INPUT' })
}

function assertJobId(jobId: string): void {
  // jobId 必须以 aijob_ 前缀，且仅含字母数字与 - _，防止传入脏数据
  if (!/^aijob_[A-Za-z0-9_-]+$/u.test(jobId)) {
    throw new ApiError('AI 任务标识无效', { code: 'INVALID_INPUT' })
  }
}

function isStyle(value: unknown): value is AiGenerationStyle {
  return value === 'natural' || value === 'cartoon' || value === 'minimal'
}

function isDetailLevel(value: unknown): value is AiGenerationDetailLevel {
  return value === 'low' || value === 'medium' || value === 'high'
}

function isBackgroundMode(value: unknown): value is AiGenerationBackgroundMode {
  return value === 'keep' || value === 'simplify' || value === 'remove'
}

function isAiInputContentType(value: unknown): value is AiInputContentType {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp'
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value))
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function invalidResponse(): ApiError {
  return new ApiError('服务返回数据异常', { code: 'INVALID_RESPONSE' })
}

/**
 * 统一收落成 ApiError。非 ApiError 的原始信息会被塞进 details.rawMessage，
 * 否则超时之类以普通 Error 抛出的现场（堆栈外的可读性信息）到这儿就全丢了，
 * 只剩一句笼统的「网络错误」，排查时无从下手。
 */
function asApiError(error: unknown, message: string, code: string): ApiError {
  if (error instanceof ApiError) return error
  const rawMessage = error instanceof Error ? error.message : String(error)
  return new ApiError(message, { code, details: { rawMessage } })
}

function errorCode(error: unknown): string | null {
  if (error instanceof ApiError) return error.code
  if (isRecord(error) && typeof error.errorCode === 'string') return error.errorCode
  return null
}

function parseFailure(value: Record<string, unknown>): AiGenerationFailure | null {
  if (
    typeof value.code !== 'string'
    || typeof value.message !== 'string'
    || !isCategory(value.category)
    || typeof value.retryable !== 'boolean'
    || !isAction(value.action)
  ) return null
  return {
    code: value.code,
    message: value.message,
    category: value.category,
    retryable: value.retryable,
    action: value.action,
  }
}

/**
 * 把服务端/网络层的各种错误码收敛成「归一化码」—— 重试动作、失败定义、文案三处
 * 都只认这张表产出的结果，避免同一个错误在不同入口被判成不同类型。
 *
 * 注意：被映射到自身的码意味着「保留独立身份」。不要为了收拢数量把它们并到通用类目，
 * 那会让语义不同的错误共用一句文案（历史上 IMAGE_DECODE_ERROR 被并成 INVALID_IMAGE，
 * 「文件读不出来」就说成了「暂不支持」，用户一直换图也解决不了）。
 */
function normalizeFailureCode(code: string): string {
  const aliases: Record<string, string> = {
    QUOTA_INSUFFICIENT: 'USER_AI_QUOTA_EXHAUSTED',
    AI_QUOTA_UNAVAILABLE_AT_COMPLETION: 'USER_AI_QUOTA_EXHAUSTED',
    AI_PROVIDER_NOT_CONFIGURED: 'AI_SERVICE_UNAVAILABLE',
    AI_SUBMISSION_UNKNOWN: 'AI_SERVICE_UNAVAILABLE',
    AI_SUBMISSION_TIMEOUT: 'AI_SERVICE_UNAVAILABLE',
    AI_PROVIDER_UNAVAILABLE: 'AI_SERVICE_BUSY',
    AI_PROVIDER_TIMEOUT: 'AI_TIMEOUT',
    AI_PROVIDER_OUTPUT_INVALID: 'AI_RESULT_INVALID',
    AI_PROVIDER_OUTPUT_TOO_LARGE: 'AI_RESULT_INVALID',
    AI_OUTPUT_INVALID: 'AI_RESULT_INVALID',
    AI_PROVIDER_ERROR: 'AI_GENERATION_FAILED',
    AI_PROVIDER_TASK_FAILED: 'AI_GENERATION_FAILED',
    AI_GENERATION_INTERNAL_ERROR: 'AI_GENERATION_FAILED',
    AI_PROVIDER_RATE_LIMITED: 'AI_SERVICE_BUSY',
    // provider 额度（含 429）耗尽与 AI 文件存储未配置：都属于「服务端这条路走不通」，
    // 重试无用。服务端 error-contract 已登记同义映射，这里是客户端侧的第二道防线 ——
    // 服务端版本落后时内部码会原样透出，缺了这两行就会兜底成「AI 生成失败，请稍后重试」。
    AI_PROVIDER_QUOTA_EXHAUSTED: 'AI_SERVICE_UNAVAILABLE',
    AI_STORAGE_NOT_CONFIGURED: 'AI_SERVICE_UNAVAILABLE',
    CONTENT_SECURITY_NOT_CONFIGURED: 'AI_SERVICE_UNAVAILABLE',
    CONTENT_SECURITY_IDENTITY_UNAVAILABLE: 'AI_SERVICE_UNAVAILABLE',
    CONTENT_RISKY: 'CONTENT_REJECTED',
    AI_IMAGE_DIMENSIONS_TOO_LARGE: 'IMAGE_TOO_LARGE',
    PAYLOAD_TOO_LARGE: 'IMAGE_TOO_LARGE',
    // 以下三个保留原样：各自对应不同的用户可行动作
    UNSUPPORTED_IMAGE: 'UNSUPPORTED_IMAGE',
    IMAGE_DECODE_ERROR: 'IMAGE_DECODE_ERROR',
    AI_TASK_EXPIRED: 'AI_TASK_EXPIRED',
  }
  return aliases[code] ?? code
}

function failureDefinition(code: string): Omit<AiGenerationFailure, 'code'> | null {
  const definitions: Record<string, Omit<AiGenerationFailure, 'code'>> = {
    // message 必须和 aiGenerationErrorMessage 里同一码的文案一致，否则同一个失败
    // 在任务卡片（走 message）和列表页（走 aiGenerationErrorMessage）上会显示两句话
    USER_AI_QUOTA_EXHAUSTED: { message: 'AI 生成次数不足，请购买次数', category: 'USER', retryable: false, action: 'VIEW_BENEFITS' },
    INVALID_IMAGE: { message: '当前图片暂不支持生成，请重新选择一张图片', category: 'INPUT', retryable: false, action: 'SELECT_IMAGE' },
    UNSUPPORTED_IMAGE: { message: '仅支持 JPG、PNG、WEBP', category: 'INPUT', retryable: false, action: 'SELECT_IMAGE' },
    IMAGE_DECODE_ERROR: { message: '图片无法读取，请更换图片', category: 'INPUT', retryable: false, action: 'SELECT_IMAGE' },
    AI_INPUT_FILE_UNAVAILABLE: { message: '输入图片已失效，请重新选择图片', category: 'INPUT', retryable: false, action: 'SELECT_IMAGE' },
    CONTENT_REJECTED: { message: '当前图片内容不支持生成，请重新选择一张图片', category: 'CONTENT', retryable: false, action: 'SELECT_IMAGE' },
    // 这一句必须与 aiGenerationErrorMessage 里同码的 case 逐字一致：任务卡片走 message、
    // 列表页走 aiGenerationErrorMessage，两处不一致时用户会看到同一件事有两种说法
    // （历史上这里写「AI 生成暂时不可用」，switch 里写下面这句更完整的安抚文案）。
    AI_SERVICE_UNAVAILABLE: { message: '当前暂时无法完成 AI 生成\n请稍后再试，本次不会消耗生成次数', category: 'PROVIDER', retryable: false, action: 'USE_STANDARD_MODE' },
    AI_SERVICE_BUSY: { message: 'AI 生成服务繁忙，请稍后重试', category: 'PROVIDER', retryable: true, action: 'RETRY' },
    AI_TIMEOUT: { message: 'AI 生成超时，请稍后重试', category: 'PROVIDER', retryable: true, action: 'RETRY' },
    AI_TASK_EXPIRED: { message: '任务已过期，请重新生成', category: 'PROVIDER', retryable: true, action: 'RETRY' },
    AI_RESULT_INVALID: { message: 'AI 生成结果不可用，请重新生成', category: 'PROVIDER', retryable: true, action: 'RETRY' },
    AI_GENERATION_FAILED: { message: 'AI 生成失败，请稍后重试', category: 'INTERNAL', retryable: true, action: 'RETRY' },
    // 以下码原本只有 aiGenerationErrorMessage 里的文案、没有 definition，于是
    // aiGenerationFailure() 返回 null，setFailure 兜底成 AI_GENERATION_FAILED：
    // 任务卡片（走 message）显示正确原因，列表页（走落库的 failure.message）却统一显示
    // 「AI 生成失败，请稍后重试」。补登记后两条路径才对同一句话负责。
    CONTENT_SECURITY_CHECK_INVALID: { message: '图片检测结果已失效，请重新选择图片', category: 'CONTENT', retryable: false, action: 'SELECT_IMAGE' },
    IMAGE_TOO_LARGE: { message: '图片过大，请更换图片', category: 'INPUT', retryable: true, action: 'RETRY' },
    RATE_LIMITED: { message: '请求过于频繁，请稍后重试', category: 'PROVIDER', retryable: true, action: 'RETRY' },
    NETWORK_ERROR: { message: '网络连接失败，请检查网络', category: 'PROVIDER', retryable: true, action: 'RETRY' },
    INVALID_RESPONSE: { message: '服务返回数据异常', category: 'INTERNAL', retryable: true, action: 'RETRY' },
    INVALID_INPUT: { message: 'AI 任务参数无效', category: 'INPUT', retryable: false, action: 'SELECT_IMAGE' },
    UNAUTHORIZED: { message: '登录状态已失效，请重新登录', category: 'USER', retryable: false, action: 'SELECT_IMAGE' },
    TOKEN_EXPIRED: { message: '登录状态已失效，请重新登录', category: 'USER', retryable: false, action: 'SELECT_IMAGE' },
  }
  return definitions[code] ?? null
}

/**
 * 按失败码取卡片上应给的操作，**唯一事实来源**：ai-generation-manager 的按钮动作与文案
 * 都从这里取，避免「文案表 / 失败定义表 / 重试动作表」三张表各自演化。
 * @param failureCode 已归一化的失败码（见 normalizeFailureCode）。
 * @returns 未登记的码给 SELECT_IMAGE —— 未知失败不给重试，避免用户反复撞同一个不可恢复错误。
 */
export function aiFailureAction(failureCode?: string): PublicErrorAction {
  if (!failureCode) return 'SELECT_IMAGE'
  return failureDefinition(normalizeFailureCode(failureCode))?.action ?? 'SELECT_IMAGE'
}

function isCategory(value: unknown): value is PublicErrorCategory {
  return value === 'USER' || value === 'INPUT' || value === 'CONTENT' || value === 'PROVIDER' || value === 'INTERNAL'
}

function isAction(value: unknown): value is PublicErrorAction {
  return value === 'VIEW_BENEFITS' || value === 'SELECT_IMAGE' || value === 'USE_STANDARD_MODE' || value === 'RETRY'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
