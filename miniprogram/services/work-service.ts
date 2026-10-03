/**
 * 作品云端读写与本地/云端数据互转：把 PatternDraft 存成云端作品，或把云端作品读回草稿。
 *
 * 职责：封装所有 /api/works、/api/favorites 云端接口；负责草稿↔持久化图纸↔云端摘要
 *       三套结构之间的转换，并对返回做严格字段校验；不负责图片选图/生成/下载。
 * 调用方：我的作品页（pages/projects）、结果页与编辑器（保存/读取云端作品）。
 * 关键点：所有解析函数对服务端返回做鸭子类型校验，字段不符即抛 INVALID_RESPONSE，
 *       防止脏数据进入本地；保存新建作品带幂等键避免重复提交。
 */
import {
  decodePatternCells,
  encodePatternCells,
  isGenerationMode,
  type GenerationMode,
  type CreationSource,
  type PatternDraft,
  type PersistedPattern,
  type WorkItem,
} from '../models/pattern'
import { normalizeCoverUrl } from '../config/api'
import { isAuthSessionExpired, loadAuthSession } from './token-storage'
import { ApiError, apiRequest, apiUploadFile } from './http-client'

/** 云端作品列表项/摘要：不含完整图纸，仅用于列表展示与转本地 WorkItem。 */
export interface CloudWorkSummary {
  id: string
  title: string
  coverUrl: string
  width: number
  height: number
  beadCount: number
  colorCount: number
  brand: string
  generationMode: GenerationMode
  creationSource: CreationSource
  status: 'draft' | 'completed'
  isFavorite: boolean
  createdAt: string
  updatedAt: string
}

/** 云端作品详情：在摘要基础上附带完整 PersistedPattern 图纸数据。 */
export interface CloudWorkDetail extends CloudWorkSummary {
  pattern: PersistedPattern
  sourcePrompt: string | null
}

/** 云端收藏项：在作品摘要基础上附带收藏时间。 */
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

/** 仅把未过期的本地会话视为可用；真正的身份与作品归属仍由服务端校验。 */
export function hasCloudSession(): boolean {
  const session = loadAuthSession()
  return Boolean(session && !isAuthSessionExpired(session))
}

/**
 * 新建并保存一个云端作品（草稿 + 封面图）。
 * @param draft 要保存的图纸草稿
 * @param coverPath 封面图本地路径（先上传取 fileId）
 * @param title 作品标题，缺省「未命名作品」
 */
export async function saveNewCloudWork(
  draft: PatternDraft,
  coverPath: string,
  title = '未命名作品',
): Promise<CloudWorkSummary> {
  return persistCloudWork({ draft, coverPath, title })
}

/**
 * 覆盖更新已存在的云端作品。
 * @param workId 目标作品 id
 * @param draft 新图纸草稿
 * @param coverPath 新封面图本地路径
 * @param title 新标题
 */
export async function updateCloudWork(
  workId: string,
  draft: PatternDraft,
  coverPath: string,
  title: string,
): Promise<CloudWorkSummary> {
  return persistCloudWork({ workId, draft, coverPath, title })
}

/** 仅修改云端作品标题，不上传图纸。 */
export async function renameCloudWork(workId: string, title: string): Promise<CloudWorkSummary> {
  const response = await apiRequest<unknown>({
    path: `/api/works/${encodeURIComponent(workId)}`,
    method: 'PUT',
    token: requireToken(),
    data: { title },
  })
  return parseWorkSummary(response)
}

/**
 * 分页拉取云端作品列表，支持按状态筛选与关键字搜索。
 * @param options.page 页码（默认 1）；pageSize 默认 50
 * @param options.status 仅取 'draft' 或 'completed'
 * @param options.query 标题/关键字搜索串
 */
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

/** 按 id 拉取云端作品完整详情（含图纸数据）。 */
export async function fetchCloudWork(workId: string): Promise<CloudWorkDetail> {
  const response = await apiRequest<unknown>({
    path: `/api/works/${encodeURIComponent(workId)}`,
    token: requireToken(),
  })
  return parseWorkDetail(response)
}

/**
 * 分页拉取云端收藏列表。
 * @param options.page 页码（默认 1）；pageSize 默认 50
 */
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

/**
 * 客户端只提交目标收藏状态，不自行维护收藏时间；服务端负责软删除或恢复收藏关系。
 * 返回值会被严格校验，避免接口异常时页面误显示为已收藏。
 */
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

/** 删除云端作品（软/硬删由服务端决定）。 */
export async function deleteCloudWork(workId: string): Promise<void> {
  await apiRequest<unknown>({
    path: `/api/works/${encodeURIComponent(workId)}`,
    method: 'DELETE',
    token: requireToken(),
  })
}

/**
 * 把云端摘要转成 WorkItem：封面 URL 归一化、ISO 时间转毫秒，并保留收藏时间语义。
 * @param summary 云端作品摘要或收藏摘要
 */
export function cloudSummaryToWorkItem(summary: CloudWorkSummary | CloudFavoriteSummary): WorkItem {
  return {
    id: summary.id,
    title: summary.title,
    coverPath: normalizeCoverUrl(summary.coverUrl),
    updatedAt: Date.parse(summary.updatedAt),
    createdAt: Date.parse(summary.createdAt),
    beadCount: summary.beadCount,
    colorCount: summary.colorCount,
    generationMode: summary.generationMode,
    creationSource: summary.creationSource,
    ...(summary.creationSource === 'text' ? { sourcePrompt: undefined } : {}),
    width: summary.width,
    height: summary.height,
    status: summary.status,
    isCloud: true,
    isFavorite: summary.isFavorite,
    ...('favoritedAt' in summary ? { favoritedAt: Date.parse(summary.favoritedAt) } : {}),
  }
}

