const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const fixturesDirectory = path.join(__dirname, 'fixtures')
const v1 = readJson(path.join(fixturesDirectory, 'wechat-v1-after.json'))
const phase2 = readJson(path.join(fixturesDirectory, 'wechat-phase-2.json'))
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
]

assert.equal(v1.algorithm, 'standard-v1')
assert.equal(phase2.algorithm, 'standard-v2-phase-2')
assert.equal(phase2.runtime, 'wechat-offscreen-canvas')
assert.equal(phase2.sampleScale, 4)
assert.equal(phase2.cases.length, v1.cases.length)

let changedMatrixCount = 0
let changedPaletteCount = 0
phase2.cases.forEach((phase2Case, index) => {
  const v1Case = v1.cases[index]
  stableFields.forEach((field) => {
    assert.deepEqual(phase2Case[field], v1Case[field], `${phase2Case.id}: ${field}`)
  })
  if (phase2Case.matrixHash !== v1Case.matrixHash) changedMatrixCount += 1
  if (phase2Case.paletteHash !== v1Case.paletteHash) changedPaletteCount += 1
  assert.ok(phase2Case.opaqueCellCount <= phase2Case.cellCount)
  assert.ok(phase2Case.colorCount <= phase2Case.colorLimit)
  assert.match(phase2Case.matrixHash, /^[0-9a-f]{8}$/)
  assert.match(phase2Case.paletteHash, /^[0-9a-f]{8}$/)
})
assert.ok(changedMatrixCount > 0, 'Phase 2 must record at least one intentional Matrix change')

const v1FlatCase = v1.cases.find((item) => item.id === 'square-flat-32-16')
const phase2FlatCase = phase2.cases.find((item) => item.id === 'square-flat-32-16')
assert.equal(phase2FlatCase.matrixHash, v1FlatCase.matrixHash)
assert.equal(phase2FlatCase.paletteHash, v1FlatCase.paletteHash)

console.info(`Verified ${phase2.cases.length} real WeChat Phase 2 A/B cases.`)
console.info(`Matrix changed in ${changedMatrixCount}/${phase2.cases.length} cases.`)
console.info(`Palette changed in ${changedPaletteCount}/${phase2.cases.length} cases.`)

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}
