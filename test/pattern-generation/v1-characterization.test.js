const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const casesFixture = require('./fixtures/v1-characterization-cases.json')
const baselineManifest = require('./fixtures/v1-baseline-manifest.json')
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

async function generateWithCurrentV1(caseDefinition) {
  const data = expandPixels(
    caseDefinition.pixels,
    caseDefinition.settings.width,
    caseDefinition.settings.height,
  )
  const calls = installWxHarness({
    sourceWidth: caseDefinition.source.width,
    sourceHeight: caseDefinition.source.height,
    imageData: data,
  })
  const draft = await createDraft(`fixture://${caseDefinition.id}`, caseDefinition.settings)
  return { calls, data, draft }
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

for (const caseDefinition of casesFixture.cases) {
  test(`current image-service matches V1 characterization: ${caseDefinition.id}`, async () => {
    const { calls, data, draft } = await generateWithCurrentV1(caseDefinition)
    const serializedCells = draft.cells.map(serializeCell)
    const palette = derivePalette(draft.cells)
    const baseline = baselineManifest.characterizationCases.find(
      (item) => item.id === caseDefinition.id,
    )

    assert.deepEqual(draft.settings, caseDefinition.settings)
    assert.deepEqual(serializedCells, caseDefinition.expectedCells)
    assert.deepEqual(palette, caseDefinition.expectedPalette)
    assert.equal(draft.cells.length, caseDefinition.settings.width * caseDefinition.settings.height)
    assert.equal(draft.sourceImagePath, `fixture://${caseDefinition.id}`)
    assert.match(draft.id, /^draft-\d+$/)
    assert.equal(typeof draft.createdAt, 'number')
    assert.deepEqual(calls.canvasOptions, {
      type: '2d',
      width: caseDefinition.settings.width,
      height: caseDefinition.settings.height,
    })
    assert.deepEqual(calls.getImageData, [
      0,
      0,
      caseDefinition.settings.width,
      caseDefinition.settings.height,
    ])

    const referenceCells = reference.createPatternCells(
      new Uint8ClampedArray(data),
      caseDefinition.settings.colorLimit,
    )
    assert.deepEqual(draft.cells, referenceCells)
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
        { length: settings.width * settings.height },
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
      settings.width,
      settings.height,
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
