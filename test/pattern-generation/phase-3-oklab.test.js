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
const { rgbToOklab, oklabDistanceSquared } = require(
  path.join(patternGenerationDirectory, 'color-space.js'),
)
const { findNearestColor } = require(
  path.join(patternGenerationDirectory, 'color-utils.js'),
)
const {
  findNearestColorOklab,
  prepareOklabPalette,
} = require(path.join(patternGenerationDirectory, 'oklab-matcher.js'))
const { MARD_CLASSIC_PALETTE } = require(
  path.join(patternGenerationDirectory, 'palette-selector.js'),
)

const DIVERGENCE = {
  pixel: { r: 141, g: 153, b: 124 },
  rgbNearest: { code: 'D20', rgb: { r: 156, g: 50, b: 178 } },
  oklabNearest: { code: 'F12', rgb: { r: 253, g: 77, b: 106 } },
}

function assertClose(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

function createSampleData(colors) {
  const sampleScale = 4
  const sourceWidth = colors.length * sampleScale
  const data = new Uint8ClampedArray(sourceWidth * sampleScale * 4)
  colors.forEach((color, cellIndex) => {
    for (let y = 0; y < sampleScale; y += 1) {
      for (let x = 0; x < sampleScale; x += 1) {
        const offset = (y * sourceWidth + cellIndex * sampleScale + x) * 4
        data.set([color.r, color.g, color.b, 255], offset)
      }
    }
  })
  return data
}

function createSolidSampleData(color, alpha) {
  return createSampleData(
    Array.from({ length: 1 }, () => ({ ...color, alpha })),
  ).map((value, index) => (index % 4 === 3 ? alpha : value))
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

test('OKLab reference colors include black, white, red, green, and blue', () => {
  assert.deepEqual(rgbToOklab({ r: 0, g: 0, b: 0 }), { l: 0, a: 0, b: 0 })

  const expected = [
    [{ r: 255, g: 255, b: 255 }, [1, 0, 0]],
    [{ r: 255, g: 0, b: 0 }, [0.6279553606, 0.2248630611, 0.1258462985]],
    [{ r: 0, g: 255, b: 0 }, [0.8664396115, -0.2338875742, 0.1794984799]],
    [{ r: 0, g: 0, b: 255 }, [0.4520137184, -0.0324569842, -0.3115281477]],
  ]

  expected.forEach(([rgb, values]) => {
    const actual = rgbToOklab(rgb)
    values.forEach((value, index) => {
      assertClose(actual[['l', 'a', 'b'][index]], value, 1e-6)
    })
  })
})

test('OKLab distance has identity and symmetry', () => {
  const left = rgbToOklab({ r: 12, g: 34, b: 56 })
  const right = rgbToOklab({ r: 210, g: 180, b: 140 })
  assert.equal(oklabDistanceSquared(left, left), 0)
  assertClose(
    oklabDistanceSquared(left, right),
    oklabDistanceSquared(right, left),
    Number.EPSILON,
  )
})

test('Prepared OKLab palette preserves order, references, and strict tie semantics', () => {
  const first = { r: 10, g: 20, b: 30 }
  const second = { r: 40, g: 50, b: 60 }
  const prepared = prepareOklabPalette([first, second])
  assert.deepEqual(prepared.map((item) => item.rgb), [first, second])
  assert.strictEqual(prepared[0].rgb, first)
  assert.strictEqual(prepared[1].rgb, second)

  const equalFirst = { r: 80, g: 90, b: 100 }
  const equalSecond = { r: 80, g: 90, b: 100 }
  const tied = prepareOklabPalette([equalFirst, equalSecond])
  assert.strictEqual(findNearestColorOklab(equalFirst, tied), equalFirst)
})

test('Fixed RGB and OKLab nearest colors diverge', () => {
  const palette = [DIVERGENCE.rgbNearest.rgb, DIVERGENCE.oklabNearest.rgb]
  assert.strictEqual(findNearestColor(DIVERGENCE.pixel, palette), palette[0])
  assert.strictEqual(
    findNearestColorOklab(DIVERGENCE.pixel, prepareOklabPalette(palette)),
    palette[1],
  )
})

test('Production createDraft uses OKLab on the fixed divergence fixture', async () => {
  const colors = [
    ...Array.from({ length: 7 }, () => DIVERGENCE.rgbNearest.rgb),
    ...Array.from({ length: 7 }, () => DIVERGENCE.oklabNearest.rgb),
    DIVERGENCE.pixel,
    DIVERGENCE.pixel,
  ]
  installWxHarness(createSampleData(colors))

  const draft = await createDraft('fixture://phase-3-oklab-divergence', {
    width: colors.length,
    height: 1,
    colorLimit: 2,
    brand: 'MARD',
  })

  assert.deepEqual(
    draft.cells.slice(0, 7).map((cell) => cell.colorCode),
    Array(7).fill(DIVERGENCE.rgbNearest.code),
  )
  assert.deepEqual(
    draft.cells.slice(7, 14).map((cell) => cell.colorCode),
    Array(7).fill(DIVERGENCE.oklabNearest.code),
  )
  assert.deepEqual(
    draft.cells.slice(14).map((cell) => cell.colorCode),
    Array(2).fill(DIVERGENCE.oklabNearest.code),
  )

  const producedCodes = new Set(draft.cells.map((cell) => cell.colorCode))
  assert.ok(producedCodes.size <= 2)
  producedCodes.forEach((code) => {
    assert.ok(MARD_CLASSIC_PALETTE.some((color) => color.code === code))
  })
})

test('Production createDraft preserves the Phase 2 alpha 31/32 boundary', async () => {
  const color = { r: 32, g: 64, b: 96 }

  installWxHarness(createSolidSampleData(color, 31))
  const transparentDraft = await createDraft('fixture://phase-3-alpha-31', {
    width: 1,
    height: 1,
    colorLimit: 1,
    brand: 'MARD',
  })
  assert.deepEqual(transparentDraft.cells, [
    { color: 'transparent', colorCode: '' },
  ])

  installWxHarness(createSolidSampleData(color, 32))
  const opaqueDraft = await createDraft('fixture://phase-3-alpha-32', {
    width: 1,
    height: 1,
    colorLimit: 1,
    brand: 'MARD',
  })
  assert.equal(opaqueDraft.cells.length, 1)
  assert.notEqual(opaqueDraft.cells[0].colorCode, '')
})
