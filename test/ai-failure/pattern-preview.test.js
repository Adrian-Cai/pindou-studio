const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const compiledRoot = path.resolve(__dirname, '../../.ai-failure-test-build/miniprogram')
const { drawPatternOnCanvas } = require(path.join(compiledRoot, 'packages/editor/services/pattern-renderer.js'))

test('AI 预览按图纸比例绘制网格并居中', () => {
  const arcs = []
  const context = {
    fillStyle: '',
    globalAlpha: 1,
    scale() {},
    fillRect() {},
    beginPath() {},
    arc(x, y, radius) { arcs.push({ x, y, radius, color: this.fillStyle }) },
    fill() {},
  }
  const draft = {
    settings: { width: 2, height: 2 },
    cells: ['#a1a1a1', '#b2b2b2', '#c3c3c3', '#d4d4d4'].map((color) => ({ color })),
  }

  drawPatternOnCanvas(context, 120, 60, draft, true)

  const beadCenters = arcs
    .filter(({ color }) => color !== '#000000' && color !== '#ffffff')
    .map(({ x, y }) => [x, y])
  assert.deepEqual(beadCenters, [[45, 15], [75, 15], [45, 45], [75, 45]])
})
