const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const compiledRoot = path.resolve(
  __dirname,
  '..',
  '..',
  '.pattern-test-build',
  'miniprogram',
)
const patternGenerationDirectory = path.join(
  compiledRoot,
  'services',
  'pattern-generation',
)
const { createDraft } = require(path.join(compiledRoot, 'services', 'image-service.js'))
const { calculateEdgeStrengths } = require(
  path.join(patternGenerationDirectory, 'edge-detector.js'),
)
const { cleanupPatternCells } = require(
  path.join(patternGenerationDirectory, 'cleanup.js'),
)
const { MARD_CLASSIC_PALETTE } = require(
  path.join(patternGenerationDirectory, 'palette-selector.js'),
)

const colorsByCode = new Map(
  MARD_CLASSIC_PALETTE.map((color) => [color.code, color]),
)

function cell(colorCode) {
  if (!colorCode) return { color: 'transparent', colorCode: '' }
  const color = colorsByCode.get(colorCode)
  assert.ok(color, `Missing MARD test color ${colorCode}`)
  return { color: color.hex, colorCode }
}

function createRgba(rows) {
  const height = rows.length
  const width = rows[0].length
  const data = new Uint8ClampedArray(width * height * 4)
  rows.forEach((row, y) => row.forEach((pixel, x) => {
    data.set(pixel, (y * width + x) * 4)
  }))
  return { data, width, height }
}

function opaque(color) {
  return [...color, 255]
}

function expandForSampling({ data, width, height }) {
  const scale = 4
  const expanded = new Uint8ClampedArray(width * scale * height * scale * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = data.slice((y * width + x) * 4, (y * width + x + 1) * 4)
      for (let offsetY = 0; offsetY < scale; offsetY += 1) {
        for (let offsetX = 0; offsetX < scale; offsetX += 1) {
          const targetOffset = (
            ((y * scale + offsetY) * width * scale) +
            x * scale +
            offsetX
          ) * 4
          expanded.set(pixel, targetOffset)
        }
      }
    }
  }
  return expanded
}

function installWxHarness(imageData, width, height) {
  global.wx = {
    createOffscreenCanvas() {
      return {
        createImage() {
          const image = { width, height }
          Object.defineProperty(image, 'src', {
            set() {
              queueMicrotask(() => image.onload())
            },
          })
          return image
        },
        getContext() {
          return {
            drawImage() {},
            getImageData() {
              return { data: new Uint8ClampedArray(imageData) }
            },
          }
        },
      }
    },
  }
}

test('flat pixels produce near-zero edge strength', () => {
  const flat = createRgba([
    [opaque([120, 120, 120]), opaque([120, 120, 120])],
    [opaque([120, 120, 120]), opaque([120, 120, 120])],
  ])
  const edges = calculateEdgeStrengths(flat.data, flat.width, flat.height)

  assert.deepEqual([...edges], [0, 0, 0, 0])
})

test('bright-dark boundary increases edge strength', () => {
  const boundary = createRgba([
    [opaque([0, 0, 0]), opaque([255, 255, 255]), opaque([255, 255, 255])],
    [opaque([0, 0, 0]), opaque([255, 255, 255]), opaque([255, 255, 255])],
    [opaque([0, 0, 0]), opaque([255, 255, 255]), opaque([255, 255, 255])],
  ])
  const edges = calculateEdgeStrengths(boundary.data, boundary.width, boundary.height)

  assert.ok(edges[1] > 0.9)
  assert.ok(edges[0] > 0.9)
  assert.ok(edges[4] > 0.9)
})

test('transparent pixels and size boundaries are safe', () => {
  assert.deepEqual([...calculateEdgeStrengths(new Uint8ClampedArray(), 0, 0)], [])
  assert.deepEqual(
    [...calculateEdgeStrengths(new Uint8ClampedArray([255, 0, 0, 0]), 1, 1)],
    [0],
  )
  assert.throws(
    () => calculateEdgeStrengths(new Uint8ClampedArray(), 1, 1),
    /边缘检测图片数据尺寸不匹配/,
  )
})

test('edge protection preserves a close shade at a structural boundary', () => {
  const original = [
    cell('G1'), cell('G1'), cell('G1'),
    cell('G1'), cell('G18'), cell('G1'),
    cell('G1'), cell('G1'), cell('G1'),
  ]
  const protectedCells = cleanupPatternCells(
    original,
    3,
    3,
    [0, 0, 0, 0, 0, 0.8, 0, 0, 0],
  )

  assert.deepEqual(protectedCells, original)
})

test('production generator uses edge protection without changing output shape or limit', async () => {
  const baseColor = colorsByCode.get('G1').rgb
  const edgeColor = colorsByCode.get('A23').rgb
  const source = createRgba([
    [opaque([baseColor.r, baseColor.g, baseColor.b]), opaque([baseColor.r, baseColor.g, baseColor.b]), opaque([baseColor.r, baseColor.g, baseColor.b])],
    [opaque([baseColor.r, baseColor.g, baseColor.b]), opaque([edgeColor.r, edgeColor.g, edgeColor.b]), opaque([baseColor.r, baseColor.g, baseColor.b])],
    [opaque([baseColor.r, baseColor.g, baseColor.b]), opaque([baseColor.r, baseColor.g, baseColor.b]), opaque([baseColor.r, baseColor.g, baseColor.b])],
  ])
  installWxHarness(expandForSampling(source), source.width, source.height)

  const draft = await createDraft('fixture://phase-6-edge-protection', {
    width: 3,
    height: 3,
    colorLimit: 24,
    brand: 'MARD',
  })
  const colorCodes = new Set(draft.cells.map((item) => item.colorCode))

  assert.equal(draft.cells.length, 9)
  assert.ok(colorCodes.size <= 24)
  assert.equal(draft.settings.colorLimit, 24)
  assert.equal(draft.cells[4].colorCode, 'A23')
  assert.equal(cleanupPatternCells(draft.cells, 3, 3)[4].colorCode, 'G1')
})
