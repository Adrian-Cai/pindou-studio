const assert = require("node:assert/strict");
const test = require("node:test");

/**
 * axios NO_PROXY / 代理绕过守卫（CVE-2026-67315）。
 *
 * 漏洞：`axios` 在 Node 下会根据 `NO_PROXY` 决定是否绕过 `HTTP_PROXY` / `HTTPS_PROXY`，
 * 早期版本只把 `127.0.0.0/8` 当回环地址，`0.0.0.0` 落进「不走 NO_PROXY」分支，
 * 于是 `http://0.0.0.0:<port>/` 会被送去代理。该地址在内核里等同于本机，
 * 请求目标可控（重定向等）时可借此打到只监听本机的服务，形成 SSRF。
 *
 * 版本正确性由 `dependency-axios-version.test.js` 用 package-lock 兜底
 * （要求 `axios@1.20.0`，高于本 CVE 的推荐修复版本 1.18.0）；
 * 这里从**可执行行为**上验证：装了 HTTP_PROXY、且 `NO_PROXY` 覆盖回环地址时，
 * 发往 `http://0.0.0.0:<port>/` 的请求必须打在本机服务上，而不是打给代理。
 * 用例自带代理与本地服务两个监听器，代理收到请求即判失败（在修复前的版本上会失败）。
 */

const ENV_KEYS = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"];

async function listen(server, host) {
  await new Promise((resolve) => server.listen(0, host, resolve));
  return server.address().port;
}

test("NO_PROXY 含回环地址时，0.0.0.0 目标不得走代理", async () => {
  const { createServer } = require("node:http");
  // axios 是 ESM/CJS 双入口包，代理与环境读取都在包内完成，这里只走公开 API。
  const axios = require("axios");
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  const proxy = createServer((_request, response) => {
    response.end("PROXY");
  });
  const local = createServer((_request, response) => {
    response.end("LOCAL");
  });

  try {
    const proxyPort = await listen(proxy, "127.0.0.1");
    const localPort = await listen(local, "0.0.0.0");

    // 代理指向只会应答 PROXY 的监听器：请求若被代理，data 会变成 "PROXY"。
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.NO_PROXY = "localhost,127.0.0.1,::1";

    const response = await axios.get(`http://0.0.0.0:${localPort}/`, {
      proxy: null,
      timeout: 5000,
    });

    assert.equal(response.data, "LOCAL");
  } finally {
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
    await Promise.all([proxy, local].map((server) => new Promise((resolve) => server.close(resolve))));
  }
});
