const assert = require("node:assert/strict");
const test = require("node:test");
const { PostgresAiGenerationService } = require("../dist/modules/ai/ai-generation-service.js");

const NOW = new Date("2026-09-01T04:00:00.000Z");

function harness({ available = 3, providerResult = { status: "succeeded", outputUrl: "https://result.aliyuncs.com/output.png" } } = {}) {
  let job = null;
  let outputFile = null;
  let debitCount = 0;
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM pindou_users")) return { rows: [{ id: "usr_a" }] };
      if (sql.includes("jobs.user_id = $1 AND jobs.idempotency_key = $2")) return { rows: job ? [{ ...job }] : [] };
      if (sql.includes("FROM pindou_file_assets") && !sql.includes("JOIN pindou_file_assets")) {
        return { rows: [{ user_id: "usr_a", file_type: "ai_input", object_key: "ai/ai_input_test.png", content_type: "image/png", deleted_at: null }] };
      }
      if (sql.includes("AS daily_free")) {
        return { rows: [{ daily_free: String(available), used_today: "0", daily_remaining: String(available), purchased: "0" }] };
      }
      if (sql.includes("'daily_grant'")) return { rows: [] };
      if (sql.includes("AS active_count")) return { rows: [{ active_count: "0" }] };
      if (sql.includes("INSERT INTO pindou_ai_generation_jobs")) {
        job = {
          id: parameters[0], user_id: parameters[1], input_file_id: parameters[2],
          input_object_key: parameters[12], input_content_type: parameters[13],
          output_file_id: null, output_public_url: null, output_content_type: null,
          output_byte_size: null, provider: parameters[3], model: parameters[4], status: "queued",
          prompt_version: parameters[5], style: parameters[6], detail_level: parameters[7],
          background_mode: parameters[8], provider_request_id: null, idempotency_key: parameters[9],
          error_code: null, created_at: parameters[10], updated_at: parameters[10], started_at: null,
          completed_at: null, expires_at: parameters[11],
        };
        return { rows: [{ ...job }] };
      }
      if (sql.includes("WHERE jobs.id = $1") && sql.includes("FOR UPDATE OF jobs")) return { rows: [{ ...job }] };
      if (sql.includes("SET status = 'processing'")) {
        job.status = "processing";
        job.provider_request_id = parameters[1];
        job.started_at = parameters[2];
        job.updated_at = parameters[2];
        return { rows: [{ ...job }] };
      }
      if (sql.includes("INSERT INTO pindou_file_assets")) {
        outputFile = { id: parameters[0], url: parameters[3], contentType: parameters[4], size: parameters[5] };
        return { rows: [] };
      }
      if (sql.includes("'usage_debit'")) {
        debitCount += 1;
        return { rows: [] };
      }
      if (sql.includes("SET status = 'succeeded'")) {
        job.status = "succeeded";
        job.output_file_id = parameters[1];
        job.output_public_url = parameters[3];
        job.output_content_type = parameters[4];
        job.output_byte_size = parameters[5];
        job.updated_at = parameters[2];
        job.completed_at = parameters[2];
        return { rows: [{ ...job }] };
      }
      if (sql.includes("SET status = 'failed'")) {
        job.status = "failed";
        job.error_code = parameters[1];
        job.updated_at = parameters[2];
        job.completed_at = parameters[2];
        return { rows: [{ ...job, input_object_key: null, input_content_type: null }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query(sql, parameters) { return client.query(sql, parameters); },
  };
  let createCount = 0;
  let pollCount = 0;
  const provider = {
    configured: true,
    name: "qwen",
    model: "qwen-image-3.0",
    async createTask() { createCount += 1; return "provider_task_1"; },
    async getTask() { pollCount += 1; return providerResult; },
    async downloadOutput() { return Buffer.from("provider-png"); },
  };
  let saveCount = 0;
  const storage = {
    async readObject() { return { buffer: Buffer.from("input-png"), contentType: "image/png" }; },
    async save() {
      saveCount += 1;
      return { objectKey: "ai/ai_output_test.png", publicUrl: "https://cdn.example/output.png", contentType: "image/png", byteSize: 12, width: 1024, height: 1024 };
    },
    async remove() {},
  };
  const service = new PostgresAiGenerationService(
    pool,
    provider,
    storage,
    { dailyStandardDownloads: 9, dailyAiGenerations: 3 },
    () => NOW,
  );
  return {
    service,
    calls,
    get job() { return job; },
    get outputFile() { return outputFile; },
    get debitCount() { return debitCount; },
    get createCount() { return createCount; },
    get pollCount() { return pollCount; },
    get saveCount() { return saveCount; },
  };
}

const REQUEST = {
  userId: "usr_a",
  idempotencyKey: "ai-create-1",
  inputFileId: "file_input",
  style: "natural",
  detailLevel: "medium",
  backgroundMode: "simplify",
};

test("AI state machine persists output and debits ai_generation exactly once after success", async () => {
  const state = harness();
  const result = await state.service.create(REQUEST);
  const duplicate = await state.service.create(REQUEST);

  assert.equal(result.status, "succeeded");
  assert.equal(result.outputFile.url, "https://cdn.example/output.png");
  assert.equal(duplicate.id, result.id);
  assert.equal(state.createCount, 1);
  assert.equal(state.pollCount, 1);
  assert.equal(state.saveCount, 1);
  assert.equal(state.debitCount, 1);
  const debit = state.calls.find((call) => call.sql.includes("'usage_debit'"));
  assert.match(debit.sql, /'ai_generation'/);
  assert.equal(debit.parameters[4], `ai-generation:${result.id}`);
});

test("AI provider failure enters a failed terminal state without output or quota debit", async () => {
  const state = harness({ providerResult: { status: "failed", errorCode: "CONTENT_REJECTED" } });
  const result = await state.service.create(REQUEST);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "PROVIDER_CONTENT_REJECTED");
  assert.equal(result.outputFile, null);
  assert.equal(state.saveCount, 0);
  assert.equal(state.debitCount, 0);
});

test("AI task creation reserves available quota before calling the paid provider", async () => {
  const state = harness({ available: 0 });
  await assert.rejects(
    () => state.service.create(REQUEST),
    (error) => error.statusCode === 402 && error.code === "QUOTA_INSUFFICIENT",
  );
  assert.equal(state.job, null);
  assert.equal(state.createCount, 0);
  assert.equal(state.debitCount, 0);
});
