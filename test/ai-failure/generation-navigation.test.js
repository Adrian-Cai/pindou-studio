const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const compiledRoot = path.resolve(__dirname, '../../.ai-failure-test-build/miniprogram')
const { aiTaskManager } = require(path.join(compiledRoot, 'services/ai-generation-manager.js'))
const aiTaskStore = require(path.join(compiledRoot, 'services/ai-task-store.js'))
const imageService = require(path.join(compiledRoot, 'services/image-service.js'))
const textService = require(path.join(compiledRoot, 'services/text-generation-service.js'))
const { appStore } = require(path.join(compiledRoot, 'store/app-store.js'))

function loadPage(relativePath) {
  const filename = path.join(compiledRoot, relativePath)
  let definition
  global.Page = (page) => { definition = page }
  delete require.cache[filename]
  require(filename)
  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch) { Object.assign(this.data, patch) },
  }
}

function setup(t, loggedIn = true) {
  const calls = { navigation: [], toasts: [], tasks: [], drafts: [], retries: [] }
  global.wx = {
    getStorageSync: (key) => key === 'pindou-auth-session-v1' && loggedIn ? {
      token: 'opaque_token_12345678901234567890',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      user: { id: 'usr_test', nickname: null, avatarUrl: null },
    } : '',
    navigateTo: (options) => { calls.navigation.push(options.url); options.complete?.() },
    redirectTo: (options) => { calls.navigation.push(options.url); options.complete?.() },
    switchTab: (options) => { calls.navigation.push(options.url) },
    showToast: (options) => { calls.toasts.push(options.title) },
    showLoading() {},
    hideLoading() {},
  }
  t.mock.method(imageService, 'persistImage', async (imagePath) => imagePath)
  t.mock.method(aiTaskManager, 'createTask', async (input) => {
    calls.tasks.push(input)
    return `task-${calls.tasks.length}`
  })
  t.mock.method(appStore, 'setCurrentDraft', async (draft) => { calls.drafts.push(draft) })
  const home = loadPage('pages/create/index.js')
  home.setData({
    sourceImagePath: '/tmp/source.png',
    contentSecurityImagePath: '/tmp/security.jpg',
    securityCheckId: 'security-1',
    uploadStatus: 'success',
    generationMode: 'ai',
  })
  home.onShow()
  t.after(() => { delete global.Page; delete global.wx })
  return { home, calls }
}

test('游客不能选择 AI 模式或提交文生图', async (t) => {
  const { home, calls } = setup(t, false)
  home.setData({ generationMode: 'standard', prompt: '一只猫', promptLength: 3 })

  home.selectMode({ currentTarget: { dataset: { mode: 'ai' } } })
  await home.startTextGeneration()

  assert.equal(home.data.generationMode, 'standard')
  assert.equal(home.data.creatingText, false)
  home.setData({ generationMode: 'ai' })
  await home.startCreating()
  assert.deepEqual(calls.toasts, [
    '请先登录后使用 AI 功能',
    '请先登录后使用 AI 功能',
    '请先登录后使用 AI 功能',
  ])
  assert.deepEqual(calls.tasks, [])
  assert.deepEqual(calls.navigation, [])
})

test('首页入口进入创作页并选中对应 Tab', (t) => {
  const homeTemplate = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/home/index.wxml'), 'utf8')
  assert.equal((homeTemplate.match(/url="\/pages\/create\/index\?source=image"/g) || []).length, 2)
  assert.match(homeTemplate, /url="\/pages\/create\/index\?source=text"/)

  const creation = loadPage('pages/create/index.js')
  creation.onLoad({ source: 'image' })
  assert.equal(creation.data.creationSource, 'image')
  creation.onLoad({ source: 'text' })
  assert.equal(creation.data.creationSource, 'text')

  creation.setData({ prompt: '一只草地上的猫', sourceImagePath: '/tmp/source.png' })
  creation.selectCreationSource({ currentTarget: { dataset: { source: 'image' } } })
  assert.equal(creation.data.creationSource, 'image')
  assert.equal(creation.data.prompt, '一只草地上的猫')
  assert.equal(creation.data.sourceImagePath, '/tmp/source.png')
  t.after(() => { delete global.Page; delete global.wx })
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('文生图防重复提交，传递尺寸，创建失败保留描述', async t => {
  const { home, calls } = setup(t)
  const pending = deferred()
  const submissions = []
  t.mock.method(textService, 'createTextGeneration', async (...args) => {
    submissions.push(args)
    await pending.promise
    throw new Error('服务繁忙，请稍后重试')
  })
  home.setData({ prompt: '  雨夜的小书店  ', promptLength: 9, textSizes: ['1280x720'], textSize: '1280x720' })
  const first = home.startTextGeneration()
  await home.startTextGeneration()
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0][0], '雨夜的小书店')
  assert.equal(submissions[0][2], '1280x720')
  pending.resolve()
  await first
  assert.equal(home.data.creatingText, false)
  assert.equal(home.data.prompt, '  雨夜的小书店  ')
  assert.deepEqual(calls.toasts, ['服务繁忙，请稍后重试'])
})

