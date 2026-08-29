import type { PatternCell, PatternDraft } from '../models/pattern'

export interface PatternCanvasContext {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  globalAlpha: number
  font: string
  textAlign: string
  textBaseline: string
  scale(x: number, y: number): void
  fillRect(x: number, y: number, width: number, height: number): void
  clearRect(x: number, y: number, width: number, height: number): void
  strokeRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
  stroke(): void
  fillText(text: string, x: number, y: number): void
  save(): void
  restore(): void
  clip(): void
  rect(x: number, y: number, width: number, height: number): void
}

/** Canvas 在屏幕上的位置与尺寸（CSS 像素） */
export interface CanvasRect {
  left: number
  top: number
  width: number
  height: number
}

/** 格子位置 */
export interface GridCell {
  row: number
  column: number
  index: number
}

export function editorTools(canUndo: boolean, canRedo: boolean) {
  return [
    { id: 'undo', label: '撤销', icon: '/assets/icons/editor-undo.svg', activeIcon: '/assets/icons/editor-undo.svg', disabled: !canUndo },
    { id: 'redo', label: '重做', icon: '/assets/icons/editor-redo.svg', activeIcon: '/assets/icons/editor-redo.svg', disabled: !canRedo },
    { id: 'pencil', label: '画笔', icon: '/assets/icons/editor-pencil.svg', activeIcon: '/assets/icons/editor-pencil-active.svg', disabled: false },
    { id: 'eyedropper', label: '吸管', icon: '/assets/icons/editor-eyedropper.svg', activeIcon: '/assets/icons/editor-eyedropper-active.svg', disabled: false },
    { id: 'fill', label: '填充', icon: '/assets/icons/editor-fill.svg', activeIcon: '/assets/icons/editor-fill-active.svg', disabled: false },
    { id: 'eraser', label: '橡皮擦', icon: '/assets/icons/editor-eraser.svg', activeIcon: '/assets/icons/editor-eraser-active.svg', disabled: false },
  ]
}

export function drawPatternOnCanvas(
  context: PatternCanvasContext,
  canvasWidth: number,
  canvasHeight: number,
  draft: PatternDraft,
  zoom: number,
): void {
  context.fillStyle = '#f7f7f7'
  context.fillRect(0, 0, canvasWidth, canvasHeight)
  const columns = draft.settings.width
  const rows = draft.settings.height
  const cellWidth = (canvasWidth / columns) * zoom
  const cellHeight = (canvasHeight / rows) * zoom
  const originX = (canvasWidth - cellWidth * columns) / 2
  const originY = (canvasHeight - cellHeight * rows) / 2
  const radius = Math.min(cellWidth, cellHeight) * 0.44

  draft.cells.forEach((cell, index) => {
    if (cell.color === 'transparent') return
    const column = index % columns
    const row = Math.floor(index / columns)
    const centerX = originX + column * cellWidth + cellWidth / 2
    const centerY = originY + row * cellHeight + cellHeight / 2
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
  })
  context.globalAlpha = 1
}

/**
 * 将屏幕触点坐标转换为格子坐标（公共函数，供所有工具复用）
 * @param touchClientX  touch.clientX
 * @param touchClientY  touch.clientY
 * @param canvasRect    canvas 在屏幕上的位置
 * @param draft         当前草稿
 * @param zoom          当前缩放倍率
 * @returns GridCell 或 null（超出画布范围）
 */
export function screenPointToGridCell(
  touchClientX: number,
  touchClientY: number,
  canvasRect: CanvasRect,
  draft: PatternDraft,
  zoom: number,
): GridCell | null {
  const localX = touchClientX - canvasRect.left
  const localY = touchClientY - canvasRect.top
  const cellWidth = (canvasRect.width / draft.settings.width) * zoom
  const cellHeight = (canvasRect.height / draft.settings.height) * zoom
  const originX = (canvasRect.width - cellWidth * draft.settings.width) / 2
  const originY = (canvasRect.height - cellHeight * draft.settings.height) / 2
  const column = Math.floor((localX - originX) / cellWidth)
  const row = Math.floor((localY - originY) / cellHeight)
  if (column < 0 || column >= draft.settings.width || row < 0 || row >= draft.settings.height) {
    return null
  }
  return { row, column, index: row * draft.settings.width + column }
}

