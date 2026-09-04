const assert = require("node:assert/strict");
const test = require("node:test");
const { OfficialWeChatContentSecurityClient } = require("../dist/modules/content-security/wechat-client.js");

function response(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("content security client caches access token and sends v2 text/media payloads", async () => {
  const requests = [];
  const client = new OfficialWeChatContentSecurityClient("app-id", "app-secret", 5_000, async (url, init) => {
    requests.push({ url, init });
    if (url.includes("cgi-bin/token")) return response({ access_token: "token-1", expires_in: 7_200 });
    if (url.includes("msg_sec_check")) return response({ errcode: 0, trace_id: "text-trace", result: { suggest: "pass", label: 100 } });
    if (url.includes("media_check_async")) return response({ errcode: 0, trace_id: "media-trace" });
    if (url.includes("img_sec_check")) return response({ errcode: 0, result: { suggest: "pass", label: 100 } });
    throw new Error(`unexpected url ${url}`);
  });

  const text = await client.checkText({ openid: "openid", content: "作品名称", scene: 2 });
  const media = await client.submitMedia({ openid: "openid", mediaUrl: "https://api.example/media.png", scene: 1 });
  const image = await client.checkImage(Buffer.from("89504e470d0a1a0a", "hex"), "source.png", "image/png");

  assert.equal(text.safe, true);
  assert.equal(media.traceId, "media-trace");
  assert.equal(image.safe, true);
  assert.equal(requests.filter((item) => item.url.includes("cgi-bin/token")).length, 1);
  const textRequest = requests.find((item) => item.url.includes("msg_sec_check"));
  assert.deepEqual(JSON.parse(textRequest.init.body), { openid: "openid", scene: 2, version: 2, content: "作品名称" });
  const imageRequest = requests.find((item) => item.url.includes("img_sec_check"));
  assert.equal(imageRequest.init.body instanceof FormData, true);
});

test("content security client maps WeChat risky response to an unsafe result", async () => {
  const client = new OfficialWeChatContentSecurityClient("app-id", "app-secret", 5_000, async (url) => {
    if (url.includes("cgi-bin/token")) return response({ access_token: "token-1", expires_in: 7_200 });
    return response({ errcode: 87014, errmsg: "risk", result: { suggest: "risky", label: 20002 } });
  });

  const result = await client.checkText({ openid: "openid", content: "违规内容", scene: 2 });
  assert.equal(result.safe, false);
  assert.equal(result.suggest, "risky");
  assert.equal(result.label, 20002);
});

test("content security client refreshes an expired token and maps review safely", async () => {
  const tokenRequests = [];
  const client = new OfficialWeChatContentSecurityClient("app-id", "app-secret", 5_000, async (url) => {
    if (url.includes("cgi-bin/token")) {
      tokenRequests.push(url);
      return response({ access_token: `token-${tokenRequests.length}`, expires_in: 7_200 });
    }
    if (url.includes("token-1")) return response({ errcode: 40001, errmsg: "expired" });
    return response({ errcode: 0, trace_id: "review-trace", result: { suggest: "review", label: 20001 } });
  });

  const result = await client.checkText({ openid: "openid", content: "待复核内容", scene: 2 });

  assert.equal(tokenRequests.length, 2);
  assert.equal(result.safe, false);
  assert.equal(result.suggest, "review");
  assert.equal(result.label, 20001);
});
