const assert = require("node:assert/strict");
const http = require("node:http");
const http2 = require("node:http2");
const test = require("node:test");
const { Readable } = require("node:stream");

const axios = require("axios");

/**
 * 从 HTTP/2 与 fetch 适配器分别验证流式请求体的 maxBodyLength 上限。
 * fetch 用例覆盖未知长度的 WHATWG ReadableStream；HTTP/2 用例同时检查超限拦截与正常上传。
 * 版本门禁由 dependency-axios-version.test.js 覆盖，这里守护 axios 的运行时行为。
 */
const MAX_BODY_LENGTH = 1024;
const OVER_LIMIT = 4 * 1024 * 1024;
const UNDER_LIMIT = 512;

async function countReceivedHttp2Body(run) {
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

function uploadHttp2(port, bytes) {
  return axios.post(`http://127.0.0.1:${port}/upload`, fixedSizeStream(bytes), {
    httpVersion: 2,
    maxBodyLength: MAX_BODY_LENGTH,
    headers: { "content-type": "application/octet-stream" },
  });
}

// HTTP/2 适配器的流式传输回归（CVE-2026-67318）。
test("httpVersion: 2 下超限的流式请求体被 maxBodyLength 拦截", async () => {
  const received = await countReceivedHttp2Body((port) =>
    assert.rejects(uploadHttp2(port, OVER_LIMIT), /maxBodyLength/i),
  );
  assert.ok(received <= MAX_BODY_LENGTH, `服务端收到 ${received} 字节，超过 maxBodyLength=${MAX_BODY_LENGTH}`);
});

test("httpVersion: 2 下未超限的流式请求体正常发送", async () => {
  const received = await countReceivedHttp2Body(async (port) => {
    const response = await uploadHttp2(port, UNDER_LIMIT);
    assert.equal(response.status, 200);
  });
  assert.equal(received, UNDER_LIMIT);
});

function oversizedFetchStream() {
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < 20; index += 1) {
        controller.enqueue(new Uint8Array(1024));
      }
      controller.close();
    },
  });
}

// fetch 适配器不能只在发送前读取长度，必须在传输时限制未知长度的流（CVE-2026-67317）。
test("fetch 适配器对未知大小的流式请求体强制执行 maxBodyLength", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => response.end("ok"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      axios.post(`http://127.0.0.1:${port}/upload`, oversizedFetchStream(), {
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
