const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

test('AI 灵感使用已启用的 hy3，校验返回，不调用生图或伪造结果', async () => {
  const calls = []
  let text = JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ title: `创意${i}`, prompt: `这是模型返回的画面描述${i}` })))
  const cloud = {
    init() {},
    ai: () => ({ createModel: group => ({ generateText: async input => {
      calls.push({ group, ...input })
      return { text }
    } }) }),
  }
  const sandbox = { exports: {}, require: name => name === 'wx-server-sdk' ? cloud : require(name), console, Buffer, URL, process }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cloudfunctions/generateImage/index.js'), 'utf8'), sandbox)
  const result = await sandbox.exports.main({ action: 'inspirations' })
  assert.equal(result.items.length, 3)
  assert.equal(calls[0].group, 'cloudbase')
  assert.equal(calls[0].model, 'hy3')
  text = '不是合法 JSON'
  const failure = await sandbox.exports.main({ action: 'inspirations' })
  assert.equal(failure.code, 'AI_INSPIRATION_UNAVAILABLE')
  assert.equal(failure.items, undefined)
})
