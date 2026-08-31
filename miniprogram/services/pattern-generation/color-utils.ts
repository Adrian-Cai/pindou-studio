export interface RGB {
  r: number
  g: number
  b: number
}

export function findNearestColor(pixel: RGB, palette: RGB[]): RGB {
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

export function rgbToHex(color: RGB): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`
}
