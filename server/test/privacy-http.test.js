const assert = require("node:assert/strict");
const test = require("node:test");
const { AppError } = require("../dist/shared/app-error.js");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");

const defaults = {
  localOnly: true,
  cloudSync: false,
  serviceNotices: true,
  personalizedRecommendations: false,
  updatedAt: "2026-09-07T00:00:00.000Z",
};

function dependencies(overrides = {}) {
  return {
    database: { async check() { return { status: "up", product: "PostgreSQL", version: "17", schemaStatus: "valid" }; } },
    auth: { async login() { throw new Error("unused"); } },
    authenticator: { async authenticate() { throw new AppError(401, "UNAUTHORIZED", "请先登录"); } },
    users: {
      async getCurrentUser() { return { user: {}, stats: {}, quota: {}, privacy: defaults }; },
      async updateNickname() { throw new Error("unused"); },
      async updateAvatar() { throw new Error("unused"); },
      async getPrivacyPreferences() { return defaults; },
      async updatePrivacyPreferences(_userId, patch) {
        return { ...defaults, ...patch };
      },
      async deleteAccount() {},
    },
    avatars: { async save() {}, async read() { return null; }, async remove() {} },
    avatarMaximumBytes: 1024,
    ...overrides,
  };
}

async function withApplication(deps, callback) {
  const running = await startHttpServer(createHttpApplication(deps), "127.0.0.1", 0);
  try {
    await callback(`http://127.0.0.1:${running.port}`);
  } finally {
    await running.close();
  }
}

test("privacy PATCH rejects unauthenticated requests before reaching users", async () => {
  let called = false;
  await withApplication(dependencies({
    authenticator: { async authenticate() { called = true; throw new AppError(401, "UNAUTHORIZED", "请先登录"); } },
    users: { async updatePrivacyPreferences() { throw new Error("must not call"); } },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/users/me/privacy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cloudSync: true }),
    });
    assert.equal(response.status, 401);
    assert.equal(called, true);
  });
});

test("privacy PATCH supports partial updates and passes only allowed booleans", async () => {
  let received;
  await withApplication(dependencies({
    authenticator: { async authenticate() { return { id: "usr_test" }; } },
    users: {
      async updatePrivacyPreferences(userId, patch) {
        received = { userId, patch };
        return { ...defaults, ...patch, localOnly: false, cloudSync: true };
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/users/me/privacy`, {
      method: "PATCH",
      headers: { authorization: "Bearer token_12345678901234567890", "content-type": "application/json" },
      body: JSON.stringify({ cloudSync: true }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(received, { userId: "usr_test", patch: { cloudSync: true } });
    assert.equal(body.privacy.cloudSync, true);

    const invalid = await fetch(`${baseUrl}/api/users/me/privacy`, {
      method: "PATCH",
      headers: { authorization: "Bearer token_12345678901234567890", "content-type": "application/json" },
      body: JSON.stringify({ cloudSync: "true" }),
    });
    assert.equal(invalid.status, 400);

    const extra = await fetch(`${baseUrl}/api/users/me/privacy`, {
      method: "PATCH",
      headers: { authorization: "Bearer token_12345678901234567890", "content-type": "application/json" },
      body: JSON.stringify({ userId: "attacker" }),
    });
    assert.equal(extra.status, 400);
  });
});

test("GET /api/users/me/privacy returns the authenticated user's preferences", async () => {
  let receivedUserId;
  await withApplication(dependencies({
    authenticator: { async authenticate() { return { id: "usr_from_token" }; } },
    users: {
      async getPrivacyPreferences(userId) {
        receivedUserId = userId;
        return defaults;
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/users/me/privacy`, {
      headers: { authorization: "Bearer token_12345678901234567890" },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(receivedUserId, "usr_from_token");
    assert.deepEqual(body.privacy, defaults);
  });
});

test("legal documents expose only controlled keys", async () => {
  await withApplication(dependencies(), async (baseUrl) => {
    for (const key of ["user-agreement", "privacy-policy", "personal-information", "third-party-sharing"]) {
      const response = await fetch(`${baseUrl}/api/legal-documents/${key}`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.document.key, key);
      assert.equal(body.document.contentType, "rich-text");
      const version = "2026-10-16";
      assert.equal(body.document.version, version);
      assert.equal(body.document.effectiveAt, `${version}T00:00:00+08:00`);
      assert.equal(typeof body.document.content, "string");
      assert.ok(body.document.content.length > 100);
      if (key === "privacy-policy") assert.match(body.document.content, /QQ 登录/);
      if (key === "personal-information") assert.match(body.document.content, /QQ 登录标识/);
      if (key === "third-party-sharing") assert.match(body.document.content, /QQ 登录/);
      assert.equal(/<script\b/i.test(body.document.content), false);
    }
    const paidService = await fetch(`${baseUrl}/api/legal-documents/paid-service`);
    const paidServiceBody = await paidService.json();
    assert.equal(paidService.status, 200);
    assert.equal(paidServiceBody.document.key, "paid-service");
    assert.equal(paidServiceBody.document.title, "小露拼豆付费服务协议");
    assert.equal(paidServiceBody.document.version, "2026-10-16");
    assert.equal(paidServiceBody.document.effectiveAt, "2026-10-16T00:00:00+08:00");
    assert.match(paidServiceBody.document.content, /QQ 端暂不提供购买和支付操作/);
    assert.ok(paidServiceBody.document.content.includes("退款"));
    assert.equal(/<script\b/i.test(paidServiceBody.document.content), false);
    const missing = await fetch(`${baseUrl}/api/legal-documents/not-supported`);
    const missingBody = await missing.json();
    assert.equal(missing.status, 404);
    assert.equal(missingBody.error.code, "DOCUMENT_NOT_FOUND");
    const prototypeKey = await fetch(`${baseUrl}/api/legal-documents/toString`);
    assert.equal(prototypeKey.status, 404);
  });
});

test("account deletion revokes the current token after transactional deletion", async () => {
  let revoked = false;
  let deletedUserId;
  await withApplication(dependencies({
    authenticator: { async authenticate() {
      if (revoked) throw new AppError(401, "UNAUTHORIZED", "登录状态已失效");
      return { id: "usr_test" };
    } },
    users: { async deleteAccount(userId) { deletedUserId = userId; revoked = true; } },
  }), async (baseUrl) => {
    const headers = { authorization: "Bearer token_12345678901234567890" };
    const first = await fetch(`${baseUrl}/api/users/me`, { method: "DELETE", headers });
    assert.equal(first.status, 204);
    assert.equal(deletedUserId, "usr_test");
    const second = await fetch(`${baseUrl}/api/users/me`, { method: "DELETE", headers });
    const body = await second.json();
    assert.equal(second.status, 401);
    assert.equal(body.error.code, "UNAUTHORIZED");
  });
});
