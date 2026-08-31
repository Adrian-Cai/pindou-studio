function calculateCenterCrop(sourceWidth, sourceHeight, targetWidth, targetHeight) {
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

function readOpaquePixels(data) {
  const pixels = []
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] < 32) continue
    pixels.push({ r: data[offset], g: data[offset + 1], b: data[offset + 2] })
  }
  return pixels
}

function createMedianCutPalette(pixels, colorLimit) {
  if (pixels.length === 0) return [{ r: 255, g: 255, b: 255 }]

  const buckets = [pixels]
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

function findBucketToSplit(buckets) {
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

function getWidestChannel(bucket) {
  const range = getColorRange(bucket)
  if (range.r >= range.g && range.r >= range.b) return 'r'
  if (range.g >= range.b) return 'g'
  return 'b'
}

function getColorRange(bucket) {
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

function averageColor(bucket) {
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

function findNearestColor(pixel, palette) {
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

function rgbToHex(color) {
  return `#${[color.r, color.g, color.b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`
}

function createPatternCells(data, colorLimit) {
  const palette = createMedianCutPalette(
    readOpaquePixels(data),
    Math.max(1, colorLimit),
  )

  return Array.from({ length: data.length / 4 }, (_, index) => {
    const offset = index * 4
    const alpha = data[offset + 3]
    if (alpha < 32) return { color: 'transparent', colorCode: '' }

    const color = findNearestColor(
      { r: data[offset], g: data[offset + 1], b: data[offset + 2] },
      palette,
    )
    const paletteIndex = palette.indexOf(color)
    return {
      color: rgbToHex(color),
      colorCode: `C${String(paletteIndex + 1).padStart(2, '0')}`,
    }
  })
}

module.exports = {
  averageColor,
  calculateCenterCrop,
  createMedianCutPalette,
  createPatternCells,
  findBucketToSplit,
  findNearestColor,
  getWidestChannel,
  readOpaquePixels,
  rgbToHex,
}
