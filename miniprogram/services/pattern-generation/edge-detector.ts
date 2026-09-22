/**
 * 边缘检测：用 Sobel 算子算出每格的边缘强度（0~1），供噪点清理保护轮廓。
 *
 * 职责：把 RGBA 采样数据转成亮度图，再做 3x3 Sobel 卷积得梯度幅值；
 *       不负责配色与清理，只输出边缘强度数组。
 * 调用方：standard-generator（生成主流程）。
 * 关键点：像素尺寸必须与 width*height*4 严格一致，否则抛错；
 *       亮度按 BT.601 权重并乘 alpha 透明度，避免透明边被当成强边缘。
 */
const CHANNEL_COUNT = 4
const RED_OFFSET = 0
const GREEN_OFFSET = 1
const BLUE_OFFSET = 2
const ALPHA_OFFSET = 3
// alpha 低于该阈值（约 12.5%）视为透明，不参与亮度/边缘计算
const OPAQUE_ALPHA_THRESHOLD = 32
// Sobel 梯度幅值除 4 归一化到大致 0~1，再 clamp 上限 1
const SOBEL_NORMALIZATION = 4

/**
 * 计算每格的边缘强度。
 * @param sourceData RGBA 采样数据，长度须为 width*height*4
 * @param width 网格宽
 * @param height 网格高
 * @returns 长度为 width*height 的边缘强度数组（行优先，0~1）
 */
export function calculateEdgeStrengths(
  sourceData: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  validateSourceData(sourceData, width, height)

  // 先按 BT.601 亮度权重转灰度，再乘 alpha 融入透明度
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
      // 取 3x3 邻域 8 个方向的亮度，越界自动 clamp 到边缘
      const topLeft = readLuminance(luminance, width, height, x - 1, y - 1)
      const top = readLuminance(luminance, width, height, x, y - 1)
      const topRight = readLuminance(luminance, width, height, x + 1, y - 1)
      const left = readLuminance(luminance, width, height, x - 1, y)
      const right = readLuminance(luminance, width, height, x + 1, y)
      const bottomLeft = readLuminance(luminance, width, height, x - 1, y + 1)
      const bottom = readLuminance(luminance, width, height, x, y + 1)
      const bottomRight = readLuminance(luminance, width, height, x + 1, y + 1)

      // Sobel 卷积：水平与垂直梯度，幅值即边缘强度
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

// 读取某格亮度，越界坐标 clamp 到图像边缘（等效于边缘复制填充）
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

// 校验输入：尺寸必须为非负整数且长度严格等于 width*height*4，否则抛错
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