/** @deprecated 使用 screenPointToGridCell 替代 */
export function getCellIndexAtPoint(
  x: number,
  y: number,
  canvasWidth: number,
  canvasHeight: number,
  draft: PatternDraft,
  zoom: number,
): number {
  const cellWidth = (canvasWidth / draft.settings.width) * zoom
  const cellHeight = (canvasHeight / draft.settings.height) * zoom
  const originX = (canvasWidth - cellWidth * draft.settings.width) / 2
  const originY = (canvasHeight - cellHeight * draft.settings.height) / 2
  const column = Math.floor((x - originX) / cellWidth)
  const row = Math.floor((y - originY) / cellHeight)
  if (column < 0 || column >= draft.settings.width || row < 0 || row >= draft.settings.height) {
    return -1
  }
  return row * draft.settings.width + column
}

/**
 * 放大镜渲染：直接读取 grid 数据重绘，保证清晰度
 * @param magCtx        放大镜 canvas 的 2d context（已按 pixelRatio scale）
 * @param magSize       放大镜 canvas 的 CSS 边长（px）
 * @param centerRow     中心行
 * @param centerColumn  中心列
 * @param draft         当前草稿
 * @param halfGrid      半径格数，默认 3 → 显示 7×7
 */
export function drawMagnifier(
  magCtx: PatternCanvasContext,
  magSize: number,
  centerRow: number,
  centerColumn: number,
  draft: PatternDraft,
  halfGrid = 3,
): void {
  const gridSpan = halfGrid * 2 + 1
  const cellSize = magSize / gridSpan
  const radius = cellSize * 0.44
  const totalRows = draft.settings.height
  const totalCols = draft.settings.width

  // 背景
  magCtx.fillStyle = '#f0f0f0'
  magCtx.fillRect(0, 0, magSize, magSize)

  for (let dr = -halfGrid; dr <= halfGrid; dr++) {
    for (let dc = -halfGrid; dc <= halfGrid; dc++) {
      const row = centerRow + dr
      const col = centerColumn + dc
      const px = (dc + halfGrid) * cellSize
      const py = (dr + halfGrid) * cellSize
      const cx = px + cellSize / 2
      const cy = py + cellSize / 2
      const isCenter = dr === 0 && dc === 0

      if (row < 0 || row >= totalRows || col < 0 || col >= totalCols) {
        // 越界格子用浅灰填充
        magCtx.globalAlpha = 0.3
        magCtx.fillStyle = '#cccccc'
        magCtx.fillRect(px, py, cellSize, cellSize)
        magCtx.globalAlpha = 1
        continue
      }

      const cell = draft.cells[row * totalCols + col]
      if (!cell || cell.color === 'transparent') {
        // 透明格：显示格线
        magCtx.globalAlpha = 0.12
        magCtx.fillStyle = '#aaaaaa'
        magCtx.fillRect(px, py, cellSize, cellSize)
        magCtx.globalAlpha = 1
      } else {
        // 投影
        magCtx.globalAlpha = 0.18
        magCtx.fillStyle = '#000000'
        magCtx.beginPath()
        magCtx.arc(cx + cellSize * 0.06, cy + cellSize * 0.08, radius, 0, Math.PI * 2)
        magCtx.fill()
        magCtx.globalAlpha = 1

        // 拼豆主体
        magCtx.fillStyle = cell.color
        magCtx.beginPath()
        magCtx.arc(cx, cy, radius, 0, Math.PI * 2)
        magCtx.fill()

        // 高光
        if (radius >= 3) {
          magCtx.globalAlpha = 0.34
          magCtx.fillStyle = '#ffffff'
          magCtx.beginPath()
          magCtx.arc(cx - radius * 0.32, cy - radius * 0.34, radius * 0.22, 0, Math.PI * 2)
          magCtx.fill()
          magCtx.globalAlpha = 1
        }
      }

      // 中心格高亮描边
      if (isCenter) {
        magCtx.strokeStyle = '#ffffff'
        magCtx.lineWidth = 3
        magCtx.strokeRect(px + 1.5, py + 1.5, cellSize - 3, cellSize - 3)
        magCtx.strokeStyle = '#6F5BFF'
        magCtx.lineWidth = 2
        magCtx.strokeRect(px + 3, py + 3, cellSize - 6, cellSize - 6)

        // colorCode 标签（格子足够大时显示）
        const code = cell?.colorCode ?? ''
        if (code && cellSize >= 20) {
          magCtx.globalAlpha = 0.92
          const labelH = Math.max(12, cellSize * 0.28)
          magCtx.fillStyle = 'rgba(0,0,0,0.62)'
          magCtx.fillRect(px, py + cellSize - labelH, cellSize, labelH)
          magCtx.globalAlpha = 1
          magCtx.fillStyle = '#ffffff'
          magCtx.font = `bold ${Math.max(8, labelH * 0.72)}px sans-serif`
          magCtx.textAlign = 'center'
          magCtx.textBaseline = 'middle'
          magCtx.fillText(code, cx, py + cellSize - labelH / 2)
        }
      }

      // 格线分隔
      magCtx.globalAlpha = 0.08
      magCtx.strokeStyle = '#000000'
      magCtx.lineWidth = 0.5
      magCtx.strokeRect(px, py, cellSize, cellSize)
      magCtx.globalAlpha = 1
    }
  }

  // 最外圆形裁剪蒙版（视觉效果）：绘制圆形外的遮罩
  const half = magSize / 2
  magCtx.globalAlpha = 1
  magCtx.fillStyle = 'rgba(240,240,240,1)'
  // 四角遮罩（简单矩形切角，不需要 clip 以保持兼容性）
  // 只绘制外框高亮圆形边框即可
  magCtx.strokeStyle = 'rgba(111,91,255,0.5)'
  magCtx.lineWidth = 2
  magCtx.beginPath()
  magCtx.arc(half, half, half - 1, 0, Math.PI * 2)
  magCtx.stroke()

  // 中心十字准星
  magCtx.strokeStyle = 'rgba(111,91,255,0.7)'
  magCtx.lineWidth = 1
  magCtx.globalAlpha = 0.5
  const cs = cellSize
  const midX = half
  const midY = half
  magCtx.beginPath()
  magCtx.rect(midX - cs / 2, midY - cs / 2, cs, cs)
  magCtx.stroke()
  magCtx.globalAlpha = 1
}

export function fillConnectedCells(
  cells: PatternCell[],
  startIndex: number,
  width: number,
  height: number,
  target: PatternCell,
  replacement: PatternCell,
): void {
  const queue = [startIndex]
  const visited = new Set<number>()
  while (queue.length > 0) {
    const index = queue.pop()
    if (index === undefined || visited.has(index)) continue
    visited.add(index)
    const cell = cells[index]
    if (!cell || !sameCell(cell, target)) continue
    cells[index] = { ...replacement }
    const column = index % width
    const row = Math.floor(index / width)
    if (column > 0) queue.push(index - 1)
    if (column + 1 < width) queue.push(index + 1)
    if (row > 0) queue.push(index - width)
    if (row + 1 < height) queue.push(index + width)
  }
}

export function sameCell(left: PatternCell, right: PatternCell): boolean {
  return left.color === right.color && left.colorCode === right.colorCode
}
