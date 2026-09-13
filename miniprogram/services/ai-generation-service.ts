import { buildAiFileUrl } from '../config/api'
import { ApiError, apiRequest, apiUploadFile } from './http-client'
import { ensureLoggedInSession } from './session-service'
import { parseAiGeneration } from './ai-generation-parser'

export type AiGenerationStatus =
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type AiGenerationStyle = 'natural' | 'cartoon' | 'minimal'
export type AiGenerationDetailLevel = 'low' | 'medium' | 'high'
export type AiGenerationBackgroundMode = 'keep' | 'simplify' | 'remove'
export type AiInputContentType = 'image/jpeg' | 'image/png' | 'image/webp'

export interface AiOutputFile {
  id: string
  url: string
  contentType: 'image/png'
  size: number
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
  provider: string
  model: string
  promptVersion: string
  style: AiGenerationStyle
  detailLevel: AiGenerationDetailLevel
  backgroundMode: AiGenerationBackgroundMode
  errorCode: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface CreateAiGenerationRequest {
  inputFileId: string
  style: AiGenerationStyle
  detailLevel: AiGenerationDetailLevel
  backgroundMode: AiGenerationBackgroundMode
  idempotencyKey: string
}

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

export function aiGenerationErrorMessage(error: unknown): string {
  const code = errorCode(error)
  switch (code) {
    case 'QUOTA_INSUFFICIENT':
    case 'USER_AI_QUOTA_EXHAUSTED':
    case 'AI_QUOTA_UNAVAILABLE_AT_COMPLETION':
      return 'AI 生成次数不足，请购买次数'
    case 'AI_SERVICE_UNAVAILABLE':
      return '当前暂时无法完成 AI 生成\n请稍后再试，本次不会消耗生成次数'
    case 'AI_PROVIDER_NOT_CONFIGURED':
    case 'AI_PROVIDER_UNAVAILABLE':
    case 'AI_PROVIDER_ERROR':
    case 'AI_GENERATION_INTERNAL_ERROR':
    case 'AI_PROVIDER_TASK_FAILED':
      return 'AI 服务暂时不可用'
    case 'AI_PROVIDER_TIMEOUT':
    case 'AI_SUBMISSION_TIMEOUT':
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
      return 'AI 生成失败，请稍后重试'
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
