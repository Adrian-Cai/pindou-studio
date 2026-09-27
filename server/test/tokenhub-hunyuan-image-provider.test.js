const assert = require("node:assert/strict");
const test = require("node:test");
const { TokenhubHunyuanImageProvider } = require("../dist/modules/ai/tokenhub-hunyuan-image-provider.js");
const { ProviderError } = require("../dist/modules/ai/provider.js");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const OUTPUT_URL = "https://aigc-output-image-file-123.cos.ap-guangzhou.myqcloud.com/result.png?token=temp";

function config(overrides = {}) {
  return {
    enabled: true,
    apiKey: "test-tokenhub-key",
    baseUrl: "https://tokenhub.tencentmaas.com",
    model: "hy-image-v3.5-preview",
    timeoutMs: 150_000,
    maximumOutputBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

const input = {
  imageDataUrl: null,
  referenceImageUrl: "https://studio.example/api/media/ai/input.png",
  prompt: "make a cat",
  clientBusinessId: "job-123",
};

test("TokenHub submits Hy-Image-3.5 without footnote and returns the temporary output URL", async () => {
  const calls = [];
  const provider = new TokenhubHunyuanImageProvider(config(), async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      request_id: "req-123",
      choices: [{ delta: { image: { url: OUTPUT_URL } } }],
      tokenhub_usage: { total_tokens: 42 },
    }), { status: 200 });
  });

  const result = await provider.createTask(input);
  const requestBody = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-tokenhub-key");
  assert.equal(requestBody.model, "hy-image-v3.5-preview");
  assert.equal(requestBody.session, "job-123");
  assert.equal(requestBody.size, "1024x1024");
  assert.deepEqual(requestBody.messages[0].content, [
    { type: "text", text: "make a cat" },
    { type: "image_url", image_url: { url: input.referenceImageUrl } },
  ]);
  assert.equal(Object.hasOwn(requestBody, "footnote"), false);
  assert.deepEqual(result, { requestId: "req-123", outputUrl: OUTPUT_URL });
});

test("TokenHub rejects content, rate-limit, and untrusted output responses", async (t) => {
  await t.test("422 content rejection", async () => {
    const provider = new TokenhubHunyuanImageProvider(config(), async () => new Response(
      JSON.stringify({ error: { code: "CONTENT_REJECTED" } }), { status: 422 },
    ));
    await assert.rejects(provider.createTask(input), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "CONTENT_REJECTED");
      assert.equal(error.failure.httpStatus, 422);
      return true;
    });
  });

  await t.test("429 retains Retry-After", async () => {
    const provider = new TokenhubHunyuanImageProvider(config(), async () => new Response(
      JSON.stringify({ error: { code: "RATE_LIMITED" } }),
      { status: 429, headers: { "retry-after": "2" } },
    ));
    await assert.rejects(provider.createTask(input), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.failure.kind, "RATE_LIMITED");
      assert.equal(error.failure.retryAfterMs, 2_000);
      return true;
    });
  });

  await t.test("rejects non-Tencent output URL", async () => {
    const provider = new TokenhubHunyuanImageProvider(config(), async () => new Response(
      JSON.stringify({ choices: [{ delta: { image: { url: "https://evil.example/image.png" } } }] }),
      { status: 200 },
    ));
    await assert.rejects(provider.createTask(input), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "AI_PROVIDER_OUTPUT_INVALID");
      return true;
    });
  });
});

test("TokenHub requires a server-owned reference image URL", async () => {
  const provider = new TokenhubHunyuanImageProvider(config(), async () => {
    throw new Error("fetch should not be called");
  });
  await assert.rejects(provider.createTask({ ...input, referenceImageUrl: null }), (error) => {
    assert.equal(error.code, "AI_INPUT_FILE_UNAVAILABLE");
    assert.equal(error.statusCode, 400);
    return true;
  });
});

test("TokenHub downloads only bounded PNG output from the approved HTTPS host", async () => {
  let request;
  const provider = new TokenhubHunyuanImageProvider(config(), async (url, init) => {
    request = { url, init };
    return new Response(PNG, { status: 200, headers: { "content-length": String(PNG.length) } });
  });

  assert.deepEqual(await provider.downloadOutput(OUTPUT_URL), PNG);
  assert.equal(request.url, OUTPUT_URL);
  assert.equal(request.init.redirect, "error");

  const limited = new TokenhubHunyuanImageProvider(config({ maximumOutputBytes: 8 }), async () => new Response(
    PNG, { status: 200, headers: { "content-length": String(PNG.length) } },
  ));
  await assert.rejects(limited.downloadOutput(OUTPUT_URL), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "AI_PROVIDER_OUTPUT_TOO_LARGE");
    return true;
  });

  await assert.rejects(provider.downloadOutput("http://aigc-output-image-file-123.cos.ap-guangzhou.myqcloud.com/result.png"), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "AI_PROVIDER_OUTPUT_INVALID");
    return true;
  });
});
