import type { PatternDraft } from '../../models/pattern'

export interface MaterialItem {
  color: string
  colorCode: string
  count: number
  percentage: string
}

export interface MaterialSummary {
  items: MaterialItem[]
  totalCount: number
}

export interface ResultSummary {
  title: string
  createdText: string
  beadCount: number
  colorCount: number
}

export function summarizeMaterials(draft: PatternDraft): MaterialSummary {
  const materials = new Map<string, Omit<MaterialItem, 'percentage'>>()
  draft.cells.forEach((cell) => {
    if (cell.color === 'transparent' || !cell.colorCode) return
    const key = `${cell.colorCode}-${cell.color}`
    const current = materials.get(key)
    if (current) {
      current.count += 1
      return
    }
    materials.set(key, { color: cell.color, colorCode: cell.colorCode, count: 1 })
  })
  const materialList = [...materials.values()]
  const calculatedTotal = materialList.reduce((total, item) => total + item.count, 0)
  const totalCount = Number.isFinite(calculatedTotal) && calculatedTotal > 0
    ? calculatedTotal
    : 0
  return {
    totalCount,
    items: materialList
      .sort((left, right) => right.count - left.count)
      .map((item) => ({
        ...item,
        percentage: formatPercentage(item.count, totalCount),
      })),
  }
}

export function formatPercentage(count: number, totalCount: number): string {
  if (!Number.isFinite(count) || count < 0 || !Number.isFinite(totalCount) || totalCount <= 0) {
    return '0.0%'
  }
  return `${((count / totalCount) * 100).toFixed(1)}%`
}

export function createDraftRenderKey(draft: PatternDraft): string {
  let hash = 2166136261
  draft.cells.forEach((cell) => {
    const value = `${cell.color}:${cell.colorCode};`
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
  })
  return `${draft.id}:${draft.settings.width}x${draft.settings.height}:${hash >>> 0}`
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

export function getTextColor(hex: string): string {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return '#111111'
  const red = Number.parseInt(normalized.slice(0, 2), 16)
  const green = Number.parseInt(normalized.slice(2, 4), 16)
  const blue = Number.parseInt(normalized.slice(4, 6), 16)
  return red * 0.299 + green * 0.587 + blue * 0.114 > 156 ? '#111111' : '#ffffff'
}
