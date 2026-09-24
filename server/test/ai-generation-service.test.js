const assert = require("node:assert/strict");
const test = require("node:test");
const { PostgresAiGenerationService } = require("../dist/modules/ai/ai-generation-service.js");
const { AppError } = require("../dist/shared/app-error.js");
const { ProviderError } = require("../dist/modules/ai/hunyuan-image-provider.js");

const NOW = new Date("2026-09-01T04:00:00.000Z");

const PROVIDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const PROVIDER_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66]),
  Buffer.alloc(512, 0x11),
  Buffer.from([0xff, 0xd9]),
]);

function harness({
  available = 3,
  providerOutputUrl = "https://aigc-image.cos.myqcloud.com/output.png",
  providerError = null,
  providerErrors = null,
  inputAvailable = true,
  inputFileUserId = "usr_a",
  inputFileType = "ai_input",
  downloadError = null,
  saveError = null,
  providerOutput = PROVIDER_PNG,
  now = () => NOW,
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
      // 失败任务被同一幂等键重新排队（清错误码、延长保留期）。
      // 必须排在「FROM pindou_file_assets」分支之前：这条 UPDATE 的 RETURNING 带子查询，会误命中它。
      if (sql.includes("SET status = 'queued'") && sql.includes("error_code = NULL")) {
        job.status = "queued";
        job.error_code = null;
        job.provider_request_id = null;
        job.provider_output_url = null;
        job.started_at = null;
        job.completed_at = null;
        job.expires_at = parameters[1];
        return { rows: [{ ...job, input_object_key: "ai/ai_input_test.png", input_content_type: "image/png" }] };
      }
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
      // providerErrors 是「按调用次序消费一次」的错误队列，用来模拟前几次限流、之后成功。
      const queued = Array.isArray(providerErrors) && providerErrors.length > 0 ? providerErrors.shift() : null;
      const failure = queued ?? providerError;
      if (failure) throw failure;
      return { requestId: "provider_request_1", outputUrl: providerOutputUrl };
    },
    async downloadOutput() {
      if (downloadError) throw downloadError;
      return providerOutput;
    },
  };
  let saveCount = 0;
  let savedOutput = null;
  const storage = {
    async readObject() {
      if (!inputAvailable) return null;
      return { buffer: Buffer.from("input-png"), contentType: "image/png" };
    },
    async save(kind, _buffer, filename, contentType) {
      saveCount += 1;
      savedOutput = { kind, filename, contentType };
      events.push({ type: "storage_save" });
      if (saveError) throw saveError;
      return { objectKey: "ai/ai_output_test.png", publicUrl: "https://cdn.example/output.png", contentType: "image/png", byteSize: 12, width: 1024, height: 1024 };
    },
    async remove() {},
  };
  const sleeps = [];
  const service = new PostgresAiGenerationService(
    pool,
    provider,
    storage,
    { dailyStandardDownloads: 9, dailyAiGenerations: 3 },
    now,
    undefined,
    async (ms) => { sleeps.push(ms); },
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
    get savedOutput() { return savedOutput; },
    get sleeps() { return sleeps; },
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

test("AI output keeps the real provider format when the upstream returns JPEG", async () => {
  const state = harness({ providerOutput: PROVIDER_JPEG });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "succeeded");
  assert.equal(state.saveCount, 1);
  assert.deepEqual(state.savedOutput, {
    kind: "ai_output",
    filename: "output.jpg",
    contentType: "image/jpeg",
  });
});

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

test("provider rate limit is retried with backoff instead of failing the task immediately", async () => {
  const state = harness({
    // 线上实测形状（2026-09-24）：混元限流码 EXCEED_REQUEST_LIMIT，无 httpStatus，1 秒内返回。
    providerErrors: [
      new ProviderError({
        provider: "hunyuan",
        providerCode: "EXCEED_REQUEST_LIMIT",
        httpStatus: null,
        kind: "RATE_LIMITED",
      }),
    ],
  });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  // 限流属于「等一下就好」：不该把任务直接判死，退避重试后应正常出图。
  assert.equal(result.status, "succeeded");
  assert.equal(state.createCount, 2);
  assert.ok(state.sleeps.some((ms) => ms >= 1500), `expected a backoff sleep, got ${state.sleeps.join(",")}`);
  assert.equal(state.debitCount, 1);
});

