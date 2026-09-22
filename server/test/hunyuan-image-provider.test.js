const assert = require("node:assert/strict");
const test = require("node:test");
const { HunyuanImageProvider, ProviderError } = require("../dist/modules/ai/hunyuan-image-provider.js");

const config = {
  enabled: true,
  apiKey: "test-hunyuan-api-key",
  baseUrl: "https://cloud1-test.api.tcloudbasegateway.com/v1/ai/cloudbase",
  model: "HY-Image-v3.0-I2I-ToB-v1.0.1",
  timeoutMs: 1000,
  maximumOutputBytes: 1024,
};

test("Hunyuan provider submits the CloudBase SDK reference-image request and downloads its PNG output", async () => {
  const requests = [];
  const sdkRequests = [];
  const imageModel = {
    generateImage: async (input) => {
      sdkRequests.push(input);
      return {
        id: "4-WandImage-test",
        request_id: "request_hy_123",
        data: [{ url: "https://cloud1-test.api.tcloudbasegateway.com/v1/ai/cloudbase/result.png" }],
      };
    },
  };
  const fetchImplementation = async (url, init) => {
    requests.push({ url, init });
    return new Response(Buffer.from([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    });
  };
  const provider = new HunyuanImageProvider(config, fetchImplementation, imageModel);
  const submission = await provider.createTask("data:image/png;base64,AA==", "生成精致图片");
  const output = await provider.downloadOutput(submission.outputUrl);

  assert.deepEqual(submission, {
    requestId: "request_hy_123",
    outputUrl: "https://cloud1-test.api.tcloudbasegateway.com/v1/ai/cloudbase/result.png",
  });
  assert.deepEqual(output, Buffer.from([1, 2, 3]));
  assert.equal(requests.length, 1);
  assert.deepEqual(sdkRequests, [{
    model: "HY-Image-v3.0-I2I-ToB-v1.0.1",
    prompt: "生成精致图片",
    images: ["data:image/png;base64,AA=="],
    size: "1024x1024",
    revise: { value: false },
  }]);
  assert.equal(JSON.stringify({ submission, sdkRequests }).includes(config.apiKey), false);
});

test("Hunyuan provider accepts the wx-server-sdk cloud function file result", async () => {
  const imageModel = {
    generateImage: async () => ({
      request_id: "request_cloud_function_123",
      fileID: "cloud://env/ai-images/result.png",
      data: [],
    }),
    downloadFile: async (fileId) => {
      assert.equal(fileId, "cloud://env/ai-images/result.png");
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    },
  };
  const provider = new HunyuanImageProvider(config, fetch, imageModel);
  const submission = await provider.createTask("data:image/png;base64,AA==", "生成精致图片");
  const output = await provider.downloadOutput(submission.outputUrl);

  assert.equal(submission.requestId, "request_cloud_function_123");
  assert.equal(submission.outputUrl, "cloud-file:cloud://env/ai-images/result.png");
  assert.equal(output.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("Hunyuan provider accepts JPEG output even when the cloud function labels it PNG", async () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66]),
    Buffer.alloc(512, 0x11),
    Buffer.from([0xff, 0xd9]),
  ]);
  const imageModel = {
    generateImage: async () => ({
      request_id: "request_jpeg_123",
      fileID: "cloud://env/ai-images/result.png",
      contentType: "image/png",
      data: [],
    }),
    downloadFile: async () => jpeg,
  };
  const provider = new HunyuanImageProvider(config, fetch, imageModel);
  const submission = await provider.createTask("data:image/png;base64,AA==", "生成精致图片");
  const output = await provider.downloadOutput(submission.outputUrl);

  assert.equal(submission.outputUrl, "cloud-file:cloud://env/ai-images/result.png");
  assert.equal(output.length, jpeg.length);
  assert.equal(output.subarray(0, 3).toString("hex"), "ffd8ff");
});

test("Hunyuan provider normalizes quota, auth and temporary upstream failures", async () => {
  const busyProvider = new HunyuanImageProvider(config, fetch, {
    generateImage: async () => { throw Object.assign(new Error("upstream busy"), { statusCode: 503 }); },
  });
  await assert.rejects(
    () => busyProvider.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error instanceof ProviderError
      && error.failure.kind === "UNAVAILABLE"
      && error.failure.httpStatus === 503,
  );

  const forbiddenProvider = new HunyuanImageProvider(config, fetch, {
    generateImage: async () => { throw Object.assign(new Error("Unauthorized"), { code: "Unauthorized", statusCode: 401 }); },
  });
  await assert.rejects(
    () => forbiddenProvider.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error instanceof ProviderError
      && error.code === "AI_SERVICE_UNAVAILABLE"
      && error.failure.kind === "UNAVAILABLE"
      && error.failure.httpStatus === 401,
  );

  const rateLimitedProvider = new HunyuanImageProvider(config, fetch, {
    generateImage: async () => { throw Object.assign(new Error("rate limited"), { code: "RATE_LIMITED", statusCode: 429 }); },
  });
  await assert.rejects(
    () => rateLimitedProvider.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error instanceof ProviderError
      && error.failure.kind === "RATE_LIMITED",
  );

  const tokenQuotaProvider = new HunyuanImageProvider(config, fetch, {
    generateImage: async () => { throw Object.assign(new Error("Request failed with status code 429"), { code: "429" }); },
  });
  await assert.rejects(
    () => tokenQuotaProvider.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error instanceof ProviderError
      && error.failure.kind === "QUOTA_EXHAUSTED",
  );

  const quotaProvider = new HunyuanImageProvider(config, fetch, {
    generateImage: async () => {
      throw Object.assign(new Error("EXCEED_TOKEN_QUOTA_LIMIT"), {
        code: "EXCEED_TOKEN_QUOTA_LIMIT",
        statusCode: 429,
      });
    },
  });
  await assert.rejects(
    () => quotaProvider.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error instanceof ProviderError
      && error.failure.kind === "QUOTA_EXHAUSTED"
      && error.failure.providerCode === "EXCEED_TOKEN_QUOTA_LIMIT",
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
