export interface SourceCropRect {
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
}

export function calculateCenterCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): SourceCropRect {
  // 任一边为 0 / 负 / 非有限时，下面的比值会算出 0、Infinity 或 NaN，
  // 裁切矩形也跟着变成 NaN —— canvas 的 drawImage 拿到 NaN 会直接抛错，
  // 报错信息又是无意义的 "Invalid arguments"，排查成本极高。这里挡在最前面。
  const dimensions = [sourceWidth, sourceHeight, targetWidth, targetHeight]
  if (!dimensions.every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error(
      `calculateCenterCrop：尺寸必须为正数，收到 ${sourceWidth}x${sourceHeight} → ${targetWidth}x${targetHeight}`,
    )
  }
  const sourceRatio = sourceWidth / sourceHeight
  const targetRatio = targetWidth / targetHeight
  let sourceX = 0
  let sourceY = 0
  let croppedWidth = sourceWidth
  let croppedHeight = sourceHeight

  if (sourceRatio > targetRatio) {
    croppedWidth = sourceHeight * targetRatio
    sourceX = (sourceWidth - croppedWidth) / 2
  } else if (sourceRatio < targetRatio) {
    croppedHeight = sourceWidth / targetRatio
    sourceY = (sourceHeight - croppedHeight) / 2
  }

  return {
    sourceX,
    sourceY,
    sourceWidth: croppedWidth,
    sourceHeight: croppedHeight,
  }
}
