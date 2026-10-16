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

for (const [size, otherSize] of [[1, 1], [7, 3], [20, 10], [23, 12], [32, 48], [48, 32], [158, 156]]) {
  const labels = renderer.buildCoordinateTicks(size, otherSize).map((tick) => Number(tick.label))
  assert.deepEqual(labels, Array.from({ length: size }, (_, index) => index + 1))
}
const tenthTick = renderer.buildCoordinateTicks(12, 12)[9]
assert.deepEqual({ coordinate: tenthTick.coordinate, label: tenthTick.label, major: tenthTick.major }, { coordinate: 10, label: '10', major: true })

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

async function verifyChartExport() {
  const { drawChartImages } = require('../../miniprogram/packages/result/services/pattern-render-service.ts')
  const previousWx = global.wx
  const previousAsync = Function.prototype.async
  try {
    // 小程序分包异步加载在 Node 测试环境中由同一个共享刻度模块代替。
    Function.prototype.async = async () => renderer
    for (const [width, height, expectedLines] of [
      [23, 12, [[288, 48, 288, 336], [528, 48, 528, 336], [48, 288, 600, 288]]],
      [7, 3, []],
      [20, 10, [[288, 48, 288, 288]]],
    ]) {
      const calls = []
      const makeCanvas = (record) => {
        let start
        let lines = []
        const ctx = {
          fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
          scale() {}, fillRect() {}, arc() {}, fill() {},
          beginPath() { lines = [] },
          moveTo(x, y) { start = [x, y] },
          lineTo(x, y) { lines.push([...start, x, y]) },
          stroke() { record.push({ kind: 'lines', width: this.lineWidth, lines: [...lines] }) },
          strokeRect(...rect) { record.push({ kind: 'border', width: this.lineWidth, rect }) },
          fillText(text, x, y) { record.push({ kind: 'text', text, x, y, align: this.textAlign, baseline: this.textBaseline }) },
        }
        return { getContext: () => ctx }
      }
      const canvases = {
        '#chartRenderCanvas': makeCanvas([]),
        '#chartHdRenderCanvas': makeCanvas(calls),
      }
      global.wx = {
        getWindowInfo: () => ({ pixelRatio: 1 }),
        createSelectorQuery: () => {
          let selector
          return {
            in() { return this }, select(value) { selector = value; return this },
            fields() { return this },
            exec(callback) { callback([{ node: canvases[selector], width: 300, height: 200 }]) },
          }
        },
        canvasToTempFilePath: ({ canvas, success }) => success({
          tempFilePath: canvas === canvases['#chartHdRenderCanvas'] ? 'hd.png' : 'preview.png',
        }),
      }
      const cells = Array.from({ length: width * height }, () => ({ color: 'transparent', colorCode: '' }))
      cells[0] = { color: '#ff0000', colorCode: 'C047' }
      cells[cells.length - 1] = { color: '#0000ff', colorCode: 'C048' }
      const draft = { settings: { width, height }, cells }
      assert.deepEqual(await drawChartImages({}, draft), { chartSrc: 'preview.png', chartHdSrc: 'hd.png' })
      assert.equal(canvases['#chartHdRenderCanvas'].width, width * 24 + 96)
      assert.equal(canvases['#chartHdRenderCanvas'].height, height * 24 + 96)
      assert.deepEqual(calls.find((call) => call.kind === 'lines' && call.width === 2).lines, expectedLines)
      assert.deepEqual(calls.find((call) => call.kind === 'border' && call.width === 2), {
        kind: 'border', width: 2, rect: [48, 48, width * 24, height * 24],
      })
      assert(calls.some((call) => call.kind === 'text' && call.text === '47' && call.x === 60 && call.y === 60))
      assert(calls.some((call) => call.kind === 'text' && call.text === '48'
        && call.x === 48 + (width - 0.5) * 24 && call.y === 48 + (height - 0.5) * 24))
      assert.deepEqual(
        calls.filter((call) => call.kind === 'text' && call.y === 24).map((call) => call.text),
        Array.from({ length: width }, (_, index) => String(index + 1)),
      )
      assert(calls.filter((call) => call.kind === 'text' && call.y === 24)
        .every((call) => call.align === 'center'))
      assert.deepEqual(
        calls.filter((call) => call.kind === 'text' && call.x === 24).map((call) => call.text),
        Array.from({ length: height }, (_, index) => String(index + 1)),
      )
      assert(calls.filter((call) => call.kind === 'text' && call.x === 24)
        .every((call) => call.baseline === 'middle'))
    }
  } finally {
    global.wx = previousWx
    if (previousAsync === undefined) delete Function.prototype.async
    else Function.prototype.async = previousAsync
  }
}

verifyChartExport().then(
  () => console.log('Coordinate ruler and chart export assertions passed.'),
  (error) => { console.error(error); process.exitCode = 1 },
)
