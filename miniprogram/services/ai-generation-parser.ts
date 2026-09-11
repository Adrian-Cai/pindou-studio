import { ApiError } from './http-client'
import type { AiGeneration, AiOutputFile } from './ai-generation-service'

export function parseAiGeneration(value: unknown): AiGeneration {
  if (!isRecord(value)) throw invalidResponse()

  const id = isJobId(value.id) ? value.id : undefined
  const status = parseStatus(value.status)
  const inputFileId = asNonEmptyString(value.inputFileId)
  const outputFile = value.outputFile === undefined || value.outputFile === null
    ? null
    : parseAiOutputFile(value.outputFile)
  const provider = asNonEmptyString(value.provider)
  const model = asNonEmptyString(value.model)
  const promptVersion = asNonEmptyString(value.promptVersion)
  const style = parseStyle(value.style)
  const detailLevel = parseDetailLevel(value.detailLevel)
  const backgroundMode = parseBackgroundMode(value.backgroundMode)

  if (
    !id
    || !status
    || !inputFileId
    || outputFile === undefined
    || !provider
    || !model
    || !promptVersion
    || !style
    || !detailLevel
    || !backgroundMode
    || !isIsoTime(value.createdAt)
    || !isIsoTime(value.updatedAt)
    || !isNullableIsoTime(value.completedAt)
    || !isNullableString(value.errorCode)
    || (status === 'succeeded' && !outputFile)
  ) throw invalidResponse()

  return {
    id,
    status,
    inputFileId,
    outputFile,
    provider,
    model,
    promptVersion,
    style,
    detailLevel,
    backgroundMode,
    errorCode: value.errorCode,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  }
}

function parseAiOutputFile(value: unknown): AiOutputFile | undefined {
  if (!isRecord(value)) return undefined
  if (
    !nonEmptyString(value.id)
    || !nonEmptyString(value.url)
    || value.contentType !== 'image/png'
    || !isNonNegativeInteger(value.size)
  ) return undefined
  return {
    id: value.id,
    url: value.url.trim(),
    contentType: 'image/png',
    size: value.size,
  }
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

function isNullableString(value: unknown): value is string | null {
  return value === null || nonEmptyString(value)
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
