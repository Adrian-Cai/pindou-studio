const assert = require('node:assert/strict')
const path = require('node:path')

const fixturesDirectory = path.join(__dirname, 'fixtures')
const phase2 = require(path.join(fixturesDirectory, 'wechat-phase-2.json'))
const phase4 = require(path.join(fixturesDirectory, 'wechat-phase-4.json'))
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
assert.equal(
  phase4.algorithm,
  'standard-v2-phase-4-classic-221-weighted-greedy',
)
assert.equal(phase4.runtime, 'wechat-offscreen-canvas')
assert.equal(phase4.sampleScale, 4)
assert.equal(phase4.cases.length, phase2.cases.length)

let changedMatrixCount = 0
let changedPaletteCount = 0
phase4.cases.forEach((phase4Case, index) => {
  const phase2Case = phase2.cases[index]
  stableFields.forEach((field) => {
    assert.deepEqual(phase4Case[field], phase2Case[field], `${phase4Case.id}: ${field}`)
  })
  if (phase4Case.matrixHash !== phase2Case.matrixHash) changedMatrixCount += 1
  if (phase4Case.paletteHash !== phase2Case.paletteHash) changedPaletteCount += 1
  assert.ok(phase4Case.colorCount <= phase4Case.colorLimit)
  assert.match(phase4Case.matrixHash, /^[0-9a-f]{8}$/)
  assert.match(phase4Case.paletteHash, /^[0-9a-f]{8}$/)
})

assert.ok(changedMatrixCount > 0, 'Phase 4 must record intentional Matrix changes')
assert.ok(changedPaletteCount > 0, 'Phase 4 must record real MARD Palette changes')

console.info(`Verified ${phase4.cases.length} real WeChat Phase 2/Phase 4 A/B cases.`)
console.info(`Matrix changed in ${changedMatrixCount}/${phase4.cases.length} cases.`)
console.info(`Palette changed in ${changedPaletteCount}/${phase4.cases.length} cases.`)
