/**
 * 图纸渲染服务：把 PatternDraft 画成各类下载/展示图（缩略图、成品图、施工图、材料清单、色板）。
 *
 * 职责：封装 2d canvas 取节点、按设备像素比高清绘制、导出临时图片的通用流程，并提供四种图的绘制实现；
 *       材料清单/色板的具体排版复用 result-download-service 的 draw*Download 函数。不负责配额与下载接口。
 * 调用方：packages/result/index.ts（结果页）。
 * 关键点：所有绘制统一按 pixelRatio（≤2）放大物理分辨率再 scale，避免高清屏模糊；
 *       施工图（chart）为网格+色号文字的「十字绣式」底图，HD 版固定 24px/格。
 */
import type { PatternDraft } from '../../../models/pattern'
import {
  drawMaterialsDownload,
  drawPaletteDownload,
} from './result-download-service'
import {
  getTextColor,
  type MaterialItem,
} from '../utils'

// 缩略图尺寸（rpx），按屏幕宽度换算成像素
const THUMB_SIZE_RPX = 176
// 材料清单/色板下载图的固定画布宽度（px）
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
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
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

/**
 * 校验网格尺寸可用于绘制。
 *
 * 宽高必须为正整数：0 会让 cellWidth 算成 Infinity、NaN 会污染所有坐标，
 * canvas 拿到非法坐标既不抛错也不画东西，表现是「导出了一张空白图」——
 * 从现象看不出是网格尺寸坏了，只能一路追到这里。挡在绘制之前。
 */
function requireGridSize(draft: PatternDraft): void {
  const { width, height } = draft.settings
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`图纸网格尺寸无效：${width}x${height}`)
  }
}

/** 画布高度同理必须为正有限数，否则 canvas 尺寸为 0/NaN，导出得到空白图。 */
function requireCanvasHeight(height: number): number {
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`下载图画布高度无效：${height}`)
  }
  return Math.round(height)
}

// 按选择器取出画布节点与尺寸，取不到抛错（canvas 未在 wxml 渲染时会失败）
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

// 把离屏 canvas 导出为 PNG 临时文件，供预览/保存到相册
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

/**
 * 绘制列表用缩略图（拼豆圆点风格），返回临时图片路径。
 * @param context 页实例
 * @param draft 图纸草稿
 */
