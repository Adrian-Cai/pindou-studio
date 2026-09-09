import type {
  PatternDraft,
  PersistedPattern,
  WorkItem,
} from '../models/pattern'
import { isAuthSessionExpired, loadAuthSession } from './token-storage'
import { ApiError, apiRequest, apiUploadFile } from './http-client'

export interface CloudWorkSummary {
  id: string
  title: string
  coverUrl: string
  width: number
  height: number
  beadCount: number
  colorCount: number
  brand: string
  status: 'draft' | 'completed'
  isFavorite: boolean
  createdAt: string
  updatedAt: string
}

export interface CloudWorkDetail extends CloudWorkSummary {
  pattern: PersistedPattern
}

export interface CloudFavoriteSummary extends CloudWorkSummary {
  favoritedAt: string
}

interface WorkListResponse {
  total: number
  page: number
  pageSize: number
  items: CloudWorkSummary[]
}

interface FavoriteListResponse {
  total: number
  page: number
  pageSize: number
  items: CloudFavoriteSummary[]
}

interface FavoriteUpdateResponse {
  workId: string
  isFavorite: boolean
  favoritedAt: string | null
}

export function hasCloudSession(): boolean {
  const session = loadAuthSession()
  return Boolean(session && !isAuthSessionExpired(session))
}

export async function saveNewCloudWork(
  draft: PatternDraft,
  coverPath: string,
  title = '未命名作品',
): Promise<CloudWorkSummary> {
  return persistCloudWork({ draft, coverPath, title })
}

export async function updateCloudWork(
  workId: string,
  draft: PatternDraft,
  coverPath: string,
  title: string,
): Promise<CloudWorkSummary> {
  return persistCloudWork({ workId, draft, coverPath, title })
}

export async function renameCloudWork(workId: string, title: string): Promise<CloudWorkSummary> {
  const response = await apiRequest<unknown>({
    path: `/api/works/${encodeURIComponent(workId)}`,
    method: 'PUT',
    token: requireToken(),
    data: { title },
  })
  return parseWorkSummary(response)
}

export async function fetchCloudWorks(options: {
  page?: number
  pageSize?: number
  status?: 'draft' | 'completed'
  query?: string
} = {}): Promise<WorkListResponse> {
  const query = [
    `page=${options.page ?? 1}`,
    `pageSize=${options.pageSize ?? 50}`,
    ...(options.status ? [`status=${options.status}`] : []),
    ...(options.query?.trim() ? [`query=${encodeURIComponent(options.query.trim())}`] : []),
  ].join('&')
  const response = await apiRequest<unknown>({
    path: `/api/works?${query}`,
    token: requireToken(),
  })
  return parseWorkList(response)
}

export async function fetchCloudWork(workId: string): Promise<CloudWorkDetail> {
  const response = await apiRequest<unknown>({
    path: `/api/works/${encodeURIComponent(workId)}`,
    token: requireToken(),
  })
  return parseWorkDetail(response)
}

export async function fetchCloudFavorites(options: {
  page?: number
  pageSize?: number
} = {}): Promise<FavoriteListResponse> {
  const query = [
    `page=${options.page ?? 1}`,
    `pageSize=${options.pageSize ?? 50}`,
  ].join('&')
  const response = await apiRequest<unknown>({
    path: `/api/favorites?${query}`,
    token: requireToken(),
  })
  return parseFavoriteList(response)
}

export async function setCloudFavorite(workId: string, favorite: boolean): Promise<FavoriteUpdateResponse> {
  const response = await apiRequest<unknown>({
    path: `/api/works/${encodeURIComponent(workId)}/favorite`,
    method: 'PATCH',
    token: requireToken(),
    data: { favorite },
  })
  const favoritedAt = response && isRecord(response) ? response.favoritedAt : undefined
  if (!isRecord(response)
    || response.workId !== workId
    || response.isFavorite !== favorite
    || (favorite
      ? typeof favoritedAt !== 'string' || !Number.isFinite(Date.parse(favoritedAt))
      : favoritedAt !== null)) throw invalidResponse()
  return {
    workId: response.workId,
    isFavorite: response.isFavorite,
    favoritedAt: favoritedAt as string | null,
  }
}

