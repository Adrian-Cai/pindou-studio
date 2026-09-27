/**
 * 拼豆图画布渲染：把 PatternDraft 绘制为带阴影与高光的圆点网格。
 *
 * 调用方：编辑器页与 AI 生成页的预览/封面画布。只负责绘制，不负责画布查询、导出或交互。
 */
import type { PatternDraft } from '../models/pattern'

/** 2d canvas 上下文的最小子集（绘制拼豆点所需 API）。 */
export interface PatternCanvasContext {
  fillStyle: string
  globalAlpha: number
  scale(x: number, y: number): void
  fillRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
}

/**
 * 把整张图纸按「拼豆圆点」风格画满整个 canvas。
 * @param context 2d canvas 上下文
 * @param canvasWidth/canvasHeight 画布尺寸（CSS px）
 * @param draft 图纸草稿
 */
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
  // 圆点半径取格宽高较小者的 0.44，留出格间缝隙
  const radius = Math.min(cellWidth, cellHeight) * 0.44

  draft.cells.forEach((cell, index) => {
    if (cell.color === 'transparent') return
    const column = index % columns
    const row = Math.floor(index / columns)
    const centerX = column * cellWidth + cellWidth / 2
    const centerY = row * cellHeight + cellHeight / 2
    // 先画一层半透明黑色作为右下阴影，制造立体感
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
    // 圆点够大时再点一个白色高光，增强拼豆质感
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
