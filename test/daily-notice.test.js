const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'utils', 'daily-notice.ts'), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const compiledModule = { exports: {} }
new Function('exports', 'module', output)(compiledModule.exports, compiledModule)
const { getLocalDateStamp, isDailyNoticeAcknowledged } = compiledModule.exports

test('daily notice acknowledgement follows the local calendar date', () => {
  const today = new Date(2026, 9, 8, 23, 59)
  assert.equal(getLocalDateStamp(today), '2026-10-08')
  assert.equal(isDailyNoticeAcknowledged('2026-10-08', today), true)
  assert.equal(isDailyNoticeAcknowledged('2026-10-07', today), false)
  assert.equal(isDailyNoticeAcknowledged(undefined, today), false)
})
