const assert = require("node:assert/strict");
const test = require("node:test");
const { AppError } = require("../dist/shared/app-error.js");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");

function dependencies(quotaDownloads) {
  return {
    database: { async check() { return { status: "up", product: "PostgreSQL", version: "17.11", schemaStatus: "valid" }; } },
    auth: { async login() { throw new Error("unused"); } },
    authenticator: { async authenticate() { return { id: "usr_current" }; } },
    users: { async getCurrentUser() { throw new Error("unused"); } },
    avatars: { async save() { throw new Error("unused"); }, async read() { return null; }, async remove() {} },
    avatarMaximumBytes: 2 * 1024 * 1024,
    coverMaximumBytes: 10 * 1024 * 1024,
    covers: { async read() { return null; }, async save() { throw new Error("unused"); }, async remove() {} },
    files: { async upload() { throw new Error("unused"); } },
    works: {},
    quotaDownloads,
  };
}

async function withApplication(quotaDownloads, callback) {
  const running = await startHttpServer(createHttpApplication(dependencies(quotaDownloads)), "127.0.0.1", 0);
  try { await callback(`http://127.0.0.1:${running.port}`); } finally { await running.close(); }
}

test("GET /api/quota/me authenticates and returns the transaction summary", async () => {
  let userId;
  await withApplication({
    async getQuota(value) {
      userId = value;
      return { dailyFree: 3, usedToday: 1, purchased: 2, remaining: 4, membershipType: null, membershipExpiresAt: null, resetsAt: "2026-09-01T00:00:00+08:00" };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quota/me`, { headers: { authorization: "Bearer token" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).remaining, 4);
    assert.equal(userId, "usr_current");

    const invalid = await fetch(`${baseUrl}/api/quota/me?userId=usr_other`, { headers: { authorization: "Bearer token" } });
    assert.equal(invalid.status, 400);
  });
});

test("GET /api/downloads validates filters and returns records without fileUrl", async () => {
  let received;
  await withApplication({
    async listDownloads(options) {
      received = options;
      return {
        total: 1,
        page: 2,
        pageSize: 5,
        items: [{ id: "dl_1", workId: null, title: "历史作品", fileType: "chart", consumedQuota: true, quotaTransactionId: "qt_1", downloadedAt: "2026-08-31T01:00:00.000Z" }],
      };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downloads?fileType=chart&query=%E7%8C%AB&page=2&pageSize=5`, { headers: { authorization: "Bearer token" } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(received, { userId: "usr_current", fileType: "chart", query: "猫", page: 2, pageSize: 5 });
    assert.equal(body.items[0].fileUrl, undefined);

    const invalid = await fetch(`${baseUrl}/api/downloads?fileType=zip`, { headers: { authorization: "Bearer token" } });
    assert.equal(invalid.status, 400);
  });
});

test("POST /api/downloads requires idempotency and passes only authenticated ownership", async () => {
  let received;
  const quotaDownloads = {
    async createDownload(input) {
      received = input;
      return {
        downloadRecord: { id: "dl_1", workId: input.workId, title: "作品", fileType: input.fileType, consumedQuota: true, quotaTransactionId: "qt_1", downloadedAt: "2026-08-31T01:00:00.000Z" },
        quota: { remaining: 2, usedToday: 1, purchased: 0 },
      };
    },
  };
  await withApplication(quotaDownloads, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downloads`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json", "Idempotency-Key": "export-1" },
      body: JSON.stringify({ workId: "work_a", fileType: "preview" }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.deepEqual(received, { userId: "usr_current", idempotencyKey: "export-1", workId: "work_a", fileType: "preview" });
    assert.equal(body.downloadRecord.fileUrl, undefined);

    const missingKey = await fetch(`${baseUrl}/api/downloads`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ workId: "work_a", fileType: "preview" }),
    });
    assert.equal(missingKey.status, 400);

    const extraField = await fetch(`${baseUrl}/api/downloads`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json", "Idempotency-Key": "export-2" },
      body: JSON.stringify({ workId: "work_a", fileType: "preview", consumedQuota: false }),
    });
    assert.equal(extraField.status, 400);
  });
});

test("POST /api/downloads exposes quota and ownership errors without partial success payloads", async () => {
  let error = new AppError(402, "QUOTA_INSUFFICIENT", "下载额度不足");
  await withApplication({ async createDownload() { throw error; } }, async (baseUrl) => {
    const request = () => fetch(`${baseUrl}/api/downloads`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json", "Idempotency-Key": "export-error" },
      body: JSON.stringify({ workId: "work_other", fileType: "materials" }),
    });
    const insufficient = await request();
    const insufficientBody = await insufficient.json();
    assert.equal(insufficient.status, 402);
    assert.equal(insufficientBody.error.code, "QUOTA_INSUFFICIENT");

    error = new AppError(403, "FORBIDDEN", "作品不属于当前用户");
    const forbidden = await request();
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, "FORBIDDEN");
  });
});
