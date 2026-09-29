const assert = require("node:assert/strict");
const test = require("node:test");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");
const { InMemoryRateLimiter } = require("../dist/http/rate-limit.js");
const { AppError } = require("../dist/shared/app-error.js");

function dependencies(aiGenerations, options = {}) {
  return {
    database: { async check() { return { status: "up", product: "PostgreSQL", version: "17", schemaStatus: "valid" }; } },
    auth: { async login() { throw new Error("unused"); } },
    authenticator: { async authenticate() { return { id: "usr_current" }; } },
    users: {},
    avatars: { async read() { return null; } },
    avatarMaximumBytes: 2 * 1024 * 1024,
    files: {},
    covers: { async read() { return null; } },
    aiFiles: options.aiFiles ?? { async read() { return null; } },
    works: {},
    quotaDownloads: {},
    payments: {},
    coverMaximumBytes: 10 * 1024 * 1024,
    aiFileMaximumBytes: 10 * 1024 * 1024,
    aiRateLimiter: options.aiRateLimiter,
    aiGenerations,
  };
}

async function withApplication(aiGenerations, callback) {
  const running = await startHttpServer(
    createHttpApplication(dependencies(aiGenerations)),
    "127.0.0.1",
    0,
  );
  try { await callback(`http://127.0.0.1:${running.port}`); } finally { await running.close(); }
}

test("AI generation HTTP endpoints accept only server-owned options and authenticated ownership", async () => {
  let created;
  let read;
  const response = {
    id: "aijob_1",
    status: "processing",
    inputFileId: "file_input",
    outputFile: null,
  };
  await withApplication({
    async create(input) { created = input; return response; },
    async get(userId, jobId) { read = { userId, jobId }; return response; },
  }, async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/ai/generations`, {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "Idempotency-Key": "ai-request-1",
      },
      body: JSON.stringify({
        inputFileId: "file_input",
        style: "kawaii",
        detailLevel: "medium",
        backgroundMode: "simplify",
      }),
    });
    assert.equal(createResponse.status, 201);
    assert.match(created.requestId, /^req_[a-f0-9]{32}$/u);
    const { requestId: _requestId, ...createdWithoutRequestId } = created;
    assert.deepEqual(createdWithoutRequestId, {
      userId: "usr_current",
      idempotencyKey: "ai-request-1",
      inputFileId: "file_input",
      style: "kawaii",
      detailLevel: "medium",
      backgroundMode: "simplify",
    });

    const getResponse = await fetch(`${baseUrl}/api/ai/generations/aijob_1`, {
      headers: { authorization: "Bearer token" },
    });
    assert.equal(getResponse.status, 200);
    assert.deepEqual(read, { userId: "usr_current", jobId: "aijob_1" });

    const tampered = await fetch(`${baseUrl}/api/ai/generations`, {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "Idempotency-Key": "ai-request-2",
      },
      body: JSON.stringify({
        inputFileId: "file_input",
        style: "natural",
        detailLevel: "medium",
        backgroundMode: "simplify",
        quota: 999,
      }),
    });
    assert.equal(tampered.status, 400);
  });
});

test("AI HTTP errors do not expose provider details", async () => {
  await withApplication({
    async create() {
      throw new AppError(502, "AI_PROVIDER_ERROR", "AI 图像服务请求失败", {
        providerCode: "SECRET_PROVIDER_CODE",
        providerResponse: "sensitive response",
      });
    },
    async get() { throw new Error("unused"); },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ai/generations`, {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "Idempotency-Key": "ai-provider-error-1",
      },
      body: JSON.stringify({
        inputFileId: "file_input",
        style: "natural",
        detailLevel: "medium",
        backgroundMode: "simplify",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "AI_SERVICE_BUSY");
    assert.equal(body.error.category, "PROVIDER");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.action, "RETRY");
    assert.deepEqual(body.error.details, {});
    assert.doesNotMatch(JSON.stringify(body), /SECRET_PROVIDER_CODE|sensitive response/u);
  });
});

test("AI generation HTTP requests are rate limited per authenticated user", async () => {
  let createCount = 0;
  const limiter = new InMemoryRateLimiter(1, 60_000, () => 1_000);
  await startWithOptions({
    async create() {
      createCount += 1;
      return { id: `aijob_${createCount}`, status: "queued", inputFileId: "file_input", outputFile: null };
    },
    async get() { throw new Error("unused"); },
  }, { aiRateLimiter: limiter }, async (baseUrl) => {
    const request = () => fetch(`${baseUrl}/api/ai/generations`, {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "Idempotency-Key": `ai-rate-${createCount + 1}`,
      },
      body: JSON.stringify({
        inputFileId: "file_input",
        style: "natural",
        detailLevel: "medium",
        backgroundMode: "simplify",
      }),
    });
    assert.equal((await request()).status, 201);
    const limited = await request();
    const body = await limited.json();
    assert.equal(limited.status, 429);
    assert.equal(body.error.code, "RATE_LIMITED");
    assert.equal(body.error.details.retryAfterSeconds, 60);
  });
  assert.equal(createCount, 1);
});

test("AI media responses are not cached beyond the server retention policy", async () => {
  await startWithOptions({
    async create() { throw new Error("unused"); },
    async get() { throw new Error("unused"); },
  }, {
    aiFiles: {
      async read() {
        return { buffer: Buffer.from([1, 2, 3]), contentType: "image/png" };
      },
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/media/ai/ai_output_${"a".repeat(32)}.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  });
});

async function startWithOptions(aiGenerations, options, callback) {
  const running = await startHttpServer(
    createHttpApplication(dependencies(aiGenerations, options)),
    "127.0.0.1",
    0,
  );
  try { await callback(`http://127.0.0.1:${running.port}`); } finally { await running.close(); }
}
