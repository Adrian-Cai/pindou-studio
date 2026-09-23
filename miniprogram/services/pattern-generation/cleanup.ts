import type { PatternCell } from '../../models/pattern'
import { oklabDistanceSquared } from './color-space'
import { MARD_CLASSIC_PALETTE } from './palette-selector'

/**
 * 噪点清理：把图纸中孤立的「异色格」改成邻居主色，但保护边缘轮廓不被误改。
 *
 * 职责：逐格看 3x3 邻域，若中心格与绝大多数近邻颜色不同且颜色差异很小，则替换为邻居主色；
 *       边缘格（边缘强度高）一律跳过；不负责配色与缩放。
 * 调用方：standard-generator（生成主流程最后一步）。
 * 关键点：用 OKLab 距离判断两色是否「够近」，避免把真实但少见的近似色当噪点抹掉。
 */
const MIN_OPAQUE_NEIGHBORS = 5
const MIN_DOMINANT_NEIGHBORS = 5
// 主色需占邻居至少 75% 才认为中心是噪点
const MIN_DOMINANT_RATIO = 0.75
// 中心格自身颜色在邻居中出现不超过 1 次才可能被替换
// 注意计数口径：下面统计的 counts **只含 8 个邻居、不含中心格自己**，
// 而 MAX_CENTER_SUPPORT 是拿它直接比的，语义即「邻居里有几个跟中心同色」。
const MAX_CENTER_SUPPORT = 1
// OKLab 距离平方阈值，两色比这更近才允许互相替换（约 0.05 感知差以内）
const MAX_COLOR_DISTANCE_SQUARED = 0.05 * 0.05
// 边缘强度达到该值即视为轮廓，跳过清理以保护细节
const EDGE_PROTECTION_THRESHOLD = 0.02

// 色号 -> BeadColor 查表，避免每次清理都线性扫描调色板
const colorsByCode = new Map(
  MARD_CLASSIC_PALETTE.map((color) => [color.code, color]),
)

/**
 * 清理图纸中的孤立噪点色块。
 * @param cells 原始 PatternCell 数组（行优先）
 * @param width 网格宽
 * @param height 网格高
 * @param edgeStrengths 可选边缘强度数组，传入则保护轮廓
 * @returns 新的清理后数组（不修改入参）
 */
export function cleanupPatternCells(
  cells: readonly PatternCell[],
  width: number,
  height: number,
  edgeStrengths?: ArrayLike<number>,
): PatternCell[] {
  // 先深拷贝，保证不修改入参（函数式输出）
  const cleaned = cells.map((cell) => ({ ...cell }))
  // 尺寸非法时直接原样返回，避免越界
  if (width <= 0 || height <= 0 || cells.length !== width * height) {
    return cleaned
  }

  cells.forEach((cell, index) => {
    if (!cell.colorCode) return
    // 轮廓格不清理，保留细节
    if (isEdgeProtected(edgeStrengths, width, height, index)) return

    // 由一维索引反推二维坐标
    const x = index % width
    const y = Math.floor(index / width)
    const neighbors = readOpaqueNeighbors(cells, width, height, x, y)
    if (neighbors.length < MIN_OPAQUE_NEIGHBORS) return

    // 统计 3x3 邻域各色号出现次数
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

    // 中心色已是主色、或主色不够 dominant、或中心色自身还有较多支持 -> 不动
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
    // 只有当中心色与主色在感知上足够接近时才合并，避免抹掉真实但少见的近似色
    if (
      !centerColor ||
      !dominantColor ||
      oklabDistanceSquared(centerColor.oklab, dominantColor.oklab) >
        MAX_COLOR_DISTANCE_SQUARED
    ) {
      return
    }

    // 只把中心格换成主色格的颜色。PatternCell 只有 color / colorCode 两个字段、
    // 不含坐标，位置由数组下标决定 —— 所以整格覆盖是安全的，
    // 但不能因为将来给 PatternCell 加了坐标字段就继续这么写（那会把邻居的坐标套过来）。
    const replacement = neighbors.find(
      (neighbor) => neighbor.colorCode === dominantCode,
    )
    if (replacement) cleaned[index] = { color: replacement.color, colorCode: replacement.colorCode }
  })

  return cleaned
}

// 若中心格 3x3 邻域内任一格边缘强度超阈值，则视为轮廓受保护
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

// 取中心格 8 邻域内的不透明格（colorCode 非空），越界跳过
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
