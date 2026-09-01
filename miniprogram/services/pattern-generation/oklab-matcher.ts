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
  return palette[findNearestColorIndexOklab(pixel, palette)].rgb
}

export function findNearestColorIndexOklab(
  pixel: RGB,
  palette: readonly PreparedOklabColor[],
): number {
  const pixelOklab = rgbToOklab(pixel)
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
