import type { PatternCell, PatternDraft } from '../models/pattern'

export interface PatternCanvasContext {
  fillStyle: string
  globalAlpha: number
  scale(x: number, y: number): void
  fillRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
}

export function editorTools(canUndo: boolean, canRedo: boolean) {
  return [
    { id: 'undo', label: '撤销', icon: '/assets/icons/editor-undo.svg', disabled: !canUndo },
    { id: 'redo', label: '重做', icon: '/assets/icons/editor-redo.svg', disabled: !canRedo },
    { id: 'eyedropper', label: '吸管', icon: '/assets/icons/editor-eyedropper.svg', disabled: false },
    { id: 'fill', label: '填充', icon: '/assets/icons/editor-fill.svg', disabled: false },
    { id: 'eraser', label: '橡皮擦', icon: '/assets/icons/editor-eraser.svg', disabled: false },
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
