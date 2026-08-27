const assert = require("node:assert/strict");
const test = require("node:test");
const { OfficialWeChatLoginClient } = require("../dist/modules/auth/wechat-client.js");

const config = {
  appId: "test-app-id",
  appSecret: "test-app-secret",
  timeoutMs: 1000,
};

test("official WeChat client sends code2Session parameters and returns only openid", async () => {
  let requestUrl;
  const client = new OfficialWeChatLoginClient(config, async (url) => {
    requestUrl = new URL(url);
    return new Response(JSON.stringify({ openid: "openid-value", session_key: "session-key-value" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.deepEqual(await client.exchangeCode("wx-code"), { openid: "openid-value" });
  assert.equal(requestUrl.pathname, "/sns/jscode2session");
  assert.equal(requestUrl.searchParams.get("appid"), config.appId);
  assert.equal(requestUrl.searchParams.get("js_code"), "wx-code");
  assert.equal(requestUrl.searchParams.get("grant_type"), "authorization_code");
});

test("official WeChat client maps invalid or reused code to a safe API error", async () => {
  const client = new OfficialWeChatLoginClient(config, async () =>
    new Response(JSON.stringify({ errcode: 40029, errmsg: "sensitive upstream detail" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await assert.rejects(() => client.exchangeCode("bad-code"), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "INVALID_WX_CODE");
    assert.doesNotMatch(error.message, /sensitive upstream detail/);
    return true;
  });
});

test("official WeChat client maps transport failures without leaking configuration", async () => {
  const client = new OfficialWeChatLoginClient(config, async () => {
    throw new Error("network failure");
  });
  await assert.rejects(() => client.exchangeCode("wx-code"), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, "WECHAT_SERVICE_UNAVAILABLE");
    assert.doesNotMatch(error.message, /test-app-secret/);
    return true;
  });
});
