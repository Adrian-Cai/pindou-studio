const assert = require("node:assert/strict");
const test = require("node:test");
const { PostgresAiGenerationService } = require("../dist/modules/ai/ai-generation-service.js");
const { AppError } = require("../dist/shared/app-error.js");

const NOW = new Date("2026-09-01T04:00:00.000Z");

function harness({
  available = 3,
  providerResult = { status: "succeeded", outputUrl: "https://result.aliyuncs.com/output.png" },
  providerError = null,
  inputAvailable = true,
  inputFileUserId = "usr_a",
  inputFileType = "ai_input",
  downloadError = null,
  saveError = null,
  contentSecurity = null,
} = {}) {
  let job = null;
  let outputFile = null;
  let debitCount = 0;
  const calls = [];
  const events = [];
  const client = {
    async query(sql, parameters = []) {
      events.push({ type: "db", sql });
      calls.push({ sql, parameters });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM pindou_users")) return { rows: [{ id: "usr_a" }] };
      if (sql.includes("jobs.user_id = $1 AND jobs.idempotency_key = $2")) return { rows: job ? [{ ...job }] : [] };
      if (sql.includes("FROM pindou_file_assets") && !sql.includes("JOIN pindou_file_assets")) {
        return { rows: [{ user_id: inputFileUserId, file_type: inputFileType, object_key: "ai/ai_input_test.png", content_type: "image/png", deleted_at: null }] };
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
      if (sql.includes("SET provider_request_id =")) {
        job.provider_request_id = parameters[1];
        job.updated_at = parameters[2];
        return { rows: [{ ...job }] };
      }
      if (sql.includes("WHERE jobs.id = $1") && sql.includes("FOR UPDATE OF jobs")) return { rows: [{ ...job }] };
      if (sql.includes("SET status = 'processing'")) {
        job.status = "processing";
        job.started_at = parameters[1];
        job.updated_at = parameters[1];
        return { rows: [{ ...job }] };
      }
      if (sql.includes("WHERE jobs.id = $1 AND jobs.user_id = $2")) return { rows: [{ ...job }] };
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
  let receivedPrompt = "";
  const provider = {
    configured: true,
    name: "qwen",
    model: "qwen-image-3.0",
    async createTask(_image, prompt) {
      events.push({ type: "provider_create" });
      receivedPrompt = prompt;
      createCount += 1;
      return "provider_task_1";
    },
    async getTask() {
      events.push({ type: "provider_poll" });
      pollCount += 1;
      if (providerError) throw providerError;
      return providerResult;
    },
    async downloadOutput() {
      if (downloadError) throw downloadError;
      return Buffer.from("provider-png");
    },
  };
  let saveCount = 0;
  const storage = {
    async readObject() {
      if (!inputAvailable) return null;
      return { buffer: Buffer.from("input-png"), contentType: "image/png" };
    },
    async save() {
      saveCount += 1;
      events.push({ type: "storage_save" });
      if (saveError) throw saveError;
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
    contentSecurity,
  );
  return {
    service,
    calls,
    events,
    get job() { return job; },
    get outputFile() { return outputFile; },
    get receivedPrompt() { return receivedPrompt; },
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

async function advanceUntilTerminal(state, jobId) {
  let result = await state.service.get(REQUEST.userId, jobId);
  for (let attempt = 0; attempt < 5 && (result.status === "queued" || result.status === "processing"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    result = await state.service.get(REQUEST.userId, jobId);
  }
  return result;
}

test("AI state machine persists output and debits ai_generation exactly once after success", async () => {
  const state = harness();
  const created = await state.service.create(REQUEST);
  assert.equal(created.status, "queued");
  const result = await advanceUntilTerminal(state, created.id);
  const duplicate = await state.service.create(REQUEST);

  assert.equal(result.status, "succeeded");
  assert.equal(result.outputFile.url, "https://cdn.example/output.png");
  assert.equal(duplicate.id, result.id);
  assert.equal(state.createCount, 1);
  assert.equal(state.pollCount, 1);
  assert.equal(state.saveCount, 1);
  assert.equal(state.debitCount, 1);
  assert.match(state.receivedPrompt, /适合后续转换为拼豆图/);
  assert.match(state.receivedPrompt, /自然、柔和、干净的写实视觉风格/);
  assert.match(state.receivedPrompt, /简化背景/);
  assert.match(state.receivedPrompt, /不要生成拼豆网格/);
  const providerCreateIndex = state.events.findIndex((event) => event.type === "provider_create");
  const firstCommitIndex = state.events.findIndex((event) => event.type === "db" && event.sql === "COMMIT");
  assert.ok(firstCommitIndex >= 0 && providerCreateIndex > firstCommitIndex);
  const debit = state.calls.find((call) => call.sql.includes("'usage_debit'"));
  assert.match(debit.sql, /'ai_generation'/);
  assert.equal(debit.parameters[4], `ai-generation:${result.id}`);
});

test("AI output passes synchronous image content security before persistence", async () => {
  const checks = [];
  const state = harness({
    contentSecurity: {
      async checkMedia(userId, input) {
        checks.push({ userId, input });
        state.events.push({ type: "content_security" });
        return { safe: true, checkId: "sec_output", traceId: "trace_output" };
      },
    },
  });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "succeeded");
  assert.equal(checks.length, 1);
  assert.equal(checks[0].userId, REQUEST.userId);
  assert.equal(checks[0].input.filename, "ai-output.png");
  assert.equal(checks[0].input.contentType, "image/png");
  assert.ok(
    state.events.findIndex((event) => event.type === "content_security")
      < state.events.findIndex((event) => event.type === "storage_save"),
  );
});

test("AI provider failure enters a failed terminal state without output or quota debit", async () => {
  const state = harness({ providerResult: { status: "failed", errorCode: "CONTENT_REJECTED" } });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "AI_PROVIDER_TASK_FAILED");
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

test("AI idempotency key rejects a changed request", async () => {
  const state = harness();
  await state.service.create(REQUEST);
  await assert.rejects(
    () => state.service.create({ ...REQUEST, style: "cartoon" }),
    (error) => error.statusCode === 409 && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("AI input ownership and type are checked before creating a job", async () => {
  for (const options of [
    { inputFileUserId: "usr_other" },
    { inputFileType: "cover" },
  ]) {
    const state = harness(options);
    await assert.rejects(
      () => state.service.create(REQUEST),
      (error) => error.statusCode === 404 && error.code === "NOT_FOUND",
    );
    assert.equal(state.job, null);
    assert.equal(state.createCount, 0);
  }
});

test("AI task remains processing while the provider is still running", async () => {
  const state = harness({ providerResult: { status: "pending" } });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "processing");
  assert.equal(result.outputFile, null);
  assert.ok(state.pollCount > 0);
  assert.equal(state.debitCount, 0);
});

test("unavailable AI input enters a failed terminal state without calling the provider", async () => {
  const state = harness({ inputAvailable: false });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "AI_INPUT_FILE_UNAVAILABLE");
  assert.equal(state.createCount, 0);
  assert.equal(state.debitCount, 0);
});

test("provider polling errors enter a failed terminal state without output or quota debit", async () => {
  const state = harness({ providerError: new Error("provider unavailable") });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "AI_GENERATION_INTERNAL_ERROR");
  assert.equal(state.saveCount, 0);
  assert.equal(state.debitCount, 0);
});

test("provider timeout preserves the stable timeout error code", async () => {
  const state = harness({ providerError: new AppError(504, "AI_PROVIDER_TIMEOUT", "provider timeout") });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "AI_PROVIDER_TIMEOUT");
  assert.equal(state.debitCount, 0);
});

test("output download and storage failures enter a failed terminal state without quota debit", async () => {
  for (const options of [
    { downloadError: new Error("output download failed") },
    { saveError: new Error("output storage failed") },
  ]) {
    const state = harness(options);
    const created = await state.service.create(REQUEST);
    const result = await advanceUntilTerminal(state, created.id);

    assert.equal(result.status, "failed");
    assert.equal(state.debitCount, 0);
  }
});
