const assert = require("node:assert/strict");
const test = require("node:test");
const { AppError } = require("../dist/shared/app-error.js");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");

function baseDependencies(overrides = {}) {
  return {
    database: { async check() { return {
      status: "up",
      product: "PostgreSQL",
      version: "17.11",
      schemaStatus: "valid",
    }; } },
    auth: { async login() { throw new Error("unused login"); } },
    authenticator: { async authenticate() { throw new Error("unused authentication"); } },
    users: { async getCurrentUser() { throw new Error("unused profile"); } },
    avatars: {
      async save() { throw new Error("unused avatar save"); },
      async read() { return null; },
      async remove() {},
    },
    avatarMaximumBytes: 2 * 1024 * 1024,
    ...overrides,
  };
}

async function withApplication(dependencies, callback) {
  const running = await startHttpServer(
    createHttpApplication(dependencies),
    "127.0.0.1",
    0,
  );
  try {
    await callback(`http://127.0.0.1:${running.port}`);
  } finally {
    await running.close();
  }
}

test("POST /api/auth/login returns an opaque token and nullable profile", async () => {
  let receivedCode;
  await withApplication(
    baseDependencies({
      auth: { async login(code) {
        receivedCode = code;
        return {
          token: "opaque-token",
          expiresAt: "2026-09-25T09:00:00.000Z",
          user: { id: "usr_test", nickname: null, avatarUrl: null },
        };
      } },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "wx-code" }),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(receivedCode, "wx-code");
      assert.equal(body.token, "opaque-token");
      assert.equal(body.user.nickname, null);
      assert.equal(body.user.avatarUrl, null);
      assert.equal("openid" in body, false);
      assert.equal("session_key" in body, false);
    },
  );
});

test("login rejects userId and other client-owned identity fields", async () => {
  let called = false;
  await withApplication(
    baseDependencies({ auth: { async login() { called = true; throw new Error("unexpected"); } } }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "wx-code", userId: "usr_attacker" }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.code, "INVALID_ARGUMENT");
      assert.equal(called, false);
    },
  );
});

test("login failures follow the shared error contract", async () => {
  await withApplication(
    baseDependencies({
      auth: { async login() { throw new AppError(400, "INVALID_WX_CODE", "微信登录凭证无效或已使用"); } },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "invalid-code" }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.code, "INVALID_WX_CODE");
      assert.equal(body.error.requestId, response.headers.get("x-request-id"));
      assert.deepEqual(body.error.details, {});
    },
  );
});

