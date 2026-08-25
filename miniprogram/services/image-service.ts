import { DEFAULT_PATTERN_SETTINGS } from '../config/product'
import type { PatternCell, PatternDraft, PatternSettings } from '../models/pattern'

interface RGB {
  r: number
  g: number
  b: number
}

interface Canvas2DContext {
  drawImage(
    image: WechatMiniprogram.Image,
    sx: number,
    sy: number,
    sourceWidth: number,
    sourceHeight: number,
    dx: number,
    dy: number,
    destinationWidth: number,
    destinationHeight: number,
  ): void
  getImageData(
    sx: number,
    sy: number,
    width: number,
    height: number,
  ): WechatMiniprogram.ImageData
}

export class UnsupportedImageFormatError extends Error {
  constructor() {
    super('仅支持 JPG、PNG、WEBP 格式')
    this.name = 'UnsupportedImageFormatError'
  }
}

export async function chooseSourceImage(): Promise<string | null> {
  const result = await wx.chooseMedia({
    count: 1,
    mediaType: ['image'],
    sourceType: ['album', 'camera'],
  })
  const sourceImagePath = result.tempFiles[0]?.tempFilePath ?? null
  if (!sourceImagePath) return null

  const header = await readFileHeader(sourceImagePath)
  if (!isSupportedImageHeader(header)) {
    throw new UnsupportedImageFormatError()
  }

  return sourceImagePath
}

export async function createDraft(
  sourceImagePath: string,
  settings: Partial<PatternSettings>,
): Promise<PatternDraft> {
  const normalizedSettings: PatternSettings = {
    ...DEFAULT_PATTERN_SETTINGS,
    ...settings,
  }
  const cells = await createPatternCells(sourceImagePath, normalizedSettings)
  const now = Date.now()

  return {
    id: 'draft-' + now,
    sourceImagePath,
    createdAt: now,
    settings: normalizedSettings,
    cells,
  }
}

async function createPatternCells(
  sourceImagePath: string,
  settings: PatternSettings,
): Promise<PatternCell[]> {
  const { width, height, colorLimit } = settings
  const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
  const context = canvas.getContext('2d') as Canvas2DContext
  const image = canvas.createImage()

  await loadCanvasImage(image, sourceImagePath)

  const sourceRatio = image.width / image.height
  const targetRatio = width / height
  let sourceX = 0
  let sourceY = 0
  let sourceWidth = image.width
  let sourceHeight = image.height

  if (sourceRatio > targetRatio) {
    sourceWidth = image.height * targetRatio
    sourceX = (image.width - sourceWidth) / 2
  } else if (sourceRatio < targetRatio) {
    sourceHeight = image.width / targetRatio
    sourceY = (image.height - sourceHeight) / 2
  }

  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  )

  const imageData = context.getImageData(0, 0, width, height)
  const pixels = readOpaquePixels(imageData.data)
  const palette = createMedianCutPalette(pixels, Math.max(1, colorLimit))

  return Array.from({ length: width * height }, (_, index) => {
    const offset = index * 4
    const alpha = imageData.data[offset + 3]
    if (alpha < 32) return { color: 'transparent', colorCode: '' }

    const color = findNearestColor(
      {
        r: imageData.data[offset],
        g: imageData.data[offset + 1],
        b: imageData.data[offset + 2],
      },
      palette,
    )
    const paletteIndex = palette.indexOf(color)
    return {
      color: rgbToHex(color),
      colorCode: `C${String(paletteIndex + 1).padStart(2, '0')}`,
    }
  })
}

function loadCanvasImage(
  image: WechatMiniprogram.Image,
  sourceImagePath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = sourceImagePath
  })
}

function readOpaquePixels(data: Uint8ClampedArray): RGB[] {
  const pixels: RGB[] = []
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] < 32) continue
    pixels.push({ r: data[offset], g: data[offset + 1], b: data[offset + 2] })
  }
  return pixels
}

function createMedianCutPalette(pixels: RGB[], colorLimit: number): RGB[] {
  if (pixels.length === 0) return [{ r: 255, g: 255, b: 255 }]

  const buckets: RGB[][] = [pixels]
  while (buckets.length < colorLimit) {
    const splitIndex = findBucketToSplit(buckets)
    const bucket = buckets[splitIndex]
    if (bucket.length < 2) break

    const channel = getWidestChannel(bucket)
    bucket.sort((a, b) => a[channel] - b[channel])
    const middle = Math.floor(bucket.length / 2)
    buckets.splice(splitIndex, 1, bucket.slice(0, middle), bucket.slice(middle))
  }

  return buckets.map(averageColor)
}

function findBucketToSplit(buckets: RGB[][]): number {
  let selectedIndex = 0
  let selectedScore = -1
  buckets.forEach((bucket, index) => {
    const range = getColorRange(bucket)
    const score = Math.max(range.r, range.g, range.b) * bucket.length
    if (score > selectedScore) {
      selectedScore = score
      selectedIndex = index
    }
  })
  return selectedIndex
}

function getWidestChannel(bucket: RGB[]): keyof RGB {
  const range = getColorRange(bucket)
  if (range.r >= range.g && range.r >= range.b) return 'r'
  if (range.g >= range.b) return 'g'
  return 'b'
}

function getColorRange(bucket: RGB[]): RGB {
  const min = { r: 255, g: 255, b: 255 }
  const max = { r: 0, g: 0, b: 0 }
  bucket.forEach((color) => {
    min.r = Math.min(min.r, color.r)
    min.g = Math.min(min.g, color.g)
    min.b = Math.min(min.b, color.b)
    max.r = Math.max(max.r, color.r)
    max.g = Math.max(max.g, color.g)
    max.b = Math.max(max.b, color.b)
  })
  return { r: max.r - min.r, g: max.g - min.g, b: max.b - min.b }
}

function averageColor(bucket: RGB[]): RGB {
  const total = bucket.reduce(
    (sum, color) => ({
      r: sum.r + color.r,
      g: sum.g + color.g,
      b: sum.b + color.b,
    }),
    { r: 0, g: 0, b: 0 },
  )
  return {
    r: Math.round(total.r / bucket.length),
    g: Math.round(total.g / bucket.length),
    b: Math.round(total.b / bucket.length),
  }
}

function findNearestColor(pixel: RGB, palette: RGB[]): RGB {
  let nearest = palette[0]
  let nearestDistance = Number.POSITIVE_INFINITY
  palette.forEach((color) => {
    const red = pixel.r - color.r
    const green = pixel.g - color.g
    const blue = pixel.b - color.b
    const distance = red * red + green * green + blue * blue
    if (distance < nearestDistance) {
      nearest = color
      nearestDistance = distance
    }
  })
  return nearest
}

function rgbToHex(color: RGB): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`
}

function readFileHeader(filePath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      position: 0,
      length: 12,
      success({ data }) {
        if (typeof data === 'string') {
          reject(new Error('无法读取图片文件头'))
          return
        }
        resolve(new Uint8Array(data))
      },
      fail: reject,
    })
  })
}

export function isSupportedImageHeader(bytes: Uint8Array): boolean {
  return isJpeg(bytes) || isPng(bytes) || isWebp(bytes)
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return signature.every((byte, index) => bytes[index] === byte)
}

function isWebp(bytes: Uint8Array): boolean {
  return hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP')
}

function hasAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  return [...expected].every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  )
}
