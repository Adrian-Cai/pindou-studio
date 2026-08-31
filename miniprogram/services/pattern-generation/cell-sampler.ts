import { linearToSrgbByte, srgbByteToLinear } from './color-space'

export const SAMPLE_SCALE = 4

const CHANNEL_COUNT = 4
const RED_OFFSET = 0
const GREEN_OFFSET = 1
const BLUE_OFFSET = 2
const ALPHA_OFFSET = 3

export function sampleCellsLinearRgb(
  sourceData: Uint8ClampedArray,
  targetWidth: number,
  targetHeight: number,
): Uint8ClampedArray {
  const sourceWidth = targetWidth * SAMPLE_SCALE
  const expectedLength = sourceWidth * targetHeight * SAMPLE_SCALE * CHANNEL_COUNT
  if (sourceData.length !== expectedLength) {
    throw new Error('采样图片数据尺寸不匹配')
  }

  const sampledData = new Uint8ClampedArray(
    targetWidth * targetHeight * CHANNEL_COUNT,
  )
  const samplesPerCell = SAMPLE_SCALE * SAMPLE_SCALE

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      let linearRed = 0
      let linearGreen = 0
      let linearBlue = 0
      let alphaSum = 0

      for (let sampleY = 0; sampleY < SAMPLE_SCALE; sampleY += 1) {
        const sourceY = targetY * SAMPLE_SCALE + sampleY
        for (let sampleX = 0; sampleX < SAMPLE_SCALE; sampleX += 1) {
          const sourceX = targetX * SAMPLE_SCALE + sampleX
          const sourceOffset = (sourceY * sourceWidth + sourceX) * CHANNEL_COUNT
          const alpha = sourceData[sourceOffset + ALPHA_OFFSET]
          alphaSum += alpha
          if (alpha === 0) continue

          const alphaWeight = alpha / 255
          linearRed += srgbByteToLinear(sourceData[sourceOffset + RED_OFFSET]) * alphaWeight
          linearGreen += srgbByteToLinear(sourceData[sourceOffset + GREEN_OFFSET]) * alphaWeight
          linearBlue += srgbByteToLinear(sourceData[sourceOffset + BLUE_OFFSET]) * alphaWeight
        }
      }

      const targetOffset = (targetY * targetWidth + targetX) * CHANNEL_COUNT
      if (alphaSum > 0) {
        const inverseAlphaWeight = 255 / alphaSum
        sampledData[targetOffset + RED_OFFSET] = linearToSrgbByte(
          linearRed * inverseAlphaWeight,
        )
        sampledData[targetOffset + GREEN_OFFSET] = linearToSrgbByte(
          linearGreen * inverseAlphaWeight,
        )
        sampledData[targetOffset + BLUE_OFFSET] = linearToSrgbByte(
          linearBlue * inverseAlphaWeight,
        )
      }
      sampledData[targetOffset + ALPHA_OFFSET] = Math.round(alphaSum / samplesPerCell)
    }
  }

  return sampledData
}
