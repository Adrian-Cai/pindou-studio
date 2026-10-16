/**
 * 编辑器绘制与坐标换算服务：把 PatternDraft 画到 2d canvas，并处理屏幕↔格子坐标、视图变换、连通域填充。
 *
 * 职责：提供 drawPatternViewport（按当前缩放/平移只画可见格，性能友好）、
 *       计算适配尺寸 calculateFittedImageSize、缩放锚点 scaleAroundViewportPoint、平移边界 clampViewTranslation、
 *       屏幕触点转格子 screenPointToGridCell、油漆桶 fillConnectedCells；不负责手势状态机（在 editor 页）。
 * 调用方：packages/editor/index.ts（编辑器页）。
 * 关键点：所有绘制用「拼豆圆点」风格（带阴影/高光）；坐标换算以 viewport 中心为原点，scale/translate 描述图片相对中心的位置。
 */
import type { GenerationMode, PatternCell, PatternDraft, PatternSettings } from '../../../models/pattern'
import { buildCoordinateTicks } from './pattern-renderer'
import type { PatternCanvasContext } from './pattern-renderer'

export type { PatternCanvasContext } from './pattern-renderer'

/** 鐭╁舰浣嶇疆涓庡昂瀵革紙CSS 鍍忕礌锛?*/
export interface CanvasRect {
  left: number
  top: number
  width: number
  height: number
}

/** 100% 鐘舵€佷笅锛屽畬鏁存嫾璞嗗浘鍦?viewport 鍐呯殑鍩虹灏哄锛圕SS 鍍忕礌锛?*/
export interface FittedImageSize {
  width: number
  height: number
  cellWidth: number
  cellHeight: number
}

/** 鎷艰眴鍥剧浉瀵?viewport 涓績鐨勮鍥惧彉鎹?*/
export interface ViewTransform {
  scale: number
  translateX: number
  translateY: number
}

/** 鏍煎瓙浣嶇疆 */
export interface GridCell {
  row: number
  column: number
  index: number
}

export interface DraftView {
  id: string
  settings: PatternSettings
  generationMode: GenerationMode
}

export interface EditPatch {
  indexes: number[]
  before: PatternCell[]
  after: PatternCell[]
}

export const EDIT_HISTORY_LIMIT = 20

export function toDraftView(draft: PatternDraft): DraftView {
  return { id: draft.id, settings: draft.settings, generationMode: draft.generationMode }
}

export function applyPatch(cells: PatternCell[], patch: EditPatch, side: 'before' | 'after'): void {
  const values = side === 'before' ? patch.before : patch.after
  patch.indexes.forEach((index, i) => { cells[index] = values[i] })
}