test("provider rate limit still fails the task after the retries are exhausted", async () => {
  const state = harness({
    providerError: new ProviderError({
      provider: "hunyuan",
      providerCode: "EXCEED_REQUEST_LIMIT",
      httpStatus: null,
      kind: "RATE_LIMITED",
    }),
  });
  const created = await state.service.create(REQUEST);
  const result = await advanceUntilTerminal(state, created.id);

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "AI_SERVICE_BUSY");
  assert.equal(state.createCount, 3);
  assert.equal(state.debitCount, 0);
});

test("a failed job is requeued when the same idempotency key is reused after the cooldown", async () => {
  let current = NOW;
  const state = harness({
    now: () => current,
    providerErrors: [
      new ProviderError({
        provider: "hunyuan",
        providerCode: "ContentReviewFailed",
        httpStatus: 422,
        kind: "UNKNOWN",
      }),
    ],
  });
  const created = await state.service.create(REQUEST);
  const failed = await advanceUntilTerminal(state, created.id);
  assert.equal(failed.status, "failed");

  // 冷却期内复用幂等键：仍拿回失败任务，不重复提交给 provider。
  const duringCooldown = await state.service.create(REQUEST);
  assert.equal(duringCooldown.status, "failed");
  assert.equal(state.createCount, 1);

  // 冷却期后复用同一幂等键：任务重新排队并真的重跑（旧客户端沿用旧键重试才有救）。
  current = new Date(NOW.getTime() + 60_000);
  const retried = await state.service.create(REQUEST);
  assert.equal(retried.status, "queued");
  assert.equal(retried.failure, null);
  const result = await advanceUntilTerminal(state, retried.id);
  assert.equal(result.status, "succeeded");
  assert.equal(state.createCount, 2);
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

const CLEANUP_NOW = new Date("2026-09-22T04:00:00.000Z");
const CLEANUP_OLD = new Date("2026-09-12T04:00:00.000Z");
const CLEANUP_EXPIRED = new Date("2026-09-13T04:00:00.000Z");
const CLEANUP_FUTURE = new Date("2026-09-30T04:00:00.000Z");

function createCleanupHarness() {
  const assets = new Map([
    ["file_input_1", { id: "file_input_1", object_key: "ai/input-1.png", deleted_at: null }],
    ["file_input_2", { id: "file_input_2", object_key: "ai/input-2.png", deleted_at: null }],
    ["file_output_1", { id: "file_output_1", object_key: "ai/output-1.png", deleted_at: null }],
  ]);
  const jobs = [
    { id: "aijob_queued", input_file_id: "file_input_1", output_file_id: null, status: "queued", error_code: null, completed_at: null, updated_at: CLEANUP_OLD, expires_at: CLEANUP_EXPIRED },
    { id: "aijob_processing", input_file_id: "file_input_1", output_file_id: null, status: "processing", error_code: null, completed_at: null, updated_at: CLEANUP_OLD, expires_at: CLEANUP_EXPIRED },
    { id: "aijob_succeeded", input_file_id: "file_input_2", output_file_id: "file_output_1", status: "succeeded", error_code: null, completed_at: CLEANUP_OLD, updated_at: CLEANUP_OLD, expires_at: CLEANUP_EXPIRED },
    { id: "aijob_finished", input_file_id: "file_input_2", output_file_id: null, status: "failed", error_code: "AI_PROVIDER_ERROR", completed_at: CLEANUP_OLD, updated_at: CLEANUP_OLD, expires_at: CLEANUP_EXPIRED },
    { id: "aijob_fresh", input_file_id: "file_input_1", output_file_id: null, status: "succeeded", error_code: null, completed_at: CLEANUP_OLD, updated_at: CLEANUP_OLD, expires_at: CLEANUP_FUTURE },
  ];
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const statements = [];
  const removals = [];

  const applyJobsUpdate = (ids, currentTime) => {
    for (const id of ids) {
      const job = byId.get(id);
      const wasSucceeded = job.status === "succeeded";
      job.status = "failed";
      job.error_code = wasSucceeded ? "AI_RESULT_EXPIRED" : (job.error_code ?? "AI_TASK_EXPIRED");
      job.completed_at = job.completed_at ?? currentTime;
      job.updated_at = currentTime;
    }
  };
  const applyAssetUpdate = (ids, currentTime) => {
    for (const id of ids) {
      const asset = assets.get(id);
      if (asset && asset.deleted_at === null) asset.deleted_at = currentTime;
    }
  };

  const client = {
    async query(sql, parameters = []) {
      statements.push({ sql, parameters });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FOR UPDATE OF jobs SKIP LOCKED")) {
        const expired = jobs.filter((job) => job.expires_at <= CLEANUP_NOW);
        // 守卫写在 SQL 里：一旦有人把它删掉，这里就退化成旧行为（返回全部过期行），
        // 第二轮会重新产生 UPDATE，测试随即失败。
        const guarded = /jobs\.completed_at IS NULL/.test(sql) && /jobs\.status = 'succeeded'/.test(sql);
        const selected = guarded
          ? expired.filter((job) => job.completed_at === null || job.status === "succeeded")
          : expired;
        return {
          rows: selected.map((job) => ({
            id: job.id,
            input_file_id: job.input_file_id,
            input_object_key: assets.get(job.input_file_id).object_key,
            output_file_id: job.output_file_id,
            output_object_key: job.output_file_id ? assets.get(job.output_file_id).object_key : null,
            status: job.status,
          })),
        };
      }
      if (sql.includes("SET status = 'failed'") && sql.includes("WHERE id = ANY")) {
        applyJobsUpdate(parameters[0], parameters[1]);
        return { rows: [] };
      }
      if (sql.includes("SET deleted_at = COALESCE(deleted_at, $2)")) {
        applyAssetUpdate(parameters[0], parameters[1]);
        return { rows: [] };
      }
      if (sql.includes("FROM pindou_file_assets files")) return { rows: [] };
      if (sql.includes("SET deleted_at = $2")) {
        applyAssetUpdate(parameters[0], parameters[1]);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query(sql, parameters) { return client.query(sql, parameters); },
  };
  const storage = {
    async readObject() { return null; },
    async save() { throw new Error("unused in cleanup test"); },
    async remove(objectKey) { removals.push(objectKey); },
  };
  const unused = async () => { throw new Error("unused in cleanup test"); };
  const service = new PostgresAiGenerationService(
    pool,
    { configured: true, name: "hunyuan", model: "HY-Image-v3.0", createTask: unused, downloadOutput: unused },
    storage,
    { dailyStandardDownloads: 9, dailyAiGenerations: 3 },
    () => CLEANUP_NOW,
  );
  return { jobs, byId, assets, statements, removals, service };
}

function countUpdateStatements(statements) {
  return statements.filter((statement) => statement.sql.trimStart().toUpperCase().startsWith("UPDATE")).length;
}

function cleanupSnapshot(jobs) {
  return jobs.map((job) => ({ id: job.id, status: job.status, errorCode: job.error_code, completedAt: job.completed_at, updatedAt: job.updated_at }));
}

test("cleanupExpired expires each job once instead of restamping the whole backlog every run", async () => {
  const state = createCleanupHarness();
  await state.service.cleanupExpired();

  assert.equal(state.byId.get("aijob_queued").status, "failed");
  assert.equal(state.byId.get("aijob_queued").error_code, "AI_TASK_EXPIRED");
  assert.equal(state.byId.get("aijob_processing").error_code, "AI_TASK_EXPIRED");
  assert.equal(state.byId.get("aijob_succeeded").status, "failed");
  assert.equal(state.byId.get("aijob_succeeded").error_code, "AI_RESULT_EXPIRED");
  assert.deepEqual(state.byId.get("aijob_succeeded").completed_at, CLEANUP_OLD);
  assert.equal(state.byId.get("aijob_fresh").status, "succeeded");
  assert.deepEqual(state.byId.get("aijob_fresh").updated_at, CLEANUP_OLD);

  assert.equal(state.byId.get("aijob_finished").error_code, "AI_PROVIDER_ERROR");
  assert.deepEqual(state.byId.get("aijob_finished").updated_at, CLEANUP_OLD);

  const afterFirst = cleanupSnapshot(state.jobs);
  const removalsAfterFirst = [...state.removals];
  assert.ok(countUpdateStatements(state.statements) > 0);
  assert.ok(removalsAfterFirst.length > 0);
  state.statements.length = 0;

  await state.service.cleanupExpired();

  assert.equal(countUpdateStatements(state.statements), 0, "second sweep must not issue any UPDATE");
  assert.deepEqual(state.removals, removalsAfterFirst, "second sweep must not remove objects again");
  assert.deepEqual(cleanupSnapshot(state.jobs), afterFirst, "second sweep must not modify any row");
});
