import { ApiError, apiRequest } from './http-client'
import { requireLoggedInSession } from './session-service'
import { createIdempotencyKey } from './ai-task-store'

export type TextGenerationStatus = 'queued' | 'processing' | 'succeeded' | 'failed'

export interface TextGeneration {
  id: string
  prompt: string
  status: TextGenerationStatus
  outputFile: { id: string; url: string; contentType: string; size: number } | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export async function createTextGeneration(prompt: string, idempotencyKey = createIdempotencyKey()): Promise<TextGeneration> {
  const cleanPrompt = prompt.trim().normalize('NFC')
  if (!cleanPrompt || Array.from(cleanPrompt).length > 500) {
    throw new ApiError('描述需要填写 1 到 500 个字', { code: 'INVALID_ARGUMENT' })
  }
  const session = requireLoggedInSession()
  const result = await apiRequest<unknown>({
    path: '/api/ai/text-generations',
    method: 'POST',
    token: session.token,
    headers: { 'Idempotency-Key': idempotencyKey },
    data: { prompt: cleanPrompt },
    timeoutMs: 15_000,
  })
  return parseTextGeneration(result)
}

export async function getTextGeneration(jobId: string): Promise<TextGeneration> {
  assertJobId(jobId)
  const session = requireLoggedInSession()
  return parseTextGeneration(await apiRequest<unknown>({
    path: `/api/ai/text-generations/${encodeURIComponent(jobId)}`,
    token: session.token,
    timeoutMs: 15_000,
  }))
}

export async function fetchRecoverableTextGenerations(): Promise<TextGeneration[]> {
  const session = requireLoggedInSession()
  const result = await apiRequest<unknown>({ path: '/api/ai/text-generations?active=true', token: session.token })
  if (!isRecord(result) || !Array.isArray(result.items)) throw invalidResponse()
  return result.items.map(parseTextGeneration)
}

export async function consumeTextGeneration(jobId: string): Promise<void> {
  assertJobId(jobId)
  const session = requireLoggedInSession()
  await apiRequest<unknown>({
    path: `/api/ai/text-generations/${encodeURIComponent(jobId)}/consume`,
    method: 'POST',
    token: session.token,
  })
}

function parseTextGeneration(value: unknown): TextGeneration {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.prompt !== 'string'
    || (value.status !== 'queued' && value.status !== 'processing' && value.status !== 'succeeded' && value.status !== 'failed')
    || (value.errorCode !== null && typeof value.errorCode !== 'string')
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.completedAt !== null && (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))))) {
    throw invalidResponse()
  }
  let outputFile: TextGeneration['outputFile'] = null
  if (value.outputFile !== null) {
    if (!isRecord(value.outputFile) || typeof value.outputFile.id !== 'string' || typeof value.outputFile.url !== 'string'
      || typeof value.outputFile.contentType !== 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(value.outputFile.contentType)
      || typeof value.outputFile.size !== 'number' || !Number.isFinite(value.outputFile.size)) throw invalidResponse()
    outputFile = {
      id: value.outputFile.id,
      url: value.outputFile.url,
      contentType: value.outputFile.contentType,
      size: value.outputFile.size,
    }
  }
  if (value.status === 'succeeded' && !outputFile) throw invalidResponse()
  return {
    id: value.id,
    prompt: value.prompt,
    status: value.status,
    outputFile,
    errorCode: value.errorCode as string | null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt as string | null,
  }
}

function assertJobId(jobId: string): void {
  if (!/^txtjob_[A-Za-z0-9_-]{20}$/u.test(jobId)) throw new ApiError('文生图任务编号无效', { code: 'INVALID_ARGUMENT' })
}

function invalidResponse(): ApiError {
  return new ApiError('服务返回了无法识别的文生图任务数据', { code: 'INVALID_RESPONSE' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
