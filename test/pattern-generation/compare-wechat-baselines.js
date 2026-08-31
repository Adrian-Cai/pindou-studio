const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const beforePath = process.argv[2]
const afterPath = process.argv[3]
if (!beforePath || !afterPath) {
  console.error('Usage: node compare-wechat-baselines.js <before.json> <after.json>')
  process.exit(1)
}

const before = JSON.parse(readFileSync(path.resolve(beforePath), 'utf8'))
const after = JSON.parse(readFileSync(path.resolve(afterPath), 'utf8'))
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

assert.equal(before.schemaVersion, 1)
assert.equal(after.schemaVersion, 1)
assert.equal(before.runtime, 'wechat-offscreen-canvas')
assert.equal(after.runtime, 'wechat-offscreen-canvas')
assert.equal(before.cases.length, after.cases.length)

before.cases.forEach((beforeCase, index) => {
  const afterCase = after.cases[index]
  comparableFields.forEach((field) => {
    assert.deepEqual(
      afterCase[field],
      beforeCase[field],
      `${beforeCase.id}: ${field} changed`,
    )
  })
})

console.log(`PASS: ${before.cases.length} WeChat Canvas baselines are identical.`)
