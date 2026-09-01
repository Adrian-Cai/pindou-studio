const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const casesFixture = require('./fixtures/v1-characterization-cases.json')
const baselineManifest = require('./fixtures/v1-baseline-manifest.json')
const wechatAfterBaseline = require('./fixtures/wechat-v1-after.json')
const wechatBeforeBaseline = require('./fixtures/wechat-v1-before.json')
const reference = require('./v1-reference')
const {
  createMatrixHash,
  createPaletteHash,
  derivePalette,
  expandPixels,
  serializeCell,
} = require('./baseline-utils')

const compiledImageServicePath = path.resolve(
  __dirname,
  '..',
  '..',
  '.pattern-test-build',
  'miniprogram',
  'services',
  'image-service.js',
)
const { createDraft } = require(compiledImageServicePath)
const compiledPatternGenerationDirectory = path.dirname(
  require.resolve(path.resolve(
    __dirname,
    '..',
    '..',
    '.pattern-test-build',
    'miniprogram',
    'services',
    'pattern-generation',
    'standard-generator.js',
  )),
)
const { findNearestColor, rgbToHex } = require(
  path.join(compiledPatternGenerationDirectory, 'color-utils.js'),
)
const { calculateCenterCrop } = require(
  path.join(compiledPatternGenerationDirectory, 'crop.js'),
)
const { createMedianCutPalette } = require(
  path.join(compiledPatternGenerationDirectory, 'median-cut.js'),
)
const { SAMPLE_SCALE } = require(
  path.join(compiledPatternGenerationDirectory, 'cell-sampler.js'),
)

function installWxHarness({ sourceWidth, sourceHeight, imageData }) {
  const calls = { canvasOptions: null, drawImage: null, getImageData: null }
  global.wx = {
    createOffscreenCanvas(options) {
      calls.canvasOptions = options
      return {
        createImage() {
          const image = { width: sourceWidth, height: sourceHeight }
          Object.defineProperty(image, 'src', {
            set() {
              queueMicrotask(() => image.onload())
            },
          })
          return image
        },
        getContext() {
          return {
            drawImage(...args) {
              calls.drawImage = args
            },
            getImageData(...args) {
              calls.getImageData = args
              return { data: new Uint8ClampedArray(imageData) }
            },
          }
        },
      }
    },
  }
  return calls
}

test('frozen V1 reference records empty-pixel fallback and strict tie behavior', () => {
  assert.deepEqual(reference.readOpaquePixels(new Uint8ClampedArray([1, 2, 3, 31])), [])
  assert.deepEqual(reference.createMedianCutPalette([], 16), [{ r: 255, g: 255, b: 255 }])

  const first = { r: 0, g: 0, b: 0 }
  const second = { r: 2, g: 0, b: 0 }
  assert.equal(reference.findNearestColor({ r: 1, g: 0, b: 0 }, [first, second]), first)

  assert.equal(reference.getWidestChannel([
    { r: 0, g: 0, b: 0 },
    { r: 10, g: 10, b: 10 },
  ]), 'r')
  assert.equal(reference.getWidestChannel([
    { r: 5, g: 0, b: 0 },
    { r: 5, g: 10, b: 10 },
  ]), 'g')

  assert.equal(reference.findBucketToSplit([
    [{ r: 0, g: 0, b: 0 }, { r: 10, g: 0, b: 0 }],
    [{ r: 20, g: 0, b: 0 }, { r: 30, g: 0, b: 0 }],
  ]), 0)
  assert.deepEqual(reference.averageColor([
    { r: 0, g: 0, b: 0 },
    { r: 1, g: 3, b: 5 },
  ]), { r: 1, g: 2, b: 3 })
  assert.equal(reference.rgbToHex({ r: 0, g: 15, b: 16 }), '#000f10')
  assert.equal(reference.rgbToHex({ r: 255, g: 255, b: 255 }), '#ffffff')
})

test('extracted RGB and Median Cut modules preserve V1 pure behavior', () => {
  assert.deepEqual(createMedianCutPalette([], 16), [{ r: 255, g: 255, b: 255 }])

  const first = { r: 0, g: 0, b: 0 }
  const second = { r: 2, g: 0, b: 0 }
  assert.equal(findNearestColor({ r: 1, g: 0, b: 0 }, [first, second]), first)
  assert.equal(rgbToHex({ r: 0, g: 15, b: 16 }), '#000f10')
  assert.equal(rgbToHex({ r: 255, g: 255, b: 255 }), '#ffffff')

  assert.deepEqual(createMedianCutPalette([
    { r: 0, g: 100, b: 100 },
    { r: 100, g: 0, b: 100 },
    { r: 100, g: 100, b: 0 },
    { r: 0, g: 0, b: 0 },
  ], 2), [
    { r: 0, g: 50, b: 50 },
    { r: 100, g: 50, b: 50 },
  ])
  assert.deepEqual(createMedianCutPalette([
    { r: 50, g: 0, b: 100 },
    { r: 50, g: 100, b: 0 },
    { r: 50, g: 100, b: 100 },
    { r: 50, g: 0, b: 0 },
  ], 2), [
    { r: 50, g: 0, b: 50 },
    { r: 50, g: 100, b: 50 },
  ])
  assert.deepEqual(createMedianCutPalette([
    { r: 0, g: 0, b: 0 },
    { r: 10, g: 0, b: 0 },
    { r: 20, g: 0, b: 0 },
    { r: 30, g: 0, b: 0 },
  ], 3), [
    { r: 0, g: 0, b: 0 },
    { r: 10, g: 0, b: 0 },
    { r: 25, g: 0, b: 0 },
  ])
  assert.deepEqual(createMedianCutPalette([
    { r: 0, g: 0, b: 0 },
    { r: 1, g: 3, b: 5 },
  ], 1), [{ r: 1, g: 2, b: 3 }])
})

