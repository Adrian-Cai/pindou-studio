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
const { AppStore, LocalStorageError } = require(path.join(compiledRoot, 'store', 'app-store.js'))

const STORAGE_KEY = 'pindou-app-state-v2'

/**
 * 这些用例锁的是「本机 storage 不能被图纸撑爆」这件事。
 *
 * 微信给单个小程序的 storage 配额只有 10MB，而 AppStore 把游客 + 所有账号的工作区
 * 塞在同一个 key 里；草稿的逐格对象（{color,colorCode}×N）是绝对大头，
 * 用户攒上几十份图纸就会写满 —— 之后每次 setStorage 都 fail，作品列表刷新、
 * AI 草稿落库全线报「本机存储空间不足」。
 *
 * 因此这里同时锁三件事：
 * 1. 落盘一律是「调色板 + 下标」压缩态（不是逐格对象）；
 * 2. 压缩态能无损还原，且旧格式数据仍可读（免迁移）；
 * 3. 写满时先自救裁剪再重试，救不回来就明确抛错，绝不静默吞掉。
 */

function installWxHarness(options = {}) {
  const memory = new Map()
  const limit = { maxBytes: options.maxBytes ?? Number.POSITIVE_INFINITY }
  const writes = []
  global.wx = {
    getStorageSync: (key) => {
      const value = memory.get(key)
      return value === undefined ? '' : JSON.parse(JSON.stringify(value))
    },
    setStorage: (params) => {
      // 用 JSON 长度近似真实占用：既模拟配额，也顺带保证落盘内容可序列化
      const serialized = JSON.stringify(params.data)
      writes.push(serialized.length)
      if (serialized.length > limit.maxBytes) {
        params.fail({ errMsg: 'setStorage:fail exceed storage max size' })
        return
      }
      memory.set(params.key, JSON.parse(serialized))
      params.success()
    },
  }
  return { memory, writes, setMaxBytes: (value) => { limit.maxBytes = value } }
}

function makeDraft(id, createdAt, size = 8) {
  const palette = ['#ff0000', '#00ff00', '#0000ff']
  const cells = []
  for (let index = 0; index < size * size; index += 1) {
    // 每 7 格留一个透明格，确保 -1 分支被覆盖
    if (index % 7 === 0) {
      cells.push({ color: 'transparent', colorCode: '' })
      continue
    }
    const slot = index % palette.length
    cells.push({ color: palette[slot], colorCode: `C${String(slot + 1).padStart(2, '0')}` })
  }
  return {
    id,
    sourceImagePath: '',
    createdAt,
    generationMode: 'standard',
    settings: { width: size, height: size, colorLimit: 32, brand: '咪小窝' },
    cells,
  }
}

function legacyPayload(guest) {
  return {
    version: 2,
    guest: {
      currentDraft: null,
      localDrafts: {},
      works: [],
      favoriteIds: [],
      downloadQuota: 9,
      downloadQuotaDate: '2026-09-23',
      downloadRecords: [],
      ...guest,
    },
    accounts: {},
  }
}

test('落盘的草稿是「调色板 + 下标」压缩态，不是逐格对象', async () => {
  const { memory } = installWxHarness()
  const draft = makeDraft('d1', 1, 40)
  const store = new AppStore()
  await store.saveLocalDraft(draft)

  const stored = memory.get(STORAGE_KEY).guest.localDrafts.d1
  assert.equal(typeof stored.cells[0], 'number', '落盘 cells 应为下标数组')
  assert.equal(stored.cells.length, 40 * 40)
  assert.ok(stored.cells.includes(-1), '透明格应存 -1')
  assert.equal(stored.palette.length, 3, '同色应去重成 3 项调色板')

  // 压缩的收益必须真实：40×40 图纸落盘体积应远小于逐格对象
  const compactSize = JSON.stringify(memory.get(STORAGE_KEY)).length
  const rawSize = JSON.stringify(draft.cells).length
  assert.ok(compactSize < rawSize / 3, `压缩后 ${compactSize} 应远小于原始 ${rawSize}`)
})

