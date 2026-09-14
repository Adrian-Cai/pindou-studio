import type { PatternDraft } from '../../../models/pattern'
import {
  drawMaterialsDownload,
  drawPaletteDownload,
} from './result-download-service'
import {
  getTextColor,
  type MaterialItem,
} from '../utils'

const THUMB_SIZE_RPX = 176
export const DOWNLOAD_CANVAS_WIDTH = 900

interface PatternCanvas {
  width: number
  height: number
  getContext(type: '2d'): PatternCanvasContext
}

interface PatternCanvasContext {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  globalAlpha: number
  font: string
  textAlign: string
  textBaseline: string
  scale(x: number, y: number): void
  fillRect(x: number, y: number, width: number, height: number): void
  strokeRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
  fillText(text: string, x: number, y: number): void
}

interface CanvasQueryResult {
  node: PatternCanvas
  width: number
  height: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ComponentContext = any

function queryCanvas(context: ComponentContext, selector: string): Promise<CanvasQueryResult> {
  return new Promise((resolve, reject) => {
    wx.createSelectorQuery()
      .in(context)
      .select(selector)
      .fields({ node: true, size: true })
      .exec((results) => {
        const result = results[0] as CanvasQueryResult | undefined
        if (!result?.node || !result.width || !result.height) {
          reject(new Error(`未找到画布 ${selector}`))
          return
        }
        resolve(result)
      })
  })
}

function exportCanvas(canvas: PatternCanvas, context: ComponentContext): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath(
      {
        canvas: canvas as unknown as WechatMiniprogram.Canvas,
        fileType: 'png',
        quality: 1,
        success: ({ tempFilePath }) => resolve(tempFilePath),
        fail: (error) => reject(new Error(error.errMsg || '图片生成失败')),
      },
      context,
    )
  })
}

export async function drawThumbnail(context: ComponentContext, draft: PatternDraft): Promise<string> {
  const thumbSizePx = Math.round((THUMB_SIZE_RPX / 750) * wx.getWindowInfo().windowWidth)
  const pixelRatio = Math.min(wx.getWindowInfo().pixelRatio || 1, 2)

  const canvasNode = await new Promise<PatternCanvas>((resolve, reject) => {
    wx.createSelectorQuery()
      .in(context)
      .select('#thumbnailCanvas')
      .fields({ node: true })
      .exec((results: [{ node?: PatternCanvas } | undefined]) => {
        const node = results[0]?.node
        if (!node) {
          reject(new Error('thumbnailCanvas not found'))
          return
        }
        resolve(node)
      })
  })

  canvasNode.width = Math.round(thumbSizePx * pixelRatio)
  canvasNode.height = Math.round(thumbSizePx * pixelRatio)

  const ctx = canvasNode.getContext('2d')
  ctx.scale(pixelRatio, pixelRatio)
  ctx.fillStyle = '#f7f7f9'
  ctx.fillRect(0, 0, thumbSizePx, thumbSizePx)

  const cellWidth = thumbSizePx / draft.settings.width
  const cellHeight = thumbSizePx / draft.settings.height
  const radius = Math.min(cellWidth, cellHeight) * 0.43

  draft.cells.forEach((cell, index) => {
    if (cell.color === 'transparent') return
    const column = index % draft.settings.width
    const row = Math.floor(index / draft.settings.width)
    const centerX = column * cellWidth + cellWidth / 2
    const centerY = row * cellHeight + cellHeight / 2

    ctx.globalAlpha = 0.16
    ctx.fillStyle = '#111111'
    ctx.beginPath()
    ctx.arc(centerX + radius * 0.1, centerY + radius * 0.14, radius, 0, Math.PI * 2)
    ctx.fill()

    ctx.globalAlpha = 1
    ctx.fillStyle = cell.color
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
    ctx.fill()

    if (radius >= 1.7) {
      ctx.globalAlpha = 0.35
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(centerX - radius * 0.3, centerY - radius * 0.32, radius * 0.2, 0, Math.PI * 2)
      ctx.fill()
    }
  })
  ctx.globalAlpha = 1

  return exportCanvas(canvasNode, context)
}

export async function drawPreviewImage(context: ComponentContext, draft: PatternDraft): Promise<string> {
  const result = await queryCanvas(context, '#previewRenderCanvas')
  const pixelRatio = Math.min(wx.getWindowInfo().pixelRatio || 1, 2)
  const canvas = result.node
  canvas.width = Math.round(result.width * pixelRatio)
  canvas.height = Math.round(result.height * pixelRatio)

  const ctx = canvas.getContext('2d')
  ctx.scale(pixelRatio, pixelRatio)
  ctx.fillStyle = '#f7f7f9'
  ctx.fillRect(0, 0, result.width, result.height)

  const cellWidth = result.width / draft.settings.width
  const cellHeight = result.height / draft.settings.height
  const radius = Math.min(cellWidth, cellHeight) * 0.43

  draft.cells.forEach((cell, index) => {
    if (cell.color === 'transparent') return
    const column = index % draft.settings.width
    const row = Math.floor(index / draft.settings.width)
    const centerX = column * cellWidth + cellWidth / 2
    const centerY = row * cellHeight + cellHeight / 2

    ctx.globalAlpha = 0.16
    ctx.fillStyle = '#111111'
    ctx.beginPath()
    ctx.arc(centerX + radius * 0.1, centerY + radius * 0.14, radius, 0, Math.PI * 2)
    ctx.fill()

    ctx.globalAlpha = 1
    ctx.fillStyle = cell.color
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
    ctx.fill()

    if (radius >= 1.7) {
      ctx.globalAlpha = 0.35
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(centerX - radius * 0.3, centerY - radius * 0.32, radius * 0.2, 0, Math.PI * 2)
      ctx.fill()
    }
  })
  ctx.globalAlpha = 1

  return exportCanvas(canvas, context)
}

