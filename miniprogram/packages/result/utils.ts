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
    // 与 models/pattern 的 encodePatternCells 用同一口径：颜色按小写归一后去重。
    // 否则 '#FF0000' 与 '#ff0000' 在这里算两种色（材料表出现两行同样的红），
    // 落盘编码时却合并成一种（调色板只有一项）—— 同一个作品在两处给出不同的色数。
    const key = `${cell.colorCode}-${cell.color.toLowerCase()}`
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

/** 只认 #rgb / #rrggbb 里的标准 6 位十六进制写法。 */
const HEX_COLOR_PATTERN = /^[0-9a-fA-F]{6}$/u

export function getTextColor(hex: string): string {
  const normalized = hex.replace('#', '')
  // 长度够了不代表是十六进制：'gggggg' 长度也是 6，parseInt 全部得到 NaN，
  // 亮度比较恒为 false，于是**任何**脏色值都会返回白字 —— 白底上的白字等于看不见。
  // 进不了合法色值域就走深色兜底，跟其它非法输入保持一致。
  if (!HEX_COLOR_PATTERN.test(normalized)) return '#111111'
  const red = Number.parseInt(normalized.slice(0, 2), 16)
  const green = Number.parseInt(normalized.slice(2, 4), 16)
  const blue = Number.parseInt(normalized.slice(4, 6), 16)
  return red * 0.299 + green * 0.587 + blue * 0.114 > 156 ? '#111111' : '#ffffff'
}
