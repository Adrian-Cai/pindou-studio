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
  createdAt: number
  settings: PatternSettings
  cells: PatternCell[]
}

export interface PersistedPaletteItem {
  code: string
  color: string
}

export interface PersistedPattern {
  schemaVersion: 1
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
