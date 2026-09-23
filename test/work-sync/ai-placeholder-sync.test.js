const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const compiledRoot = path.resolve(
  __dirname,
  '..',
  '..',
  '.work-sync-test-build',
  'miniprogram',
)
const { AppStore } = require(path.join(compiledRoot, 'store', 'app-store.js'))
const { resolveSyncFields } = require(path.join(compiledRoot, 'models', 'pattern.js'))

/**
 * 这些用例锁的是一条不变式：**AI 占位作品（ai_pending / ai_failed）永远不进云同步队列**。
 * 占位作品没有图纸，一旦进队列就会被 work-sync-service 以「图案数据不完整」判失败，
 * 并被 markSyncStatus 回写成 failed，从而每次同步反复重试。
 * 规则散落在多个写入口时必然有入口漏判（markSyncStatus 就漏过），
 * 所以这里同时覆盖「收口函数」与「读写两侧的实际行为」。
 */

function installWxHarness() {
  const memory = new Map()
  global.wx = {
    getStorageSync: (key) => memory.get(key),
    setStorage: (options) => {
      memory.set(options.key, options.data)
      options.success()
    },
  }
}

function aiPlaceholder(id, status = 'ai_pending') {
  return {
    id,
    title: 'AI 生成中',
    coverPath: '/tmp/cover.png',
    generationMode: 'ai',
    updatedAt: 1,
    beadCount: 0,
    colorCount: 32,
    status,
  }
}

function realWork(id) {
  return {
    id,
    title: '真实作品',
    coverPath: '/tmp/cover.png',
    generationMode: 'standard',
    updatedAt: 1,
    beadCount: 100,
    colorCount: 32,
    status: 'draft',
  }
}

async function loggedInStore(userId = 'user-1') {
  const store = new AppStore()
  await store.activateAccount(userId)
  return store
}

for (const status of ['ai_pending', 'ai_failed']) {
  test(`resolveSyncFields 让 ${status} 占位作品只存本机，即便已登录`, () => {
    const guest = resolveSyncFields(aiPlaceholder('w1', status), 'user-1')
    assert.equal(guest.syncStatus, 'guest')
    assert.equal(guest.ownerId, undefined)
    assert.equal(guest.isCloud, false)
  })
}

test('resolveSyncFields 让真实作品进待同步队列', () => {
  const pending = resolveSyncFields(realWork('w1'), 'user-1')
  assert.equal(pending.syncStatus, 'pending')
  assert.equal(pending.ownerId, 'user-1')
})

test('resolveSyncFields 保留真实作品的 failed 态', () => {
  const failed = resolveSyncFields({ ...realWork('w1'), syncStatus: 'failed' }, 'user-1')
  assert.equal(failed.syncStatus, 'failed')
})

test('resolveSyncFields 在游客态下让任何作品都只存本机', () => {
  assert.equal(resolveSyncFields(realWork('w1'), null).syncStatus, 'guest')
  assert.equal(resolveSyncFields(aiPlaceholder('w1'), null).syncStatus, 'guest')
})

test('saveWork 落库后，占位作品不在同步候选里', async () => {
  installWxHarness()
  const store = await loggedInStore()
  await store.saveWork(aiPlaceholder('task-1'))
  const saved = store.getSnapshot().works.find((work) => work.id === 'task-1')
  assert.equal(saved.syncStatus, 'guest')
  assert.deepEqual(store.getSyncCandidates('user-1').map((work) => work.id), [])
})

test('saveWork 落库后，真实作品进入同步候选', async () => {
  installWxHarness()
  const store = await loggedInStore()
  await store.saveWork(realWork('work-1'))
  assert.deepEqual(store.getSyncCandidates('user-1').map((work) => work.id), ['work-1'])
})

test('adoptGuestWorks 不把占位作品带进待同步队列', async () => {
  installWxHarness()
  const store = new AppStore()
  await store.saveWork(aiPlaceholder('task-1'))
  await store.saveWork(realWork('work-1'))
  await store.activateAccount('user-1')
  await store.adoptGuestWorks('user-1')

  const candidates = store.getSyncCandidates('user-1').map((work) => work.id)
  assert.deepEqual(candidates, ['work-1'])
  const adoptedPlaceholder = store
    .getSnapshot()
    .works.find((work) => work.id === 'task-1')
  assert.equal(adoptedPlaceholder.syncStatus, 'guest')
  assert.equal(adoptedPlaceholder.ownerId, undefined)
})

test('markSyncStatus 不会把占位作品钉成同步失败', async () => {
  installWxHarness()
  const store = await loggedInStore()
  await store.saveWork(aiPlaceholder('task-1'))
  // 同步服务对缺 draft 的作品回写 failed；占位作品必须免疫，否则会陷入反复重试
  await store.markSyncStatus('task-1', 'failed', '作品图案数据不完整，请重新编辑后重试')

  const work = store.getSnapshot().works.find((item) => item.id === 'task-1')
  assert.equal(work.syncStatus, 'guest')
  assert.equal(work.syncError, undefined)
  assert.equal(work.ownerId, undefined)
  assert.deepEqual(store.getSyncCandidates('user-1').map((item) => item.id), [])
})

test('markSyncStatus 对真实作品照常生效', async () => {
  installWxHarness()
  const store = await loggedInStore()
  await store.saveWork(realWork('work-1'))
  await store.markSyncStatus('work-1', 'failed', '网络异常')
  const work = store.getSnapshot().works.find((item) => item.id === 'work-1')
  assert.equal(work.syncStatus, 'failed')
  assert.equal(work.syncError, '网络异常')
  assert.deepEqual(store.getSyncCandidates('user-1').map((item) => item.id), ['work-1'])
})

test('同步候选对脏数据兜底：占位作品带 failed 也捞不出来', async () => {
  installWxHarness()
  const store = await loggedInStore()
  // 模拟旧版本遗留数据或未来新增入口漏判：占位作品被写成了待同步态
  await store.saveWork({ ...aiPlaceholder('task-1'), syncStatus: 'pending', ownerId: 'user-1' })
  store.persisted.accounts['user-1'].works = store.persisted.accounts['user-1'].works.map(
    (work) => (work.id === 'task-1' ? { ...work, syncStatus: 'failed', ownerId: 'user-1' } : work),
  )
  assert.deepEqual(store.getSyncCandidates('user-1').map((work) => work.id), [])
})

test('任务成功后占位作品转为真实作品并进入同步候选', async () => {
  installWxHarness()
  const store = await loggedInStore()
  await store.saveWork(aiPlaceholder('task-1'))
  await store.saveWork({ ...aiPlaceholder('task-1'), status: 'draft', beadCount: 4096 })

  const candidates = store.getSyncCandidates('user-1').map((work) => work.id)
  assert.deepEqual(candidates, ['task-1'])
})
