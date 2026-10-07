const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

const pagePath = path.resolve(
  __dirname,
  '..',
  '..',
  '.payment-test-build',
  'miniprogram',
  'packages',
  'payment',
  'recharge',
  'index.js',
)

for (const errorKind of ['cancel', 'closed']) {
  test(`${errorKind} payment clears the key before the next purchase`, async () => {
    let page
    let nextKey = 0
    let payCount = 0
    const usedKeys = []
    const modals = []
    const error = { kind: errorKind }
    const paymentService = {
      createPaymentIdempotencyKey: () => `payment-${++nextKey}`,
      getPaidPaymentOrderId: () => null,
      isMaxPendingOrdersReached: () => false,
      isPaymentOrderExpired: () => false,
      isWechatPaymentCancelled: (value) => value === error && errorKind === 'cancel',
      isWechatPaymentOrderClosed: (value) => value === error && errorKind === 'closed',
      payForAiGenerationPackage: async (_packageId, key) => {
        usedKeys.push(key)
        if (payCount++ === 0) throw error
        return { orderId: 'order_test' }
      },
      paymentErrorMessage: () => '',
    }
    const previousPage = global.Page
    const previousWx = global.wx
    const originalLoad = Module._load
    global.Page = (definition) => { page = definition }
    global.wx = {
      navigateTo() {},
      showModal: (options) => modals.push(options),
      showToast() {},
    }
    Module._load = function (request, parent, isMain) {
      if (request === '../../../store/auth-store') return { authStore: {} }
      if (request === '../../../services/payment-service') return paymentService
      return originalLoad.call(this, request, parent, isMain)
    }

    try {
      delete require.cache[pagePath]
      require(pagePath)
      const instance = {
        data: {
          ...page.data,
          packages: [{ id: 'ai_generation_30', price: '9.9' }],
          selected: 0,
        },
        setData(value) { Object.assign(this.data, value) },
      }

      await page.purchase.call(instance)
      assert.equal(instance.data.paymentIdempotencyKey, '')
      assert.equal(instance.data.paymentIdempotencyPackageId, '')
      if (errorKind === 'closed') assert.equal(modals[0].title, '订单已关闭')

      await page.purchase.call(instance)
      assert.deepEqual(usedKeys, ['payment-1', 'payment-2'])
    } finally {
      Module._load = originalLoad
      if (previousPage === undefined) delete global.Page
      else global.Page = previousPage
      if (previousWx === undefined) delete global.wx
      else global.wx = previousWx
      delete require.cache[pagePath]
    }
  })
}
