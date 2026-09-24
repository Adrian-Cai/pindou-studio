/**
 * 虚拟支付（小程序端）单元测试。
 *
 * 锁的是三条容易在重构中悄悄丢失的约束：
 * ① signData 必须原样透传服务端下发的字符串，不能 JSON.parse 成对象再传
 *    （传对象会让微信直接报 parameter.signData should be String instead of Object）；
 * ② 基础库不支持时必须给出可行动提示，而不是让 API 抛出难以理解的运行时错误；
 * ③ 支付成功/取消/错误码三类结果要被正确归一化，用户看到的是人话而不是 -15007。
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const compiledRoot = path.resolve(
  __dirname,
  '..',
  '..',
  '.payment-test-build',
  'miniprogram',
)
const modulePath = path.join(compiledRoot, 'services', 'payment-service.js')

/** 一个完整、合法的服务端下单响应。 */
function validCreateResponse() {
  const signData = JSON.stringify({
    offerId: 'offer-test',
    buyQuantity: 1,
    env: 0,
    currencyType: 'CNY',
    productId: 'product_30',
    goodsPrice: 990,
    outTradeNo: 'order_abcdef0123456789abcdef0123',
    attach: 'order_abcdef0123456789abcdef0123',
  })
  return {
    orderId: 'order_abcdef0123456789abcdef0123',
    virtual: { signData, paySig: 'pay-sig-value', signature: 'user-sig-value', mode: 'short_series_goods' },
  }
}

/**
 * 安装 wx 与登录态的测试替身。
 *
 * @param options.apiCalls 记录每次 wx 支付 API 的入参
 * @param options.failWith fail 回调的内容；为 null 时走 success
 * @param options.omitVirtualPayment 删掉该 API，用于模拟低版本基础库
 * @param options.sdkVersion getSystemInfoSync 返回的 SDKVersion
 */
function installHarness(options = {}) {
  const apiCalls = options.apiCalls ?? []
  const storage = new Map()
  // 键与形状必须与 services/token-storage.ts 一致，否则 loadAuthSession 认不出登录态
  storage.set('pindou-auth-session-v1', {
    token: 'test-token-with-sufficient-length',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: 'usr_test', nickname: null, avatarUrl: null },
  })

  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    getSystemInfoSync: () => ({ SDKVersion: options.sdkVersion ?? '3.0.0' }),
    canIUse: () => Boolean(options.canIUse),
    request: (config) => {
      if (options.failWith) {
        config.fail(options.failWith)
        return
      }
      config.success({ statusCode: 201, data: validCreateResponse() })
    },
  }
  if (!options.omitVirtualPayment) {
    wx.requestVirtualPayment = (payload) => {
      apiCalls.push(payload)
      if (options.virtualFail) options.virtualFail(payload)
      else payload.success({ errMsg: 'requestVirtualPayment:ok' })
    }
  }
  global.wx = wx
  return { apiCalls, wx }
}

/** 每次 require 都拿全新模块实例，避免 wx 替身被上一个用例污染。 */
function loadModule() {
  delete require.cache[require.resolve(modulePath)]
  return require(modulePath)
}

test('拉起支付时原样透传 signData 字符串，不解析成对象', async () => {
  const apiCalls = []
  installHarness({ apiCalls })
  const { payForAiGenerationPackage } = loadModule()

  await payForAiGenerationPackage('ai_generation_30', 'idempotent-key-1')

  assert.equal(apiCalls.length, 1)
  /**
   * 官方运行时只接受 string。传对象时微信直接报
   * `parameter.signData should be String instead of Object`，支付一步都走不出去。
   * 断言「严格等于服务端那份字符串」而不只是 typeof：重新 stringify 出来的
   * 字符串同样是 string，但一个空格差异就会让 paySig 校验失败。
   */
  assert.equal(typeof apiCalls[0].signData, 'string')
  assert.equal(apiCalls[0].signData, validCreateResponse().virtual.signData)
  assert.equal(apiCalls[0].paySig, 'pay-sig-value')
  assert.equal(apiCalls[0].signature, 'user-sig-value')
  assert.equal(apiCalls[0].mode, 'short_series_goods')
})