export async function drawChartImages(
  context: ComponentContext,
  draft: PatternDraft,
): Promise<{ chartSrc: string; chartHdSrc: string }> {
  const [canvas, hdCanvas] = await Promise.all([
    drawChartCanvas(context, '#chartRenderCanvas', draft),
    drawChartHdCanvas(context, '#chartHdRenderCanvas', draft),
  ])
  const [chartSrc, chartHdSrc] = await Promise.all([
    exportCanvas(canvas, context),
    exportCanvas(hdCanvas, context),
  ])
  return { chartSrc, chartHdSrc }
}

async function drawChartCanvas(
  context: ComponentContext,
  selector: string,
  draft: PatternDraft,
): Promise<PatternCanvas> {
  const result = await queryCanvas(context, selector)
  const pixelRatio = Math.min(wx.getWindowInfo().pixelRatio || 1, 2)
  const canvas = result.node
  canvas.width = Math.round(result.width * pixelRatio)
  canvas.height = Math.round(result.height * pixelRatio)

  const ctx = canvas.getContext('2d')
  ctx.scale(pixelRatio, pixelRatio)
  const cellWidth = result.width / draft.settings.width
  const cellHeight = result.height / draft.settings.height
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, result.width, result.height)
  ctx.lineWidth = 0.5
  ctx.strokeStyle = '#d9d9d9'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.max(7, Math.min(10, cellWidth * 0.52))}px sans-serif`

  draft.cells.forEach((cell, index) => {
    const column = index % draft.settings.width
    const row = Math.floor(index / draft.settings.width)
    const x = column * cellWidth
    const y = row * cellHeight
    ctx.fillStyle = cell.color === 'transparent' ? '#ffffff' : cell.color
    ctx.fillRect(x, y, cellWidth, cellHeight)
    ctx.strokeRect(x, y, cellWidth, cellHeight)

    if (cell.colorCode) {
      ctx.fillStyle = getTextColor(cell.color)
      ctx.fillText(cell.colorCode.replace(/^C0?/, ''), x + cellWidth / 2, y + cellHeight / 2)
    }
  })
  return canvas
}

async function drawChartHdCanvas(
  context: ComponentContext,
  selector: string,
  draft: PatternDraft,
): Promise<PatternCanvas> {
  const CHART_HD_CELL_PX = 24
  const totalWidth = draft.settings.width * CHART_HD_CELL_PX
  const totalHeight = draft.settings.height * CHART_HD_CELL_PX

  const canvas = await new Promise<PatternCanvas>((resolve, reject) => {
    wx.createSelectorQuery()
      .in(context)
      .select(selector)
      .fields({ node: true })
      .exec((results: [{ node?: PatternCanvas } | undefined]) => {
        const node = results[0]?.node
        if (!node) {
          reject(new Error(`未找到画布 ${selector}`))
          return
        }
        resolve(node)
      })
  })

  canvas.width = totalWidth
  canvas.height = totalHeight

  const ctx = canvas.getContext('2d')
  const cellPx = CHART_HD_CELL_PX
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, totalWidth, totalHeight)
  ctx.lineWidth = 0.5
  ctx.strokeStyle = '#cccccc'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.round(cellPx * 0.5)}px sans-serif`

  draft.cells.forEach((cell, index) => {
    const column = index % draft.settings.width
    const row = Math.floor(index / draft.settings.width)
    const x = column * cellPx
    const y = row * cellPx
    ctx.fillStyle = cell.color === 'transparent' ? '#ffffff' : cell.color
    ctx.fillRect(x, y, cellPx, cellPx)
    ctx.strokeRect(x, y, cellPx, cellPx)

    if (cell.colorCode) {
      ctx.fillStyle = getTextColor(cell.color)
      ctx.fillText(cell.colorCode.replace(/^C0?/, ''), x + cellPx / 2, y + cellPx / 2)
    }
  })
  return canvas
}

export async function drawMaterialsDownloadImage(
  context: ComponentContext,
  materials: MaterialItem[],
  workTitle: string,
  beadCount: number,
  height: number,
): Promise<string> {
  const canvas = await queryCanvas(context, '#materialsDownloadCanvas')
  canvas.node.width = DOWNLOAD_CANVAS_WIDTH
  canvas.node.height = height
  const ctx = canvas.node.getContext('2d')

  drawMaterialsDownload(
    ctx,
    {
      width: DOWNLOAD_CANVAS_WIDTH,
      height,
      workTitle,
      fileTitle: '材料清单',
    },
    materials,
    beadCount,
  )
  return exportCanvas(canvas.node, context)
}

export async function drawPaletteDownloadImage(
  context: ComponentContext,
  materials: MaterialItem[],
  workTitle: string,
  height: number,
): Promise<string> {
  const canvas = await queryCanvas(context, '#paletteDownloadCanvas')
  canvas.node.width = DOWNLOAD_CANVAS_WIDTH
  canvas.node.height = height
  const ctx = canvas.node.getContext('2d')

  drawPaletteDownload(
    ctx,
    {
      width: DOWNLOAD_CANVAS_WIDTH,
      height,
      workTitle,
      fileTitle: '色板参考',
    },
    materials,
  )
  return exportCanvas(canvas.node, context)
}
