import type { RGB } from './color-utils'

export function createMedianCutPalette(pixels: RGB[], colorLimit: number): RGB[] {
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
