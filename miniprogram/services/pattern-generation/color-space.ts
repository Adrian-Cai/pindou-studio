export function srgbByteToLinear(channel: number): number {
  const normalized = channel / 255
  if (normalized <= 0.04045) return normalized / 12.92
  return Math.pow((normalized + 0.055) / 1.055, 2.4)
}

export function linearToSrgbByte(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel))
  const encoded = clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}
