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
const {
  MARD_COLORS,
  MARD_PALETTE_SOURCE,
} = require(path.join(compiledRoot, 'data', 'bead-palettes', 'mard.js'))
const {
  oklabDistanceSquared,
  rgbToOklab,
} = require(path.join(patternGenerationDirectory, 'color-space.js'))
const { pickNearest } = require(
  path.join(patternGenerationDirectory, 'color-utils.js'),
)
const { createMedianCutCandidates } = require(
  path.join(patternGenerationDirectory, 'median-cut.js'),
)
const {
  findNearestColorOklab,
  prepareOklabPalette,
} = require(path.join(patternGenerationDirectory, 'oklab-matcher.js'))
const {
  findNearestMardColor,
  MARD_CLASSIC_PALETTE,
  MARD_PALETTE,
  selectMardPalette,
} = require(path.join(patternGenerationDirectory, 'palette-selector.js'))

function assertClose(actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

function createSampleData(colors) {
  const sampleScale = 4
  const data = new Uint8ClampedArray(colors.length * sampleScale * sampleScale * 4)
  colors.forEach((color, cellIndex) => {
    for (let y = 0; y < sampleScale; y += 1) {
      for (let x = 0; x < sampleScale; x += 1) {
        const sourceWidth = colors.length * sampleScale
        const offset = (y * sourceWidth + cellIndex * sampleScale + x) * 4
        data.set([color.r, color.g, color.b, 255], offset)
      }
    }
  })
  return data
}

function installWxHarness(imageData) {
  global.wx = {
    createOffscreenCanvas() {
      return {
        createImage() {
          const image = { width: 200, height: 100 }
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

test('OKLab conversion matches standard black, white, and red reference values', () => {
  assert.deepEqual(rgbToOklab({ r: 0, g: 0, b: 0 }), { l: 0, a: 0, b: 0 })

  const white = rgbToOklab({ r: 255, g: 255, b: 255 })
  assertClose(white.l, 1)
  assertClose(white.a, 0)
  assertClose(white.b, 0)

  const red = rgbToOklab({ r: 255, g: 0, b: 0 })
  assertClose(red.l, 0.6279553606)
  assertClose(red.a, 0.2248630611)
  assertClose(red.b, 0.1258462985)
})

test('OKLab squared distance has identity and symmetry', () => {
  const left = rgbToOklab({ r: 12, g: 34, b: 56 })
  const right = rgbToOklab({ r: 210, g: 180, b: 140 })
  assert.equal(oklabDistanceSquared(left, left), 0)
  assertClose(
    oklabDistanceSquared(left, right),
    oklabDistanceSquared(right, left),
    Number.EPSILON,
  )
})

test('prepared OKLab palette preserves order and ties keep the first item', () => {
  const first = { r: 10, g: 20, b: 30 }
  const second = { r: 40, g: 50, b: 60 }
  const prepared = prepareOklabPalette([first, second])
  assert.deepEqual(prepared.map((item) => item.rgb), [first, second])

  const duplicate = prepareOklabPalette([first, first])
  assert.equal(findNearestColorOklab(first, duplicate), first)
})

test('OKLab matcher selects the perceptual nearest color when RGB disagrees', () => {
  const pixel = { r: 243, g: 73, b: 0 }
  const rgbNearest = { r: 61, g: 86, b: 149 }
  const oklabNearest = { r: 118, g: 127, b: 244 }
  const palette = [rgbNearest, oklabNearest]

  // RGB 欧氏距离：pickNearest 返回的是「距离最小」的候选本身
  const rgbDistance = (color) => {
    const red = pixel.r - color.r
    const green = pixel.g - color.g
    const blue = pixel.b - color.b
    return red * red + green * green + blue * blue
  }
  assert.equal(pickNearest(palette, rgbDistance), rgbNearest)
  assert.equal(
    findNearestColorOklab(pixel, prepareOklabPalette(palette)),
    oklabNearest,
  )
})

test('MARD data is pinned, complete, unique, and valid', () => {
  assert.equal(MARD_PALETTE_SOURCE.colorCount, 291)
  assert.equal(
    MARD_PALETTE_SOURCE.revision,
    'f97ff4283d03cef5cd7e1071a86f5892e0c0c61b',
  )
  assert.equal(MARD_COLORS.length, 291)
  assert.equal(new Set(MARD_COLORS.map((item) => item.code)).size, 291)
  MARD_COLORS.forEach((item) => assert.match(item.hex, /^#[0-9a-f]{6}$/))

  const byCode = new Map(MARD_COLORS.map((item) => [item.code, item.hex]))
  assert.equal(byCode.get('A1'), '#f9f0cd')
  assert.equal(byCode.get('B4'), '#1ef942')
  assert.equal(byCode.get('H7'), '#000000')
  assert.equal(byCode.get('ZG8'), '#ab91c0')
})

test('classic MARD palette contains only the 221 opaque construction colors', () => {
  assert.equal(MARD_CLASSIC_PALETTE.length, 221)
  MARD_CLASSIC_PALETTE.forEach((item) => {
    assert.match(item.code, /^(?:[A-H]|M)\d+$/)
  })
  for (const code of ['P1', 'Q4', 'R1', 'T1', 'Y1', 'ZG1']) {
    assert.equal(MARD_CLASSIC_PALETTE.some((item) => item.code === code), false)
  }
})

test('oversampled Median Cut candidates retain their represented pixel weights', () => {
  const pixels = Array.from({ length: 17 }, (_, index) => ({
    r: index * 11,
    g: index * 7,
    b: index * 3,
  }))
  const candidates = createMedianCutCandidates(pixels, 8)

  assert.equal(candidates.length, 8)
  assert.equal(
    candidates.reduce((total, candidate) => total + candidate.weight, 0),
    pixels.length,
  )
  candidates.forEach((candidate) => assert.ok(candidate.weight > 0))
})

test('weighted greedy MARD selection favors prominent colors and obeys colorLimit', () => {
  const a1 = MARD_PALETTE.find((item) => item.code === 'A1')
  const h7 = MARD_PALETTE.find((item) => item.code === 'H7')
  assert.ok(a1)
  assert.ok(h7)

  const selected = selectMardPalette(
    [
      { rgb: a1.rgb, weight: 100 },
      { rgb: h7.rgb, weight: 1 },
    ],
    2,
  )
  assert.deepEqual(selected.map((item) => item.code), ['A1', 'H7'])
  assert.ok(selected.length <= 2)
  assert.match(
    findNearestMardColor({ r: 255, g: 235, b: 250 }).code,
    /^(?:[A-H]|M)\d+$/,
  )
})

test('production generator emits constructible MARD colors and codes', async () => {
  const a1 = MARD_PALETTE.find((item) => item.code === 'A1')
  const h7 = MARD_PALETTE.find((item) => item.code === 'H7')
  assert.ok(a1)
  assert.ok(h7)
  installWxHarness(createSampleData([a1.rgb, h7.rgb]))

  const draft = await createDraft('fixture://phase-4-mard', {
    width: 2,
    height: 1,
    colorLimit: 2,
    brand: 'MARD',
  })

  assert.deepEqual(draft.cells, [
    { color: a1.hex, colorCode: 'A1' },
    { color: h7.hex, colorCode: 'H7' },
  ])
  assert.ok(new Set(draft.cells.map((cell) => cell.colorCode)).size <= 2)
})
