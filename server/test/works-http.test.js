const assert = require("node:assert/strict");
const test = require("node:test");
const { AppError } = require("../dist/shared/app-error.js");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function pattern() {
  return {
    schemaVersion: 1,
    width: 32,
    height: 32,
    settings: { colorLimit: 1, brand: "MARD" },
    palette: [{ code: "C01", color: "#000000" }],
    cells: Array(1024).fill(0),
  };
}

function summary() {
  return {
    id: "work_test",
    title: "作品",
    coverUrl: "https://cdn.example/cover.png",
    width: 32,
    height: 32,
    beadCount: 1024,
    colorCount: 1,
    brand: "MARD",
    status: "completed",
    isFavorite: false,
    createdAt: "2026-08-27T01:00:00.000Z",
    updatedAt: "2026-08-27T01:00:00.000Z",
  };
}

function dependencies(overrides = {}) {
  return {
    database: { async check() { return { status: "up", product: "PostgreSQL", version: "17.11", schemaStatus: "valid" }; } },
    auth: { async login() { throw new Error("unused"); } },
    authenticator: { async authenticate() { return { id: "usr_current" }; } },
    users: { async getCurrentUser() { throw new Error("unused"); } },
    avatars: { async save() { throw new Error("unused"); }, async read() { return null; }, async remove() {} },
    avatarMaximumBytes: 2 * 1024 * 1024,
    coverMaximumBytes: 10 * 1024 * 1024,
    covers: { async read() { return null; }, async save() { throw new Error("unused"); }, async remove() {} },
    files: { async upload() { return { id: "file_test", type: "cover", url: "https://cdn.example/cover.png", contentType: "image/png", size: PNG.length, createdAt: "2026-08-27T01:00:00.000Z" }; } },
    works: {
      async create() { return summary(); },
      async update() { return summary(); },
      async list() { return { total: 0, page: 1, pageSize: 20, items: [] }; },
      async get() { return { ...summary(), pattern: pattern() }; },
      async delete() {},
      async setFavorite() { return { workId: "work_test", isFavorite: true, favoritedAt: "2026-08-27T01:00:00.000Z" }; },
      async listFavorites() { return { total: 0, page: 1, pageSize: 20, items: [] }; },
    },
    ...overrides,
  };
}

async function withApplication(deps, callback) {
  const running = await startHttpServer(createHttpApplication(deps), "127.0.0.1", 0);
  try { await callback(`http://127.0.0.1:${running.port}`); } finally { await running.close(); }
}

test("cover upload authenticates and accepts only type=cover", async () => {
  let received;
  await withApplication(dependencies({
    files: { async upload(userId, input) { received = { userId, input }; return { id: "file_test", type: "cover", url: "https://cdn.example/cover.png", contentType: "image/png", size: PNG.length, createdAt: "2026-08-27T01:00:00.000Z" }; } },
  }), async (baseUrl) => {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "client.png");
    form.append("type", "cover");
    const response = await fetch(`${baseUrl}/api/files/upload`, { method: "POST", headers: { authorization: "Bearer token" }, body: form });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(received.userId, "usr_current");
    assert.equal(received.input.filename, "client.png");

    const invalid = new FormData();
    invalid.append("file", new Blob([PNG], { type: "image/png" }), "client.png");
    invalid.append("type", "original");
    const invalidResponse = await fetch(`${baseUrl}/api/files/upload`, { method: "POST", headers: { authorization: "Bearer token" }, body: invalid });
    assert.equal(invalidResponse.status, 400);
  });
});

test("GET /api/media/covers serves an uploaded cover path", async () => {
  await withApplication(dependencies({
    covers: {
      async read(path) {
        assert.equal(path, "/api/media/covers/cover_0123456789abcdef0123456789abcdef.png");
        return { buffer: PNG, contentType: "image/png" };
      },
      async save() { throw new Error("unused"); },
      async remove() {},
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/media/covers/cover_0123456789abcdef0123456789abcdef.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  });
});

test("work creation rejects client-owned URLs/statistics and requires idempotency", async () => {
  let called = false;
  await withApplication(dependencies({ works: { async create() { called = true; return summary(); }, async list() {}, async get() {}, async delete() {} } }), async (baseUrl) => {
    const payload = { coverFileId: "file_test", pattern: pattern(), coverUrl: "https://attacker", beadCount: 1 };
    const response = await fetch(`${baseUrl}/api/works`, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json", "Idempotency-Key": "save-1" }, body: JSON.stringify(payload) });
    assert.equal(response.status, 400);
    assert.equal(called, false);

    const missingKey = await fetch(`${baseUrl}/api/works`, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ coverFileId: "file_test", pattern: pattern() }) });
    assert.equal(missingKey.status, 400);
  });
});

