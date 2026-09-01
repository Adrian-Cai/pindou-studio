import { MARD_COLORS } from '../../data/bead-palettes/mard'
import { oklabDistanceSquared, rgbToOklab } from './color-space'
import type { OKLab } from './color-space'
import type { RGB } from './color-utils'

export interface BeadColor {
  code: string
  hex: string
  rgb: RGB
  oklab: OKLab
}

export const MARD_PALETTE: readonly BeadColor[] = MARD_COLORS.map((color) => {
  const rgb = hexToRgb(color.hex)
  return { ...color, rgb, oklab: rgbToOklab(rgb) }
})

export function selectMardPalette(
  candidateColors: readonly RGB[],
  colorLimit: number,
): BeadColor[] {
  const selected: BeadColor[] = []
  const selectedCodes = new Set<string>()
  const maximumColors = Math.max(1, Math.floor(colorLimit))

  candidateColors.forEach((candidate) => {
    const color = findNearestMardColor(candidate)
    if (selectedCodes.has(color.code) || selected.length >= maximumColors) return
    selectedCodes.add(color.code)
    selected.push(color)
  })

  return selected
}

export function findNearestMardColor(color: RGB): BeadColor {
  const oklab = rgbToOklab(color)
  let nearest = MARD_PALETTE[0]
  let nearestDistance = Number.POSITIVE_INFINITY

  MARD_PALETTE.forEach((candidate) => {
    const distance = oklabDistanceSquared(oklab, candidate.oklab)
    if (distance < nearestDistance) {
      nearest = candidate
      nearestDistance = distance
    }
  })

  return nearest
}

function hexToRgb(hex: string): RGB {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}
