const assert = require('node:assert/strict')
const test = require('node:test')
const { AppError } = require('../dist/shared/app-error')
const { PostgresTextImageWorkService } = require('../dist/modules/works/text-image-work-service')
const { PostgresTextImageGenerationService } = require('../dist/modules/ai/text-image-generation-service')

function workFixture(options = {}) {
  const now = new Date('2026-10-03T04:00:00.000Z')
  const db = {
    userId: options.userId ?? 'usr_current',
    jobId: options.jobId ?? 'textjob_0123456789abcdef',
    status: options.status ?? 'succeeded',
    expiresAt: new Date('2026-10-04T04:00:00.000Z'),
    consumedAt: null,
    deletedAt: options.deletedAt ?? null,
    work: null,
    asset: null,
    coverSaveCount: 0,
    coverRemoveCount: 0,
    aiReadCount: 0,
  }
  const query = async (sql, args = []) => {
    const text = sql.toLowerCase()
    if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 }
    if (text.includes('select id from pindou_text_image_works')) {
      const found = db.work && db.work.user_id === args[0] && db.work.source_job_id === args[1] && db.work.deleted_at
      return { rows: found ? [{ id: db.work.id }] : [], rowCount: found ? 1 : 0 }
    }
    if (text.includes('select jobs.id, jobs.prompt, jobs.status')) {
      const found = db.jobId === args[0] && db.userId === args[1]
      return { rows: found ? [{
        id: db.jobId,
        prompt: '一只橘猫',
        status: db.status,
        expires_at: db.expiresAt,
        output_object_key: 'ai/ai_output.png',
        output_content_type: 'image/png',
      }] : [], rowCount: found ? 1 : 0 }
    }
    if (text.includes('select works.id, works.prompt')) {
      const found = db.work && db.work.user_id === args[0] && db.work.source_job_id === args[1] && !db.work.deleted_at
      return { rows: found ? [{
        id: db.work.id,
        title: '文生图作品',
        prompt: db.work.prompt,
        cover_url: 'https://cdn.example.test/original.png',
        width: 1024,
        height: 1024,
        created_at: db.work.created_at,
        updated_at: db.work.updated_at,
      }] : [], rowCount: found ? 1 : 0 }
    }
    if (text.includes('select files.id, files.object_key')) {
      const found = db.work && db.asset && db.work.user_id === args[0]
        && db.work.id === args[1] && !db.work.deleted_at
      return { rows: found ? [{ id: db.asset.id, object_key: db.asset.object_key }] : [], rowCount: found ? 1 : 0 }
    }
    if (text.includes('insert into pindou_file_assets')) {
      db.asset = { id: args[0], object_key: args[2] }
      return { rows: [], rowCount: 1 }
    }
    if (text.includes('insert into pindou_text_image_works')) {
      db.work = {
        id: args[0],
        user_id: args[1],
        source_job_id: args[2],
        image_file_id: args[3],
        prompt: args[4],
        created_at: args[5],
        updated_at: args[5],
        deleted_at: db.deletedAt,
      }
      return { rows: [{
        id: args[0],
        prompt: args[4],
        created_at: args[5],
        updated_at: args[5],
        title: args[6],
        cover_url: args[7],
        width: args[8],
        height: args[9],
      }], rowCount: 1 }
    }
    if (text.includes('update pindou_text_image_generation_jobs') && text.includes('consumed_at')) {
      db.consumedAt = args[2]
      return { rows: [], rowCount: 1 }
    }
    if (text.includes('update pindou_text_image_works set deleted_at')) {
      if (db.work?.user_id === args[0] && db.work.id === args[1]) db.work.deleted_at = args[2]
      return { rows: [], rowCount: 1 }
    }
    if (text.includes('update pindou_file_assets set deleted_at')) {
      if (db.asset?.id === args[0]) db.asset.deleted_at = args[1]
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
  const pool = { async connect() { return { query, release() {} } }, query }
  const covers = {
    async save() {
      db.coverSaveCount += 1
      if (options.failCoverSave) throw new Error('storage unavailable')
      return {
        objectKey: 'cover/original.png', publicUrl: 'https://cdn.example.test/original.png',
        contentType: 'image/png', byteSize: 5, width: 1024, height: 1024,
      }
    },
    async remove() { db.coverRemoveCount += 1 },
  }
  const aiFiles = {
    async readObject(key) {
      db.aiReadCount += 1
      assert.equal(key, 'ai/ai_output.png')
      return { buffer: Buffer.from('image'), contentType: 'image/png' }
    },
  }
  return { db, service: new PostgresTextImageWorkService(pool, covers, aiFiles, () => now) }
}

test('successful text generation is stored as one durable, repeatable artwork', async () => {
  const { db, service } = workFixture()
  const first = await service.create('usr_current', db.jobId)
  const second = await service.create('usr_current', db.jobId)

  assert.equal(first.id, second.id)
  assert.equal(first.coverUrl, 'https://cdn.example.test/original.png')
  assert.equal(first.prompt, '一只橘猫')
  assert.equal(db.coverSaveCount, 1)
  assert.ok(db.consumedAt)
})

test('text image artwork read and delete enforce ownership and remove its durable image', async () => {
  const { db, service } = workFixture()
  const work = await service.create('usr_current', db.jobId)
  await assert.rejects(service.get('usr_other', work.id), (error) => error.statusCode === 404)
  await assert.rejects(service.delete('usr_other', work.id), (error) => error.statusCode === 404)
  assert.equal(db.work.deleted_at, null)

  await service.delete('usr_current', work.id)
  assert.ok(db.work.deleted_at)
  assert.equal(db.coverRemoveCount, 1)
  await assert.rejects(service.get('usr_current', work.id), (error) => error.statusCode === 404)
})

test('text image save rejects another user and a previously deleted artwork', async () => {
  const foreign = workFixture({ userId: 'usr_owner' })
  await assert.rejects(foreign.service.create('usr_other', foreign.db.jobId), (error) => error.statusCode === 404)

  const deleted = workFixture({ deletedAt: new Date('2026-10-02T00:00:00.000Z') })
  deleted.db.work = { user_id: 'usr_current', source_job_id: deleted.db.jobId, deleted_at: deleted.db.deletedAt, id: 'txtwork_deleted' }
  await assert.rejects(deleted.service.create('usr_current', deleted.db.jobId), (error) =>
    error instanceof AppError && error.statusCode === 409 && error.code === 'TEXT_IMAGE_WORK_DELETED')
  assert.equal(deleted.db.coverSaveCount, 0)
})

test('failed durable upload leaves the successful source task available for retry', async () => {
  const fixture = workFixture({ failCoverSave: true })
  await assert.rejects(fixture.service.create('usr_current', fixture.db.jobId), /storage unavailable/)
  assert.equal(fixture.db.consumedAt, null)
  assert.equal(fixture.db.work, null)
})

test('failed task deletion checks status and owner before deleting the task or temporary file', async () => {
  let status = 'succeeded'
  let owner = 'usr_current'
  let deletedTask = false
  let deletedFile = false
  let quotaQueries = 0
  let removed = false
  const pool = {
    async connect() {
      return {
        async query(sql, args = []) {
          const text = sql.toLowerCase()
          if (text.includes('pindou_quota_transactions')) quotaQueries += 1
          if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 }
          if (text.includes('select jobs.*, files.object_key')) {
            return owner === args[1] ? { rows: [{ id: args[0], status, output_file_id: 'file_output', output_object_key: 'ai/output.png' }], rowCount: 1 } : { rows: [], rowCount: 0 }
          }
          if (text.includes('delete from pindou_text_image_generation_jobs')) deletedTask = true
          if (text.includes('delete from pindou_file_assets')) deletedFile = true
          return { rows: [], rowCount: 1 }
        },
        release() {},
      }
    },
  }
  const storage = { async remove(key) { assert.equal(key, 'ai/output.png'); removed = true } }
  const service = new PostgresTextImageGenerationService(pool, {}, storage, { dailyAiGenerations: 1 })

  await assert.rejects(service.deleteFailed('usr_current', 'textjob_0123456789abcdef'), (error) => error.statusCode === 409)
  assert.equal(deletedTask, false)
  status = 'failed'
  owner = 'usr_other'
  await assert.rejects(service.deleteFailed('usr_current', 'textjob_0123456789abcdef'), (error) => error.statusCode === 404)
  assert.equal(deletedTask, false)
  owner = 'usr_current'
  await service.deleteFailed('usr_current', 'textjob_0123456789abcdef')
  assert.equal(deletedTask, true)
  assert.equal(deletedFile, true)
  assert.equal(removed, true)
  assert.equal(quotaQueries, 0)
})
