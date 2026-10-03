import { oklabDistanceSquared, rgbToOklab } from './color-space'
import type { OKLab } from './color-space'
import type { RGB } from './color-utils'

export interface PreparedOklabColor {
  rgb: RGB
  oklab: OKLab
}

export function prepareOklabPalette(
  palette: readonly RGB[],
): PreparedOklabColor[] {
  return palette.map((rgb) => ({ rgb, oklab: rgbToOklab(rgb) }))
}

export function findNearestColorOklab(
  pixel: RGB,
  palette: readonly PreparedOklabColor[],
): RGB {
  // 空调色板时 findNearestColorIndexOklab 会返回 0，palette[0] 即 undefined ——
  // 这里提前抛出，避免 undefined 一路流到绘制/材料清单才崩。
  if (palette.length === 0) throw new Error('findNearestColorOklab：调色板为空')
  return palette[findNearestColorIndexOklab(pixel, palette)].rgb
}

export function findNearestColorIndexOklab(
  pixel: RGB,
  palette: readonly PreparedOklabColor[],
): number {
  const pixelOklab = rgbToOklab(pixel)
  // 空调色板返回 0 是一个"合法但错误"的下标：调用方解引用时就崩。宁可在这里抛。
  if (palette.length === 0) throw new Error('findNearestColorIndexOklab：调色板为空')
  let nearestIndex = 0
  let nearestDistance = Number.POSITIVE_INFINITY

  palette.forEach((color, index) => {
    const distance = oklabDistanceSquared(pixelOklab, color.oklab)
    if (distance < nearestDistance) {
      nearestIndex = index
      nearestDistance = distance
    }
  })

  return nearestIndex
}
