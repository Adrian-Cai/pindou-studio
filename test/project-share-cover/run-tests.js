const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const typescript = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const source = readFileSync(filename, 'utf8')
  module._compile(typescript.transpile(source, {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2020,
  }), filename)
}

const {
  parseProjectTab,
  renderProjectShareCover,
  selectProjectShareCoverItems,
} = require('../../miniprogram/services/project-share-cover-service.ts')

const now = Date.now()
const work = (id, status, age, extra = {}) => ({
  id,
  title: id,
  coverPath: `${id}.jpg`,
  updatedAt: now - age,
  status,
  generationMode: 'standard',
  colorCount: 8,
  beadCount: 100,
  ...extra,
})
const textWork = (id, age, prompt) => ({
  id,
  title: '文生图作品',
  prompt,
  coverUrl: `${id}.jpg`,
  width: 1024,
  height: 1024,
  createdAt: new Date(now - age).toISOString(),
  updatedAt: new Date(now - age).toISOString(),
})
const works = [
  work('draft-new', 'draft', 100),
  work('completed-new', 'completed', 200),
  work('completed-old', 'completed', 31 * 24 * 60 * 60 * 1000),
  work('ai-pending', 'ai_pending', 10),
  work('ai-failed', 'ai_failed', 20),
]
const textWorks = [
  textWork('text-new', 50, 'private prompt must not appear'),
  textWork('text-old', 32 * 24 * 60 * 60 * 1000, 'another private prompt'),
]

assert.equal(parseProjectTab('completed'), 'completed')
assert.equal(parseProjectTab('untrusted-tab'), 'all')
assert.deepEqual(
  selectProjectShareCoverItems('all', works, textWorks, now).map(({ id }) => id),
  ['text-new', 'draft-new', 'completed-new', 'completed-old'],
)
assert.deepEqual(
  selectProjectShareCoverItems('recent', works, textWorks, now).map(({ id }) => id),
  ['text-new'],
)
assert.deepEqual(
  selectProjectShareCoverItems('draft', works, textWorks, now).map(({ id }) => id),
  ['draft-new'],
)
assert.deepEqual(
  selectProjectShareCoverItems('completed', works, textWorks, now).map(({ id }) => id),
  ['text-new'],
)
assert.deepEqual(
  selectProjectShareCoverItems('completed', works, [textWork('text-oldest', 31 * 24 * 60 * 60 * 1000, 'hidden')], now)
    .map(({ id }) => id),
  ['completed-new'],
)
assert.deepEqual(
  selectProjectShareCoverItems('text', works, textWorks, now).map(({ id }) => id),
  ['text-new'],
)
assert.deepEqual(selectProjectShareCoverItems('all', [], [], now), [])
assert.deepEqual(selectProjectShareCoverItems('recent', [works[2]], [], now), [])
assert(!JSON.stringify(selectProjectShareCoverItems('text', [], textWorks, now)).includes('private prompt'))

async function verifyCanvasAndPromptPrivacy() {
  const drawnText = []
  const context = {
    fillStyle: '', font: '', textBaseline: 'alphabetic',
    save() {}, restore() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, clip() {},
    drawImage() {},
    fillText(text) { drawnText.push(text) },
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext() { return context },
    createImage() {
      return {
        width: 100,
        height: 100,
        set src(_value) { queueMicrotask(() => this.onload()) },
        onload: null,
        onerror: null,
      }
    },
  }
  const previousWx = global.wx
  let exportedSize
  global.wx = {
    createOffscreenCanvas({ width, height }) {
      canvas.width = width
      canvas.height = height
      return canvas
    },
    canvasToTempFilePath(options) {
      exportedSize = [options.width, options.height]
      options.success({ tempFilePath: '/tmp/share-cover.jpg' })
    },
  }
  try {
    const cover = await renderProjectShareCover('text', [], [textWork('text', 10, 'do not render this prompt')])
    assert.equal(cover, '/tmp/share-cover.jpg')
    assert.deepEqual(exportedSize, [800, 640])
    assert(!drawnText.join('\n').includes('do not render this prompt'))
    for (const tab of ['all', 'recent', 'draft', 'completed', 'text']) {
      drawnText.length = 0
      await renderProjectShareCover(tab, [], [])
      assert(drawnText.length > 0, `${tab} should render an empty-category cover`)
    }
  } finally {
    global.wx = previousWx
  }
}

verifyCanvasAndPromptPrivacy().then(
  () => console.log('Project share cover assertions passed.'),
  (error) => { console.error(error); process.exitCode = 1 },
)