export async function drawThumbnail(context: ComponentContext, draft: PatternDraft): Promise<string> {
  requireGridSize(draft)
  // rpx→px：750rpx 为设计基准屏宽；pixelRatio 上限 2 控制内存
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

/**
 * 绘制成品大图（与缩略图同款圆点风格），返回临时图片路径，用于结果页展示与分享。
 * @param context 页实例
 * @param draft 图纸草稿
 */
export async function drawPreviewImage(context: ComponentContext, draft: PatternDraft): Promise<string> {
  requireGridSize(draft)
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

/**
 * 绘制施工图的「普通版 + 高清版」两张图，分别用于屏内预览与下载/放大查看。
 * @returns { chartSrc, chartHdSrc } 两张临时图片路径
 */
export async function drawChartImages(
  context: ComponentContext,
  draft: PatternDraft,
): Promise<{ chartSrc: string; chartHdSrc: string }> {
  requireGridSize(draft)
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
  // 色号字号随格子大小自适应，限制在 7~10px 之间
  ctx.font = `${Math.max(7, Math.min(10, cellWidth * 0.52))}px sans-serif`

  draft.cells.forEach((cell, index) => {
    const column = index % draft.settings.width
    const row = Math.floor(index / draft.settings.width)
    const x = column * cellWidth
    const y = row * cellHeight
    // 每格填背景色（透明格填白），再描网格线，形成十字绣式底图
    ctx.fillStyle = cell.color === 'transparent' ? '#ffffff' : cell.color
    ctx.fillRect(x, y, cellWidth, cellHeight)
    ctx.strokeRect(x, y, cellWidth, cellHeight)

    if (cell.colorCode) {
      // 字号颜色取与底色对比度高的黑/白；色号去掉前导 C0/C 只显示数字
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
  requireGridSize(draft)
  // HD 版固定 24px/格，并为四边坐标标尺留白。
  const CHART_HD_CELL_PX = 24
  const AXIS_PADDING = 48
  const chartWidth = draft.settings.width * CHART_HD_CELL_PX
  const chartHeight = draft.settings.height * CHART_HD_CELL_PX
  const totalWidth = chartWidth + AXIS_PADDING * 2
  const totalHeight = chartHeight + AXIS_PADDING * 2

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
  const chartLeft = AXIS_PADDING
  const chartTop = AXIS_PADDING
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
    const x = chartLeft + column * cellPx
    const y = chartTop + row * cellPx
    ctx.fillStyle = cell.color === 'transparent' ? '#ffffff' : cell.color
    ctx.fillRect(x, y, cellPx, cellPx)
    ctx.strokeRect(x, y, cellPx, cellPx)

    if (cell.colorCode) {
      ctx.fillStyle = getTextColor(cell.color)
      ctx.fillText(cell.colorCode.replace(/^C0?/, ''), x + cellPx / 2, y + cellPx / 2)
    }
  })

  // 每 10 格画分区边界，末尾不足 10 格由外框收尾。
  ctx.beginPath()
  for (let column = 10; column < draft.settings.width; column += 10) {
    const x = chartLeft + column * cellPx
    ctx.moveTo(x, chartTop)
    ctx.lineTo(x, chartTop + chartHeight)
  }
  for (let row = 10; row < draft.settings.height; row += 10) {
    const y = chartTop + row * cellPx
    ctx.moveTo(chartLeft, y)
    ctx.lineTo(chartLeft + chartWidth, y)
  }
  ctx.strokeStyle = '#576779'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.strokeRect(chartLeft, chartTop, chartWidth, chartHeight)

  // Shared coordinate ticks stay in the editor subpackage; load asynchronously to preserve package isolation.
  const { buildCoordinateTicks } = await require.async(
    '../../editor/services/pattern-renderer.js',
  ) as typeof import('../../editor/services/pattern-renderer')
  const fontSize = 12
  const columnTicks = buildCoordinateTicks(draft.settings.width, draft.settings.width)
  const rowTicks = buildCoordinateTicks(draft.settings.height, draft.settings.height)
  ctx.fillStyle = '#27313d'
  ctx.font = `${fontSize}px sans-serif`

  for (const major of [false, true]) {
    ctx.beginPath()
    columnTicks.forEach((tick) => {
      if (tick.major !== major) return
      const x = chartLeft + Number.parseFloat(tick.position) * chartWidth / 100
      const length = major ? 10 : 5
      ctx.moveTo(x, chartTop - length)
      ctx.lineTo(x, chartTop)
      ctx.moveTo(x, chartTop + chartHeight)
      ctx.lineTo(x, chartTop + chartHeight + length)
    })
    ctx.strokeStyle = major ? '#8391a1' : '#aeb8c4'
    ctx.lineWidth = major ? 1 : 0.6
    ctx.stroke()
  }
  columnTicks.forEach((tick) => {
    const x = chartLeft + Number.parseFloat(tick.position) * chartWidth / 100
    ctx.fillText(tick.label, x, chartTop / 2)
    ctx.fillText(tick.label, x, chartTop + chartHeight + chartTop / 2)
  })

  for (const major of [false, true]) {
    ctx.beginPath()
    rowTicks.forEach((tick) => {
      if (tick.major !== major) return
      const y = chartTop + Number.parseFloat(tick.position) * chartHeight / 100
      const length = major ? 10 : 5
      ctx.moveTo(chartLeft - length, y)
      ctx.lineTo(chartLeft, y)
      ctx.moveTo(chartLeft + chartWidth, y)
      ctx.lineTo(chartLeft + chartWidth + length, y)
    })
    ctx.strokeStyle = major ? '#8391a1' : '#aeb8c4'
    ctx.lineWidth = major ? 1 : 0.6
    ctx.stroke()
  }
  rowTicks.forEach((tick) => {
    const y = chartTop + Number.parseFloat(tick.position) * chartHeight / 100
    ctx.fillText(tick.label, chartLeft / 2, y)
    ctx.fillText(tick.label, chartLeft + chartWidth + chartLeft / 2, y)
  })
  return canvas
}

/**
 * 绘制材料清单下载图（每色用量汇总），返回临时图片路径。
 * @param materials 各色用量列表；beadCount 总珠数；height 由结果页按条数估算的画布高度
 */
export async function drawMaterialsDownloadImage(
  context: ComponentContext,
  materials: MaterialItem[],
  workTitle: string,
  beadCount: number,
  height: number,
): Promise<string> {
  const canvas = await queryCanvas(context, '#materialsDownloadCanvas')
  const canvasHeight = requireCanvasHeight(height)
  canvas.node.width = DOWNLOAD_CANVAS_WIDTH
  canvas.node.height = canvasHeight
  const ctx = canvas.node.getContext('2d')

  drawMaterialsDownload(
    ctx,
    {
      width: DOWNLOAD_CANVAS_WIDTH,
      height: canvasHeight,
      workTitle,
      fileTitle: '材料清单',
    },
    materials,
    beadCount,
  )
  return exportCanvas(canvas.node, context)
}

/**
 * 绘制色板参考下载图（各色色块+色号），返回临时图片路径。
 * @param materials 各色列表；height 由结果页按行数估算的画布高度
 */
export async function drawPaletteDownloadImage(
  context: ComponentContext,
  materials: MaterialItem[],
  workTitle: string,
  height: number,
): Promise<string> {
  const canvas = await queryCanvas(context, '#paletteDownloadCanvas')
  const canvasHeight = requireCanvasHeight(height)
  canvas.node.width = DOWNLOAD_CANVAS_WIDTH
  canvas.node.height = canvasHeight
  const ctx = canvas.node.getContext('2d')

  drawPaletteDownload(
    ctx,
    {
      width: DOWNLOAD_CANVAS_WIDTH,
      height: canvasHeight,
      workTitle,
      fileTitle: '色板参考',
    },
    materials,
  )
  return exportCanvas(canvas.node, context)
}
