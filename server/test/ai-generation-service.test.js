const assert = require("node:assert/strict");
const test = require("node:test");
const { PostgresAiGenerationService } = require("../dist/modules/ai/ai-generation-service.js");
const { AppError } = require("../dist/shared/app-error.js");
const { ProviderError } = require("../dist/modules/ai/hunyuan-image-provider.js");

const NOW = new Date("2026-09-01T04:00:00.000Z");

function harness({
  available = 3,
  providerOutputUrl = "https://aigc-image.cos.myqcloud.com/output.png",
  providerError = null,
  inputAvailable = true,
  inputFileUserId = "usr_a",
  inputFileType = "ai_input",
  downloadError = null,
  saveError = null,
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
          background_mode: parameters[8], provider_request_id: null, provider_output_url: null, idempotency_key: parameters[9],
          error_code: null, created_at: parameters[10], updated_at: parameters[10], started_at: null,
          completed_at: null, expires_at: parameters[11],
        };
        return { rows: [{ ...job }] };
      }
      if (sql.includes("SET provider_request_id =")) {
        job.provider_request_id = parameters[1];
        job.provider_output_url = parameters[2];
        job.updated_at = parameters[3];
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
  let receivedPrompt = "";
  const provider = {
    configured: true,
    name: "hunyuan",
    model: "HY-Image-v3.0-I2I-ToB-v1.0.1",
    async createTask(_image, prompt) {
      events.push({ type: "provider_create" });
      receivedPrompt = prompt;
      createCount += 1;
      if (providerError) throw providerError;
      return { requestId: "provider_request_1", outputUrl: providerOutputUrl };
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
  assert.equal(result.generationMode, "ai");
  assert.equal(result.outputFile.url, "https://cdn.example/output.png");
  assert.equal(duplicate.id, result.id);
  assert.equal(state.createCount, 1);
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
  assert.match(state.calls.find((call) => call.sql.includes("INSERT INTO pindou_ai_generation_jobs")).sql, /generation_mode/u);
});

test("AI output is persisted without a second content security check", async () => {
  const state = harness();
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "succeeded");
  assert.equal(state.events.some((event) => event.type === "content_security"), false);
  assert.ok(state.events.findIndex((event) => event.type === "storage_save") >= 0);
});

test("AI provider failure enters a failed terminal state without output or quota debit", async () => {
  const state = harness({
    providerError: new ProviderError({
      provider: "hunyuan",
      providerCode: "ContentReviewFailed",
      httpStatus: 422,
      kind: "UNKNOWN",
    }),
  });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "AI_SERVICE_BUSY");
  assert.equal(result.failure.category, "PROVIDER");
  assert.equal(result.outputFile, null);
  assert.equal(state.saveCount, 0);
  assert.equal(state.debitCount, 0);
});

test("AI task creation reserves available quota before calling the paid provider", async () => {
  const state = harness({ available: 0 });
  await assert.rejects(
    () => state.service.create(REQUEST),
    (error) => error.statusCode === 402 && error.code === "USER_AI_QUOTA_EXHAUSTED",
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

test("unavailable AI input enters a failed terminal state without calling the provider", async () => {
  const state = harness({ inputAvailable: false });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "AI_INPUT_FILE_UNAVAILABLE");
  assert.equal(result.failure.action, "SELECT_IMAGE");
  assert.equal(state.createCount, 0);
  assert.equal(state.debitCount, 0);
});

test("provider submission errors fail the task without output or quota debit", async () => {
  const state = harness({
    providerError: new ProviderError({
      provider: "hunyuan",
      providerCode: null,
      httpStatus: 503,
      kind: "UNAVAILABLE",
    }),
  });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "AI_SERVICE_BUSY");
  assert.equal(state.saveCount, 0);
  assert.equal(state.debitCount, 0);
});

test("provider timeout fails the task without charging the user", async () => {
  const state = harness({ providerError: new AppError(504, "AI_PROVIDER_TIMEOUT", "provider timeout") });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "AI_TIMEOUT");
  assert.equal(state.debitCount, 0);
});

test("temporary output download failures keep the task processing for a later download", async () => {
  const state = harness({
    downloadError: new ProviderError({
      provider: "hunyuan",
      providerCode: null,
      httpStatus: 503,
      kind: "UNAVAILABLE",
    }),
  });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "processing");
  assert.equal(state.debitCount, 0);
});

test("output storage failures enter a failed terminal state without quota debit", async () => {
  const state = harness({ saveError: new Error("output storage failed") });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "AI_GENERATION_FAILED");
  assert.equal(state.debitCount, 0);
});
