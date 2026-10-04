import { ApiError, apiRequest } from './http-client'
import { requireLoggedInSession } from './session-service'
import { createIdempotencyKey } from './ai-task-store'
import { downloadAiOutput } from './ai-generation-service'
import { persistImage } from './image-service'

export type TextGenerationStatus = 'queued' | 'processing' | 'succeeded' | 'failed'

export interface TextGeneration {
  size: string
  id: string
  prompt: string
  status: TextGenerationStatus
  outputFile: { id: string; url: string; contentType: string; size: number } | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export async function createTextGeneration(prompt: string, idempotencyKey = createIdempotencyKey(), size = '1024x1024'): Promise<TextGeneration> {
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
    data: { prompt: cleanPrompt, size },
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

/** 删除一条失败文生图任务及其临时输出；服务端会校验任务归属和失败状态。 */
export async function deleteFailedTextGeneration(jobId: string): Promise<void> {
  assertJobId(jobId)
  const session = requireLoggedInSession()
  await apiRequest<unknown>({
    path: `/api/ai/text-generations/${encodeURIComponent(jobId)}`,
    method: 'DELETE',
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
    size: typeof value.size === 'string' ? value.size : '1024x1024',
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

/** 服务端提供当前生图尺寸和扣费规则，页面不自建白名单。 */
export async function fetchTextGenerationOptions(): Promise<{ sizes: string[]; defaultSize: string; cost: number }> {
  const result = await apiRequest<unknown>({ path: '/api/ai/text-generation-options' })
  if (!isRecord(result) || !Array.isArray(result.sizes) || !result.sizes.length
    || !result.sizes.every(size => typeof size === 'string' && /^\d+x\d+$/.test(size))
    || typeof result.defaultSize !== 'string' || !result.sizes.includes(result.defaultSize)
    || typeof result.cost !== 'number' || !Number.isInteger(result.cost) || result.cost < 0) throw invalidResponse()
  return { sizes: result.sizes as string[], defaultSize: result.defaultSize, cost: result.cost }
}

function assertJobId(jobId: string): void {
  if (!/^txtjob_[A-Za-z0-9_-]{20}$/u.test(jobId)) throw new ApiError('文生图任务编号无效', { code: 'INVALID_ARGUMENT' })
}

/**
 * 下载并永久化文生图产物，返回可直接渲染的本地路径。
 * 下载/写入都失败时抛错，由调用方提示「重新读取」——不会重复扣 AI 额度。
 */
export async function loadTextGenerationImage(task: TextGeneration): Promise<string> {
  if (!task.outputFile) throw new ApiError('灵感图还没有生成完成', { code: 'AI_OUTPUT_INVALID' })
  return persistImage(await downloadAiOutput(task.outputFile.url))
}

/** 文生图失败原因统一在服务层翻译，创作页与任务页共用同一套文案。 */
export function textGenerationFailureMessage(errorCode: string | null): string {
  switch (errorCode) {
    case 'AI_QUOTA_UNAVAILABLE_AT_COMPLETION':
      return '图片生成后暂时无法保存，请稍后重试。此次没有扣除 AI 额度。'
    case 'AI_PROVIDER_NOT_CONFIGURED':
    case 'AI_SERVICE_UNAVAILABLE':
      return '图片生成服务暂时不可用，请稍后再试。此次没有扣除 AI 额度。'
    case 'IMAGE_GENERATION_FAILED':
    case 'AI_TEXT_GENERATION_FAILED':
      return '这次没有生成成功，AI 额度不会扣除。可以调整描述后重试，或稍后再试。'
    default:
      return '图片暂时没有生成成功，AI 额度不会扣除。可以重新尝试或调整描述。'
  }
}

function invalidResponse(): ApiError {
  return new ApiError('服务返回了无法识别的文生图任务数据', { code: 'INVALID_RESPONSE' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