test('signData 未被本地重新序列化，字段顺序与服务端一致', async () => {
  const apiCalls = []
  installHarness({ apiCalls })
  const { payForAiGenerationPackage } = loadModule()
  await payForAiGenerationPackage('ai_generation_30', 'key-serialization')

  // 键顺序是签名输入的一部分：这里确保透传过程没有重排或丢字段
  assert.deepEqual(Object.keys(JSON.parse(apiCalls[0].signData)), [
    'offerId', 'buyQuantity', 'env', 'currencyType', 'productId', 'goodsPrice', 'outTradeNo', 'attach',
  ])
  const parsed = JSON.parse(apiCalls[0].signData)
  assert.equal(parsed.productId, 'product_30')
  assert.equal(parsed.goodsPrice, 990)
})

test('基础库缺少虚拟支付接口时给出可行动提示而不是直接崩溃', async () => {
  const apiCalls = []
  installHarness({ apiCalls, omitVirtualPayment: true })
  const { payForAiGenerationPackage } = loadModule()

  await assert.rejects(
    () => payForAiGenerationPackage('ai_generation_30', 'key-unsupported'),
    /请升级微信后重试/,
  )
  assert.equal(apiCalls.length, 0)
})

test('低版本基础库但 canIUse 可用时仍然允许支付', async () => {
  const apiCalls = []
  installHarness({ apiCalls, sdkVersion: '2.10.0', canIUse: true })
  const { payForAiGenerationPackage } = loadModule()

  await payForAiGenerationPackage('ai_generation_30', 'key-old-sdk')
  assert.equal(apiCalls.length, 1)
})

test('canUseVirtualPayment 在接口缺失时为 false', () => {
  installHarness({ omitVirtualPayment: true })
  const { canUseVirtualPayment } = loadModule()
  assert.equal(canUseVirtualPayment(), false)
})

test('getSystemInfoSync 抛错时退回 canIUse 判定而非崩溃', () => {
  installHarness({ canIUse: true })
  global.wx.getSystemInfoSync = () => { throw new Error('宿主不支持') }
  const { canUseVirtualPayment } = loadModule()
  assert.equal(canUseVirtualPayment(), true)
})

test('用户取消支付被识别为取消而不是通用失败', async () => {
  installHarness({
    virtualFail: (payload) => payload.fail({ errMsg: 'requestVirtualPayment:fail cancel', errCode: -2 }),
  })
  const { payForAiGenerationPackage, isWechatPaymentCancelled } = loadModule()

  const error = await payForAiGenerationPackage('ai_generation_30', 'key-cancel')
    .then(() => null, (caught) => caught)
  assert.ok(error, '取消应当 reject')
  assert.equal(isWechatPaymentCancelled(error), true)
  assert.equal(error.message, '已取消支付')
})

test('session_key 过期被翻译成可行动文案而不是原始错误码', async () => {
  installHarness({
    virtualFail: (payload) => payload.fail({ errMsg: 'requestVirtualPayment:fail', errCode: -15007 }),
  })
  const { payForAiGenerationPackage, isWechatPaymentCancelled } = loadModule()

  const error = await payForAiGenerationPackage('ai_generation_30', 'key-expired')
    .then(() => null, (caught) => caught)
  assert.ok(error)
  assert.equal(error.message, '登录状态已失效，请重新登录后支付')
  // 过期不是用户取消，幂等键必须保留以便重试归属同一笔
  assert.equal(isWechatPaymentCancelled(error), false)
})