test("GET /api/users/me derives ownership exclusively from Bearer token", async () => {
  let receivedAuthorization;
  let receivedUserId;
  await withApplication(
    baseDependencies({
      authenticator: { async authenticate(authorization) {
        receivedAuthorization = authorization;
        return { id: "usr_from_token" };
      } },
      users: { async getCurrentUser(userId) {
        receivedUserId = userId;
        return {
          user: { id: userId, nickname: null, avatarUrl: null, createdAt: "2026-08-26T09:00:00.000Z" },
          stats: { workCount: 0, favoriteCount: 0, downloadCount: 0 },
          quota: { dailyFree: 3, usedToday: 0, purchased: 0, remaining: 3, resetsAt: "2026-08-27T00:00:00+08:00" },
        };
      } },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users/me`, {
        headers: { authorization: "Bearer opaque_token_12345678901234567890" },
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(receivedAuthorization, "Bearer opaque_token_12345678901234567890");
      assert.equal(receivedUserId, "usr_from_token");
      assert.equal(body.user.id, "usr_from_token");
    },
  );
});

test("GET /api/users/me rejects query userId", async () => {
  let authenticated = false;
  await withApplication(
    baseDependencies({ authenticator: { async authenticate() { authenticated = true; return { id: "usr_test" }; } } }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users/me?userId=usr_attacker`, {
        headers: { authorization: "Bearer opaque_token_12345678901234567890" },
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.code, "INVALID_ARGUMENT");
      assert.equal(authenticated, false);
    },
  );
});

test("PATCH /api/users/me updates only the authenticated user's normalized nickname", async () => {
  let update;
  await withApplication(
    baseDependencies({
      authenticator: { async authenticate() { return { id: "usr_from_token" }; } },
      users: { async updateNickname(userId, nickname) {
        update = { userId, nickname };
        return { id: userId, nickname, avatarUrl: null, createdAt: "2026-08-26T09:00:00.000Z" };
      } },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users/me`, {
        method: "PATCH",
        headers: {
          authorization: "Bearer opaque_token_12345678901234567890",
          "content-type": "application/json",
        },
        body: JSON.stringify({ nickname: "  拼豆玩家  " }),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(update, { userId: "usr_from_token", nickname: "拼豆玩家" });
      assert.equal(body.user.nickname, "拼豆玩家");
    },
  );
});

test("PATCH /api/users/me rejects empty or client-owned profile fields", async () => {
  await withApplication(
    baseDependencies({
      authenticator: { async authenticate() { return { id: "usr_test" }; } },
    }),
    async (baseUrl) => {
      const empty = await fetch(`${baseUrl}/api/users/me`, {
        method: "PATCH",
        headers: { authorization: "Bearer opaque_token_12345678901234567890", "content-type": "application/json" },
        body: JSON.stringify({ nickname: "   " }),
      });
      assert.equal(empty.status, 400);

      const arbitraryAvatar = await fetch(`${baseUrl}/api/users/me`, {
        method: "PATCH",
        headers: { authorization: "Bearer opaque_token_12345678901234567890", "content-type": "application/json" },
        body: JSON.stringify({ nickname: "用户", avatarUrl: "https://attacker.example/avatar.png" }),
      });
      assert.equal(arbitraryAvatar.status, 400);
    },
  );
});

test("POST /api/users/me/avatar authenticates, uploads one file and replaces the stored avatar", async () => {
  const calls = [];
  await withApplication(
    baseDependencies({
      authenticator: { async authenticate() { return { id: "usr_test" }; } },
      avatars: {
        async save(buffer, contentType) {
          calls.push({ action: "save", size: buffer.length, contentType });
          return { publicPath: "/api/media/avatars/avatar_0123456789abcdef0123456789abcdef.png", contentType: "image/png" };
        },
        async read() { return null; },
        async remove(path) { calls.push({ action: "remove", path }); },
      },
      users: { async updateProfileWithAvatar(userId, nickname, avatarUrl) {
        calls.push({ action: "update", userId, nickname, avatarUrl });
        return {
          user: { id: userId, nickname: "拼豆玩家", avatarUrl, createdAt: "2026-08-26T09:00:00.000Z" },
          previousAvatarUrl: "/api/media/avatars/avatar_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg",
        };
      } },
    }),
    async (baseUrl) => {
      const form = new FormData();
      form.append("file", new Blob([Buffer.from("png-data")], { type: "image/png" }), "avatar.png");
      form.append("nickname", "拼豆玩家");
      const response = await fetch(`${baseUrl}/api/users/me/avatar`, {
        method: "POST",
        headers: { authorization: "Bearer opaque_token_12345678901234567890" },
        body: form,
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.user.avatarUrl, "/api/media/avatars/avatar_0123456789abcdef0123456789abcdef.png");
      assert.deepEqual(calls, [
        { action: "save", size: 8, contentType: "image/png" },
        {
          action: "update",
          userId: "usr_test",
          nickname: "拼豆玩家",
          avatarUrl: "/api/media/avatars/avatar_0123456789abcdef0123456789abcdef.png",
        },
        { action: "remove", path: "/api/media/avatars/avatar_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg" },
      ]);
    },
  );
});

test("GET /api/media/avatars serves immutable image bytes", async () => {
  await withApplication(
    baseDependencies({
      avatars: {
        async save() { throw new Error("unused avatar save"); },
        async read(path) {
          assert.equal(path, "/api/media/avatars/avatar_0123456789abcdef0123456789abcdef.png");
          return { buffer: Buffer.from([1, 2, 3]), contentType: "image/png" };
        },
        async remove() {},
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/media/avatars/avatar_0123456789abcdef0123456789abcdef.png`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.match(response.headers.get("cache-control"), /immutable/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1, 2, 3]));
    },
  );
});
