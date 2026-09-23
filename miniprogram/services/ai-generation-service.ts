/**
 * AI 生成任务的接口封装：上传输入图、创建/查询任务、下载产物，以及错误码到中文提示的映射。
 *
 * 职责：封装小程序端对 /api/ai/generations 等接口的请求与响应解析；把服务端/网络错误码
 *       统一翻译成用户可读文案（aiGenerationErrorMessage）。不负责状态机与轮询（见 ai-generation-flow）、
 *       本地任务持久化（见 ai-task-store）、也不负责页面展示。
 * 调用方：ai-generation-flow（生成主流程）、content-security-service（传入 securityCheckId）、AI 生成页 packages/ai-generation。
 * 关键点：所有网络异常统一收口为 NETWORK_ERROR；错误码别名与文案集中维护在 normalizeFailureCode / aiGenerationErrorMessage，
 *       新增错误码时两处都要补充。
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
 * 这是错误码 -> 文案的唯一权威映射表，新增错误码需在此补充分支。
 */
export function aiGenerationErrorMessage(error: unknown): string {
  const failure = aiGenerationFailure(error)
  const code = failure?.code ?? errorCode(error)
  switch (code) {
    case 'QUOTA_INSUFFICIENT':
    case 'USER_AI_QUOTA_EXHAUSTED':
    case 'AI_QUOTA_UNAVAILABLE_AT_COMPLETION':
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
    case 'AI_PROVIDER_NOT_CONFIGURED':
    case 'AI_PROVIDER_UNAVAILABLE':
    case 'AI_PROVIDER_ERROR':
    case 'AI_GENERATION_INTERNAL_ERROR':
    case 'AI_PROVIDER_TASK_FAILED':
      return 'AI 服务暂时不可用'
    case 'AI_PROVIDER_TIMEOUT':
      return 'AI 处理超时，请稍后重试'
    case 'AI_INPUT_FILE_UNAVAILABLE':
      return '输入图片已失效，请重新上传'
    case 'CONTENT_SECURITY_CHECK_INVALID':
      return '图片检测结果已失效，请重新选择图片'
    case 'AI_TASK_EXPIRED':
      return '任务已过期，请重新生成'
    case 'AI_OUTPUT_INVALID':
    case 'AI_PROVIDER_OUTPUT_INVALID':
      return 'AI 返回的图片无法使用'
    case 'AI_IMAGE_DIMENSIONS_TOO_LARGE':
    case 'PAYLOAD_TOO_LARGE':
      return '图片过大，请更换图片'
    case 'RATE_LIMITED':
      return '请求过于频繁，请稍后重试'
    case 'UNSUPPORTED_IMAGE':
      return '仅支持 JPG、PNG、WEBP'
    case 'IMAGE_DECODE_ERROR':
      return '图片无法读取，请更换图片'
    case 'NETWORK_ERROR':
      return '网络连接失败，请检查网络'
    case 'UNAUTHORIZED':
    case 'TOKEN_EXPIRED':
      return '登录状态已失效，请重新登录'
    case 'INVALID_RESPONSE':
      return '服务返回数据异常'
    default:
      return failure?.message || (error instanceof Error ? error.message : 'AI 生成失败，请稍后重试')
  }
}

export function aiGenerationFailure(error: unknown): AiGenerationFailure | null {
  if (isRecord(error) && isRecord(error.failure)) {
    const failure = parseFailure(error.failure)
    if (failure) return failure
  }
  if (error instanceof ApiError && error.category && error.action && error.retryable !== null) {
    return {
      code: error.code,
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
  ) throw new ApiError('AI 任务参数无效', { code: 'INVALID_RESPONSE' })
}

function assertJobId(jobId: string): void {
  // jobId 必须以 aijob_ 前缀，且仅含字母数字与 - _，防止传入脏数据
  if (!/^aijob_[A-Za-z0-9_-]+$/u.test(jobId)) {
    throw new ApiError('AI 任务标识无效', { code: 'INVALID_RESPONSE' })
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

function asApiError(error: unknown, message: string, code: string): ApiError {
  return error instanceof ApiError ? error : new ApiError(message, { code })
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

function normalizeFailureCode(code: string): string {
  const aliases: Record<string, string> = {
    USER_AI_QUOTA_EXHAUSTED: 'USER_AI_QUOTA_EXHAUSTED',
    QUOTA_INSUFFICIENT: 'USER_AI_QUOTA_EXHAUSTED',
    AI_PROVIDER_NOT_CONFIGURED: 'AI_SERVICE_UNAVAILABLE',
    AI_SUBMISSION_UNKNOWN: 'AI_SERVICE_UNAVAILABLE',
    AI_PROVIDER_UNAVAILABLE: 'AI_SERVICE_BUSY',
    AI_PROVIDER_ERROR: 'AI_GENERATION_FAILED',
    AI_PROVIDER_TIMEOUT: 'AI_TIMEOUT',
    AI_SUBMISSION_TIMEOUT: 'AI_SERVICE_UNAVAILABLE',
    AI_TASK_EXPIRED: 'AI_TIMEOUT',
    AI_PROVIDER_OUTPUT_INVALID: 'AI_RESULT_INVALID',
    AI_PROVIDER_OUTPUT_TOO_LARGE: 'AI_RESULT_INVALID',
    AI_OUTPUT_INVALID: 'AI_RESULT_INVALID',
    AI_PROVIDER_TASK_FAILED: 'AI_GENERATION_FAILED',
    AI_GENERATION_INTERNAL_ERROR: 'AI_GENERATION_FAILED',
    AI_QUOTA_UNAVAILABLE_AT_COMPLETION: 'USER_AI_QUOTA_EXHAUSTED',
    UNSUPPORTED_IMAGE: 'INVALID_IMAGE',
    IMAGE_DECODE_ERROR: 'INVALID_IMAGE',
    CONTENT_RISKY: 'CONTENT_REJECTED',
  }
  return aliases[code] ?? code
}

function failureDefinition(code: string): Omit<AiGenerationFailure, 'code'> | null {
  const definitions: Record<string, Omit<AiGenerationFailure, 'code'>> = {
    USER_AI_QUOTA_EXHAUSTED: { message: 'AI 生成次数已用完', category: 'USER', retryable: false, action: 'VIEW_BENEFITS' },
    INVALID_IMAGE: { message: '当前图片暂不支持生成', category: 'INPUT', retryable: false, action: 'SELECT_IMAGE' },
    AI_INPUT_FILE_UNAVAILABLE: { message: '输入图片已失效，请重新选择图片', category: 'INPUT', retryable: false, action: 'SELECT_IMAGE' },
    CONTENT_REJECTED: { message: '当前图片内容不支持生成', category: 'CONTENT', retryable: false, action: 'SELECT_IMAGE' },
    AI_SERVICE_UNAVAILABLE: { message: 'AI 生成暂时不可用', category: 'PROVIDER', retryable: false, action: 'USE_STANDARD_MODE' },
    AI_SERVICE_BUSY: { message: 'AI 生成服务繁忙，请稍后重试', category: 'PROVIDER', retryable: true, action: 'RETRY' },
    AI_TIMEOUT: { message: 'AI 生成超时，请稍后重试', category: 'PROVIDER', retryable: true, action: 'RETRY' },
    AI_RESULT_INVALID: { message: 'AI 生成结果不可用，请重新生成', category: 'PROVIDER', retryable: true, action: 'RETRY' },
    AI_GENERATION_FAILED: { message: 'AI 生成失败，请稍后重试', category: 'INTERNAL', retryable: true, action: 'RETRY' },
  }
  return definitions[code] ?? null
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
