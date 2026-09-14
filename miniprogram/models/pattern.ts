export type GenerationMode = 'standard' | 'ai'

export interface PatternSettings {
  width: number
  height: number
  colorLimit: number
  brand: string
}

export interface PatternCell {
  color: string
  colorCode: string
}

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

export function isGenerationMode(value: unknown): value is GenerationMode {
  return value === 'standard' || value === 'ai'
}

export function resolveGenerationMode(draft: { id: string; generationMode?: unknown }): GenerationMode {
  if (isGenerationMode(draft.generationMode)) return draft.generationMode
  return draft.id.startsWith('ai-pending-') ? 'ai' : 'standard'
}

export interface PersistedPaletteItem {
  code: string
  color: string
}

export interface PersistedPattern {
  schemaVersion: 1
  generationMode: GenerationMode
  width: number
  height: number
  settings: Pick<PatternSettings, 'colorLimit' | 'brand'>
  palette: PersistedPaletteItem[]
  cells: number[]
}

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
  status?: 'draft' | 'completed'
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
}

export type DownloadFileType = 'preview' | 'chart' | 'materials' | 'palette'

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
