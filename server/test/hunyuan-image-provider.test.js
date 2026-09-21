const assert = require("node:assert/strict");
const test = require("node:test");
const { HunyuanImageProvider, ProviderError } = require("../dist/modules/ai/hunyuan-image-provider.js");

const config = {
  enabled: true,
  apiKey: "test-hunyuan-api-key",
  baseUrl: "https://tokenhub.tencentmaas.com",
  model: "hy-image-v3",
  timeoutMs: 1000,
  maximumOutputBytes: 1024,
};

test("Hunyuan provider submits the TokenHub reference-image request and downloads its PNG output", async () => {
  const requests = [];
  const fetchImplementation = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/v1/wand/hunyuan-image/v3-generation")) {
      return Response.json({
        id: "4-WandImage-test",
        request_id: "request_hy_123",
        data: [{ url: "https://aigc-image.cos.myqcloud.com/result.png" }],
      });
    }
    return new Response(Buffer.from([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    });
  };
  const provider = new HunyuanImageProvider(config, fetchImplementation);
  const submission = await provider.createTask("data:image/png;base64,AA==", "生成精致图片");
  const output = await provider.downloadOutput(submission.outputUrl);

  assert.deepEqual(submission, {
    requestId: "request_hy_123",
    outputUrl: "https://aigc-image.cos.myqcloud.com/result.png",
  });
  assert.deepEqual(output, Buffer.from([1, 2, 3]));
  assert.equal(requests[0].url, `${config.baseUrl}/v1/wand/hunyuan-image/v3-generation`);
  assert.equal(requests[0].init.headers.authorization, `Bearer ${config.apiKey}`);
  const requestBody = JSON.parse(requests[0].init.body);
  assert.equal(requestBody.model, "hy-image-v3");
  assert.equal(requestBody.prompt, "生成精致图片");
  assert.deepEqual(requestBody.images, ["data:image/png;base64,AA=="]);
  assert.equal(requestBody.size, "1024x1024");
  assert.equal(requestBody.revise, false);
  assert.equal(JSON.stringify({ submission }).includes(config.apiKey), false);
});

test("Hunyuan provider normalizes quota, auth and temporary upstream failures", async () => {
  const busyProvider = new HunyuanImageProvider(config, async () => new Response(null, { status: 503 }));
  await assert.rejects(
    () => busyProvider.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error instanceof ProviderError
      && error.failure.kind === "UNAVAILABLE"
      && error.failure.httpStatus === 503,
  );

  const forbiddenProvider = new HunyuanImageProvider(config, async () => Response.json({ code: "Unauthorized" }, { status: 401 }));
  await assert.rejects(
    () => forbiddenProvider.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error instanceof ProviderError
      && error.code === "AI_SERVICE_UNAVAILABLE"
      && error.failure.kind === "UNAVAILABLE"
      && error.failure.httpStatus === 401,
  );

  const rateLimitedProvider = new HunyuanImageProvider(config, async () => new Response(null, { status: 429 }));
  await assert.rejects(
    () => rateLimitedProvider.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error instanceof ProviderError
      && error.failure.kind === "RATE_LIMITED",
  );
});

test("Hunyuan provider is safely disabled and rejects untrusted output URLs", async () => {
  const disabled = new HunyuanImageProvider({ enabled: false });
  await assert.rejects(
    () => disabled.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error.code === "AI_PROVIDER_NOT_CONFIGURED",
  );

  const provider = new HunyuanImageProvider(config, async () => {
    throw new Error("network must not be called");
  });
  await assert.rejects(
    () => provider.downloadOutput("https://attacker.example/output.png"),
    (error) => error.code === "AI_PROVIDER_OUTPUT_INVALID",
  );

  await assert.rejects(
    () => provider.downloadOutput("https://myqcloud.com.evil.example/output.png"),
    (error) => error.code === "AI_PROVIDER_OUTPUT_INVALID",
  );
});

test("Hunyuan output downloads do not follow redirects or accept non-PNG output", async () => {
  let requestInit;
  const redirectProvider = new HunyuanImageProvider(config, async (_url, init) => {
    requestInit = init;
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/output.png" } });
  });

  await assert.rejects(
    () => redirectProvider.downloadOutput("https://aigc-image.cos.myqcloud.com/result.png"),
    (error) => error.code === "AI_PROVIDER_OUTPUT_INVALID",
  );
  assert.equal(requestInit.redirect, "error");

  const jpegProvider = new HunyuanImageProvider(config, async () => new Response(Buffer.from([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "3" },
  }));
  await assert.rejects(
    () => jpegProvider.downloadOutput("https://aigc-image.cos.myqcloud.com/result.jpg"),
    (error) => error.code === "AI_PROVIDER_OUTPUT_INVALID",
  );
});