/** 鍦ㄥ浐瀹?viewport Canvas 鍐呮寜褰撳墠瑙嗗浘鍙樻崲缁樺埗锛屼粎閬嶅巻鍙 grid cell銆?*/
export function drawPatternViewport(
  context: PatternCanvasContext,
  canvasWidth: number,
  canvasHeight: number,
  board: CanvasRect,
  image: FittedImageSize,
  transform: ViewTransform,
  draft: PatternDraft,
): void {
  const axisWidth = board.left
  const axisHeight = board.top
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvasWidth, canvasHeight)
  context.fillStyle = '#f7f7f7'
  context.fillRect(board.left, board.top, board.width, board.height)
  const columns = draft.settings.width
  const rows = draft.settings.height
  // 缩放或格子尺寸退化到 <=0 时，下面所有除法都会产出 NaN/Infinity，
  // 进而让循环边界 Math.floor(NaN) 恒为假、整张图静默不画（不报错，最难查的那种）。
  // 与其画出一张空白图让人以为"图纸就是空的"，不如直接返回并保持上一帧。
  if (transform.scale <= 0 || image.cellWidth <= 0 || image.cellHeight <= 0) return
  const cellWidth = image.cellWidth * transform.scale
  const cellHeight = image.cellHeight * transform.scale
  // 图片以中间图纸区域为锚点；四边标尺不随画布移动。
  const imageLeft = board.left + board.width / 2 + transform.translateX - image.width * transform.scale / 2
  const imageTop = board.top + board.height / 2 + transform.translateY - image.height * transform.scale / 2
  // 只遍历落在 viewport 内的格子，避免整图重绘（大图缩放时性能关键）
  const firstColumn = Math.max(0, Math.floor((board.left - imageLeft) / cellWidth))
  const lastColumn = Math.min(columns - 1, Math.floor((board.left + board.width - imageLeft) / cellWidth))
  const firstRow = Math.max(0, Math.floor((board.top - imageTop) / cellHeight))
  const lastRow = Math.min(rows - 1, Math.floor((board.top + board.height - imageTop) / cellHeight))
  const radius = Math.min(cellWidth, cellHeight) * 0.44

  context.save()
  context.beginPath()
  context.rect(board.left, board.top, board.width, board.height)
  context.clip()
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      const cell = draft.cells[row * columns + column]
      if (!cell || cell.color === 'transparent') continue
      const centerX = imageLeft + column * cellWidth + cellWidth / 2
      const centerY = imageTop + row * cellHeight + cellHeight / 2
      context.globalAlpha = 0.18
      context.fillStyle = '#000000'
      context.beginPath()
      context.arc(centerX + cellWidth * 0.06, centerY + cellHeight * 0.08, radius, 0, Math.PI * 2)
      context.fill()
      context.globalAlpha = 1
      context.fillStyle = cell.color
      context.beginPath()
      context.arc(centerX, centerY, radius, 0, Math.PI * 2)
      context.fill()
      if (radius >= 1.8) {
        context.globalAlpha = 0.34
        context.fillStyle = '#ffffff'
        context.beginPath()
        context.arc(centerX - radius * 0.32, centerY - radius * 0.34, radius * 0.22, 0, Math.PI * 2)
        context.fill()
      }
    }
  }

  const drawGrid = (major: boolean) => {
    context.beginPath()
    for (let column = 0; column <= columns; column += 1) {
      if ((column % 10 === 0) !== major) continue
      const x = imageLeft + column * cellWidth
      context.moveTo(x, board.top)
      context.lineTo(x, board.top + board.height)
    }
    for (let row = 0; row <= rows; row += 1) {
      if ((row % 10 === 0) !== major) continue
      const y = imageTop + row * cellHeight
      context.moveTo(board.left, y)
      context.lineTo(board.left + board.width, y)
    }
    context.strokeStyle = major ? '#bb747e' : '#d7dce3'
    context.lineWidth = major ? 1 : 0.5
    context.stroke()
  }
  drawGrid(false)
  drawGrid(true)
  context.restore()

  context.globalAlpha = 1
  const fontSize = Math.max(8, Math.min(12, Math.min(axisWidth, axisHeight) * 0.42))
  const columnTicks = buildCoordinateTicks(columns, rows)
  const rowTicks = buildCoordinateTicks(rows, columns)
  const bottomAxisHeight = canvasHeight - board.top - board.height
  const rightAxisWidth = canvasWidth - board.left - board.width
  const centerX = board.left + board.width / 2
  const centerY = board.top + board.height / 2
  context.fillStyle = '#27313d'
  context.font = `${fontSize}px sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.save()
  context.beginPath()
  context.rect(board.left, 0, board.width, board.top)
  context.rect(board.left, board.top + board.height, board.width, bottomAxisHeight)
  context.clip()
  for (const major of [false, true]) {
    context.beginPath()
    columnTicks.forEach((tick) => {
      if (tick.major !== major) return
      const baseX = board.left + Number.parseFloat(tick.position) * board.width / 100
      const x = centerX + transform.translateX + (baseX - centerX) * transform.scale
      const topLength = major ? axisHeight * 0.58 : axisHeight * 0.3
      const bottomLength = major ? bottomAxisHeight * 0.58 : bottomAxisHeight * 0.3
      context.moveTo(x, board.top - topLength)
      context.lineTo(x, board.top)
      context.moveTo(x, board.top + board.height)
      context.lineTo(x, board.top + board.height + bottomLength)
    })
    context.strokeStyle = major ? '#8391a1' : '#aeb8c4'
    context.lineWidth = major ? 1 : 0.6
    context.stroke()
  }
  columnTicks.forEach((tick) => {
    const baseX = board.left + Number.parseFloat(tick.position) * board.width / 100
    const x = centerX + transform.translateX + (baseX - centerX) * transform.scale
    context.fillText(tick.label, x, axisHeight / 2)
    context.fillText(tick.label, x, board.top + board.height + bottomAxisHeight / 2)
  })
  context.restore()
  context.save()
  context.beginPath()
  context.rect(0, board.top, board.left, board.height)
  context.rect(board.left + board.width, board.top, rightAxisWidth, board.height)
  context.clip()
  for (const major of [false, true]) {
    context.beginPath()
    rowTicks.forEach((tick) => {
      if (tick.major !== major) return
      const baseY = board.top + Number.parseFloat(tick.position) * board.height / 100
      const y = centerY + transform.translateY + (baseY - centerY) * transform.scale
      const leftLength = major ? axisWidth * 0.58 : axisWidth * 0.3
      const rightLength = major ? rightAxisWidth * 0.58 : rightAxisWidth * 0.3
      context.moveTo(board.left - leftLength, y)
      context.lineTo(board.left, y)
      context.moveTo(board.left + board.width, y)
      context.lineTo(board.left + board.width + rightLength, y)
    })
    context.strokeStyle = major ? '#8391a1' : '#aeb8c4'
    context.lineWidth = major ? 1 : 0.6
    context.stroke()
  }
  rowTicks.forEach((tick) => {
    const baseY = board.top + Number.parseFloat(tick.position) * board.height / 100
    const y = centerY + transform.translateY + (baseY - centerY) * transform.scale
    context.fillText(tick.label, axisWidth / 2, y)
    context.fillText(tick.label, board.left + board.width + rightAxisWidth / 2, y)
  })
  context.restore()
  context.textBaseline = 'alphabetic'
}

/**
 * 璁＄畻瀹屾暣鎷艰眴鍥惧湪鍥哄畾 viewport 鍐呯殑 100% 灏哄銆? * 闄愬埗杞撮摵婊?viewport锛屽彟涓€杞存寜缃戞牸姣斾緥瀹屾暣鏄剧ず銆? */
export function calculateFittedImageSize(
  viewportWidth: number,
  viewportHeight: number,
  columns: number,
  rows: number,
): FittedImageSize {
  if (viewportWidth <= 0 || viewportHeight <= 0 || columns <= 0 || rows <= 0) {
    return { width: 0, height: 0, cellWidth: 0, cellHeight: 0 }
  }
  const cellSize = Math.min(viewportWidth / columns, viewportHeight / rows)
  return {
    width: cellSize * columns,
    height: cellSize * rows,
    cellWidth: cellSize,
    cellHeight: cellSize,
  }
}

/**
 * 浠?viewport 鍐呯殑鎸囧畾鐐逛负閿氱偣璁＄畻缂╂斁鍚庣殑骞崇Щ閲忋€? * 缂╂斁鍓嶉敋鐐瑰搴旂殑鍥剧墖鍧愭爣锛屽湪缂╂斁鍚庝粛钀藉湪鍚屼竴涓墜鎸囦綅缃€? */
export function scaleAroundViewportPoint(
  transform: ViewTransform,
  nextScale: number,
  anchorX: number,
  anchorY: number,
  viewportWidth: number,
  viewportHeight: number,
): ViewTransform {
  if (transform.scale <= 0 || nextScale <= 0) return transform
  const imageOffsetX = (anchorX - viewportWidth / 2 - transform.translateX) / transform.scale
  const imageOffsetY = (anchorY - viewportHeight / 2 - transform.translateY) / transform.scale
  return {
    scale: nextScale,
    translateX: anchorX - viewportWidth / 2 - imageOffsetX * nextScale,
    translateY: anchorY - viewportHeight / 2 - imageOffsetY * nextScale,
  }
}

/** 由一次双指手势求出锚点缩放与中点平移后的视图，并限制可移动范围。 */
export function transformFromPinch(
  start: ViewTransform,
  startDistance: number,
  currentDistance: number,
  startMidX: number,
  startMidY: number,
  currentMidX: number,
  currentMidY: number,
  viewport: CanvasRect,
  minScale: number,
  maxScale: number,
  image: FittedImageSize,
): ViewTransform {
  if (startDistance <= 0 || currentDistance <= 0) return start
  const scale = Math.min(maxScale, Math.max(minScale, start.scale * currentDistance / startDistance))
  const anchored = scaleAroundViewportPoint(
    start,
    scale,
    startMidX,
    startMidY,
    viewport.width,
    viewport.height,
  )
  const translation = clampViewTranslation(
    anchored.translateX + currentMidX - startMidX,
    anchored.translateY + currentMidY - startMidY,
    scale,
    viewport.width,
    viewport.height,
    image,
  )
  return { scale, translateX: translation.x, translateY: translation.y }
}

/**
 * 闄愬埗鍥剧墖骞崇Щ鑼冨洿銆?00% 鏃堕攣瀹氬眳涓紱鏀惧ぇ鍚庡厑璁告渶澶栦晶 cell 鐨勪腑蹇? * 绉诲姩鍒?viewport 涓績锛屾弧瓒冲洓瑙掑尯鍩熷彲灞呬腑鏌ョ湅锛屽悓鏃剁姝㈠浘鐗囨棤闄愮Щ鍑恒€? */
export function clampViewTranslation(
  translateX: number,
  translateY: number,
  scale: number,
  viewportWidth: number,
  viewportHeight: number,
  image: FittedImageSize,
): { x: number; y: number } {
  if (
    scale <= 1
    || viewportWidth <= 0
    || viewportHeight <= 0
    || image.width <= 0
    || image.height <= 0
  ) {
    return { x: 0, y: 0 }
  }
  const maxX = Math.max(0, (image.width - image.cellWidth) * scale / 2)
  const maxY = Math.max(0, (image.height - image.cellHeight) * scale / 2)
  return {
    x: Math.min(maxX, Math.max(-maxX, translateX)),
    y: Math.min(maxY, Math.max(-maxY, translateY)),
  }
}

/**
 * 灏嗗睆骞曡Е鐐瑰潗鏍囪浆鎹负鏍煎瓙鍧愭爣锛堝叕鍏卞嚱鏁帮紝渚涙墍鏈夊伐鍏峰鐢級
 * @param touchClientX  touch.clientX
 * @param touchClientY  touch.clientY
 * @param viewportRect 鍥哄畾缂栬緫宸ヤ綔鍖哄湪灞忓箷涓婄殑浣嶇疆
 * @param image        100% 鐘舵€佷笅鐨勫畬鏁村浘鐗囧昂瀵? * @param transform    褰撳墠 scale 涓?translate
 * @param draft         褰撳墠鑽夌
 * @returns GridCell 鎴?null锛堣秴鍑虹敾甯冭寖鍥达級
 */
export function screenPointToGridCell(
  touchClientX: number,
  touchClientY: number,
  viewportRect: CanvasRect,
  image: FittedImageSize,
  transform: ViewTransform,
  draft: PatternDraft,
): GridCell | null {
  if (transform.scale <= 0 || image.cellWidth <= 0 || image.cellHeight <= 0) return null
  const localX = touchClientX - viewportRect.left
  const localY = touchClientY - viewportRect.top
  if (localX < 0 || localX >= viewportRect.width || localY < 0 || localY >= viewportRect.height) {
    return null
  }
  // 反向套用 scale/translate，把屏幕坐标换算回 100% 图片下的像素坐标
  const imageX = (
    (localX - viewportRect.width / 2 - transform.translateX) / transform.scale
    + image.width / 2
  )
  const imageY = (
    (localY - viewportRect.height / 2 - transform.translateY) / transform.scale
    + image.height / 2
  )
  if (imageX < 0 || imageX >= image.width || imageY < 0 || imageY >= image.height) {
    return null
  }
  const column = Math.floor(imageX / image.cellWidth)
  const row = Math.floor(imageY / image.cellHeight)
  if (column < 0 || column >= draft.settings.width || row < 0 || row >= draft.settings.height) {
    return null
  }
  return { row, column, index: row * draft.settings.width + column }
}

/** 一次填充中被替换掉的格子：下标 + 替换前的颜色，供撤销栈做增量回滚。 */
export interface CellReplacement {
  index: number
  before: PatternCell
}

/**
 * 油漆桶/连通域填充：从 startIndex 出发，把 4 邻接且与 target 同色的整片区域替换为 replacement。
 * 原地修改 cells；用 visited 集合防止回环死循环。
 * @param cells 网格数组（行优先）
 * @param startIndex 起点格子索引
 * @param width/height 网格尺寸
 * @param target 被填充的目标色（匹配条件）
 * @param replacement 替换成的新色（直接放入数组，PatternCell 一律整体替换、不原地改字段）
 * @returns 被替换的格子（下标 + 旧值），供调用方生成撤销用的增量记录；一格都没换到时为空数组
 */
export function fillConnectedCells(
  cells: PatternCell[],
  startIndex: number,
  width: number,
  height: number,
  target: PatternCell,
  replacement: PatternCell,
): CellReplacement[] {
  const replaced: CellReplacement[] = []
  const queue = [startIndex]
  const visited = new Set<number>()
  while (queue.length > 0) {
    const index = queue.pop()
    if (index === undefined || visited.has(index)) continue
    visited.add(index)
    const cell = cells[index]
    if (!cell || !sameCell(cell, target)) continue
    replaced.push({ index, before: cell })
    cells[index] = replacement
    // 把上下左右 4 邻接格子入队，下一轮继续扩散
    const column = index % width
    const row = Math.floor(index / width)
    if (column > 0) queue.push(index - 1)
    if (column + 1 < width) queue.push(index + 1)
    if (row > 0) queue.push(index - width)
    if (row + 1 < height) queue.push(index + width)
  }
  return replaced
}

/** 判断两格是否为同一颜色（同时比 color 与 colorCode）。 */
export function sameCell(left: PatternCell, right: PatternCell): boolean {
  return left.color === right.color && left.colorCode === right.colorCode
}
