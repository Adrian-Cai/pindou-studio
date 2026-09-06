const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const fixturesDirectory = path.join(__dirname, 'fixtures')
const phase2 = readJson(path.join(fixturesDirectory, 'wechat-phase-2.json'))
const phase3Path = path.join(fixturesDirectory, 'wechat-phase-3.json')

if (!fs.existsSync(phase3Path)) {
  throw new Error(
    'Missing fixtures/wechat-phase-3.json. Run runWechatCanvasPhase3() in WeChat DevTools first.',
  )
}

const phase3 = readJson(phase3Path)
const stableFields = [
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
]

assert.equal(phase2.algorithm, 'standard-v2-phase-2')
assert.equal(phase3.algorithm, 'standard-v2-phase-3')
assert.equal(phase3.runtime, 'wechat-offscreen-canvas')
assert.equal(phase3.sampleScale, 4)
assert.equal(phase3.cases.length, phase2.cases.length)

let changedMatrixCount = 0
let changedPaletteCount = 0
phase3.cases.forEach((phase3Case, index) => {
  const phase2Case = phase2.cases[index]
  stableFields.forEach((field) => {
    assert.deepEqual(phase3Case[field], phase2Case[field], `${phase3Case.id}: ${field}`)
  })
  if (phase3Case.matrixHash !== phase2Case.matrixHash) changedMatrixCount += 1
  if (phase3Case.paletteHash !== phase2Case.paletteHash) changedPaletteCount += 1
  assert.ok(phase3Case.colorCount <= phase3Case.colorLimit)
  assert.match(phase3Case.matrixHash, /^[0-9a-f]{8}$/)
  assert.match(phase3Case.paletteHash, /^[0-9a-f]{8}$/)
  assert.equal(typeof phase3Case.generationTimeMs, 'number')
})

console.info(`Verified ${phase3.cases.length} real WeChat Phase 2/Phase 3 A/B cases.`)
console.info(`Matrix changed in ${changedMatrixCount}/${phase3.cases.length} cases.`)
console.info(`Palette changed in ${changedPaletteCount}/${phase3.cases.length} cases.`)

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}