/**
 * 把云端作品详情还原为本地 PatternDraft（用于重新编辑）；封面不回写，sourceImagePath 留空。
 * @param detail 云端作品详情
 */
export function cloudDetailToDraft(detail: CloudWorkDetail): PatternDraft {
  const pattern = detail.pattern
  // 下标越界/调色板缺失意味着图纸数据损坏，按无效响应处理，不让脏数据进编辑器
  const cells = decodePatternCells(pattern)
  if (!cells) throw invalidResponse()
  return {
    id: detail.id,
    sourceImagePath: '',
    createdAt: Date.parse(detail.createdAt),
    generationMode: pattern.generationMode,
    creationSource: detail.creationSource,
    ...(detail.sourcePrompt ? { sourcePrompt: detail.sourcePrompt } : {}),
    settings: {
      width: pattern.width,
      height: pattern.height,
      colorLimit: pattern.settings.colorLimit,
      brand: pattern.settings.brand,
    },
    cells,
  }
}

/**
 * 把本地草稿转成云端持久化结构：调色板按色号与颜色值去重，cells 保存索引，透明格用 -1 表示。
 * 网格尺寸不符时拒绝保存。
 * @param draft 本地图纸草稿
 */
export function draftToPersistedPattern(draft: PatternDraft): PersistedPattern {
  if (draft.cells.length !== draft.settings.width * draft.settings.height) {
    throw new ApiError('当前作品网格数据不完整，请重新生成', { code: 'INVALID_PATTERN' })
  }
  // 与本机落盘共用 models/pattern 的编码，避免两处压缩逻辑各自演化
  const packed = encodePatternCells(draft.cells)
  return {
    schemaVersion: 1,
    generationMode: draft.generationMode,
    width: draft.settings.width,
    height: draft.settings.height,
    settings: { colorLimit: draft.settings.colorLimit, brand: draft.settings.brand },
    palette: packed.palette,
    cells: packed.cells,
  }
}

// 上传封面图，返回服务端 fileId，供创建作品时引用
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

// 新建或更新云端作品的统一入口：先上传封面，再按是否有 workId 决定 POST/PUT
async function persistCloudWork(input: {
  readonly workId?: string
  readonly draft: PatternDraft
  readonly coverPath: string
  readonly title: string
}): Promise<CloudWorkSummary> {
  const token = requireToken()
  const isNew = input.workId === undefined
  // 新建的幂等键直接由 draft.id 派生：id 为空时键退化成 'create-'，
  // 所有空 id 的新建会被服务端当成同一笔去重 —— 用户存了两份作品，云端只留下一份，
  // 而且不会有任何报错。宁可在这里明确失败，也不要悄悄少存一份。
  if (isNew && !input.draft.id) {
    throw new ApiError('作品 id 缺失，无法安全创建云端作品', { code: 'INVALID_PATTERN' })
  }
  if (input.draft.creationSource === 'text' && !input.draft.sourcePrompt?.trim()) {
    throw new ApiError('文字创作描述缺失，无法保存作品', { code: 'INVALID_PATTERN' })
  }
  // 后端作品只引用受所有权校验的文件资产 ID，因此必须先上传封面，再创建或更新作品。
  const coverFileId = await uploadCover(token, input.coverPath)
  const response = await apiRequest<unknown>({
    path: isNew ? '/api/works' : `/api/works/${encodeURIComponent(input.workId)}`,
    method: isNew ? 'POST' : 'PUT',
    token,
    // 草稿 ID 在创建重试期间保持稳定，避免弱网下重复生成云端作品。
    ...(isNew ? { headers: { 'Idempotency-Key': `create-${input.draft.id}` } } : {}),
    data: {
      title: input.title,
      coverFileId,
      status: 'completed',
      creationSource: input.draft.creationSource ?? 'image',
      sourcePrompt: input.draft.creationSource === 'text' ? input.draft.sourcePrompt : null,
      pattern: draftToPersistedPattern(input.draft),
    },
    timeoutMs: 30_000,
  })
  return parseWorkSummary(response)
}

// 取当前登录 token，未登录或过期直接抛 UNAUTHORIZED，由调用方兜底提示
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
  if (summary.generationMode !== pattern.generationMode) throw invalidResponse()
  if ((summary.creationSource === 'text' && typeof value.sourcePrompt !== 'string')
    || (summary.creationSource === 'image' && value.sourcePrompt !== null && value.sourcePrompt !== undefined)) throw invalidResponse()
  return { ...summary, pattern, sourcePrompt: typeof value.sourcePrompt === 'string' ? value.sourcePrompt : null }
}

// 解析并严格校验作品摘要字段；任何字段类型不符都抛 INVALID_RESPONSE
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
    || (value.creationSource !== undefined && value.creationSource !== 'image' && value.creationSource !== 'text')
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
    generationMode: isGenerationMode(value.generationMode) ? value.generationMode : 'standard',
    creationSource: value.creationSource === 'text' ? 'text' : 'image',
    status: value.status,
    isFavorite: value.isFavorite,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

// 解析并校验持久化图纸：校验 schemaVersion=1、网格尺寸与 cells 长度一致、下标合法
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
    // 每个格子下标必须是 -1（透明）或落在调色板范围内，否则数据损坏
    if (!Number.isInteger(cell) || (cell as number) < -1 || (cell as number) >= palette.length) {
      throw invalidResponse()
    }
    return cell as number
  })
  return {
    schemaVersion: 1,
    generationMode: isGenerationMode(value.generationMode) ? value.generationMode : 'standard',
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
