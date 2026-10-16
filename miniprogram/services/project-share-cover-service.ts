import { isAiTaskWork, isWorkDraft, type WorkItem } from '../models/pattern'
import type { TextImageWork } from './text-image-work-service'

export type ProjectTab = 'all' | 'recent' | 'draft' | 'completed' | 'text'

export interface ProjectShareCoverItem {
  id: string
  kind: 'pattern' | 'text'
  title: string
  coverPath: string
  updatedAt: number
  colorCount?: number
  width?: number
  height?: number
}

const WIDTH = 800
const HEIGHT = 640
const RECENT_WINDOW = 30 * 24 * 60 * 60 * 1000
const IMAGE_FALLBACK_PATH = '/assets/icons/image-upload.svg'
const COLORS = ['#e99a6f', '#86a995', '#e8c86f', '#8c9ec4', '#c98583', '#d1a75c']

export function parseProjectTab(value: unknown): ProjectTab {
  return value === 'recent' || value === 'draft' || value === 'completed' || value === 'text'
    ? value
    : 'all'
}

export function selectProjectShareCoverItems(
  tab: ProjectTab,
  works: readonly WorkItem[],
  textWorks: readonly TextImageWork[],
  now = Date.now(),
): ProjectShareCoverItem[] {
  const patterns = works
    .filter((work) => !isAiTaskWork(work) && Number.isFinite(work.updatedAt))
    .map((work): ProjectShareCoverItem => ({
      id: work.id,
      kind: 'pattern',
      title: work.title,
      coverPath: work.coverPath,
      updatedAt: work.updatedAt,
      colorCount: work.colorCount,
      width: work.width,
      height: work.height,
    }))
  const draftIds = new Set(works.filter((work) => !isAiTaskWork(work) && isWorkDraft(work)).map((work) => work.id))
  const completedIds = new Set(works.filter((work) => !isAiTaskWork(work) && !isWorkDraft(work)).map((work) => work.id))
  const textImages = textWorks
    .filter((work) => Number.isFinite(Date.parse(work.updatedAt)))
    .map((work): ProjectShareCoverItem => ({
      id: work.id,
      kind: 'text',
      // 文生图作品标题固定为通用名称，分享封面不读取或显示提示词。
      title: '文生图作品',
      coverPath: work.coverUrl,
      updatedAt: Date.parse(work.updatedAt),
      width: work.width,
      height: work.height,
    }))
  const newestFirst = (items: ProjectShareCoverItem[]) => items.sort((left, right) => right.updatedAt - left.updatedAt)

  if (tab === 'text') return newestFirst(textImages).slice(0, 1)
  if (tab === 'draft') return newestFirst(patterns.filter((item) => draftIds.has(item.id))).slice(0, 1)

  const savedPatterns = patterns
  if (tab === 'completed') {
    return newestFirst([
      ...savedPatterns.filter((item) => completedIds.has(item.id)),
      ...textImages,
    ]).slice(0, 1)
  }

  const saved = newestFirst([...savedPatterns, ...textImages])
  if (tab === 'recent') return saved.filter((item) => now - item.updatedAt <= RECENT_WINDOW).slice(0, 1)
  return saved.slice(0, 4)
}

export async function renderProjectShareCover(
  tab: ProjectTab,
  works: readonly WorkItem[],
  textWorks: readonly TextImageWork[],
): Promise<string> {
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: WIDTH, height: HEIGHT })
  const context = canvas.getContext('2d') as WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D
  const items = selectProjectShareCoverItems(tab, works, textWorks)
  drawBackground(context, tab)

  if (tab === 'all') await drawAllCover(context, canvas, items)
  else if (tab === 'recent') await drawRecentCover(context, canvas, items[0])
  else if (tab === 'draft') await drawDraftCover(context, canvas, items[0])
  else if (tab === 'completed') await drawCompletedCover(context, canvas, items[0])
  else await drawTextCover(context, canvas, items[0])

  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas: canvas as unknown as WechatMiniprogram.IAnyObject,
      fileType: 'jpg',
      quality: 0.88,
      width: WIDTH,
      height: HEIGHT,
      destWidth: WIDTH,
      destHeight: HEIGHT,
      success: ({ tempFilePath }) => resolve(tempFilePath),
      fail: reject,
    })
  })
}