export async function deleteCloudWork(workId: string): Promise<void> {
  await apiRequest<unknown>({
    path: `/api/works/${encodeURIComponent(workId)}`,
    method: 'DELETE',
    token: requireToken(),
  })
}

export function cloudSummaryToWorkItem(summary: CloudWorkSummary | CloudFavoriteSummary): WorkItem {
  return {
    id: summary.id,
    title: summary.title,
    coverPath: summary.coverUrl,
    updatedAt: Date.parse(summary.updatedAt),
    createdAt: Date.parse(summary.createdAt),
    beadCount: summary.beadCount,
    colorCount: summary.colorCount,
    width: summary.width,
    height: summary.height,
    status: summary.status,
    isCloud: true,
    ...('favoritedAt' in summary ? { favoritedAt: Date.parse(summary.favoritedAt) } : {}),
  }
}

export function cloudDetailToDraft(detail: CloudWorkDetail): PatternDraft {
  const pattern = detail.pattern
  return {
    id: detail.id,
    sourceImagePath: '',
    createdAt: Date.parse(detail.createdAt),
    settings: {
      width: pattern.width,
      height: pattern.height,
      colorLimit: pattern.settings.colorLimit,
      brand: pattern.settings.brand,
    },
    cells: pattern.cells.map((paletteIndex) => {
      if (paletteIndex === -1) return { color: 'transparent', colorCode: '' }
      const paletteItem = pattern.palette[paletteIndex]
      if (!paletteItem) throw invalidResponse()
      return { color: paletteItem.color, colorCode: paletteItem.code }
    }),
  }
}

export function draftToPersistedPattern(draft: PatternDraft): PersistedPattern {
  if (draft.cells.length !== draft.settings.width * draft.settings.height) {
    throw new ApiError('当前作品网格数据不完整，请重新生成', { code: 'INVALID_PATTERN' })
  }
  const palette: PersistedPattern['palette'] = []
  const paletteIndexes = new Map<string, number>()
  const cells = draft.cells.map((cell) => {
    if (cell.color === 'transparent') return -1
    const key = `${cell.colorCode}\u0000${cell.color.toLowerCase()}`
    const existing = paletteIndexes.get(key)
    if (existing !== undefined) return existing
    const index = palette.length
    paletteIndexes.set(key, index)
    palette.push({ code: cell.colorCode || `C${String(index + 1).padStart(2, '0')}`, color: cell.color })
    return index
  })
  return {
    schemaVersion: 1,
    width: draft.settings.width,
    height: draft.settings.height,
    settings: { colorLimit: draft.settings.colorLimit, brand: draft.settings.brand },
    palette,
    cells,
  }
}

async function uploadCover(token: string, filePath: string): Promise<string> {
  const response = await apiUploadFile<unknown>({
    path: '/api/files/upload',
    filePath,
    name: 'file',
    formData: { type: 'cover' },
    token,
  })
  if (!isRecord(response) || !isRecord(response.file) || typeof response.file.id !== 'string') {
    throw invalidResponse()
  }
  return response.file.id
}

async function persistCloudWork(input: {
  readonly workId?: string
  readonly draft: PatternDraft
  readonly coverPath: string
  readonly title: string
}): Promise<CloudWorkSummary> {
  const token = requireToken()
  const coverFileId = await uploadCover(token, input.coverPath)
  const isNew = input.workId === undefined
  const response = await apiRequest<unknown>({
    path: isNew ? '/api/works' : `/api/works/${encodeURIComponent(input.workId)}`,
    method: isNew ? 'POST' : 'PUT',
    token,
    ...(isNew ? { headers: { 'Idempotency-Key': `create-${input.draft.id}` } } : {}),
    data: {
      title: input.title,
      coverFileId,
      status: 'completed',
      pattern: draftToPersistedPattern(input.draft),
    },
    timeoutMs: 30_000,
  })
  return parseWorkSummary(response)
}

