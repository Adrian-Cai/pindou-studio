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
const { createDraft } = require(path.join(compiledRoot, 'services', 'image-service.js'))
const patternGenerationDirectory = path.join(
  compiledRoot,
  'services',
  'pattern-generation',
)
const {
  SAMPLE_SCALE,
  sampleCellsLinearRgb,
} = require(path.join(patternGenerationDirectory, 'cell-sampler.js'))
const {
  linearToSrgbByte,
  srgbByteToLinear,
} = require(path.join(patternGenerationDirectory, 'color-space.js'))
const { MARD_PALETTE } = require(
  path.join(patternGenerationDirectory, 'palette-selector.js'),
)

function createSampleData(targetWidth, targetHeight, getPixel) {
  const sourceWidth = targetWidth * SAMPLE_SCALE
  const sourceHeight = targetHeight * SAMPLE_SCALE
  const data = new Uint8ClampedArray(sourceWidth * sourceHeight * 4)
  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < sourceWidth; x += 1) {
      const offset = (y * sourceWidth + x) * 4
      data.set(getPixel(x, y), offset)
    }
  }
  return data
}

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

test('sRGB channel conversion preserves endpoints', () => {
  assert.equal(srgbByteToLinear(0), 0)
  assert.equal(srgbByteToLinear(255), 1)
  assert.equal(linearToSrgbByte(0), 0)
  assert.equal(linearToSrgbByte(1), 255)
})

test('4x area sampling preserves a constant color', () => {
  const source = createSampleData(1, 1, () => [12, 34, 56, 255])
  assert.deepEqual(
    [...sampleCellsLinearRgb(source, 1, 1)],
    [12, 34, 56, 255],
  )
})

test('Linear RGB area average maps equal black and white samples to 188', () => {
  const source = createSampleData(1, 1, (x, y) => (
    y * SAMPLE_SCALE + x < 8
      ? [0, 0, 0, 255]
      : [255, 255, 255, 255]
  ))
  assert.deepEqual(
    [...sampleCellsLinearRgb(source, 1, 1)],
    [188, 188, 188, 255],
  )
})

test('transparent RGB values do not contaminate the sampled visible color', () => {
  const source = createSampleData(1, 1, (x, y) => (
    y * SAMPLE_SCALE + x < 8
      ? [255, 0, 0, 255]
      : [0, 0, 255, 0]
  ))
  assert.deepEqual(
    [...sampleCellsLinearRgb(source, 1, 1)],
    [255, 0, 0, 128],
  )
})

test('sampled cells keep row-major order', () => {
  const source = createSampleData(2, 1, (x) => (
    x < SAMPLE_SCALE ? [0, 0, 0, 255] : [255, 255, 255, 255]
  ))
  assert.deepEqual(
    [...sampleCellsLinearRgb(source, 2, 1)],
    [0, 0, 0, 255, 255, 255, 255, 255],
  )
})

test('sampled data size mismatches fail explicitly', () => {
  assert.throws(
    () => sampleCellsLinearRgb(new Uint8ClampedArray(4), 1, 1),
    /采样图片数据尺寸不匹配/,
  )
})

test('current generator keeps Phase 2 4x sampling and alpha threshold', async () => {
  const green = MARD_PALETTE.find((item) => item.code === 'B4')
  assert.ok(green)
  const imageData = createSampleData(2, 1, (x, y) => {
    const sampleIndex = y * SAMPLE_SCALE + (x % SAMPLE_SCALE)
    if (x < SAMPLE_SCALE) {
      return sampleIndex === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]
    }
    return sampleIndex < 2
      ? [green.rgb.r, green.rgb.g, green.rgb.b, 255]
      : [0, 0, 255, 0]
  })
  const calls = installWxHarness({
    sourceWidth: 200,
    sourceHeight: 100,
    imageData,
  })
  const draft = await createDraft('fixture://phase-2-alpha', {
    width: 2,
    height: 1,
    colorLimit: 2,
    brand: 'MARD',
  })

  assert.deepEqual(calls.canvasOptions, { type: '2d', width: 8, height: 4 })
  assert.deepEqual(calls.getImageData, [0, 0, 8, 4])
  assert.deepEqual(calls.drawImage.slice(1), [0, 0, 200, 100, 0, 0, 8, 4])
  assert.deepEqual(draft.cells, [
    { color: 'transparent', colorCode: '' },
    { color: green.hex, colorCode: green.code },
  ])
})
