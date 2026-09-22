/**
 * 图纸下载与配额：查询下载配额、拉取下载记录、创建下载（消耗配额）。
 *
 * 职责：封装 /api/quota、/api/downloads 接口与返回校验，并把云端下载记录转本地记录；
 *       不负责实际文件的本地落盘/分享（那在结果页下载服务里）。
 * 调用方：结果页下载、下载历史页。
 * 关键点：createDownload 带幂等键避免重复扣配额；所有解析对返回做严格字段校验。
 */
import type { DownloadFileType, DownloadRecord } from '../models/pattern'
import { isAuthSessionExpired, loadAuthSession } from './token-storage'
import { ApiError, apiRequest } from './http-client'

/** 当前用户的下载配额：每日免费额度、已用、已购、剩余，及 AI 生成的独立配额。 */
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

/** 云端一条下载记录：含作品 id、文件类型、扣费交易与下载时间。 */
export interface CloudDownloadRecord {
  id: string
  workId: string | null
  title: string
  fileType: DownloadFileType
  consumedQuota: true
  quotaTransactionId: string
  downloadedAt: string
}

/** 下载记录分页响应。 */
export interface DownloadListResponse {
  total: number
  page: number
  pageSize: number
  items: CloudDownloadRecord[]
}

/** 创建下载后返回：下载记录 + 扣减后的配额快照。 */
export interface CreateDownloadResponse {
  downloadRecord: CloudDownloadRecord
  quota: Pick<QuotaResponse, 'remaining' | 'usedToday' | 'purchased'>
}

/** 拉取当前用户的下载配额（含 AI 生成独立配额）。 */
export async function fetchQuota(): Promise<QuotaResponse> {
  const response = await apiRequest<unknown>({
    path: '/api/quota/me',
    token: requireToken(),
  })
  return parseQuota(response)
}

/**
 * 分页拉取云端下载记录，可按文件类型筛选与关键字搜索。
 * @param options.fileType 仅 'preview' | 'chart' | 'materials' | 'palette'
 */
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

/**
 * 创建一次下载（服务端据此扣减配额并返回下载记录）。
 * @param workId 作品 id
 * @param fileType 下载文件类型
 * @param idempotencyKey 幂等键，防止网络重试重复扣费
 */
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

/**
 * 把云端下载记录转成本地统一记录；封面/尺寸等作品信息可选补全。
 * @param record 云端下载记录
 * @param work 可选的作品展示信息（封面、宽高、色数）
 */
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

// 校验文件类型取值是否合法（预览图/图纸/材料清单/调色板）
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
