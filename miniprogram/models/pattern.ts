/**
 * 图纸数据模型：定义图片转图纸链路共享的核心类型与少量校验/派生工具。
 *
 * 职责：统一 GenerationMode、PatternSettings、PatternCell、PatternDraft（编辑态）、
 *       PersistedPattern（云端持久化态，去重建调色板、每格存下标）、WorkItem（列表项）、下载相关类型；
 *       提供 isGenerationMode / resolveGenerationMode 两个类型守卫。不含任何业务逻辑与 IO。
 * 调用方：生成流程、编辑器、结果页、作品列表、各 service 都引用这里的类型。
 * 关键点：透明格在 PatternCell 用 color='transparent'、colorCode='' 表示；
 *       在 PersistedPattern 里透明格存 -1，其余存 palette 下标以压缩体积。
 */

/** 生成模式：standard=标准图片转图纸；ai=AI 生成。 */
export type GenerationMode = 'standard' | 'ai'

/** 图纸尺寸与色数等设置。 */
export interface PatternSettings {
  width: number
  height: number
  colorLimit: number
  brand: string
}

/** 单个网格：color 为 hex 或 'transparent'，colorCode 为拼豆色号（透明时为空）。 */
export interface PatternCell {
  color: string
  colorCode: string
}

/** 编辑态完整草稿（内存中用），cells 为每格的颜色信息。 */
export interface PatternDraft {
  id: string
  sourceImagePath: string
  /** AI 临时草稿使用：首页完成的内容安全检查编号。 */
  contentSecurityCheckId?: string
  /** 与内容安全检查对应的已压缩输入图片路径。 */
  contentSecurityImagePath?: string
  createdAt: number
  generationMode: GenerationMode
  settings: PatternSettings
  cells: PatternCell[]
}

/** 类型守卫：判断未知值是否为合法 GenerationMode。 */
export function isGenerationMode(value: unknown): value is GenerationMode {
  return value === 'standard' || value === 'ai'
}

/**
 * 由草稿反推生成模式：已有合法 generationMode 直接用，否则按 id 前缀 'ai-pending-' 判定为 ai。
 * @param draft 至少含 id，可能带 generationMode
 */
export function resolveGenerationMode(draft: { id: string; generationMode?: unknown }): GenerationMode {
  if (isGenerationMode(draft.generationMode)) return draft.generationMode
  return draft.id.startsWith('ai-pending-') ? 'ai' : 'standard'
}

/** 持久化调色板的一项：色号 + hex。 */
export interface PersistedPaletteItem {
  code: string
  color: string
}

/** 云端持久化图纸：去重调色板 + 每格存调色板下标（透明格=-1），体积更小。 */
export interface PersistedPattern {
  schemaVersion: 1
  generationMode: GenerationMode
  width: number
  height: number
  settings: Pick<PatternSettings, 'colorLimit' | 'brand'>
  palette: PersistedPaletteItem[]
  cells: number[]
}

/**
 * 作品列表统一项（本地/云端通用），含同步状态与收藏信息。
 *
 * status 语义：
 * - draft / completed：已有真实图纸的普通作品
 * - ai_pending：AI 任务进行中的占位记录（尚无图纸，workId === aiTaskId）
 * - ai_failed：AI 任务失败的占位记录（同上，带 failureCode/failureMessage）
 */
export interface WorkItem {
  id: string
  title: string
  coverPath: string
  generationMode: GenerationMode
  updatedAt: number
  beadCount: number
  colorCount: number
  width?: number
  height?: number
  status?: WorkStatus
  /** 本地副本与云端的真实同步状态。 */
  syncStatus?: 'guest' | 'pending' | 'synced' | 'failed'
  /** pending / failed 作品归属的账号；游客作品不带该字段。 */
  ownerId?: string
  syncError?: string
  /** @deprecated 使用 syncStatus 判断，保留以兼容旧缓存。 */
  isCloud?: boolean
  createdAt?: number
  /** 云端摘要携带的收藏状态；进入 AppStore 后由 favoriteIds 统一派生。 */
  isFavorite?: boolean
  favoritedAt?: number
  /** 关联的任务 ID，非 AI 作品不带 */
  aiTaskId?: string
  /** 失败原因，卡片上直接展示 */
  failureCode?: string
  failureMessage?: string
}

/** 作品状态：ai_pending / ai_failed 是 AI 任务的占位态，其余为真实图纸态。 */
export type WorkStatus = 'draft' | 'completed' | 'ai_pending' | 'ai_failed'

/** 是否为 AI 任务的占位作品（生成中或生成失败，尚无图纸）。 */
export function isAiTaskWork(work: Pick<WorkItem, 'status'>): boolean {
  return work.status === 'ai_pending' || work.status === 'ai_failed'
}

/** 是否为未完成的作品：AI 占位态与普通草稿都算。 */
export function isWorkDraft(work: Pick<WorkItem, 'status'>): boolean {
  return work.status !== 'completed'
}

/** 下载文件类型：成品图/施工图/材料清单/色板。 */
export type DownloadFileType = 'preview' | 'chart' | 'materials' | 'palette'

/** 一条本地下载记录。 */
export interface DownloadRecord {
  id: string
  workId: string | null
  title: string
  coverPath: string
  downloadedAt: number
  fileType: DownloadFileType
  width?: number
  height?: number
  colorCount: number
}
