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

function createGrid(rows) {
  return rows.flatMap((row) => [...row].map(cell))
}

function createSampleData(cells, width, height) {
  const sampleScale = 4
  const sourceWidth = width * sampleScale
  const data = new Uint8ClampedArray(sourceWidth * height * sampleScale * 4)
  cells.forEach((sourceCell, cellIndex) => {
    const color = sourceCell.colorCode
      ? colorsByCode.get(sourceCell.colorCode).rgb
      : { r: 0, g: 0, b: 0 }
    const cellX = cellIndex % width
    const cellY = Math.floor(cellIndex / width)
    for (let y = 0; y < sampleScale; y += 1) {
      for (let x = 0; x < sampleScale; x += 1) {
        const offset = (
          (cellY * sampleScale + y) * sourceWidth +
          cellX * sampleScale + x
        ) * 4
        data.set(
          [color.r, color.g, color.b, sourceCell.colorCode ? 255 : 0],
          offset,
        )
      }
    }
  })
  return data
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

test('cleanup replaces an isolated, perceptually close MARD shade', () => {
  const original = createGrid([
    ['G1', 'G1', 'G1'],
    ['G1', 'G18', 'G1'],
    ['G1', 'G1', 'G1'],
  ])
  const cleaned = cleanupPatternCells(original, 3, 3)

  assert.deepEqual(cleaned, Array.from({ length: 9 }, () => cell('G1')))
  assert.equal(original[4].colorCode, 'G18')
})

test('cleanup preserves high-contrast highlights and paired color fields', () => {
  const original = createGrid([
    ['H7', 'H7', 'H7'],
    ['H7', 'A1', 'H7'],
    ['H7', 'H7', 'H7'],
  ])
  const cleaned = cleanupPatternCells(original, 3, 3)

  assert.deepEqual(cleaned, original)
  assert.deepEqual(cleaned[4], cell('A1'))
})

test('cleanup requires a highly consistent neighborhood', () => {
  const original = createGrid([
    ['G1', 'G1', 'G18'],
    ['G18', 'G18', 'G1'],
    ['G1', 'G1', 'G18'],
  ])

  assert.deepEqual(cleanupPatternCells(original, 3, 3), original)
})

test('cleanup never fills transparent cells or creates a new color', () => {
  const original = createGrid([
    ['G1', 'G1', 'G1'],
    ['G1', '', 'G18'],
    ['G1', 'G1', 'G1'],
  ])
  const beforeCodes = new Set(original.map((item) => item.colorCode))
  const cleaned = cleanupPatternCells(original, 3, 3)
  const afterCodes = new Set(cleaned.map((item) => item.colorCode))

  assert.deepEqual(cleaned[4], cell(''))
  afterCodes.forEach((colorCode) => assert.ok(beforeCodes.has(colorCode)))
})

test('cleanup removes a two-cell speckle without mutating its source matrix', () => {
  const original = createGrid([
    ['G1', 'G1', 'G1', 'G1'],
    ['G1', 'G18', 'G18', 'G1'],
    ['G1', 'G1', 'G1', 'G1'],
  ])
  const cleaned = cleanupPatternCells(original, 4, 3)

  assert.deepEqual(cleaned, Array.from({ length: 12 }, () => cell('G1')))
  assert.deepEqual(original.slice(5, 7), [cell('G18'), cell('G18')])
})

test('production generator applies Phase 5 cleanup after MARD mapping', async () => {
  const input = createGrid([
    ['G1', 'G1', 'G1'],
    ['G1', 'G18', 'G1'],
    ['G1', 'G1', 'G1'],
  ])
  installWxHarness(createSampleData(input, 3, 3), 3, 3)

  const draft = await createDraft('fixture://phase-5-cleanup', {
    width: 3,
    height: 3,
    colorLimit: 2,
    brand: 'MARD',
  })

  assert.deepEqual(draft.cells, Array.from({ length: 9 }, () => cell('G1')))
  assert.ok(new Set(draft.cells.map((item) => item.colorCode)).size <= 2)
})
