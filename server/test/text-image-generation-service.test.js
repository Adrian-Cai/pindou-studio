const test = require('node:test')
const assert = require('node:assert/strict')
const { PostgresTextImageGenerationService } = require('../dist/modules/ai/text-image-generation-service')

function fixture(providerFails = false) {
  const now = new Date('2026-09-29T04:00:00.000Z')
  const db = { job: null, debitCount: 0 }
  const pool = {
    async connect() {
      return { query: (sql, args = []) => query(sql, args), release() {} }
    },
    query,
  }
  function query(sql, args = []) {
    const text = sql.toLowerCase()
    if (text.includes('insert into pindou_text_image_generation_jobs')) {
      db.job = {
        id: args[0], user_id: args[1], prompt: args[2], provider: args[3], model: args[4], image_size: args[8],
        status: 'queued', output_file_id: null, output_public_url: null, output_content_type: null,
        output_byte_size: null, provider_request_id: null, idempotency_key: args[5], error_code: null,
        created_at: now, updated_at: now, started_at: null, completed_at: null, expires_at: args[7],
      }
      return Promise.resolve({ rows: [db.job], rowCount: 1 })
    }
    if (text.includes('update pindou_text_image_generation_jobs') && text.includes("set status = 'processing'")) {
      if (!db.job || db.job.status !== 'queued') return Promise.resolve({ rows: [], rowCount: 0 })
      Object.assign(db.job, { status: 'processing', started_at: args[1], updated_at: args[1] })
      return Promise.resolve({ rows: [db.job], rowCount: 1 })
    }
    if (text.includes('update pindou_text_image_generation_jobs') && text.includes("set status = 'succeeded'")) {
      Object.assign(db.job, { status: 'succeeded', output_file_id: args[1], provider_request_id: args[2], completed_at: args[3], updated_at: args[3] })
      return Promise.resolve({ rows: [], rowCount: 1 })
    }
    if (text.includes('update pindou_text_image_generation_jobs') && text.includes("set status = 'failed'")) {
      Object.assign(db.job, { status: 'failed', error_code: args[1], completed_at: args[2], updated_at: args[2] })
      return Promise.resolve({ rows: [], rowCount: 1 })
    }
    if (text.includes('select jobs.*')) return Promise.resolve({ rows: [] })
    if (text.includes('from pindou_users')) return Promise.resolve({ rows: [{ id: 'usr_test' }] })
    if (text.includes('from pindou_quota_transactions')) return Promise.resolve({ rows: [{ daily_free: '1', used_today: '0', daily_remaining: '1', purchased: '0' }] })
    if (text.includes('count(*)::text as active_count')) return Promise.resolve({ rows: [{ active_count: '0' }] })
    if (text.includes('from pindou_text_image_generation_jobs') && text.includes('for update')) return Promise.resolve({ rows: [db.job] })
    if (text.includes('insert into pindou_quota_transactions') && text.includes("'usage_debit'")) db.debitCount += 1
    return Promise.resolve({ rows: [], rowCount: 1 })
  }
  const provider = {
    name: 'hunyuan',
    configured: true,
    async generateTextImage(prompt, size) {
      db.providerInput = { prompt, size }
      if (providerFails) throw new Error('provider failed')
      return { requestId: 'provider_req_1', buffer: Buffer.from('image'), contentType: 'image/png' }
    },
  }
  const storage = {
    async save() { return { objectKey: 'ai/ai_output_test.png', publicUrl: 'https://example.test/ai.png', contentType: 'image/png', byteSize: 5, width: 1, height: 1 } },
    async remove() {},
  }
  return {
    db,
    service: new PostgresTextImageGenerationService(pool, provider, storage, { dailyAiGenerations: 1 }, () => now),
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail('文生图后台任务未收口')
}

test('文生图仅在参考图成功落盘后扣一次额度', async () => {
  const { db, service } = fixture()
  const task = await service.create({ userId: 'usr_test', idempotencyKey: 'request-1', prompt: '一只橘猫' })
  assert.ok(task.status === 'queued' || task.status === 'processing')
  await waitFor(() => db.job?.status === 'succeeded')
  assert.equal(db.debitCount, 1)
})

test('文生图 Provider 失败时不扣额度', async () => {
  const { db, service } = fixture(true)
  await service.create({ userId: 'usr_test', idempotencyKey: 'request-2', prompt: '一朵黄色小花' })
  await waitFor(() => db.job?.status === 'failed')
  assert.equal(db.debitCount, 0)
})

test('文生图尺寸校验、持久化与 Provider 传递使用同一白名单', async () => {
  const { validateCreateTextImageGenerationBody } = require('../dist/http/request-validation')
  const { TEXT_IMAGE_SIZES } = require('../dist/modules/ai/text-image-options')
  const cloudSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../cloudfunctions/generateImage/index.js'), 'utf8')
  assert.deepEqual(TEXT_IMAGE_SIZES, cloudSource.match(/const ALLOWED_SIZES = \[(.+)\]/)[1].match(/'([^']+)'/g).map(size => size.slice(1, -1)))
  assert.throws(() => validateCreateTextImageGenerationBody({ prompt: '猫', size: '1920x1080' }))
  assert.throws(() => validateCreateTextImageGenerationBody({ prompt: '猫', size: null }))
  assert.equal(validateCreateTextImageGenerationBody({ prompt: '猫' }).size, '1024x1024')
  for (const size of TEXT_IMAGE_SIZES) {
    const { db, service } = fixture()
    const body = validateCreateTextImageGenerationBody({ prompt: '一只猫', size })
    const task = await service.create({ userId: 'usr_test', idempotencyKey: size, ...body })
    await waitFor(() => db.job?.status === 'succeeded')
    assert.equal(task.size, size)
    assert.equal(db.job.image_size, size)
    assert.deepEqual(db.providerInput, { prompt: '一只猫', size })
  }
})
