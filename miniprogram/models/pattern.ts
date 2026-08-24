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
}
