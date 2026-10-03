/**
 * OCR 全量扫描第二轮加固的行为锁。
 *
 * 锁的是「看起来是合法值、实际是脏数据」这一类坑：
 * - median cut 原地重排调用方数组（副作用不报错，只让结果悄悄不对）
 * - candidateLimit 非法时循环一次不跑，静默塌成单色
 * - rgbToHex 越界分量拼出不是颜色的字符串（canvas 不报错，只是不画）
 * - getTextColor 对非十六进制脏值一律返回白字（白底白字等于看不见）
 * - 材料统计与落盘编码对「同一颜色的大小写」给出不同色数
 */
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
const patternGenerationDirectory = path.join(
  compiledRoot,
  'services',
  'pattern-generation',
)
const { createMedianCutCandidates } = require(
  path.join(patternGenerationDirectory, 'median-cut.js'),
)
const { rgbToHex } = require(
  path.join(patternGenerationDirectory, 'color-utils.js'),
)
const { getTextColor, summarizeMaterials } = require(
  path.join(compiledRoot, 'packages', 'result', 'utils.js'),
)

const pixels = [
  { r: 9, g: 0, b: 0 },
  { r: 1, g: 0, b: 0 },
  { r: 200, g: 10, b: 10 },
  { r: 5, g: 0, b: 0 },
]

/** 复制一份像素快照，用于比对调用前后数组是否被原地重排。 */
function snapshot(list) {
  return list.map((color) => `${color.r},${color.g},${color.b}`)
}

test('median cut 不重排调用方的像素数组', () => {
  const input = pixels.map((color) => ({ ...color }))
  const before = snapshot(input)

  createMedianCutCandidates(input, 3)

  // 排序是切分算法的内部实现细节，绝不能外泄成调用方数据的副作用
  assert.deepEqual(snapshot(input), before)
})

test('median cut 拒绝非法的候选数', () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createMedianCutCandidates(pixels, limit),
      /候选数必须为正整数/u,
      `候选数 ${limit} 应当被拒绝`,
    )
  }
})

test('rgbToHex 对越界与非有限分量仍产出合法颜色', () => {
  assert.equal(rgbToHex({ r: -20, g: 300, b: 0 }), '#00ff00')
  assert.equal(rgbToHex({ r: Number.NaN, g: 0, b: 0 }), '#000000')
  assert.equal(rgbToHex({ r: 1.6, g: 255, b: 16 }), '#02ff10')
  assert.match(rgbToHex({ r: 300, g: -5, b: Number.POSITIVE_INFINITY }), /^#[0-9a-f]{6}$/u)
})

test('getTextColor 只接受合法十六进制色值', () => {
  // 脏色值不能一律落白字：白底上的白字等于看不见
  assert.equal(getTextColor('#gggggg'), '#111111')
  assert.equal(getTextColor('#12345'), '#111111')
  assert.equal(getTextColor('#ffffff'), '#111111')
  assert.equal(getTextColor('#000000'), '#ffffff')
})

test('材料统计按小写颜色去重，与落盘编码口径一致', () => {
  const draft = {
    id: 'work-hardening',
    sourceImagePath: '',
    createdAt: 0,
    generationMode: 'standard',
    settings: { width: 2, height: 1, colorLimit: 8, brand: 'MARD' },
    cells: [
      { color: '#FF0000', colorCode: 'A1' },
      { color: '#ff0000', colorCode: 'A1' },
    ],
  }

  const summary = summarizeMaterials(draft)

  // 与 encodePatternCells 一样按小写归一，否则材料表会出现两行同样的红
  assert.equal(summary.items.length, 1)
  assert.equal(summary.items[0].count, 2)
  assert.equal(summary.totalCount, 2)
})