test('商户单号被微信关单（-15012）时提示重新发起，而不是让用户对着原始错误码发呆', async () => {
  installHarness({
    virtualFail: (payload) =>
      payload.fail({ errMsg: 'requestVirtualPayment:fail ORDER_CLOSED', errCode: -15012 }),
  })
  const { payForAiGenerationPackage, isWechatPaymentOrderClosed, isWechatPaymentCancelled } =
    loadModule()

  const error = await payForAiGenerationPackage('ai_generation_30', 'key-order-closed')
    .then(() => null, (caught) => caught)
  assert.ok(error)
  assert.equal(error.message, '订单已失效，请重新发起支付')
  // 必须能被识别成「换新单」：调用方据此丢弃当前幂等键，否则重试仍撞同一个已关闭的单号
  assert.equal(isWechatPaymentOrderClosed(error), true)
  assert.equal(isWechatPaymentCancelled(error), false)
})

test('outTradeNo 重复（-15002）同样判定为需要换单', async () => {
  installHarness({
    virtualFail: (payload) => payload.fail({ errMsg: 'requestVirtualPayment:fail', errCode: -15002 }),
  })
  const { payForAiGenerationPackage, isWechatPaymentOrderClosed } = loadModule()

  const error = await payForAiGenerationPackage('ai_generation_30', 'key-duplicate')
    .then(() => null, (caught) => caught)
  assert.equal(isWechatPaymentOrderClosed(error), true)
})

test('未知错误码保留原始信息以便排查', async () => {
  installHarness({
    virtualFail: (payload) => payload.fail({ errMsg: 'requestVirtualPayment:fail boom', errCode: -19999 }),
  })
  const { payForAiGenerationPackage, paymentErrorMessage } = loadModule()

  const error = await payForAiGenerationPackage('ai_generation_30', 'key-unknown')
    .then(() => null, (caught) => caught)
  assert.equal(paymentErrorMessage(error), 'requestVirtualPayment:fail boom')
})

test('服务端未下发虚拟支付参数时拒绝拉起支付', async () => {
  const apiCalls = []
  installHarness({ apiCalls })
  global.wx.request = (config) => {
    config.success({ statusCode: 201, data: { orderId: 'order_x', virtual: null } })
  }
  const { payForAiGenerationPackage } = loadModule()

  await assert.rejects(
    () => payForAiGenerationPackage('ai_generation_30', 'key-no-payload'),
    /支付参数已失效/,
  )
  assert.equal(apiCalls.length, 0)
})

test('signData 非法 JSON 时给出明确解析错误', async () => {
  const apiCalls = []
  installHarness({ apiCalls })
  global.wx.request = (config) => {
    config.success({
      statusCode: 201,
      data: {
        orderId: 'order_x',
        virtual: { signData: '{{{not json', paySig: 'a', signature: 'b', mode: 'short_series_goods' },
      },
    })
  }
  const { payForAiGenerationPackage } = loadModule()

  await assert.rejects(
    () => payForAiGenerationPackage('ai_generation_30', 'key-broken-json'),
    /支付参数解析失败/,
  )
  assert.equal(apiCalls.length, 0)
})

test('缺少 signature 时拒绝下单响应，避免带上残缺签名去拉起支付', async () => {
  installHarness()
  global.wx.request = (config) => {
    const { virtual } = validCreateResponse()
    config.success({
      statusCode: 201,
      data: { orderId: virtual.goodsPrice ? 'order_x' : 'order_x', virtual: { ...virtual, signature: '' } },
    })
  }
  const { payForAiGenerationPackage } = loadModule()

  await assert.rejects(
    () => payForAiGenerationPackage('ai_generation_30', 'key-missing-sig'),
    /无法识别|套餐数据/,
  )
})

test('未登录时直接拒绝下单', async () => {
  installHarness()
  const storage = new Map()
  global.wx.getStorageSync = (key) => storage.get(key)
  global.wx.removeStorageSync = (key) => storage.delete(key)
  const { payForAiGenerationPackage } = loadModule()

  await assert.rejects(
    () => payForAiGenerationPackage('ai_generation_30', 'key-anon'),
    /请先登录/,
  )
})
