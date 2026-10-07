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

const renderer = require('../../miniprogram/packages/editor/services/pattern-renderer.ts')
const editor = require('../../miniprogram/packages/editor/services/pattern-editor-service.ts')
const labelsDrawn = []
const context = {
  fillStyle: '',
  globalAlpha: 1,
  strokeStyle: '',
  lineWidth: 1,
  font: '',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  save() {}, restore() {}, rect() {}, clip() {}, fillRect() {}, beginPath() {},
  moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
  fillText(text, x, y) { labelsDrawn.push({ text, x, y }) },
}

function labels(size, otherSize, axisLength, fontSize) {
  return renderer.buildCoordinateTicks(size, otherSize, axisLength, fontSize)
    .filter((tick) => tick.label)
    .map((tick) => Number(tick.label))
}

assert.deepEqual(labels(16, 16, 320, 10), [1, 10, 16])
assert.deepEqual(labels(32, 32, 320, 10), [1, 10, 20, 30, 32])
assert.deepEqual(labels(32, 48, 320, 10), [1, 10, 20, 30, 32])
assert.deepEqual(labels(48, 32, 480, 10), [1, 10, 20, 30, 40, 48])
assert.deepEqual(labels(78, 79, 320, 10), [1, 10, 20, 30, 40, 50, 60, 70, 78])
assert.deepEqual(labels(79, 78, 320, 10), [1, 10, 20, 30, 40, 50, 60, 70, 79])
assert.deepEqual(labels(156, 158, 320, 9.6), [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 156])
assert.deepEqual(labels(158, 156, 320, 9.6), [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 158])

const draft = { settings: { width: 32, height: 32 }, cells: Array(1024).fill({ color: 'transparent' }) }
const board = { left: 44, top: 44, width: 320, height: 320 }
const fitted = editor.calculateFittedImageSize(board.width, board.height, 32, 32)
editor.drawPatternViewport(context, 408, 408, board, fitted, { scale: 1, translateX: 0, translateY: 0 }, draft)
const baseLabel = labelsDrawn.find((item) => item.text === '10')
labelsDrawn.length = 0
editor.drawPatternViewport(context, 408, 408, board, fitted, { scale: 2, translateX: 7, translateY: 5 }, draft)
const transformedColumn = labelsDrawn.find((item) => item.text === '10' && item.y === 22)
const transformedRow = labelsDrawn.find((item) => item.text === '10' && item.x === 22)
assert.equal(baseLabel.x, 139)
assert.equal(transformedColumn.x, 81)
assert.equal(transformedRow.y, 79)

const viewport = { left: 10, top: 20, width: 200, height: 200 }
const image = { width: 200, height: 200, cellWidth: 10, cellHeight: 10 }
const pinch = editor.transformFromPinch(
  { scale: 2, translateX: 0, translateY: 0 },
  100,
  200,
  100,
  100,
  120,
  110,
  viewport,
  1,
  6,
  image,
)
assert.deepEqual(pinch, { scale: 4, translateX: 20, translateY: 10 })
assert.equal(editor.transformFromPinch({ scale: 5, translateX: 0, translateY: 0 }, 100, 200, 100, 100, 100, 100, viewport, 1, 6, image).scale, 6)
assert.equal(editor.transformFromPinch({ scale: 2, translateX: 0, translateY: 0 }, 100, 25, 100, 100, 100, 100, viewport, 1, 6, image).scale, 1)
assert.deepEqual(editor.clampViewTranslation(999, -999, 6, 200, 200, image), { x: 570, y: -570 })

const touchDraft = { settings: { width: 2, height: 2 } }
assert.equal(editor.screenPointToGridCell(9, 20, viewport, image, { scale: 1, translateX: 0, translateY: 0 }, touchDraft), null)
assert.deepEqual(editor.screenPointToGridCell(10, 20, viewport, image, { scale: 1, translateX: 0, translateY: 0 }, touchDraft), { row: 0, column: 0, index: 0 })

console.log('Coordinate ruler assertions passed.')
