const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const compiledRoot = path.resolve(__dirname, '../../.auth-store-logout-test-build/miniprogram')
const { AuthStore } = require(path.join(compiledRoot, 'store/auth-store.js'))
const { LocalStorageError, appStore } = require(path.join(compiledRoot, 'store/app-store.js'))
const authService = require(path.join(compiledRoot, 'services/auth-service.js'))
const sessionService = require(path.join(compiledRoot, 'services/session-service.js'))
const { ApiError } = require(path.join(compiledRoot, 'services/http-client.js'))
const { loadAuthSession, saveAuthSession } = require(path.join(compiledRoot, 'services/token-storage.js'))

function setup(t) {
  const storage = new Map()
  global.wx = {
    getStorageSync: (key) => storage.get(key) ?? '',
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
  }
  sessionService.clearSecuritySession()
  t.after(() => {
    sessionService.clearSecuritySession()
    delete global.wx
  })
  return new AuthStore()
}

function session(token = 'opaque_token_12345678901234567890') {
  return {
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    user: { id: 'usr_test', nickname: null, avatarUrl: null },
  }
}

test('logout invalidates an in-flight restore before it can restore credentials or authenticated state', async (t) => {
  const store = setup(t)
  saveAuthSession(session())
  t.mock.method(appStore, 'leaveAccount', async () => {})
  let resolveProfile
  t.mock.method(authService, 'fetchCurrentUser', () => new Promise((resolve) => { resolveProfile = resolve }))
  t.mock.method(authService, 'revokeCurrentSession', async () => {})

  const restoring = store.restore()
  await Promise.resolve()
  await store.logout()
  resolveProfile({ user: { id: 'usr_test', nickname: null, avatarUrl: null } })
  await restoring

  assert.equal(loadAuthSession(), null)
  assert.equal(store.getSnapshot().status, 'guest')
})

test('logout clears credentials even when local persistence fails', async (t) => {
  const store = setup(t)
  saveAuthSession(session())
  t.mock.method(appStore, 'persist', async () => { throw new LocalStorageError('storage full') })
  let remoteCalled = false
  t.mock.method(authService, 'revokeCurrentSession', async () => { remoteCalled = true })
  const previousConsoleError = console.error
  console.error = () => {}
  t.after(() => { console.error = previousConsoleError })

  await assert.doesNotReject(store.logout())

  assert.equal(loadAuthSession(), null)
  assert.equal(store.getSnapshot().status, 'guest')
  assert.equal(remoteCalled, true)
})

test('logout treats an already unauthorized session as completed', async (t) => {
  const store = setup(t)
  saveAuthSession(session())
  t.mock.method(appStore, 'leaveAccount', async () => {})
  t.mock.method(authService, 'revokeCurrentSession', async () => {
    throw new ApiError('登录状态已失效', { statusCode: 401, code: 'UNAUTHORIZED' })
  })
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args))

  await assert.doesNotReject(store.logout())

  assert.deepEqual(errors, [])
  assert.equal(store.getSnapshot().status, 'guest')
})

test('revokeAllDevices logs out only after success and propagates failure', async (t) => {
  const successfulStore = setup(t)
  saveAuthSession(session())
  let revokedToken
  t.mock.method(authService, 'revokeAllSessions', async (token) => { revokedToken = token })
  t.mock.method(authService, 'revokeCurrentSession', async () => assert.fail('must not revoke twice'))
  t.mock.method(appStore, 'leaveAccount', async () => {})

  await successfulStore.revokeAllDevices()
  assert.equal(revokedToken, 'opaque_token_12345678901234567890')
  assert.equal(loadAuthSession(), null)
  assert.equal(successfulStore.getSnapshot().status, 'guest')

  const failedStore = new AuthStore()
  saveAuthSession(session())
  t.mock.method(authService, 'revokeAllSessions', async () => { throw new Error('network down') })
  await assert.rejects(failedStore.revokeAllDevices(), /network down/)
  assert.ok(loadAuthSession())
})

test('logout clears the in-memory security session', async (t) => {
  const store = setup(t)
  let loginCount = 0
  t.mock.method(authService, 'loginWithWechat', async () => session(`opaque_token_${++loginCount}_12345678901234567890`))
  t.mock.method(appStore, 'leaveAccount', async () => {})

  await sessionService.ensureLoggedInSession()
  await store.logout()
  const next = await sessionService.ensureLoggedInSession()

  assert.equal(loginCount, 2)
  assert.match(next.token, /opaque_token_2_/)
})