test('extracted calculateCenterCrop preserves every V1 geometry case', () => {
  casesFixture.cropCases.forEach((cropCase) => {
    assert.deepEqual(
      calculateCenterCrop(
        cropCase.source.width,
        cropCase.source.height,
        cropCase.target.width,
        cropCase.target.height,
      ),
      cropCase.expected,
      cropCase.id,
    )
  })
})

for (const caseDefinition of casesFixture.cases) {
  test(`frozen V1 reference preserves characterization case: ${caseDefinition.id}`, () => {
    const data = expandPixels(
      caseDefinition.pixels,
      caseDefinition.settings.width,
      caseDefinition.settings.height,
    )
    const cells = reference.createPatternCells(
      new Uint8ClampedArray(data),
      caseDefinition.settings.colorLimit,
    )
    const serializedCells = cells.map(serializeCell)
    const palette = derivePalette(cells)
    const baseline = baselineManifest.characterizationCases.find(
      (item) => item.id === caseDefinition.id,
    )

    assert.deepEqual(serializedCells, caseDefinition.expectedCells)
    assert.deepEqual(palette, caseDefinition.expectedPalette)
    assert.equal(cells.length, caseDefinition.settings.width * caseDefinition.settings.height)
    assert.ok(baseline, `Missing manifest baseline for ${caseDefinition.id}`)
    assert.equal(createMatrixHash(serializedCells), baseline.matrixHash)
    assert.equal(createPaletteHash(palette), baseline.paletteHash)
  })
}

for (const cropCase of casesFixture.cropCases) {
  test(`current Canvas drawImage preserves V1 crop geometry: ${cropCase.id}`, async () => {
    const settings = {
      width: cropCase.target.width,
      height: cropCase.target.height,
      colorLimit: 1,
      brand: 'MARD',
    }
    const pixels = new Uint8ClampedArray(
      Array.from(
        {
          length: settings.width
            * SAMPLE_SCALE
            * settings.height
            * SAMPLE_SCALE,
        },
        () => [10, 20, 30, 255],
      ).flat(),
    )
    const calls = installWxHarness({
      sourceWidth: cropCase.source.width,
      sourceHeight: cropCase.source.height,
      imageData: pixels,
    })
    await createDraft(`fixture://${cropCase.id}`, settings)

    const drawArguments = calls.drawImage
    assert.ok(drawArguments)
    assert.deepEqual(drawArguments.slice(1, 5), [
      cropCase.expected.sourceX,
      cropCase.expected.sourceY,
      cropCase.expected.sourceWidth,
      cropCase.expected.sourceHeight,
    ])
    assert.deepEqual(drawArguments.slice(5), [
      0,
      0,
      settings.width * SAMPLE_SCALE,
      settings.height * SAMPLE_SCALE,
    ])
    assert.deepEqual(
      reference.calculateCenterCrop(
        cropCase.source.width,
        cropCase.source.height,
        cropCase.target.width,
        cropCase.target.height,
      ),
      cropCase.expected,
    )
  })
}

test('WeChat Canvas manifest keeps all required fixture settings explicit', () => {
  assert.equal(baselineManifest.wechatCanvasCases.length, 6)
  assert.deepEqual(
    [...new Set(baselineManifest.wechatCanvasCases.map((item) => item.width))].sort((a, b) => a - b),
    [32, 64, 96, 128],
  )
  baselineManifest.wechatCanvasCases.forEach((item) => {
    assert.equal(item.brand, 'MARD')
    assert.ok(['pending-wechat-devtools', 'recorded'].includes(item.baselineStatus))
    if (item.baselineStatus === 'recorded') {
      assert.equal(typeof item.matrixHash, 'string')
      assert.equal(typeof item.paletteHash, 'string')
    }
  })

  assert.deepEqual(
    baselineManifest.wechatCanvasCases,
    wechatBeforeBaseline.cases.map(({ generationTimeMs: _generationTimeMs, ...item }) => ({
      ...item,
      baselineStatus: 'recorded',
    })),
  )
})

test('real WeChat Canvas before and after baselines are identical', () => {
  const comparableFields = [
    'id',
    'fixture',
    'sourceWidth',
    'sourceHeight',
    'width',
    'height',
    'colorLimit',
    'brand',
    'cellCount',
    'opaqueCellCount',
    'colorCount',
    'matrixHash',
    'paletteHash',
  ]
  assert.equal(wechatAfterBaseline.cases.length, wechatBeforeBaseline.cases.length)
  wechatBeforeBaseline.cases.forEach((beforeCase, index) => {
    const afterCase = wechatAfterBaseline.cases[index]
    comparableFields.forEach((field) => {
      assert.deepEqual(afterCase[field], beforeCase[field], `${beforeCase.id}: ${field}`)
    })
  })
})
