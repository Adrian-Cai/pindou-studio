/**
 * 调色板与「最近色匹配」：把图片量化出的候选色映射到 Mard 拼豆实体色号。
 *
 * 职责：维护 Mard 标准调色板（含 OKLab 预计算），并提供从候选色贪心挑选
 *       有限数量拼豆色（k-means++ 式选种）的能力；不负责图片采样与边缘处理。
 * 调用方：standard-generator（生成主流程）。
 * 关键点：在 OKLab 色彩空间计算距离，比 RGB 更接近人眼感知；
 *       选色用「最小总距离损失」贪心，每次加一个最能降低整体误差的色号。
 */
import { MARD_COLORS } from '../../data/bead-palettes/mard'
import { oklabDistanceSquared, rgbToOklab } from './color-space'
import type { OKLab } from './color-space'
import { pickNearest, type RGB } from './color-utils'
import type { WeightedColorCandidate } from './median-cut'

/** 一个拼豆实体色：色号 code、十六进制、RGB 与 OKLab（用于感知距离计算）。 */
export interface BeadColor {
  code: string
  hex: string
  rgb: RGB
  oklab: OKLab
}

/** 完整 Mard 调色板：在原始色号数据上补算 RGB 与 OKLab，避免重复换算。 */
export const MARD_PALETTE: readonly BeadColor[] = MARD_COLORS.map((color) => {
  const rgb = hexToRgb(color.hex)
  return { ...color, rgb, oklab: rgbToOklab(rgb) }
})

// 经典系列只保留 A~H、M 段编号的色号（标准拼豆色盘），过滤掉特殊/限定色
export const MARD_CLASSIC_PALETTE: readonly BeadColor[] = MARD_PALETTE.filter(
  (color) => /^(?:[A-H]|M)\d+$/.test(color.code),
)

/**
 * 从候选色中贪心挑选最多 colorLimit 个 Mard 拼豆色，使整体配色误差最小。
 * 采用 k-means++ 式选种：先按权重选种子，再反复加入「边际降误最大」的色号。
 * @param candidateColors 量化得到的带权重候选色
 * @param colorLimit 最多选几种拼豆色
 * @returns 选中拼豆色数组（按选入顺序排列）
 */
export function selectMardPalette(
  candidateColors: readonly WeightedColorCandidate[],
  colorLimit: number,
): BeadColor[] {
  const maximumColors = Math.max(1, Math.floor(colorLimit))
  const candidates = candidateColors.map((candidate) => ({
    oklab: rgbToOklab(candidate.rgb),
    weight: Math.max(0, candidate.weight),
  }))
  // 没有候选色（全透明图）时回退到白色拼豆
  if (candidates.length === 0) return [findNearestMardColor({ r: 255, g: 255, b: 255 })]

  const distances = candidates.map((candidate) =>
    MARD_CLASSIC_PALETTE.map((color) =>
      oklabDistanceSquared(candidate.oklab, color.oklab),
    ),
  )
  const selected: BeadColor[] = []
  const selectedIndexes = new Set<number>()
  // nearestDistances[c] = 候选 c 当前到已选色集合的最小距离平方，用于增量更新总误差
  const nearestDistances = candidates.map(() => Number.POSITIVE_INFINITY)
  // 种子候选：权重最大的候选色
  const seedCandidateIndex = candidates.reduce(
    (selectedIndex, candidate, index) =>
      candidate.weight > candidates[selectedIndex].weight ? index : selectedIndex,
    0,
  )
  // 种子色号：该候选在经典调色板中最近的颜色
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

    // 遍历未选色号，计算「加入它后」的总加权误差，挑降误最多的
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

    // 加下去误差不再明显下降就停止，避免白捡区分度极低的近似色
    if (bestPaletteIndex < 0 || currentLoss - bestLoss <= Number.EPSILON) break
    selectedIndexes.add(bestPaletteIndex)
    selected.push(MARD_CLASSIC_PALETTE[bestPaletteIndex])
    // 增量刷新：每个候选到新色集合的最小距离只可能更小
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

/**
 * 在 Mard 经典调色板中找与给定 RGB 最近的拼豆色（OKLab 距离最小）。
 * @param color 目标 RGB 颜色
 * @returns 最近的 BeadColor
 */
export function findNearestMardColor(color: RGB): BeadColor {
  const oklab = rgbToOklab(color)
  // pickNearest 对空候选抛错，不给 undefined 流出去的机会
  return pickNearest(MARD_CLASSIC_PALETTE, (candidate) => oklabDistanceSquared(oklab, candidate.oklab))
}

// 把 "#RRGGBB" 十六进制串解析成 RGB（色号数据只存 hex，绘制/距离需 RGB）
function hexToRgb(hex: string): RGB {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}
