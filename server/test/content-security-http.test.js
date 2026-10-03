const assert = require("node:assert/strict");
const test = require("node:test");
const { AppError } = require("../dist/shared/app-error.js");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");

function dependencies(contentSecurity) {
  return {
    database: { async check() { return { status: "up", product: "PostgreSQL", version: "17", schemaStatus: "valid" }; } },
    auth: { async login() {} },
    authenticator: { async authenticate() { return { id: "usr_test" }; } },
    users: {},
    contentSecurity,
  };
}

async function withServer(contentSecurity, callback) {
  const running = await startHttpServer(createHttpApplication(dependencies(contentSecurity)), "127.0.0.1", 0);
  try { await callback(`http://127.0.0.1:${running.port}`); } finally { await running.close(); }
}

test("content security text endpoint uses the generic risky message", async () => {
  let received;
  await withServer({
    async checkText(userId, content) {
      received = { userId, content };
      throw new AppError(400, "CONTENT_RISKY", "你发布的内容含违规信息，请修改后重试");
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/content-security/text`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ content: "作品名称" }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.message, "你发布的内容含违规信息，请修改后重试");
    assert.equal(received.userId, "usr_test");
  });
});

test("content security callback requires the configured signature", async () => {
  await withServer({
    verifyCallback() { return false; },
    async handleCallback() { throw new Error("must not be called"); },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/wechat/content-security/callback?signature=bad&timestamp=1&nonce=2&echostr=test`);
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error.code, "INVALID_CALLBACK_SIGNATURE");
  });
});

test("content security callback GET returns the verified echo string", async () => {
  await withServer({
    verifyCallback() { return true; },
    async handleCallback() {},
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/wechat/content-security/callback?signature=ok&timestamp=1&nonce=2&echostr=echo`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "echo");
  });
});

test("content security media endpoint requires one multipart file", async () => {
  await withServer({
    async checkMedia() { throw new Error("must not be called"); },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/content-security/media`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ content: "not-a-file" }),
    });
    const body = await response.json();
    assert.equal(response.status, 415);
    assert.equal(body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });
});
