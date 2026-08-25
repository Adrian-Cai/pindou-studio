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
}

export type DownloadFileType = 'preview' | 'chart' | 'materials'

export interface DownloadRecord {
  id: string
  workId: string
  title: string
  coverPath: string
  downloadedAt: number
  fileType: DownloadFileType
  width?: number
  height?: number
  colorCount: number
}

export interface PrivacyPreferences {
  localOnly: boolean
  cloudSync: boolean
  serviceNotices: boolean
  personalizedRecommendations: boolean
}
