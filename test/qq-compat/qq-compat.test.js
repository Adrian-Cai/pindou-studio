const assert = require('node:assert/strict')
const test = require('node:test')

const platformPath = require.resolve('../../.qq-compat-test-build/miniprogram/config/platform.js')
const cloudPath = require.resolve('../../.qq-compat-test-build/miniprogram/config/cloud.js')

function restoreGlobal(name, value) {
  if (value === undefined) delete global[name]
  else global[name] = value
}

test('QQ runtime detection uses the official AppPlatform field', () => {
  const originalQq = global.qq
  const originalWx = global.wx
  try {
    global.qq = { getSystemInfoSync: () => ({ AppPlatform: 'qq' }) }
    global.wx = { getSystemInfoSync: () => ({}) }
    assert.equal(require(platformPath).isQqEnvironment(), true)

    global.qq = { getSystemInfoSync: () => ({ AppPlatform: 'wechat' }) }
    assert.equal(require(platformPath).isQqEnvironment(), false)
  } finally {
    restoreGlobal('qq', originalQq)
    restoreGlobal('wx', originalWx)
  }
})

test('QQ startup skips unused WeChat CloudBase initialization', () => {
  const originalQq = global.qq
  const originalWx = global.wx
  try {
    global.qq = { getSystemInfoSync: () => ({ AppPlatform: 'qq' }) }
    global.wx = { cloud: { init() { throw new Error('must not initialize wx.cloud in QQ') } } }
    delete require.cache[cloudPath]
    assert.doesNotThrow(() => require(cloudPath).initCloud())
  } finally {
    restoreGlobal('qq', originalQq)
    restoreGlobal('wx', originalWx)
    delete require.cache[cloudPath]
  }
})