test('压缩态能被无损还原，且旧格式数据免迁移直接可读', async () => {
  const { memory } = installWxHarness()
  const draft = makeDraft('d1', 1, 20)
  const store = new AppStore()
  await store.saveLocalDraft(draft)
  // 真实微信会重新反序列化，这里一并验证
  memory.set(STORAGE_KEY, JSON.parse(JSON.stringify(memory.get(STORAGE_KEY))))

  const revived = new AppStore()
  revived.hydrate()
  assert.deepEqual(revived.getLocalDraft('d1'), draft)

  // 旧版本留下的是逐格对象，hydrate 后必须原样可用
  const legacy = new AppStore()
  memory.set(STORAGE_KEY, legacyPayload({ localDrafts: { d1: draft } }))
  legacy.hydrate()
  assert.deepEqual(legacy.getLocalDraft('d1'), draft)
})

test('压缩态调色板损坏时整份丢弃，不会把下标当颜色用', () => {
  const { memory } = installWxHarness()
  const draft = makeDraft('d1', 1, 4)
  const stored = {
    ...draft,
    palette: [{ code: 'C01', color: '#ff0000' }],
    cells: [0, 1, 2, -1],
  }
  const legacy = new AppStore()
  memory.set(STORAGE_KEY, legacyPayload({ localDrafts: { d1: stored } }))
  legacy.hydrate()
  // 下标 1、2 超出调色板范围：整份丢弃，作品打开时走「缺少可恢复的网格数据」提示。
  // 降级成空网格是错的 —— 空网格是一份合法画布，编辑器会照常打开，用户看不到任何异常。
  assert.equal(legacy.getLocalDraft('d1'), null)
})

test('损坏的当前草稿也会被清掉，不会顶着空网格进编辑器', () => {
  const { memory } = installWxHarness()
  const stored = {
    ...makeDraft('d1', 1, 4),
    palette: [{ code: 'C01', color: '#ff0000' }],
    cells: [5],
  }
  const legacy = new AppStore()
  memory.set(STORAGE_KEY, legacyPayload({ currentDraft: stored, localDrafts: { d1: stored } }))
  legacy.hydrate()
  assert.equal(legacy.getSnapshot().currentDraft, null)
  assert.equal(legacy.getLocalDraft('d1'), null)
})

test('草稿条数超上限时只落盘最新的若干份', async () => {
  const { memory } = installWxHarness()
  const store = new AppStore()
  // 60 份小图纸，超过 50 的落盘上限
  for (let index = 0; index < 60; index += 1) {
    await store.saveLocalDraft(makeDraft(`d${index}`, index, 4), false)
  }
  await store.setCurrentDraft(makeDraft('old-but-current', -1, 4))

  const storedIds = Object.keys(memory.get(STORAGE_KEY).guest.localDrafts)
  assert.ok(storedIds.length <= 50, `落盘草稿应不超过 50 份，实际 ${storedIds.length}`)
  assert.ok(storedIds.includes('d59'), '最新的草稿应保留')
  assert.ok(!storedIds.includes('d0'), '最旧的草稿应被丢弃')
  // 当前草稿不在 localDrafts 里时走 currentDraft 字段，不受条数上限影响
  assert.equal(memory.get(STORAGE_KEY).guest.currentDraft.id, 'old-but-current')
})

test('存储写满时先自救裁剪再重试，不把失败抛给用户', async () => {
  const harness = installWxHarness({ maxBytes: Number.POSITIVE_INFINITY })
  const store = new AppStore()
  for (let index = 0; index < 30; index += 1) {
    await store.saveLocalDraft(makeDraft(`d${index}`, index, 20), false)
  }
  assert.equal(Object.keys(harness.memory.get(STORAGE_KEY).guest.localDrafts).length, 30)

  // 收紧配额到「30 份写不下、8 份写得下」，再存一份触发写满
  harness.setMaxBytes(12_000)
  await store.saveLocalDraft(makeDraft('d30', 30, 20), false)

  const storedIds = Object.keys(harness.memory.get(STORAGE_KEY).guest.localDrafts)
  // 自救保留 8 份，当前草稿（最早那份）额外保留一份，故上限是 9
  assert.ok(storedIds.length <= 9, `自救后应大幅裁剪，实际剩 ${storedIds.length} 份`)
  assert.ok(storedIds.includes('d30'), '自救不能把刚保存的这份也丢掉')
  assert.equal(store.getLocalDraft('d30').cells.length, 400, '内存里的这份仍完整可读')
})

test('自救也救不回来时明确抛 LocalStorageError，不静默吞掉', async () => {
  installWxHarness({ maxBytes: 100 })
  const store = new AppStore()
  await assert.rejects(
    () => store.saveLocalDraft(makeDraft('too-big', 1, 30)),
    (error) => error instanceof LocalStorageError && /存储空间不足/.test(error.message),
  )
})
