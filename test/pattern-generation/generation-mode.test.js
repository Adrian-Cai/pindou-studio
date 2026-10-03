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
const { resolveGenerationMode } = require(path.join(compiledRoot, 'models', 'pattern.js'))

function installStandardWxHarness() {
  global.wx = {
    createOffscreenCanvas(options) {
      return {
        createImage() {
          const image = { width: 64, height: 64 }
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
              return { data: new Uint8ClampedArray(options.width * options.height * 4).fill(255) }
            },
          }
        },
      }
    },
  }
}

for (const aiQuota of [0, 3]) {
  test(`standard generation ignores AI quota=${aiQuota}`, async () => {
    installStandardWxHarness()
    let aiQuotaReads = 0
    global.wx.request = () => {
      aiQuotaReads += 1
      throw new Error('standard generation must not call AI APIs')
    }
    const draft = await createDraft('/tmp/standard.png', {
      width: 32,
      height: 32,
      colorLimit: 1,
      brand: 'MARD',
    }, 'standard')

    assert.equal(draft.generationMode, 'standard')
    assert.equal(draft.cells.length, 32 * 32)
    assert.equal(aiQuotaReads, 0)
  })
}

test('generation mode survives draft refresh and re-entry', () => {
  assert.equal(resolveGenerationMode({ id: 'draft-standard', generationMode: 'standard' }), 'standard')
  assert.equal(resolveGenerationMode({ id: 'draft-ai', generationMode: 'ai' }), 'ai')
  assert.equal(resolveGenerationMode({ id: 'legacy-draft' }), 'standard')
  assert.equal(resolveGenerationMode({ id: 'ai-pending-legacy' }), 'ai')
})
