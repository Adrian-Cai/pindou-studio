const CHANNEL_COUNT = 4
const RED_OFFSET = 0
const GREEN_OFFSET = 1
const BLUE_OFFSET = 2
const ALPHA_OFFSET = 3
const OPAQUE_ALPHA_THRESHOLD = 32
const SOBEL_NORMALIZATION = 4

export function calculateEdgeStrengths(
  sourceData: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  validateSourceData(sourceData, width, height)

  const luminance = new Float32Array(width * height)
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * CHANNEL_COUNT
    const alpha = sourceData[offset + ALPHA_OFFSET]
    if (alpha < OPAQUE_ALPHA_THRESHOLD) continue

    luminance[index] = (
      0.2126 * sourceData[offset + RED_OFFSET] +
      0.7152 * sourceData[offset + GREEN_OFFSET] +
      0.0722 * sourceData[offset + BLUE_OFFSET]
    ) / 255 * (alpha / 255)
  }

  const edgeStrengths = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const topLeft = readLuminance(luminance, width, height, x - 1, y - 1)
      const top = readLuminance(luminance, width, height, x, y - 1)
      const topRight = readLuminance(luminance, width, height, x + 1, y - 1)
      const left = readLuminance(luminance, width, height, x - 1, y)
      const right = readLuminance(luminance, width, height, x + 1, y)
      const bottomLeft = readLuminance(luminance, width, height, x - 1, y + 1)
      const bottom = readLuminance(luminance, width, height, x, y + 1)
      const bottomRight = readLuminance(luminance, width, height, x + 1, y + 1)

      const sobelX = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight
      const sobelY = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight
      edgeStrengths[y * width + x] = Math.min(
        1,
        Math.sqrt(sobelX * sobelX + sobelY * sobelY) / SOBEL_NORMALIZATION,
      )
    }
  }

  return edgeStrengths
}

function readLuminance(
  luminance: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const clampedX = Math.max(0, Math.min(width - 1, x))
  const clampedY = Math.max(0, Math.min(height - 1, y))
  return luminance[clampedY * width + clampedX]
}

function validateSourceData(
  sourceData: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 0 ||
    height < 0 ||
    sourceData.length !== width * height * CHANNEL_COUNT
  ) {
    throw new Error('边缘检测图片数据尺寸不匹配')
  }
}