test("work list, detail recovery and delete use the authenticated owner", async () => {
  const calls = [];
  await withApplication(dependencies({
    works: {
      async create() { return summary(); },
      async list(options) { calls.push({ method: "list", options }); return { total: 1, page: 2, pageSize: 10, items: [summary()] }; },
      async get(userId, id) { calls.push({ method: "get", userId, id }); return { ...summary(), pattern: pattern() }; },
      async delete(userId, id) { calls.push({ method: "delete", userId, id }); },
    },
  }), async (baseUrl) => {
    const listResponse = await fetch(`${baseUrl}/api/works?page=2&pageSize=10&status=completed&query=%E7%8C%AB`, { headers: { authorization: "Bearer token" } });
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listBody.items[0].pattern, undefined);
    assert.deepEqual(calls[0], { method: "list", options: { userId: "usr_current", page: 2, pageSize: 10, status: "completed", query: "猫" } });

    const detailResponse = await fetch(`${baseUrl}/api/works/work_test`, { headers: { authorization: "Bearer token" } });
    const detailBody = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert.equal(detailBody.pattern.cells.length, 1024);
    assert.deepEqual(calls[1], { method: "get", userId: "usr_current", id: "work_test" });

    const deleteResponse = await fetch(`${baseUrl}/api/works/work_test`, { method: "DELETE", headers: { authorization: "Bearer token" } });
    assert.equal(deleteResponse.status, 204);
    assert.deepEqual(calls[2], { method: "delete", userId: "usr_current", id: "work_test" });
  });
});

test("PUT /api/works/:id updates title, cover and edited pattern for the authenticated owner", async () => {
  let received;
  await withApplication(dependencies({
    works: {
      async create() { return summary(); },
      async update(input) { received = input; return { ...summary(), title: input.title, beadCount: 1 }; },
      async list() { return { total: 0, page: 1, pageSize: 20, items: [] }; },
      async get() { return { ...summary(), pattern: pattern() }; },
      async delete() {},
    },
  }), async (baseUrl) => {
    const editedPattern = pattern();
    editedPattern.cells[0] = -1;
    const response = await fetch(`${baseUrl}/api/works/work_test`, {
      method: "PUT",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        title: "编辑后的作品",
        coverFileId: "file_edited",
        status: "completed",
        pattern: editedPattern,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.title, "编辑后的作品");
    assert.equal(received.userId, "usr_current");
    assert.equal(received.workId, "work_test");
    assert.equal(received.coverFileId, "file_edited");
    assert.equal(received.validatedPattern.beadCount, 1023);
  });
});

test("cross-owner work deletion follows the ownership error contract", async () => {
  await withApplication(dependencies({ works: { async create() {}, async list() {}, async get() {}, async delete() { throw new AppError(403, "FORBIDDEN", "作品不属于当前用户"); } } }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/works/work_other`, { method: "DELETE", headers: { authorization: "Bearer token" } });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error.code, "FORBIDDEN");
  });
});

test("favorite update uses the authenticated user and validates the exact boolean body", async () => {
  const calls = [];
  const works = {
    ...dependencies().works,
    async setFavorite(userId, workId, favorite) {
      calls.push({ userId, workId, favorite });
      return { workId, isFavorite: favorite, favoritedAt: favorite ? "2026-08-29T01:00:00.000Z" : null };
    },
  };
  await withApplication(dependencies({ works }), async (baseUrl) => {
    const favoriteResponse = await fetch(`${baseUrl}/api/works/work_test/favorite`, {
      method: "PATCH",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ favorite: true }),
    });
    assert.equal(favoriteResponse.status, 200);
    assert.deepEqual(await favoriteResponse.json(), {
      workId: "work_test",
      isFavorite: true,
      favoritedAt: "2026-08-29T01:00:00.000Z",
    });
    assert.deepEqual(calls[0], { userId: "usr_current", workId: "work_test", favorite: true });

    const invalidResponse = await fetch(`${baseUrl}/api/works/work_test/favorite`, {
      method: "PATCH",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ favorite: 1 }),
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal(calls.length, 1);
  });
});

test("favorite list accepts query pagination and returns summaries without pattern", async () => {
  let received;
  const favoriteSummary = { ...summary(), isFavorite: true, pattern: pattern() };
  const works = {
    ...dependencies().works,
    async listFavorites(options) {
      received = options;
      const { pattern: _pattern, ...item } = favoriteSummary;
      return { total: 3, page: 2, pageSize: 1, items: [item] };
    },
  };
  await withApplication(dependencies({ works }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/favorites?query=%E7%8C%AB&page=2&pageSize=1`, {
      headers: { authorization: "Bearer token" },
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(received, { userId: "usr_current", query: "猫", page: 2, pageSize: 1 });
    assert.equal(body.items[0].isFavorite, true);
    assert.equal(body.items[0].pattern, undefined);

    const unsupported = await fetch(`${baseUrl}/api/favorites?status=completed`, {
      headers: { authorization: "Bearer token" },
    });
    assert.equal(unsupported.status, 400);
  });
});

test("cross-owner favorite access follows the ownership error contract", async () => {
  const works = {
    ...dependencies().works,
    async setFavorite() { throw new AppError(403, "FORBIDDEN", "作品不属于当前用户"); },
  };
  await withApplication(dependencies({ works }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/works/work_other/favorite`, {
      method: "PATCH",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ favorite: true }),
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error.code, "FORBIDDEN");
  });
});
