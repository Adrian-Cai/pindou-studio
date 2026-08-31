import type { PatternCell, PatternSettings } from '../../models/pattern'
import { findNearestColor, rgbToHex } from './color-utils'
import type { RGB } from './color-utils'
import { calculateCenterCrop } from './crop'
import { createMedianCutPalette } from './median-cut'

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

export async function generateStandardPatternCells(
  sourceImagePath: string,
  settings: PatternSettings,
): Promise<PatternCell[]> {
  const { width, height, colorLimit } = settings
  const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
  const context = canvas.getContext('2d') as Canvas2DContext
  const image = canvas.createImage()

  await loadCanvasImage(image, sourceImagePath)

  const crop = calculateCenterCrop(image.width, image.height, width, height)
  context.drawImage(
    image,
    crop.sourceX,
    crop.sourceY,
    crop.sourceWidth,
    crop.sourceHeight,
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
