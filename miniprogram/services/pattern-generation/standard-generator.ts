import type { PatternCell, PatternSettings } from '../../models/pattern'
import { SAMPLE_SCALE, sampleCellsLinearRgb } from './cell-sampler'
import type { RGB } from './color-utils'
import { calculateCenterCrop } from './crop'
import { createMedianCutCandidates } from './median-cut'
import { findNearestColorIndexOklab } from './oklab-matcher'
import { selectMardPalette } from './palette-selector'

const CANDIDATE_OVERSAMPLING_FACTOR = 4
const MAX_CANDIDATE_COLORS = 128

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
  const sampleWidth = width * SAMPLE_SCALE
  const sampleHeight = height * SAMPLE_SCALE
  const canvas = wx.createOffscreenCanvas({
    type: '2d',
    width: sampleWidth,
    height: sampleHeight,
  })
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
    sampleWidth,
    sampleHeight,
  )

  const imageData = context.getImageData(0, 0, sampleWidth, sampleHeight)
  const sampledData = sampleCellsLinearRgb(imageData.data, width, height)
  const pixels = readOpaquePixels(sampledData)
  const candidateLimit = Math.min(
    MAX_CANDIDATE_COLORS,
    Math.max(1, colorLimit) * CANDIDATE_OVERSAMPLING_FACTOR,
  )
  const candidates = createMedianCutCandidates(pixels, candidateLimit)
  const palette = selectMardPalette(candidates, colorLimit)

  return Array.from({ length: width * height }, (_, index) => {
    const offset = index * 4
    const alpha = sampledData[offset + 3]
    if (alpha < 32) return { color: 'transparent', colorCode: '' }

    const paletteIndex = findNearestColorIndexOklab(
      {
        r: sampledData[offset],
        g: sampledData[offset + 1],
        b: sampledData[offset + 2],
      },
      palette,
    )
    const beadColor = palette[paletteIndex]
    return {
      color: beadColor.hex,
      colorCode: beadColor.code,
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
