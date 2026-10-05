const assert = require("node:assert/strict");
const test = require("node:test");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");

test("share-link routes only create the supported page links and query WeChat links", async () => {
  const calls = [];
  const running = await startHttpServer(createHttpApplication({
    urlLinks: {
      async generate(page) { calls.push(["generate", page]); return { urlLink: "https://wxaurl.cn/generated" }; },
      async query(urlLink) {
        calls.push(["query", urlLink]);
        return { urlLinkInfo: { appId: "app-id", path: "/pages/profile/index", query: "", createTime: 1, expireTime: 2, envVersion: "release" } };
      },
    },
  }), "127.0.0.1", 0);
  try {
    const baseUrl = `http://127.0.0.1:${running.port}`;
    const createResponse = await fetch(`${baseUrl}/api/share-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "profile" }),
    });
    assert.equal(createResponse.status, 201);
    assert.deepEqual(await createResponse.json(), { urlLink: "https://wxaurl.cn/generated" });

    const queryResponse = await fetch(`${baseUrl}/api/share-links/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urlLink: "https://wxaurl.cn/generated" }),
    });
    assert.equal(queryResponse.status, 200);
    assert.equal((await queryResponse.json()).urlLinkInfo.path, "/pages/profile/index");

    const invalidPage = await fetch(`${baseUrl}/api/share-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "admin" }),
    });
    assert.equal(invalidPage.status, 400);
    const invalidLink = await fetch(`${baseUrl}/api/share-links/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urlLink: "https://example.com/not-a-wechat-link" }),
    });
    assert.equal(invalidLink.status, 400);
    assert.deepEqual(calls, [
      ["generate", "profile"],
      ["query", "https://wxaurl.cn/generated"],
    ]);
  } finally {
    await running.close();
  }
});
