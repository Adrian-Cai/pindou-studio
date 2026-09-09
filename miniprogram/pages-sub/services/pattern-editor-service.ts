import type { PatternCell, PatternDraft } from '../../models/pattern'

export interface PatternCanvasContext {
  fillStyle: string
  globalAlpha: number
  scale(x: number, y: number): void
  fillRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
}

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

/** 鍦ㄥ浐瀹?viewport Canvas 鍐呮寜褰撳墠瑙嗗浘鍙樻崲缁樺埗锛屼粎閬嶅巻鍙 grid cell銆?*/
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
