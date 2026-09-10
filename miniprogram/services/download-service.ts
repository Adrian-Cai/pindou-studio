import type { DownloadFileType, DownloadRecord } from '../models/pattern'
import { isAuthSessionExpired, loadAuthSession } from './token-storage'
import { ApiError, apiRequest } from './http-client'

export interface QuotaResponse {
  dailyFree: number
  usedToday: number
  purchased: number
  remaining: number
  membershipType: null
  membershipExpiresAt: null
  resetsAt: string
  aiGeneration: {
    dailyFree: number
    usedToday: number
    purchased: number
    remaining: number
    resetsAt: string
  }
}

export interface CloudDownloadRecord {
  id: string
  workId: string | null
  title: string
  fileType: DownloadFileType
  consumedQuota: true
  quotaTransactionId: string
  downloadedAt: string
}

export interface DownloadListResponse {
  total: number
  page: number
  pageSize: number
  items: CloudDownloadRecord[]
}

export interface CreateDownloadResponse {
  downloadRecord: CloudDownloadRecord
  quota: Pick<QuotaResponse, 'remaining' | 'usedToday' | 'purchased'>
}

export async function fetchQuota(): Promise<QuotaResponse> {
  const response = await apiRequest<unknown>({
    path: '/api/quota/me',
    token: requireToken(),
  })
  return parseQuota(response)
}

export async function fetchDownloads(options: {
  page?: number
  pageSize?: number
  fileType?: DownloadFileType
  query?: string
} = {}): Promise<DownloadListResponse> {
  const params = [
    `page=${options.page ?? 1}`,
    `pageSize=${options.pageSize ?? 50}`,
    ...(options.fileType ? [`fileType=${options.fileType}`] : []),
    ...(options.query?.trim() ? [`query=${encodeURIComponent(options.query.trim())}`] : []),
  ].join('&')
  const response = await apiRequest<unknown>({
    path: `/api/downloads?${params}`,
    token: requireToken(),
  })
  return parseDownloadList(response)
}

export async function createDownload(
  workId: string,
  fileType: DownloadFileType,
  idempotencyKey: string,
): Promise<CreateDownloadResponse> {
  const response = await apiRequest<unknown>({
    path: '/api/downloads',
    method: 'POST',
    token: requireToken(),
    headers: { 'Idempotency-Key': idempotencyKey },
    data: { workId, fileType },
  })
  return parseCreateDownload(response)
}

export function cloudDownloadToLocalRecord(
  record: CloudDownloadRecord,
  work?: { coverPath: string; width?: number; height?: number; colorCount: number },
): DownloadRecord {
  return {
    id: record.id,
    workId: record.workId,
    title: record.title,
    coverPath: work?.coverPath ?? '',
    downloadedAt: Date.parse(record.downloadedAt),
    fileType: record.fileType,
    ...(work?.width !== undefined ? { width: work.width } : {}),
    ...(work?.height !== undefined ? { height: work.height } : {}),
    colorCount: work?.colorCount ?? 0,
  }
}

function parseQuota(value: unknown): QuotaResponse {
  const aiGeneration = isRecord(value) ? value.aiGeneration : null
  if (!isRecord(value)
    || !isFiniteNumber(value.dailyFree)
    || !isFiniteNumber(value.usedToday)
    || !isFiniteNumber(value.purchased)
    || !isFiniteNumber(value.remaining)
    || (value.membershipType !== null)
    || (value.membershipExpiresAt !== null)
    || typeof value.resetsAt !== 'string'
    || !Number.isFinite(Date.parse(value.resetsAt))
    || !isRecord(aiGeneration)
    || !isFiniteNumber(aiGeneration.dailyFree)
    || !isFiniteNumber(aiGeneration.usedToday)
    || !isFiniteNumber(aiGeneration.purchased)
    || !isFiniteNumber(aiGeneration.remaining)
    || typeof aiGeneration.resetsAt !== 'string'
    || !Number.isFinite(Date.parse(aiGeneration.resetsAt))) throw invalidResponse()
  return {
    dailyFree: value.dailyFree,
    usedToday: value.usedToday,
    purchased: value.purchased,
    remaining: value.remaining,
    membershipType: null,
    membershipExpiresAt: null,
    resetsAt: value.resetsAt,
    aiGeneration: {
      dailyFree: aiGeneration.dailyFree,
      usedToday: aiGeneration.usedToday,
      purchased: aiGeneration.purchased,
      remaining: aiGeneration.remaining,
      resetsAt: aiGeneration.resetsAt,
    },
  }
}

function parseDownloadList(value: unknown): DownloadListResponse {
  if (!isRecord(value)
    || !isFiniteNumber(value.total)
    || !isFiniteNumber(value.page)
    || !isFiniteNumber(value.pageSize)
    || !Array.isArray(value.items)) throw invalidResponse()
  return {
    total: value.total,
    page: value.page,
    pageSize: value.pageSize,
    items: value.items.map(parseDownloadRecord),
  }
}

function parseCreateDownload(value: unknown): CreateDownloadResponse {
  if (!isRecord(value) || !isRecord(value.downloadRecord) || !isRecord(value.quota)) {
    throw invalidResponse()
  }
  if (!isFiniteNumber(value.quota.remaining)
    || !isFiniteNumber(value.quota.usedToday)
    || !isFiniteNumber(value.quota.purchased)) throw invalidResponse()
  return {
    downloadRecord: parseDownloadRecord(value.downloadRecord),
    quota: {
      remaining: value.quota.remaining,
      usedToday: value.quota.usedToday,
      purchased: value.quota.purchased,
    },
  }
}

function parseDownloadRecord(value: unknown): CloudDownloadRecord {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || (value.workId !== null && typeof value.workId !== 'string')
    || typeof value.title !== 'string'
    || !isDownloadFileTypeValue(value.fileType)
    || value.consumedQuota !== true
    || typeof value.quotaTransactionId !== 'string'
    || typeof value.downloadedAt !== 'string'
    || !Number.isFinite(Date.parse(value.downloadedAt))) throw invalidResponse()
  return {
    id: value.id,
    workId: value.workId,
    title: value.title,
    fileType: value.fileType,
    consumedQuota: true,
    quotaTransactionId: value.quotaTransactionId,
    downloadedAt: value.downloadedAt,
  }
}

function isDownloadFileTypeValue(value: unknown): value is DownloadFileType {
  return value === 'preview'
    || value === 'chart'
    || value === 'materials'
    || value === 'palette'
}

function requireToken(): string {
  const session = loadAuthSession()
  if (!session || isAuthSessionExpired(session)) {
    throw new ApiError('请先登录后再使用云端下载服务', { statusCode: 401, code: 'UNAUTHORIZED' })
  }
  return session.token
}

function invalidResponse(): ApiError {
  return new ApiError('服务返回了无法识别的下载数据，请稍后重试', { code: 'INVALID_RESPONSE' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
