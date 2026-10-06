const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const compiledRoot = path.resolve(__dirname, '..', '..', '.work-sync-test-build', 'miniprogram')
const { saveNewCloudWork, updateCloudWork } = require(path.join(compiledRoot, 'services', 'work-service.js'))

const draft = {
  id: 'local-1',
  sourceImagePath: '/saved/original.jpg',
  createdAt: Date.now(),
  generationMode: 'standard',
  settings: { width: 1, height: 1, colorLimit: 32, brand: 'MARD' },
  cells: [{ color: '#ffffff', colorCode: 'A01' }],
}

const summary = {
  id: 'cloud-1', title: '作品', coverUrl: 'https://cdn.example/original.jpg',
  width: 1, height: 1, beadCount: 1, colorCount: 1, brand: 'MARD',
  generationMode: 'standard', status: 'completed', isFavorite: false,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}

test('新作品上传原图；旧云端作品缺原图时保留原封面', async () => {
  const requests = []
  const uploads = []
  global.wx = {
    getStorageSync: () => ({
      token: 'test-token-123456', expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'user-1', nickname: '用户', avatarUrl: null },
    }),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    uploadFile: (options) => {
      uploads.push(options.filePath)
      options.success({ statusCode: 200, data: JSON.stringify({ file: { id: 'file-1' } }) })
    },
    request: (options) => {
      requests.push(options)
      options.success({ statusCode: 200, data: summary })
    },
  }

  await saveNewCloudWork(draft, draft.sourceImagePath, '作品')
  await updateCloudWork('cloud-1', draft, undefined, '作品')

  assert.deepEqual(uploads, ['/saved/original.jpg'])
  assert.equal(requests[0].data.coverFileId, 'file-1')
  assert.equal(requests[1].method, 'PUT')
  assert.equal('coverFileId' in requests[1].data, false)
})

test('离线编辑的云端作品补传时更新原作品且不重传旧封面', async () => {
  const service = require(path.join(compiledRoot, 'services', 'work-service.js'))
  const { appStore } = require(path.join(compiledRoot, 'store', 'app-store.js'))
  const { syncPendingWorks } = require(path.join(compiledRoot, 'services', 'work-sync-service.js'))
  const originals = {
    session: service.hasCloudSession,
    create: service.saveNewCloudWork,
    update: service.updateCloudWork,
    user: appStore.getActiveUserId,
    candidates: appStore.getSyncCandidates,
    draft: appStore.getLocalDraft,
    mark: appStore.markSyncStatus,
    replace: appStore.replaceLocalWorkWithCloud,
  }
  let updated = null
  let replaced = false
  try {
    service.hasCloudSession = () => true
    service.saveNewCloudWork = () => { throw new Error('不应创建新作品') }
    service.updateCloudWork = async (...args) => { updated = args; return summary }
    appStore.getActiveUserId = () => 'user-1'
    appStore.getSyncCandidates = () => [{ id: 'cloud-1', title: '作品', pendingCloudUpdate: true }]
    appStore.getLocalDraft = () => ({ ...draft, sourceImagePath: '' })
    appStore.markSyncStatus = async () => {}
    appStore.replaceLocalWorkWithCloud = async () => { replaced = true }

    assert.deepEqual(await syncPendingWorks('user-1'), { uploaded: 1, skipped: 0, failed: 0 })
    assert.equal(updated[0], 'cloud-1')
    assert.equal(updated[2], undefined)
    assert.equal(replaced, true)
  } finally {
    service.hasCloudSession = originals.session
    service.saveNewCloudWork = originals.create
    service.updateCloudWork = originals.update
    appStore.getActiveUserId = originals.user
    appStore.getSyncCandidates = originals.candidates
    appStore.getLocalDraft = originals.draft
    appStore.markSyncStatus = originals.mark
    appStore.replaceLocalWorkWithCloud = originals.replace
  }
})

test('标准作品原图从 AI 临时目录复制到不会被任务清理的目录', async () => {
  const { persistImage, removePersistedWorkImage } = require(path.join(compiledRoot, 'services', 'image-service.js'))
  let copied = null
  const removed = []
  global.wx.env = { USER_DATA_PATH: '/saved' }
  global.wx.getFileSystemManager = () => ({
    accessSync: () => {},
    copyFile: (options) => { copied = options; options.success() },
    unlinkSync: (filePath) => { removed.push(filePath) },
  })

  const destination = await persistImage('/saved/pindou-ai/original.png', '/saved/pindou-work-images')
  assert.match(destination, /^\/saved\/pindou-work-images\/\d+-[a-z0-9]+\.png$/)
  assert.equal(copied.srcPath, '/saved/pindou-ai/original.png')
  assert.equal(copied.destPath, destination)
  removePersistedWorkImage(destination)
  removePersistedWorkImage('/saved/pindou-ai/original.png')
  assert.deepEqual(removed, [destination])
})
