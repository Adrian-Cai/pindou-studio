const assert = require("node:assert/strict");
const test = require("node:test");
const http2 = require("node:http2");
const { Readable } = require("node:stream");

const axios = require("axios");

/**
 * axios HTTP/2 流式请求体 maxBodyLength 守卫（CVE-2026-67318）。
 *
 * 漏洞：Node.js HTTP 适配器在 `httpVersion: 2` 下发送**流式**请求体时，
 * `maxBodyLength` 不会作用到 HTTP/2 传输层，攻击者可控的流可以无限发送，
 * 绕过作为硬性上限的 `maxBodyLength`（`1.13.0` ~ `<1.18.0` 受影响）。
 *
 * 版本正确性由 `dependency-axios-version.test.js` 用 package-lock 兜底；
 * 这里从**可执行行为**上验证：超限的 HTTP/2 流式上传必须被拦截，
 * 服务端实际收到的字节数不得超过上限，未超限的正常上传不受影响。
 */

const MAX_BODY_LENGTH = 1024;
const OVER_LIMIT = 4 * 1024 * 1024;
const UNDER_LIMIT = 512;

/** 起一个本地 HTTP/2 服务，跑完 run 后返回服务端实收的请求体字节数 */
async function countReceivedBody(run) {
  const server = http2.createServer();
  let received = 0;

  server.on("stream", (stream) => {
    stream.on("data", (chunk) => {
      received += chunk.length;
    });
    stream.on("end", () => {
      stream.respond({ ":status": 200 });
      stream.end("ok");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server.address().port);
    return received;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 恰好 totalBytes 字节的流，分块推送以模拟上传流 */
function fixedSizeStream(totalBytes) {
  const CHUNK = 128 * 1024;
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= totalBytes) {
        this.push(null);
        return;
      }
      const size = Math.min(CHUNK, totalBytes - sent);
      sent += size;
      this.push(Buffer.alloc(size, 0x61));
    },
  });
}

function upload(port, bytes) {
  return axios.post(`http://127.0.0.1:${port}/upload`, fixedSizeStream(bytes), {
    httpVersion: 2,
    maxBodyLength: MAX_BODY_LENGTH,
    headers: { "content-type": "application/octet-stream" },
  });
}

test("httpVersion: 2 下超限的流式请求体被 maxBodyLength 拦截", async () => {
  const received = await countReceivedBody((port) =>
    assert.rejects(upload(port, OVER_LIMIT), /maxBodyLength/i),
  );

  assert.ok(
    received <= MAX_BODY_LENGTH,
    `服务端收到 ${received} 字节，超过 maxBodyLength=${MAX_BODY_LENGTH}`,
  );
});

test("httpVersion: 2 下未超限的流式请求体正常发送", async () => {
  const received = await countReceivedBody(async (port) => {
    const res = await upload(port, UNDER_LIMIT);
    assert.equal(res.status, 200);
  });

  assert.equal(received, UNDER_LIMIT);
});
