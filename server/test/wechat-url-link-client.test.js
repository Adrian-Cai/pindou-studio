const assert = require("node:assert/strict");
const test = require("node:test");
const { OfficialWeChatUrlLinkClient } = require("../dist/modules/wechat/url-link-client.js");

test("URL Link create and query share a cached token and retry an expired token", async () => {
  const requests = [];
  let tokenCount = 0;
  let createCount = 0;
  const client = new OfficialWeChatUrlLinkClient("app-id", "app-secret", 1_000, async (url, init) => {
    requests.push({ url, init });
    if (url.startsWith("https://api.weixin.qq.com/cgi-bin/token")) {
      tokenCount += 1;
      return Response.json({ access_token: `token-${tokenCount}`, expires_in: 7_200 });
    }
    if (url.includes("/generate_urllink")) {
      createCount += 1;
      if (createCount === 1) return Response.json({ errcode: 42001, errmsg: "expired" });
      return Response.json({ errcode: 0, url_link: "https://wxaurl.cn/generated" });
    }
    return Response.json({
      errcode: 0,
      url_link_info: {
        appid: "app-id",
        path: "/pages/projects/index",
        query: "",
        create_time: 1_800_000_000,
        expire_time: 1_802_592_000,
        env_version: "release",
      },
    });
  });

  assert.deepEqual(await client.generate("projects"), { urlLink: "https://wxaurl.cn/generated" });
  assert.deepEqual(await client.query("https://wxaurl.cn/generated"), {
    urlLinkInfo: {
      appId: "app-id",
      path: "/pages/projects/index",
      query: "",
      createTime: 1_800_000_000,
      expireTime: 1_802_592_000,
      envVersion: "release",
    },
  });
  assert.equal(tokenCount, 2);
  assert.equal(createCount, 2);
  const generatedBody = JSON.parse(requests.find(({ url }) => url.includes("/generate_urllink") && url.includes("token-2" )).init.body);
  assert.deepEqual(generatedBody, {
    path: "/pages/projects/index",
    expire_type: 1,
    expire_interval: 30,
    env_version: "release",
  });
});
