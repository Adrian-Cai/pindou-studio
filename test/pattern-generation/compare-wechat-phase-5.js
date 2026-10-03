const assert = require('node:assert/strict')
const path = require('node:path')

const fixturesDirectory = path.join(__dirname, 'fixtures')
const phase4 = require(path.join(fixturesDirectory, 'wechat-phase-4.json'))
const phase5 = require(path.join(fixturesDirectory, 'wechat-phase-5.json'))
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

assert.equal(
  phase4.algorithm,
  'standard-v2-phase-4-classic-221-weighted-greedy',
)
assert.equal(phase5.algorithm, 'standard-v2-phase-5-conservative-cleanup')
assert.equal(phase5.runtime, 'wechat-offscreen-canvas')
assert.equal(phase5.sampleScale, 4)
assert.equal(phase5.cases.length, phase4.cases.length)

let changedMatrixCount = 0
phase5.cases.forEach((phase5Case, index) => {
  const phase4Case = phase4.cases[index]
  stableFields.forEach((field) => {
    assert.deepEqual(phase5Case[field], phase4Case[field], `${phase5Case.id}: ${field}`)
  })
  if (phase5Case.matrixHash !== phase4Case.matrixHash) changedMatrixCount += 1
  assert.ok(phase5Case.colorCount <= phase5Case.colorLimit)
  assert.match(phase5Case.matrixHash, /^[0-9a-f]{8}$/)
  assert.match(phase5Case.paletteHash, /^[0-9a-f]{8}$/)
})

assert.ok(changedMatrixCount > 0, 'Phase 5 must record intentional cleanup changes')

console.info(`Verified ${phase5.cases.length} real WeChat Phase 4/Phase 5 A/B cases.`)
console.info(`Matrix changed in ${changedMatrixCount}/${phase5.cases.length} cases.`)
