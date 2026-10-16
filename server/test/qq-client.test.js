const assert = require("node:assert/strict");
const test = require("node:test");
const { OfficialQqLoginClient } = require("../dist/modules/auth/qq-client.js");

const config = { appId: "qq-app-id", appSecret: "qq-app-secret", timeoutMs: 1000 };

test("official QQ client sends code2Session parameters and returns the QQ identity", async () => {
  let requestUrl;
  const client = new OfficialQqLoginClient(config, async (url) => {
    requestUrl = new URL(url);
    return new Response(JSON.stringify({ openid: "qq-openid", session_key: "qq-session-key" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.deepEqual(await client.exchangeCode("qq-code"), {
    openid: "qq-openid",
    sessionKey: "qq-session-key",
  });
  assert.equal(requestUrl.origin, "https://api.q.qq.com");
  assert.equal(requestUrl.pathname, "/sns/jscode2session");
  assert.equal(requestUrl.searchParams.get("appid"), config.appId);
  assert.equal(requestUrl.searchParams.get("secret"), config.appSecret);
  assert.equal(requestUrl.searchParams.get("js_code"), "qq-code");
  assert.equal(requestUrl.searchParams.get("grant_type"), "authorization_code");
});

test("QQ client maps invalid or reused codes without exposing upstream details", async () => {
  const client = new OfficialQqLoginClient(config, async () =>
    new Response(JSON.stringify({ errcode: 40029, errmsg: "sensitive upstream detail" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  await assert.rejects(() => client.exchangeCode("bad-code"), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "INVALID_QQ_CODE");
    assert.doesNotMatch(error.message, /sensitive upstream detail/);
    return true;
  });
});

test("QQ client maps transport failures without leaking credentials", async () => {
  const client = new OfficialQqLoginClient(config, async () => {
    throw new Error("network failure");
  });
  await assert.rejects(() => client.exchangeCode("qq-code"), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, "QQ_SERVICE_UNAVAILABLE");
    assert.doesNotMatch(error.message, /qq-app-secret/);
    return true;
  });
});
