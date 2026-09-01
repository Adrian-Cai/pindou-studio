const assert = require("node:assert/strict");
const test = require("node:test");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");

function dependencies(aiGenerations) {
  return {
    database: { async check() { return { status: "up", product: "PostgreSQL", version: "17", schemaStatus: "valid" }; } },
    auth: { async login() { throw new Error("unused"); } },
    authenticator: { async authenticate() { return { id: "usr_current" }; } },
    users: {},
    avatars: { async read() { return null; } },
    avatarMaximumBytes: 2 * 1024 * 1024,
    files: {},
    covers: { async read() { return null; } },
    aiFiles: { async read() { return null; } },
    works: {},
    quotaDownloads: {},
    payments: {},
    coverMaximumBytes: 10 * 1024 * 1024,
    aiFileMaximumBytes: 10 * 1024 * 1024,
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
        style: "natural",
        detailLevel: "medium",
        backgroundMode: "simplify",
      }),
    });
    assert.equal(createResponse.status, 201);
    assert.deepEqual(created, {
      userId: "usr_current",
      idempotencyKey: "ai-request-1",
      inputFileId: "file_input",
      style: "natural",
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
