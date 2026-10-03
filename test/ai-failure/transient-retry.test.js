/**
 * 守卫「服务端瞬时故障（AI 服务忙 / 超时）不弹失败卡片，而是原地排队重投」。
 *
 * 真机上 AI 失败绝大多数是这一类：混元账号维度限流被翻成 AI_SERVICE_BUSY，
 * 用户能做的唯一动作就是再试一次。把它包装成失败卡片，等于让用户替程序点按钮。
 * 这里锁住三条不变式：瞬时码必须重投、重投必须换幂等键、次数用尽必须真的失败。
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const compiledRoot = path.resolve(__dirname, '../../.ai-failure-test-build/miniprogram')
const { AiGenerationFlow } = require(path.join(compiledRoot, 'services/ai-generation-flow.js'))
const taskStore = require(path.join(compiledRoot, 'services/ai-task-store.js'))

// readTasks 会按结构校验过滤脏数据，settings 缺 brand 的任务会被整条丢弃（读出来是 null）
const SETTINGS = { width: 64, height: 64, colorLimit: 32, brand: 'mard' }

function failure(code) {
  return {
    code,
    message: 'AI 生成服务繁忙，请稍后重试',
    category: 'PROVIDER',
    retryable: true,
    action: 'RETRY',
  }
}

function setup(t) {
  const storage = {}
  global.wx = {
    env: { USER_DATA_PATH: '/tmp/user' },
    getStorageSync: (key) => storage[key] ?? '',
    setStorageSync: (key, value) => { storage[key] = value },
    removeStorageSync: (key) => { delete storage[key] },
    getFileSystemManager: () => ({
      accessSync: () => undefined,
      readdirSync: () => [],
      unlinkSync: () => undefined,
    }),
  }
  t.after(() => { delete global.wx })
  const task = taskStore.createAiTask({ sourceImagePath: '/tmp/source.png', settings: SETTINGS })
  taskStore.patchAiTask(task.taskId, { jobId: 'aijob_1', status: 'processing', inputFileId: 'file_input' })
  const states = []
  const flow = new AiGenerationFlow({
    taskId: task.taskId,
    onStateChange: (taskId) => { states.push(taskId) },
  })
  return { flow, taskId: task.taskId, states }
}

/** 模拟一次「轮询查到服务端已完成且失败」。 */
async function reportFailed(flow, code) {
  await flow.handleGeneration({
    id: 'aijob_1',
    status: 'failed',
    failure: failure(code),
    inputFileId: 'file_input',
    outputFile: null,
    generationMode: 'ai',
  })
}

test('AI_SERVICE_BUSY 不进失败态，而是原地排队重投', async (t) => {
  const { flow, taskId } = setup(t)
  await reportFailed(flow, 'AI_SERVICE_BUSY')

  const task = taskStore.getAiTask(taskId)
  assert.equal(task.status, 'queued')
  assert.equal(task.finishedAt, null)
  assert.equal(task.failure, null)
  // 清 jobId 才能重新走 submit；换幂等键才能真的新建任务
  // （沿用旧键会命中服务端那个已 failed 的任务，每次都拿回同一个失败结果）。
  assert.equal(task.jobId, null)
  assert.notEqual(task.idempotencyKey, '')
  assert.equal(flow.getState().pageState, 'queued')
  assert.match(flow.getState().statusMessage, /自动重试/)
})

test('自动重投最多两次，之后仍然真的进失败态', async (t) => {
  const { flow, taskId } = setup(t)
  const firstKey = taskStore.getAiTask(taskId).idempotencyKey

  await reportFailed(flow, 'AI_SERVICE_BUSY')
  assert.equal(taskStore.getAiTask(taskId).status, 'queued')
  const secondKey = taskStore.getAiTask(taskId).idempotencyKey
  assert.notEqual(secondKey, firstKey)

  await reportFailed(flow, 'AI_SERVICE_BUSY')
  assert.equal(taskStore.getAiTask(taskId).status, 'queued')

  await reportFailed(flow, 'AI_SERVICE_BUSY')
  const failed = taskStore.getAiTask(taskId)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.failure.code, 'AI_SERVICE_BUSY')
  assert.ok(failed.finishedAt > 0, '失败任务必须写入 finishedAt')
})

test('非瞬时失败码不重投：沿用旧幂等键重试没有意义', async (t) => {
  for (const code of ['AI_GENERATION_FAILED', 'CONTENT_REJECTED', 'AI_SERVICE_UNAVAILABLE']) {
    const { flow, taskId } = setup(t)
    const keyBefore = taskStore.getAiTask(taskId).idempotencyKey
    await reportFailed(flow, code)
    const task = taskStore.getAiTask(taskId)
    assert.equal(task.status, 'failed')
    assert.equal(task.failure.code, code)
    assert.equal(task.idempotencyKey, keyBefore, `${code} 不该触发重投`)
  }
})
