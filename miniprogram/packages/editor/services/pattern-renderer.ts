/**
 * 拼豆图画布渲染：把 PatternDraft 绘制为带阴影与高光的圆点网格。
 *
 * 单一来源放在 editor 分包：主包自身不使用它，留在主包会触发
 * 「主包内不应存在主包未使用的 JS 文件」告警并白占主包体积。
 * 调用方：editor 分包（pattern-editor-service，封面绘制）与
 *         ai-generation 分包（require.async 分包异步化按需加载，失败走页面内 patternRenderError 兜底）。
 * 只负责绘制，不负责画布查询、导出或交互。
 */
import type { PatternDraft } from '../../../models/pattern'

/** 2d canvas 上下文的最小子集（绘制拼豆点所需 API）。 */
export interface PatternCanvasContext {
  fillStyle: string
  globalAlpha: number
  strokeStyle: string
  lineWidth: number
  font: string
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end'
  textBaseline: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom'
  scale(x: number, y: number): void
  translate(x: number, y: number): void
  save(): void
  restore(): void
  rect(x: number, y: number, width: number, height: number): void
  clip(): void
  fillRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  fillText(text: string, x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
}

export interface CoordinateTick {
  coordinate: number
  position: string
  label: string
  major: boolean
  start: boolean
  end: boolean
}

/** 按 1 起算生成格心刻度；空间不足时保留末端标签并隐藏相邻主刻度。 */
export function buildCoordinateTicks(
  size: number,
  otherSize: number,
  axisLength: number,
  fontSize: number,
): CoordinateTick[] {
  const count = Math.max(1, Math.floor(size))
  const crossCount = Math.max(1, Math.floor(otherSize))
  const extent = Math.min(count, crossCount) / count
  const offset = (1 - extent) / 2
  const cellPitch = axisLength * extent / count
  const labelIndexes = [0]
  for (let index = 9; index < count; index += 10) labelIndexes.push(index)
  if (count > 1 && labelIndexes[labelIndexes.length - 1] !== count - 1) {
    labelIndexes.push(count - 1)
  }

  const visibleLabelIndexes: number[] = []
  labelIndexes.forEach((index) => {
    const previous = visibleLabelIndexes[visibleLabelIndexes.length - 1]
    const requiredGap = previous === undefined
      ? 0
      : (String(previous + 1).length + String(index + 1).length) * fontSize * 0.3 + 2
    if (previous !== undefined && (index - previous) * cellPitch < requiredGap) {
      if (index === count - 1) visibleLabelIndexes.pop()
      else return
    }
    visibleLabelIndexes.push(index)
  })

  return Array.from({ length: count }, (_, index) => {
    const position = offset + ((index + 0.5) / count) * extent
    return {
      coordinate: index + 1,
      position: `${position * 100}%`,
      label: visibleLabelIndexes.includes(index) ? String(index + 1) : '',
      major: index === 0 || (index + 1) % 10 === 0,
      start: index === 0,
      end: index === count - 1,
    }
  })
}

/**
 * 把整张图纸按「拼豆圆点」风格绘制到 canvas。
 * @param context 2d canvas 上下文
 * @param canvasWidth/canvasHeight 画布尺寸（CSS px）
 * @param draft 图纸草稿
 * @param preserveAspectRatio 是否保持网格比例并居中绘制
 */
export function drawPatternOnCanvas(
  context: PatternCanvasContext,
  canvasWidth: number,
  canvasHeight: number,
  draft: PatternDraft,
  preserveAspectRatio = false,
): void {
  context.fillStyle = '#f7f7f7'
  context.fillRect(0, 0, canvasWidth, canvasHeight)
  const columns = draft.settings.width
  const rows = draft.settings.height
  const fittedCellSize = Math.min(canvasWidth / columns, canvasHeight / rows)
  const cellWidth = preserveAspectRatio ? fittedCellSize : canvasWidth / columns
  const cellHeight = preserveAspectRatio ? fittedCellSize : canvasHeight / rows
  const offsetX = preserveAspectRatio ? (canvasWidth - cellWidth * columns) / 2 : 0
  const offsetY = preserveAspectRatio ? (canvasHeight - cellHeight * rows) / 2 : 0
  // 圆点半径取格宽高较小者的 0.44，留出格间缝隙
  const radius = Math.min(cellWidth, cellHeight) * 0.44

  draft.cells.forEach((cell, index) => {
    if (cell.color === 'transparent') return
    const column = index % columns
    const row = Math.floor(index / columns)
    const centerX = offsetX + column * cellWidth + cellWidth / 2
    const centerY = offsetY + row * cellHeight + cellHeight / 2
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

  context.save()
  context.beginPath()
  context.rect(offsetX, offsetY, cellWidth * columns, cellHeight * rows)
  context.clip()
  context.beginPath()
  for (let column = 0; column <= columns; column += 1) {
    const x = offsetX + column * cellWidth
    context.moveTo(x, offsetY)
    context.lineTo(x, offsetY + cellHeight * rows)
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = offsetY + row * cellHeight
    context.moveTo(offsetX, y)
    context.lineTo(offsetX + cellWidth * columns, y)
  }
  context.strokeStyle = '#d7dce3'
  context.lineWidth = 0.5
  context.stroke()

  context.beginPath()
  for (let column = 0; column <= columns; column += 10) {
    const x = offsetX + column * cellWidth
    context.moveTo(x, offsetY)
    context.lineTo(x, offsetY + cellHeight * rows)
  }
  for (let row = 0; row <= rows; row += 10) {
    const y = offsetY + row * cellHeight
    context.moveTo(offsetX, y)
    context.lineTo(offsetX + cellWidth * columns, y)
  }
  context.strokeStyle = '#bb747e'
  context.lineWidth = 1
  context.stroke()
  context.restore()
}
