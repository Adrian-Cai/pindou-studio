const assert = require("node:assert/strict");
const test = require("node:test");
const { ToapisImageProvider } = require("../dist/modules/ai/toapis-image-provider.js");
const { ProviderError } = require("../dist/modules/ai/provider.js");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function config(overrides = {}) {
  return {
    enabled: true,
    apiKey: "secret-test-key",
    baseUrl: "https://api.toapis.cn",
    model: "gpt-image-2.5-sunburst",
    size: "1:1",
    resolution: "1K",
    quality: "high",
    timeoutMs: 30_000,
    pollIntervalMs: 7_000,
    maximumOutputBytes: 1024 * 1024,
    outputHosts: ["files.toapis.com"],
    ...overrides,
  };
}

test("ToAPIs submits a public reference URL and returns an async task id", async () => {
  let request;
  const provider = new ToapisImageProvider(config(), async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ id: "task_123", status: "queued" }), { status: 202 });
  });
  const submission = await provider.createTask({
    imageDataUrl: "data:image/png;base64,should-not-be-sent",
    referenceImageUrl: "https://studio.example/api/media/ai/input.png",
    prompt: "生成清晰的产品图",
    clientBusinessId: "aijob_123",
  });
  assert.deepEqual(submission, { requestId: "task_123", outputUrl: null });
  assert.equal(request.url, "https://api.toapis.cn/v1/images/generations");
  assert.equal(request.init.headers.authorization, "Bearer secret-test-key");
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, "gpt-image-2.5-sunburst");
  assert.deepEqual(body.reference_images, ["https://studio.example/api/media/ai/input.png"]);
  assert.equal(body.client_business_id, "aijob_123");
  assert.equal(body.n, 1);
  assert.equal(body.imageDataUrl, undefined);
});

test("ToAPIs maps pending and completed task status", async () => {
  const responses = [
    new Response(JSON.stringify({ id: "task_123", status: "in_progress" }), { status: 200 }),
    new Response(JSON.stringify({ id: "task_123", status: "completed", result: { data: [{ url: "https://files.toapis.com/output.png" }] } }), { status: 200 }),
  ];
  const provider = new ToapisImageProvider(config(), async () => responses.shift());
  assert.deepEqual(await provider.getTask("task_123"), { status: "in_progress", outputUrl: null });
  assert.deepEqual(await provider.getTask("task_123"), { status: "completed", outputUrl: "https://files.toapis.com/output.png" });
});

test("ToAPIs downloads only allow-listed HTTPS output and enforces response bytes", async () => {
  const provider = new ToapisImageProvider(config(), async () => new Response(PNG, {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(PNG.length) },
  }));
  assert.deepEqual(await provider.downloadOutput("https://files.toapis.com/output.png"), PNG);
  await assert.rejects(
    () => provider.downloadOutput("https://evil.example/output.png"),
    (error) => error instanceof ProviderError && error.failure.kind === "INVALID_OUTPUT",
  );
  await assert.rejects(
    () => provider.downloadOutput("http://files.toapis.com/output.png"),
    (error) => error instanceof ProviderError && error.failure.kind === "INVALID_OUTPUT",
  );
  const limitedProvider = new ToapisImageProvider(config({ maximumOutputBytes: 8 }), async () => new Response(PNG, {
    status: 200,
    headers: { "content-length": String(PNG.length) },
  }));
  await assert.rejects(
    () => limitedProvider.downloadOutput("https://files.toapis.com/output.png"),
    (error) => error instanceof ProviderError && error.code === "AI_PROVIDER_OUTPUT_TOO_LARGE",
  );
});

test("ToAPIs rejects a redirect response instead of following it", async () => {
  const provider = new ToapisImageProvider(config(), async () => new Response(null, {
    status: 302,
    headers: { location: "https://evil.example/output.png" },
  }));
  await assert.rejects(
    () => provider.downloadOutput("https://files.toapis.com/output.png"),
    (error) => error instanceof ProviderError && error.failure.kind === "UNKNOWN",
  );
});

test("ToAPIs preserves Retry-After on rate limiting without exposing the key", async () => {
  const provider = new ToapisImageProvider(config(), async () => new Response("{}", {
    status: 429,
    headers: { "retry-after": "3" },
  }));
  await assert.rejects(
    () => provider.getTask("task_123"),
    (error) => error instanceof ProviderError
      && error.failure.kind === "RATE_LIMITED"
      && error.failure.retryAfterMs === 3000
      && !error.message.includes("secret-test-key"),
  );
});
