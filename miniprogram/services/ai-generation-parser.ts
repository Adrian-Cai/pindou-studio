import { ApiError } from './http-client'
import {
  aiGenerationFailure,
  type AiGeneration,
  type AiGenerationFailure,
  type AiOutputContentType,
  type AiOutputFile,
} from './ai-generation-service'

/**
 * 将服务端单个 AI 生成任务的响应校验并解析为 AiGeneration。
 * @param value 接口原始返回（unknown）
 * @returns 校验通过的 AiGeneration
 * @throws ApiError 任意字段缺失/类型不符/状态与产物不匹配时抛 INVALID_RESPONSE
 */
export function parseAiGeneration(value: unknown): AiGeneration {
  if (!isRecord(value)) throw invalidResponse()

  const id = isJobId(value.id) ? value.id : undefined
  const generationMode = value.generationMode === undefined || value.generationMode === 'ai' ? 'ai' : undefined
  const status = parseStatus(value.status)
  const inputFileId = asNonEmptyString(value.inputFileId)
  const outputFile = value.outputFile === undefined || value.outputFile === null
    ? null
    : parseAiOutputFile(value.outputFile)
  const style = parseStyle(value.style)
  const detailLevel = parseDetailLevel(value.detailLevel)
  const backgroundMode = parseBackgroundMode(value.backgroundMode)
  let failure: AiGenerationFailure | null | undefined
  if (value.failure === undefined) {
    // 未显式给 failure：尝试从 errorCode 反查（兼容旧接口）
    failure = typeof value.errorCode === 'string' ? aiGenerationFailure(value) : null
  } else if (value.failure === null) {
    failure = null
  } else if (isRecord(value.failure)) {
    failure = parseFailure(value.failure)
  }

  // 终态一致性校验：成功必须有产物；失败/取消必须有 failure；进行中则不得带 failure
  if (
    !id
    || !generationMode
    || !status
    || !inputFileId
    || outputFile === undefined
    || !style
    || !detailLevel
    || !backgroundMode
    || !isIsoTime(value.createdAt)
    || !isIsoTime(value.updatedAt)
    || !isNullableIsoTime(value.completedAt)
    || (status === 'succeeded' && !outputFile)
    || failure === undefined
    || ((status === 'failed' || status === 'canceled') && !failure)
    || (status !== 'failed' && status !== 'canceled' && failure !== null)
  ) throw invalidResponse()

  return {
    id,
    generationMode,
    status,
    inputFileId,
    outputFile,
    style,
    detailLevel,
    backgroundMode,
    failure,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  }
}

function parseFailure(value: Record<string, unknown>): AiGenerationFailure | undefined {
  if (
    !nonEmptyString(value.code)
    || !nonEmptyString(value.message)
    || !isCategory(value.category)
    || typeof value.retryable !== 'boolean'
    || !isAction(value.action)
  ) return undefined
  return {
    code: value.code.trim(),
    message: value.message.trim(),
    category: value.category,
    retryable: value.retryable,
    action: value.action,
  }
}

function parseAiOutputFile(value: unknown): AiOutputFile | undefined {
  if (!isRecord(value)) return undefined
  if (
    !nonEmptyString(value.id)
    || !nonEmptyString(value.url)
    || !isAiOutputContentType(value.contentType)
    || !isNonNegativeInteger(value.size)
  ) return undefined
  return {
    id: value.id,
    url: value.url.trim(),
    contentType: value.contentType,
    size: value.size,
  }
}

function isAiOutputContentType(value: unknown): value is AiOutputContentType {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp'
}

function parseStatus(value: unknown): AiGeneration['status'] | undefined {
  return value === 'queued'
    || value === 'processing'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'canceled'
    ? value
    : undefined
}

function parseStyle(value: unknown): AiGeneration['style'] | undefined {
  return value === 'natural' || value === 'cartoon' || value === 'minimal' ? value : undefined
}

function parseDetailLevel(value: unknown): AiGeneration['detailLevel'] | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined
}

function parseBackgroundMode(value: unknown): AiGeneration['backgroundMode'] | undefined {
  return value === 'keep' || value === 'simplify' || value === 'remove' ? value : undefined
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value))
}

function isNullableIsoTime(value: unknown): value is string | null {
  return value === null || isIsoTime(value)
}

function isCategory(value: unknown): value is AiGenerationFailure['category'] {
  return value === 'USER' || value === 'INPUT' || value === 'CONTENT' || value === 'PROVIDER' || value === 'INTERNAL'
}

function isAction(value: unknown): value is AiGenerationFailure['action'] {
  return value === 'VIEW_BENEFITS' || value === 'SELECT_IMAGE' || value === 'USE_STANDARD_MODE' || value === 'RETRY'
}

function isJobId(value: unknown): value is string {
  return typeof value === 'string' && /^aijob_[A-Za-z0-9_-]+$/u.test(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function asNonEmptyString(value: unknown): string | undefined {
  return nonEmptyString(value) ? value.trim() : undefined
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(): ApiError {
  return new ApiError('服务返回数据异常', { code: 'INVALID_RESPONSE' })
}