function setupDetail(t, from = 'home', status = 'processing') {
  const context = setup(t)
  let listener
  const view = {
    status, isFailed: status === 'failed', isSucceeded: status === 'succeeded',
    sourceImagePath: '/tmp/source.png', width: 64, height: 64, colorLimit: 32,
    createdAt: Date.now(), progress: 60, stateTitle: 'AI 正在生成拼豆图',
    failureMessage: status === 'failed' ? 'AI 生成超时，请稍后重试' : '',
    canRetry: true, action: 'RETRY',
  }
  t.mock.method(aiTaskManager, 'resolveTaskId', (id) => id)
  t.mock.method(aiTaskManager, 'getTaskView', () => view)
  t.mock.method(aiTaskManager, 'subscribeTask', (_id, callback) => {
    listener = callback
    return () => { listener = null }
  })
  t.mock.method(aiTaskManager, 'retryTask', async (id) => { context.calls.retries.push(id) })
  t.mock.method(appStore, 'getLocalDraft', () => ({
    id: 'task-1',
    sourceImagePath: '/tmp/generated.png',
    createdAt: Date.now(),
    generationMode: 'ai',
    settings: { width: 64, height: 64, colorLimit: 32, brand: 'mard' },
    cells: [{ color: '#7c5cfc', colorCode: 'C01' }],
  }))
  const detail = loadPage('packages/ai-generation/index.js')
  detail.onLoad({ taskId: 'task-1', from })
  detail.onShow()
  return { ...context, detail, view, notify: () => listener?.() }
}

test('AI 提交后进入本次任务生成页，保留首页图片与参数供返回重试', async (t) => {
  const { home, calls } = setup(t)
  assert.equal(home.data.aiStyle, 'kawaii')
  const settings = structuredClone(home.data.settings)
  await home.startCreating()
  assert.deepEqual(calls.navigation, ['/packages/ai-generation/index?taskId=task-1&from=home'])
  assert.equal(calls.tasks.length, 1)
  assert.equal(calls.tasks[0].style, 'kawaii')
  assert.equal(calls.tasks[0].securityCheckId, 'security-1')
  assert.equal(home.data.sourceImagePath, '/tmp/source.png')
  assert.equal(home.data.uploadStatus, 'success')
  assert.deepEqual(home.data.settings, settings)
  assert.equal(home.data.submitting, false)
  assert.deepEqual(calls.toasts, [])
  assert.deepEqual(calls.drafts, [])
})

test('切换 AI 风格会提交对应风格', async (t) => {
  const { home, calls } = setup(t)
  home.selectAiStyle({ currentTarget: { dataset: { style: 'cartoon' } } })
  assert.equal(home.data.aiStyle, 'cartoon')
  await home.startCreating()
  assert.equal(calls.tasks[0].style, 'cartoon')
})

test('Q 版风格在本地任务恢复和重试状态更新后保留', (t) => {
  const storage = new Map()
  global.wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
  }
  const task = aiTaskStore.createAiTask({
    sourceImagePath: '/tmp/source.png',
    settings: { width: 64, height: 64, colorLimit: 32, brand: 'mard' },
    style: 'kawaii',
  })

  assert.equal(aiTaskStore.listActiveAiTasks()[0].style, 'kawaii')
  assert.equal(aiTaskStore.patchAiTask(task.taskId, { status: 'created', retryCount: 1 }).style, 'kawaii')
  t.after(() => { delete global.wx })
})

test('创建任务失败后解除按钮状态，保留图片并允许再次生成', async (t) => {
  const { home, calls } = setup(t)
  aiTaskManager.createTask.mock.mockImplementationOnce(async () => { throw new Error('任务创建失败') })
  await home.startCreating()
  assert.deepEqual(calls.navigation, [])
  assert.equal(home.data.submitting, false)
  assert.equal(home.data.uploadStatus, 'success')
  assert.deepEqual(calls.toasts, ['任务创建失败'])
  await home.startCreating()
  assert.equal(calls.tasks.length, 1)
  assert.equal(calls.navigation.length, 1)
})

test('入队期间重复点击不重复创建，异步保存使用点击时的完整输入', async (t) => {
  const { home, calls } = setup(t)
  const pending = deferred()
  imageService.persistImage.mock.mockImplementationOnce(() => pending.promise)
  const creating = home.startCreating()
  await home.startCreating()
  home.setData({ contentSecurityImagePath: '/tmp/new.jpg', securityCheckId: 'new-check' })
  home.data.settings.width = 128
  pending.resolve('/tmp/source.png')
  await creating
  assert.equal(calls.tasks.length, 1)
  assert.equal(calls.tasks[0].inputImagePath, '/tmp/security.jpg')
  assert.equal(calls.tasks[0].securityCheckId, 'security-1')
  assert.equal(calls.tasks[0].settings.width, 64)
})

