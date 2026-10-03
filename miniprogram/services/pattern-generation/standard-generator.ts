/**
 * 标准模式「图片转图纸」主流程：把用户图片处理成网格化的 PatternCell 数组。
 *
 * 职责：负责整条生成链路——缩放采样、中心裁切、边缘检测、中位切分取色板、
 *       逐格最近色匹配、噪点清理；不负责 AI 生成模式，也不负责编辑器里的手绘。
 * 调用方：standard 生成页（选图后调用 generateStandardPatternCells）。
 * 关键点：在小程序离屏 2d canvas 上完成采样，alpha < 32 视为透明；
 *       取色板先用中位切分得到候选色，再用 Mard 调色板做 k-means 式贪心选色。
 */
import type { PatternCell, PatternSettings } from '../../models/pattern'
import { SAMPLE_SCALE, sampleCellsLinearRgb } from './cell-sampler'
import type { RGB } from './color-utils'
import { cleanupPatternCells } from './cleanup'
import { calculateCenterCrop } from './crop'
import { calculateEdgeStrengths } from './edge-detector'
import { createMedianCutCandidates } from './median-cut'
import { findNearestColorIndexOklab } from './oklab-matcher'
import { selectMardPalette } from './palette-selector'

// 候选色数量 = 调色板上限 * 该系数，先多取候选色再精选，避免漏掉低频主色
const CANDIDATE_OVERSAMPLING_FACTOR = 4
// 候选色数量硬上限，防止极端多色图片导致中位切分耗时爆炸
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

/**
 * 生成标准模式图纸：输入原图路径与图纸尺寸/色数设置，输出每格的色块（PatternCell）。
 * @param sourceImagePath 原图本地路径（已下载/选好的图）
 * @param settings 图纸设置：width/height 为网格尺寸，colorLimit 为最大色数
 * @returns 长度为 width*height 的 PatternCell 数组（按行优先排列），透明格 color 为 'transparent'
 */
export async function generateStandardPatternCells(
  sourceImagePath: string,
  settings: PatternSettings,
): Promise<PatternCell[]> {
  const { width, height, colorLimit } = settings
  // 采样分辨率 = 网格尺寸 * SAMPLE_SCALE，比最终网格更精细，采样时降采样抗锯齿
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
  const edgeStrengths = calculateEdgeStrengths(sampledData, width, height)
  const pixels = readOpaquePixels(sampledData)
  const candidateLimit = Math.min(
    MAX_CANDIDATE_COLORS,
    Math.max(1, colorLimit) * CANDIDATE_OVERSAMPLING_FACTOR,
  )
  const candidates = createMedianCutCandidates(pixels, candidateLimit)
  const palette = selectMardPalette(candidates, colorLimit)

  const cells = Array.from({ length: width * height }, (_, index) => {
    const offset = index * 4
    const alpha = sampledData[offset + 3]
    // alpha < 32（约 12.5%）视为透明格，不参与配色
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

  // 最后用边缘强度保护轮廓，清理孤立噪点色块
  return cleanupPatternCells(cells, width, height, edgeStrengths)
}

/**
 * 把本地图片路径加载到离屏 canvas 的 Image 对象上，解码失败才 reject。
 * @param image wx.createImage() 创建的 Image 实例
 * @param sourceImagePath 图片本地路径
 */
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

// 从 RGBA 采样数据中抽出不透明像素，供中位切分建色板（透明区域不参与配色统计）
function readOpaquePixels(data: Uint8ClampedArray): RGB[] {
  const pixels: RGB[] = []
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] < 32) continue
    pixels.push({ r: data[offset], g: data[offset + 1], b: data[offset + 2] })
  }
  return pixels
}
