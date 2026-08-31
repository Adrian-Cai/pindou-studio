function expandPixels(pixelSpec, width, height) {
  const pixelCount = width * height
  if (pixelSpec.type === 'fill') {
    return new Uint8ClampedArray(
      Array.from({ length: pixelCount }, () => pixelSpec.rgba).flat(),
    )
  }
  if (pixelSpec.type === 'list') {
    if (pixelSpec.rgba.length !== pixelCount) {
      throw new Error(`Expected ${pixelCount} RGBA pixels, got ${pixelSpec.rgba.length}`)
    }
    return new Uint8ClampedArray(pixelSpec.rgba.flat())
  }
  throw new Error(`Unsupported pixel fixture type: ${pixelSpec.type}`)
}

function serializeCell(cell) {
  return `${cell.color}:${cell.colorCode}`
}

function derivePalette(cells) {
  const colorsByCode = new Map()
  cells.forEach((cell) => {
    if (!cell.colorCode || colorsByCode.has(cell.colorCode)) return
    colorsByCode.set(cell.colorCode, cell.color)
  })
  return [...colorsByCode]
    .sort(([leftCode], [rightCode]) => leftCode.localeCompare(rightCode))
    .map(([colorCode, color]) => `${colorCode}:${color}`)
}

function fnv1a32(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function createMatrixHash(serializedCells) {
  return fnv1a32(serializedCells.join('|'))
}

function createPaletteHash(serializedPalette) {
  return fnv1a32(serializedPalette.join('|'))
}

module.exports = {
  createMatrixHash,
  createPaletteHash,
  derivePalette,
  expandPixels,
  fnv1a32,
  serializeCell,
}
