const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const axios = require("axios");

/**
 * axios fetch 适配器 maxBodyLength 守卫（CVE-2026-67317）。
 *
 * 漏洞：`axios@1.16.0` 的 fetch 适配器只在**请求前**用 `resolveBodyLength()` 校验
 * `maxBodyLength`，而活体 WHATWG `ReadableStream` 请求体无法预先确定大小，
 * 该分支直接跳过校验（源码注释：`Skip when the body length cannot be determined
 * (e.g. a live ReadableStream supplied by the caller).`）。流式上传路径也没做逐块计数，
 * 于是声明 `adapter: "fetch"` + `maxBodyLength` 的调用方会被绕过，超限流整体发出。
 * HTTP 适配器不受影响。
 *
 * 修复版本 `1.18.0` 起，fetch 适配器对 `ReadableStream` / Node `Stream` 请求体
 * 用 `trackStream` 逐块累加，超过 `maxBodyLength` 即抛
 * `AxiosError ERR_BAD_REQUEST / Request body larger than maxBodyLength limit`。
 *
 * 版本正确性由 `dependency-axios-version.test.js` 用 package-lock 兜底；
 * 这里从**可执行行为**上验证限制真实生效，若将来 axios 回退该实现，本用例会转红。
 */

const MAX_BODY_LENGTH = 1000;

// 每次请求放 20KB，远超 maxBodyLength；本地自建 server，不产生外网流量。
const createOversizedStream = () =>
  new ReadableStream({
    start(controller) {
      for (let i = 0; i < 20; i++) {
        controller.enqueue(new Uint8Array(1024));
      }
      controller.close();
    },
  });

test("fetch 适配器对未知大小的流式请求体强制执行 maxBodyLength", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      axios.post(`http://127.0.0.1:${port}/upload`, createOversizedStream(), {
        adapter: "fetch",
        maxBodyLength: MAX_BODY_LENGTH,
        headers: { "content-type": "application/octet-stream" },
        validateStatus: () => true,
      }),
      (error) => {
        assert.equal(error.code, "ERR_BAD_REQUEST");
        assert.match(error.message, /maxBodyLength/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
