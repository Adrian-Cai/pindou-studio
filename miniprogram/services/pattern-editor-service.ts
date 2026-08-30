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

/** 矩形位置与尺寸（CSS 像素） */
export interface CanvasRect {
  left: number
  top: number
  width: number
  height: number
}

/** 100% 状态下，完整拼豆图在 viewport 内的基础尺寸（CSS 像素） */
export interface FittedImageSize {
  width: number
  height: number
  cellWidth: number
  cellHeight: number
}

/** 拼豆图相对 viewport 中心的视图变换 */
export interface ViewTransform {
  scale: number
  translateX: number
  translateY: number
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
): void {
  context.fillStyle = '#f7f7f7'
  context.fillRect(0, 0, canvasWidth, canvasHeight)
  const columns = draft.settings.width
  const rows = draft.settings.height
  const cellWidth = canvasWidth / columns
  const cellHeight = canvasHeight / rows
  const radius = Math.min(cellWidth, cellHeight) * 0.44

  draft.cells.forEach((cell, index) => {
    if (cell.color === 'transparent') return
    const column = index % columns
    const row = Math.floor(index / columns)
    const centerX = column * cellWidth + cellWidth / 2
    const centerY = row * cellHeight + cellHeight / 2
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

export function exportPatternCoverImage(
  draft: PatternDraft,
  component: WechatMiniprogram.Page.TrivialInstance,
): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.createSelectorQuery()
      .in(component)
      .select('#exportPatternCanvas')
      .fields({ node: true, size: true })
      .exec((results) => {
        const result = results[0] as {
          node?: { width: number; height: number; getContext(type: '2d'): PatternCanvasContext }
          width?: number
          height?: number
        } | undefined
        if (!result?.node || !result.width || !result.height) {
          reject(new Error('封面画布尚未准备好'))
          return
        }
        result.node.width = Math.round(result.width)
        result.node.height = Math.round(result.height)
        drawPatternOnCanvas(result.node.getContext('2d'), result.width, result.height, draft)
        wx.canvasToTempFilePath(
          {
            canvas: result.node as unknown as WechatMiniprogram.Canvas,
            fileType: 'png',
            quality: 1,
            success: ({ tempFilePath }) => resolve(tempFilePath),
            fail: (error) => reject(new Error(error.errMsg || '封面生成失败')),
          },
          component,
        )
      })
  })
}

/** 在固定 viewport Canvas 内按当前视图变换绘制，仅遍历可见 grid cell。 */
export function drawPatternViewport(
  context: PatternCanvasContext,
  viewportWidth: number,
  viewportHeight: number,
  image: FittedImageSize,
  transform: ViewTransform,
  draft: PatternDraft,
): void {
  context.fillStyle = '#f7f7f7'
  context.fillRect(0, 0, viewportWidth, viewportHeight)
  const columns = draft.settings.width
  const rows = draft.settings.height
  const cellWidth = image.cellWidth * transform.scale
  const cellHeight = image.cellHeight * transform.scale
  const imageLeft = viewportWidth / 2 + transform.translateX - image.width * transform.scale / 2
  const imageTop = viewportHeight / 2 + transform.translateY - image.height * transform.scale / 2
  const firstColumn = Math.max(0, Math.floor(-imageLeft / cellWidth))
  const lastColumn = Math.min(columns - 1, Math.floor((viewportWidth - imageLeft) / cellWidth))
  const firstRow = Math.max(0, Math.floor(-imageTop / cellHeight))
  const lastRow = Math.min(rows - 1, Math.floor((viewportHeight - imageTop) / cellHeight))
  const radius = Math.min(cellWidth, cellHeight) * 0.44

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
  context.globalAlpha = 1
}

/**
 * 计算完整拼豆图在固定 viewport 内的 100% 尺寸。
 * 限制轴铺满 viewport，另一轴按网格比例完整显示。
 */
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
 * 以 viewport 内的指定点为锚点计算缩放后的平移量。
 * 缩放前锚点对应的图片坐标，在缩放后仍落在同一个手指位置。
 */
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

/**
 * 限制图片平移范围。100% 时锁定居中；放大后允许最外侧 cell 的中心
 * 移动到 viewport 中心，满足四角区域可居中查看，同时禁止图片无限移出。
 */
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
 * 将屏幕触点坐标转换为格子坐标（公共函数，供所有工具复用）
 * @param touchClientX  touch.clientX
 * @param touchClientY  touch.clientY
 * @param viewportRect 固定编辑工作区在屏幕上的位置
 * @param image        100% 状态下的完整图片尺寸
 * @param transform    当前 scale 与 translate
 * @param draft         当前草稿
 * @returns GridCell 或 null（超出画布范围）
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

/** 将 grid cell 正向映射到 viewport 局部坐标，用于绘制固定线宽的选中框。 */
export function gridCellToViewportRect(
  cell: GridCell,
  image: FittedImageSize,
  transform: ViewTransform,
  viewportWidth: number,
  viewportHeight: number,
): CanvasRect {
  const width = image.cellWidth * transform.scale
  const height = image.cellHeight * transform.scale
  const imageLeft = viewportWidth / 2 + transform.translateX - image.width * transform.scale / 2
  const imageTop = viewportHeight / 2 + transform.translateY - image.height * transform.scale / 2
  return {
    left: imageLeft + cell.column * width,
    top: imageTop + cell.row * height,
    width,
    height,
  }
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
        magCtx.strokeStyle = '#1677ff'
        magCtx.lineWidth = 2
        magCtx.strokeRect(px + 3, py + 3, cellSize - 6, cellSize - 6)

      }

      // 格线分隔
      magCtx.globalAlpha = 0.08
      magCtx.strokeStyle = '#000000'
      magCtx.lineWidth = 0.5
      magCtx.strokeRect(px, py, cellSize, cellSize)
      magCtx.globalAlpha = 1
    }
  }

  // 中心十字准星
  const half = magSize / 2
  magCtx.strokeStyle = 'rgba(22,119,255,0.75)'
  magCtx.lineWidth = 1
  magCtx.globalAlpha = 0.5
  const cs = cellSize
  const midX = half
  const midY = half
  magCtx.beginPath()
  magCtx.rect(midX - cs / 2, midY - cs / 2, cs, cs)
  magCtx.stroke()
  magCtx.globalAlpha = 1

  const captionTop = magSize
  const captionHeight = 48
  const code = draft.cells[centerRow * totalCols + centerColumn]?.colorCode || '空白'
  magCtx.fillStyle = '#ffffff'
  magCtx.fillRect(0, captionTop, magSize, captionHeight)
  magCtx.fillStyle = '#1677ff'
  magCtx.fillRect(0, captionTop, magSize, 2)
  magCtx.fillStyle = '#172033'
  magCtx.font = '600 12px sans-serif'
  magCtx.textAlign = 'center'
  magCtx.textBaseline = 'middle'
  magCtx.fillText(`第 ${centerRow + 1} 行 · 第 ${centerColumn + 1} 列`, magSize / 2, captionTop + 16)
  magCtx.fillStyle = '#eaf3ff'
  magCtx.fillRect(magSize / 2 - 22, captionTop + 27, 44, 18)
  magCtx.fillStyle = '#0b63ce'
  magCtx.font = '700 11px sans-serif'
  magCtx.fillText(code, magSize / 2, captionTop + 36)
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