function drawBackground(context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D, tab: ProjectTab): void {
  const backgrounds: Record<ProjectTab, string> = {
    all: '#f7f1e6',
    recent: '#f4eee6',
    draft: '#f3eddf',
    completed: '#edf3e8',
    text: '#f2edf3',
  }
  context.fillStyle = backgrounds[tab]
  context.fillRect(0, 0, WIDTH, HEIGHT)
  context.fillStyle = 'rgba(255,255,255,0.46)'
  context.beginPath()
  context.arc(740, 80, 96, 0, Math.PI * 2)
  context.fill()
}

async function drawAllCover(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  canvas: WechatMiniprogram.OffscreenCanvas,
  items: ProjectShareCoverItem[],
): Promise<void> {
  drawLabel(context, 'PIN DOU  ·  MY COLLECTION', 56, 42, '#7e806f', 18)
  drawText(context, '我的拼豆作品', 56, 77, 42, '#302e2a', 600, 390)
  const positions = [[56, 160], [412, 160], [56, 367], [412, 367]]
  for (let index = 0; index < positions.length; index += 1) {
    const [x, y] = positions[index]
    const item = items[index]
    roundedRect(context, x, y, 332, 180, 20, '#fffdf8')
    await drawItemImage(context, canvas, item, x + 10, y + 10, 312, 123, index)
    drawText(context, item?.title ?? '留一个位置给新作品', x + 18, y + 142, 18, '#393832', 600, 292)
  }
  drawBeadLine(context, 58, 588, 7)
  drawLabel(context, items.length ? `${items.length} 件作品 · 持续更新` : '从第一颗豆开始', 638, 584, '#777667', 15)
}

async function drawRecentCover(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  canvas: WechatMiniprogram.OffscreenCanvas,
  item?: ProjectShareCoverItem,
): Promise<void> {
  drawLabel(context, 'A LITTLE UPDATE', 62, 54, '#8a7464', 18)
  drawText(context, '最近更新', 62, 91, 50, '#302e2a', 600, 370)
  await drawItemImage(context, canvas, item, 62, 172, 386, 390, 1)
  drawText(context, item?.title ?? '最近的创作会出现在这里', 488, 254, 28, '#393832', 600, 254)
  drawLabel(context, item ? formatDate(item.updatedAt) : '等待下一次创作', 490, 310, '#847b70', 17)
  if (item?.colorCount) drawLabel(context, `${item.colorCount} 种拼豆色`, 490, 346, '#698373', 16)
  drawBeadLine(context, 492, 472, 8)
  drawText(context, '每一次更新，\n都是新的灵感。', 490, 514, 20, '#777267', 400, 235)
}

async function drawDraftCover(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  canvas: WechatMiniprogram.OffscreenCanvas,
  item?: ProjectShareCoverItem,
): Promise<void> {
  drawLabel(context, 'IN PROGRESS', 60, 52, '#927b55', 18)
  drawText(context, '还差几颗豆', 60, 92, 44, '#38342c', 600, 300)
  drawText(context, item?.title ?? '未完成的创作\n会留在这里', 60, 174, 24, '#6d675b', 500, 286)
  drawBeadLine(context, 62, 294, 8)
  drawLabel(context, item ? formatDate(item.updatedAt) : '草稿准备就绪', 62, 328, '#847d6d', 16)
  roundedRect(context, 336, 144, 402, 420, 24, '#fffdf7')
  await drawItemImage(context, canvas, item, 351, 159, 372, 390, 3)
  context.fillStyle = '#e8c86f'
  context.beginPath()
  context.arc(538, 148, 13, 0, Math.PI * 2)
  context.fill()
  drawLabel(context, '草稿', 664, 530, '#8b7650', 17)
}

async function drawCompletedCover(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  canvas: WechatMiniprogram.OffscreenCanvas,
  item?: ProjectShareCoverItem,
): Promise<void> {
  drawLabel(context, 'FINISHED WITH CARE', 60, 48, '#66816a', 18)
  drawText(context, '已完成', 60, 84, 44, '#303a31', 600, 260)
  drawText(context, '把喜欢的图案，\n一颗一颗拼出来。', 60, 143, 23, '#677366', 400, 350)
  await drawItemImage(context, canvas, item, 60, 246, 680, 320, 4)
  context.fillStyle = '#7fa183'
  context.beginPath()
  context.arc(688, 104, 42, 0, Math.PI * 2)
  context.fill()
  drawText(context, '✓', 674, 78, 46, '#ffffff', 600, 34)
  drawLabel(context, item?.title ?? '完成一件小作品', 62, 586, '#5f725f', 17)
}

