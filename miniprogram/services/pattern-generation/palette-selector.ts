import { MARD_COLORS } from '../../data/bead-palettes/mard'
import { oklabDistanceSquared, rgbToOklab } from './color-space'
import type { OKLab } from './color-space'
import type { RGB } from './color-utils'
import type { WeightedColorCandidate } from './median-cut'

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

export const MARD_CLASSIC_PALETTE: readonly BeadColor[] = MARD_PALETTE.filter(
  (color) => /^(?:[A-H]|M)\d+$/.test(color.code),
)

export function selectMardPalette(
  candidateColors: readonly WeightedColorCandidate[],
  colorLimit: number,
): BeadColor[] {
  const maximumColors = Math.max(1, Math.floor(colorLimit))
  const candidates = candidateColors.map((candidate) => ({
    oklab: rgbToOklab(candidate.rgb),
    weight: Math.max(0, candidate.weight),
  }))
  if (candidates.length === 0) return [findNearestMardColor({ r: 255, g: 255, b: 255 })]

  const distances = candidates.map((candidate) =>
    MARD_CLASSIC_PALETTE.map((color) =>
      oklabDistanceSquared(candidate.oklab, color.oklab),
    ),
  )
  const selected: BeadColor[] = []
  const selectedIndexes = new Set<number>()
  const nearestDistances = candidates.map(() => Number.POSITIVE_INFINITY)
  const seedCandidateIndex = candidates.reduce(
    (selectedIndex, candidate, index) =>
      candidate.weight > candidates[selectedIndex].weight ? index : selectedIndex,
    0,
  )
  const seedPaletteIndex = distances[seedCandidateIndex].reduce(
    (selectedIndex, distance, index) =>
      distance < distances[seedCandidateIndex][selectedIndex]
        ? index
        : selectedIndex,
    0,
  )
  selectedIndexes.add(seedPaletteIndex)
  selected.push(MARD_CLASSIC_PALETTE[seedPaletteIndex])
  nearestDistances.forEach((_distance, candidateIndex) => {
    nearestDistances[candidateIndex] = distances[candidateIndex][seedPaletteIndex]
  })
  let currentLoss = candidates.reduce(
    (loss, candidate, index) =>
      loss + candidate.weight * nearestDistances[index],
    0,
  )

  while (
    selected.length < maximumColors &&
    selected.length < MARD_CLASSIC_PALETTE.length
  ) {
    let bestPaletteIndex = -1
    let bestLoss = Number.POSITIVE_INFINITY

    MARD_CLASSIC_PALETTE.forEach((_color, paletteIndex) => {
      if (selectedIndexes.has(paletteIndex)) return

      let loss = 0
      candidates.forEach((candidate, candidateIndex) => {
        loss +=
          candidate.weight *
          Math.min(
            nearestDistances[candidateIndex],
            distances[candidateIndex][paletteIndex],
          )
      })
      if (loss < bestLoss) {
        bestLoss = loss
        bestPaletteIndex = paletteIndex
      }
    })

    if (bestPaletteIndex < 0 || currentLoss - bestLoss <= Number.EPSILON) break
    selectedIndexes.add(bestPaletteIndex)
    selected.push(MARD_CLASSIC_PALETTE[bestPaletteIndex])
    nearestDistances.forEach((_distance, candidateIndex) => {
      nearestDistances[candidateIndex] = Math.min(
        nearestDistances[candidateIndex],
        distances[candidateIndex][bestPaletteIndex],
      )
    })
    currentLoss = bestLoss
  }

  return selected
}

export function findNearestMardColor(color: RGB): BeadColor {
  const oklab = rgbToOklab(color)
  let nearest = MARD_CLASSIC_PALETTE[0]
  let nearestDistance = Number.POSITIVE_INFINITY

  MARD_CLASSIC_PALETTE.forEach((candidate) => {
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