test('生成页打开失败时提示已有任务的位置，不误报创建失败', async (t) => {
  const { home, calls } = setup(t)
  global.wx.navigateTo = (options) => { options.fail(); options.complete() }
  await home.startCreating()
  assert.equal(calls.tasks.length, 1)
  assert.equal(home.data.submitting, false)
  assert.deepEqual(calls.toasts, ['生成页打开失败，可到作品页查看任务'])
})

test('用户在提交过程中离开首页，入队完成不抢走当前页面', async (t) => {
  const { home, calls } = setup(t)
  const pending = deferred()
  imageService.persistImage.mock.mockImplementationOnce(() => pending.promise)
  const creating = home.startCreating()
  home.onHide()
  pending.resolve('/tmp/source.png')
  await creating
  assert.equal(calls.tasks.length, 1)
  assert.deepEqual(calls.navigation, [])
})

for (const mode of ['standard', 'ai']) {
  test(`返回首页保留 ${mode} 选择，不被另一模式的旧草稿改写`, (t) => {
    const { home } = setup(t)
    t.mock.method(appStore, 'getSnapshot', () => ({
      currentDraft: { generationMode: mode === 'standard' ? 'ai' : 'standard' },
    }))
    home.setData({ generationMode: mode, generating: true, submitting: true })
    home.onShow()
    assert.equal(home.data.generationMode, mode)
    assert.equal(home.data.generating, false)
    assert.equal(home.data.submitting, false)
  })
}

test('标准模式直接生成并进入编辑器，不创建或取消 AI 任务', async (t) => {
  const { home, calls } = setup(t)
  home.setData({ generationMode: 'standard' })
  const draft = { id: 'standard-draft', generationMode: 'standard' }
  t.mock.method(imageService, 'createDraft', async (_path, _settings, mode) => {
    assert.equal(mode, 'standard')
    return draft
  })
  t.mock.method(aiTaskManager, 'cancelTask', () => assert.fail('标准模式不得取消 AI 任务'))
  await home.startCreating()
  assert.deepEqual(calls.navigation, ['/packages/editor/index'])
  assert.deepEqual(calls.drafts, [draft])
  assert.deepEqual(calls.tasks, [])
  assert.equal(home.data.generating, false)
})

test('生成中的任务启用既有动效状态；失败后可返回首页再次生成', async (t) => {
  const { home, detail, view, notify, calls } = setupDetail(t)
  assert.equal(detail.data.isGenerating, true)
  assert.equal(detail.data.progress, 60)
  assert.equal(detail.data.stateTitle, 'AI 正在生成拼豆图')
  Object.assign(view, { status: 'failed', isFailed: true, failureMessage: 'AI 生成超时，请稍后重试' })
  notify()
  assert.equal(detail.data.isGenerating, false)
  assert.equal(detail.data.isFailed, true)
  assert.equal(detail.data.editorReady, false)
  detail.backHome()
  detail.onUnload()
  home.onShow()
  await home.startCreating()
  assert.deepEqual(calls.navigation, [
    '/pages/home/index', '/packages/ai-generation/index?taskId=task-1&from=home',
  ])
})

test('当前生成页成功后留在同一页，并加载对应 AI 草稿', async (t) => {
  const { detail, view, calls } = setupDetail(t)
  Object.assign(view, { status: 'succeeded', isSucceeded: true })
  await detail.handleSucceeded()
  await detail.handleSucceeded()
  assert.deepEqual(calls.navigation, [])
  assert.equal(calls.drafts.length, 1)
  assert.equal(detail.data.editorReady, true)
  assert.equal(detail.data.draft.id, 'task-1')
})

test('离开生成页后成功通知不覆盖当前草稿、不跳转', async (t) => {
  const { detail, view, notify, calls } = setupDetail(t)
  detail.onHide()
  Object.assign(view, { status: 'succeeded', isSucceeded: true })
  notify()
  await detail.handleSucceeded()
  assert.deepEqual(calls.navigation, [])
  assert.deepEqual(calls.drafts, [])
})

test('成功后返回首页，保存完成也不抢回编辑器', async (t) => {
  const { detail, calls } = setupDetail(t)
  const pending = deferred()
  appStore.setCurrentDraft.mock.mockImplementationOnce(() => pending.promise)
  const completing = detail.handleSucceeded()
  detail.backHome()
  detail.onHide()
  pending.resolve()
  await completing
  assert.deepEqual(calls.navigation, ['/pages/home/index'])
})

test('从作品页回看成功任务仍留在当前页；失败重试仍绑定原任务', async (t) => {
  const { detail, calls } = setupDetail(t, 'projects', 'succeeded')
  await detail.handleSucceeded()
  assert.deepEqual(calls.navigation, [])
  assert.equal(calls.drafts.length, 1)
  detail.retry()
  assert.deepEqual(calls.retries, ['task-1'])
})
