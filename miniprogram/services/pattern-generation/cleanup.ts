import type { PatternCell } from '../../models/pattern'
import { oklabDistanceSquared } from './color-space'
import { MARD_CLASSIC_PALETTE } from './palette-selector'

const MIN_OPAQUE_NEIGHBORS = 5
const MIN_DOMINANT_NEIGHBORS = 5
const MIN_DOMINANT_RATIO = 0.75
const MAX_CENTER_SUPPORT = 1
const MAX_COLOR_DISTANCE_SQUARED = 0.05 * 0.05
const EDGE_PROTECTION_THRESHOLD = 0.02

const colorsByCode = new Map(
  MARD_CLASSIC_PALETTE.map((color) => [color.code, color]),
)

export function cleanupPatternCells(
  cells: readonly PatternCell[],
  width: number,
  height: number,
  edgeStrengths?: ArrayLike<number>,
): PatternCell[] {
  const cleaned = cells.map((cell) => ({ ...cell }))
  if (width <= 0 || height <= 0 || cells.length !== width * height) {
    return cleaned
  }

  cells.forEach((cell, index) => {
    if (!cell.colorCode) return
    if (isEdgeProtected(edgeStrengths, width, height, index)) return

    const x = index % width
    const y = Math.floor(index / width)
    const neighbors = readOpaqueNeighbors(cells, width, height, x, y)
    if (neighbors.length < MIN_OPAQUE_NEIGHBORS) return

    const counts = new Map<string, number>()
    neighbors.forEach((neighbor) => {
      counts.set(neighbor.colorCode, (counts.get(neighbor.colorCode) ?? 0) + 1)
    })

    let dominantCode = ''
    let dominantCount = 0
    counts.forEach((count, colorCode) => {
      if (count > dominantCount) {
        dominantCode = colorCode
        dominantCount = count
      }
    })

    if (
      dominantCode === cell.colorCode ||
      dominantCount < MIN_DOMINANT_NEIGHBORS ||
      dominantCount / neighbors.length < MIN_DOMINANT_RATIO ||
      (counts.get(cell.colorCode) ?? 0) > MAX_CENTER_SUPPORT
    ) {
      return
    }

    const centerColor = colorsByCode.get(cell.colorCode)
    const dominantColor = colorsByCode.get(dominantCode)
    if (
      !centerColor ||
      !dominantColor ||
      oklabDistanceSquared(centerColor.oklab, dominantColor.oklab) >
        MAX_COLOR_DISTANCE_SQUARED
    ) {
      return
    }

    const replacement = neighbors.find(
      (neighbor) => neighbor.colorCode === dominantCode,
    )
    if (replacement) cleaned[index] = { ...replacement }
  })

  return cleaned
}

function isEdgeProtected(
  edgeStrengths: ArrayLike<number> | undefined,
  width: number,
  height: number,
  centerIndex: number,
): boolean {
  if (!edgeStrengths || edgeStrengths.length !== width * height) return false

  const centerX = centerIndex % width
  const centerY = Math.floor(centerIndex / width)
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const x = centerX + offsetX
      const y = centerY + offsetY
      if (x < 0 || x >= width || y < 0 || y >= height) continue
      if (edgeStrengths[y * width + x] >= EDGE_PROTECTION_THRESHOLD) return true
    }
  }
  return false
}

function readOpaqueNeighbors(
  cells: readonly PatternCell[],
  width: number,
  height: number,
  centerX: number,
  centerY: number,
): PatternCell[] {
  const neighbors: PatternCell[] = []
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue
      const x = centerX + offsetX
      const y = centerY + offsetY
      if (x < 0 || x >= width || y < 0 || y >= height) continue

      const neighbor = cells[y * width + x]
      if (neighbor.colorCode) neighbors.push(neighbor)
    }
  }
  return neighbors
}
