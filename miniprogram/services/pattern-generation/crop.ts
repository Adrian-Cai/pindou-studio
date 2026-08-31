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