function requireToken(): string {
  const session = loadAuthSession()
  if (!session || isAuthSessionExpired(session)) {
    throw new ApiError('请先登录后再同步云端作品', { statusCode: 401, code: 'UNAUTHORIZED' })
  }
  return session.token
}

function parseWorkList(value: unknown): WorkListResponse {
  if (!isRecord(value) || !isFiniteNumber(value.total) || !isFiniteNumber(value.page)
    || !isFiniteNumber(value.pageSize) || !Array.isArray(value.items)) throw invalidResponse()
  return {
    total: value.total,
    page: value.page,
    pageSize: value.pageSize,
    items: value.items.map(parseWorkSummary),
  }
}

function parseFavoriteList(value: unknown): FavoriteListResponse {
  if (!isRecord(value) || !isFiniteNumber(value.total) || !isFiniteNumber(value.page)
    || !isFiniteNumber(value.pageSize) || !Array.isArray(value.items)) throw invalidResponse()
  return {
    total: value.total,
    page: value.page,
    pageSize: value.pageSize,
    items: value.items.map((item) => {
      const summary = parseWorkSummary(item)
      if (!isRecord(item) || typeof item.favoritedAt !== 'string'
        || !Number.isFinite(Date.parse(item.favoritedAt))) throw invalidResponse()
      return { ...summary, favoritedAt: item.favoritedAt }
    }),
  }
}

function parseWorkDetail(value: unknown): CloudWorkDetail {
  const summary = parseWorkSummary(value)
  if (!isRecord(value) || !isRecord(value.pattern)) throw invalidResponse()
  const pattern = parsePersistedPattern(value.pattern)
  return { ...summary, pattern }
}

function parseWorkSummary(value: unknown): CloudWorkSummary {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.title !== 'string'
    || (value.coverUrl !== null && typeof value.coverUrl !== 'string')
    || !isFiniteNumber(value.width)
    || !isFiniteNumber(value.height)
    || !isFiniteNumber(value.beadCount)
    || !isFiniteNumber(value.colorCount)
    || typeof value.brand !== 'string'
    || (value.status !== 'draft' && value.status !== 'completed')
    || typeof value.isFavorite !== 'boolean'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.updatedAt))) throw invalidResponse()
  return {
    id: value.id,
    title: value.title,
    coverUrl: value.coverUrl ?? '',
    width: value.width,
    height: value.height,
    beadCount: value.beadCount,
    colorCount: value.colorCount,
    brand: value.brand,
    status: value.status,
    isFavorite: value.isFavorite,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function parsePersistedPattern(value: Record<string, unknown>): PersistedPattern {
  if (value.schemaVersion !== 1
    || !isFiniteNumber(value.width)
    || !isFiniteNumber(value.height)
    || !isRecord(value.settings)
    || !isFiniteNumber(value.settings.colorLimit)
    || typeof value.settings.brand !== 'string'
    || !Array.isArray(value.palette)
    || !Array.isArray(value.cells)
    || value.cells.length !== value.width * value.height) throw invalidResponse()
  const palette = value.palette.map((item) => {
    if (!isRecord(item) || typeof item.code !== 'string' || typeof item.color !== 'string') {
      throw invalidResponse()
    }
    return { code: item.code, color: item.color }
  })
  const cells = value.cells.map((cell) => {
    if (!Number.isInteger(cell) || (cell as number) < -1 || (cell as number) >= palette.length) {
      throw invalidResponse()
    }
    return cell as number
  })
  return {
    schemaVersion: 1,
    width: value.width,
    height: value.height,
    settings: { colorLimit: value.settings.colorLimit, brand: value.settings.brand },
    palette,
    cells,
  }
}

function invalidResponse(): ApiError {
  return new ApiError('服务返回了无法识别的作品数据，请稍后重试', { code: 'INVALID_RESPONSE' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