async function drawTextCover(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  canvas: WechatMiniprogram.OffscreenCanvas,
  item?: ProjectShareCoverItem,
): Promise<void> {
  drawLabel(context, 'AI IMAGE  ·  BEAD IDEAS', 60, 46, '#856d87', 18)
  drawText(context, '文生图作品', 60, 83, 42, '#372f3a', 600, 380)
  await drawItemImage(context, canvas, item, 60, 158, 430, 414, 5)
  drawText(context, '灵感成像', 534, 245, 30, '#4a3f4b', 600, 205)
  drawLabel(context, item ? formatDate(item.updatedAt) : '等待灵感出现', 536, 296, '#84778a', 16)
  drawLabel(context, item?.width && item.height ? `${item.width} × ${item.height}` : 'AI 原图', 536, 337, '#84778a', 16)
  drawBeadLine(context, 536, 398, 7)
  drawText(context, '把脑海里的画面，\n留成一张作品。', 536, 436, 20, '#736877', 400, 206)
}

async function drawItemImage(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  canvas: WechatMiniprogram.OffscreenCanvas,
  item: ProjectShareCoverItem | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
  paletteOffset: number,
): Promise<void> {
  context.save()
  roundedPath(context, x, y, width, height, 14)
  context.clip()
  context.fillStyle = '#ece6d9'
  context.fillRect(x, y, width, height)
  if (item?.coverPath && item.coverPath !== IMAGE_FALLBACK_PATH) {
    const image = await loadImage(canvas, item.coverPath)
    if (image) {
      const cropWidth = Math.min(image.width, image.height * width / height)
      const cropHeight = cropWidth * height / width
      context.drawImage(
        image,
        (image.width - cropWidth) / 2,
        (image.height - cropHeight) / 2,
        cropWidth,
        cropHeight,
        x,
        y,
        width,
        height,
      )
      context.restore()
      return
    }
  }
  drawBeadMosaic(context, x, y, width, height, paletteOffset)
  context.restore()
}

function loadImage(canvas: WechatMiniprogram.OffscreenCanvas, path: string): Promise<WechatMiniprogram.Image | null> {
  return new Promise((resolve) => {
    const image = canvas.createImage()
    let settled = false
    const finish = (result: WechatMiniprogram.Image | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => finish(null), 2_000)
    image.onload = () => finish(image)
    image.onerror = () => finish(null)
    image.src = path
  })
}

function drawBeadMosaic(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  paletteOffset: number,
): void {
  const size = Math.min(width, height) / 12
  const centerX = x + width / 2
  const centerY = y + height / 2
  for (let row = -4; row <= 4; row += 1) {
    for (let column = -4; column <= 4; column += 1) {
      const distance = Math.abs(row) + Math.abs(column)
      if (distance > 7 || ((row * 3 + column + paletteOffset) % 5 === 0)) continue
      context.fillStyle = COLORS[Math.abs(row * 2 + column + paletteOffset) % COLORS.length]
      context.beginPath()
      context.arc(centerX + column * size * 1.2, centerY + row * size * 1.2, size * 0.37, 0, Math.PI * 2)
      context.fill()
    }
  }
}

function drawBeadLine(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  x: number,
  y: number,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    context.fillStyle = COLORS[index % COLORS.length]
    context.beginPath()
    context.arc(x + index * 24, y, 7, 0, Math.PI * 2)
    context.fill()
  }
}

function drawText(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight: number,
  maxWidth: number,
): void {
  context.fillStyle = color
  context.font = `${weight} ${size}px sans-serif`
  context.textBaseline = 'top'
  text.split('\n').forEach((line, index) => {
    context.fillText(truncate(line, Math.floor(maxWidth / (size * 0.95))), x, y + index * size * 1.38, maxWidth)
  })
}

function drawLabel(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  size: number,
): void {
  context.fillStyle = color
  context.font = `500 ${size}px sans-serif`
  context.textBaseline = 'top'
  context.fillText(text, x, y, WIDTH - x - 48)
}

function roundedRect(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
): void {
  roundedPath(context, x, y, width, height, radius)
  context.fillStyle = color
  context.fill()
}

function roundedPath(
  context: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.lineTo(x + width - radius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + radius)
  context.lineTo(x + width, y + height - radius)
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  context.lineTo(x + radius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - radius)
  context.lineTo(x, y + radius)
  context.quadraticCurveTo(x, y, x + radius, y)
  context.closePath()
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`
}

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value)
  return characters.length > maxLength ? `${characters.slice(0, Math.max(1, maxLength - 1)).join('')}…` : value
}
