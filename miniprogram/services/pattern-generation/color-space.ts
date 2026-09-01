import type { RGB } from './color-utils'

export interface LinearRGB {
  r: number
  g: number
  b: number
}

export interface OKLab {
  l: number
  a: number
  b: number
}

export function srgbByteToLinear(channel: number): number {
  const normalized = channel / 255
  if (normalized <= 0.04045) return normalized / 12.92
  return Math.pow((normalized + 0.055) / 1.055, 2.4)
}

export function rgbToLinearRgb(color: RGB): LinearRGB {
  return {
    r: srgbByteToLinear(color.r),
    g: srgbByteToLinear(color.g),
    b: srgbByteToLinear(color.b),
  }
}

export function linearRgbToOklab(color: LinearRGB): OKLab {
  const l = Math.cbrt(
    0.4122214708 * color.r + 0.5363325363 * color.g + 0.0514459929 * color.b,
  )
  const m = Math.cbrt(
    0.2119034982 * color.r + 0.6806995451 * color.g + 0.1073969566 * color.b,
  )
  const s = Math.cbrt(
    0.0883024619 * color.r + 0.2817188376 * color.g + 0.6299787005 * color.b,
  )

  return {
    l: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  }
}

export function rgbToOklab(color: RGB): OKLab {
  return linearRgbToOklab(rgbToLinearRgb(color))
}

export function oklabDistanceSquared(left: OKLab, right: OKLab): number {
  const lightness = left.l - right.l
  const greenRed = left.a - right.a
  const blueYellow = left.b - right.b
  return lightness * lightness + greenRed * greenRed + blueYellow * blueYellow
}

export function linearToSrgbByte(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel))
  const encoded = clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}
