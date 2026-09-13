const assert = require("node:assert/strict");
const test = require("node:test");
const { ProviderError, QwenImageProvider } = require("../dist/modules/ai/qwen-image-provider.js");

const config = {
  enabled: true,
  apiKey: "test-qwen-api-key",
  baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com",
  model: "qwen-image-3.0",
  timeoutMs: 1000,
  maximumOutputBytes: 1024,
};

test("Qwen provider submits and polls the official async image API without exposing credentials", async () => {
  const requests = [];
  const fetchImplementation = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/image-generation/generation")) {
      return Response.json({ output: { task_status: "PENDING", task_id: "task_123" } });
    }
    if (url.endsWith("/api/v1/tasks/task_123")) {
      return Response.json({
        output: {
          task_status: "SUCCEEDED",
          choices: [{ message: { content: [{ image: "https://result.oss-cn-shanghai.aliyuncs.com/result.png" }] } }],
        },
      });
    }
    return new Response(Buffer.from([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    });
  };
  const provider = new QwenImageProvider(config, fetchImplementation);
  const taskId = await provider.createTask("data:image/png;base64,AA==", "生成精致图片");
  const result = await provider.getTask(taskId);
  const output = await provider.downloadOutput(result.outputUrl);

  assert.equal(taskId, "task_123");
  assert.deepEqual(result, {
    status: "succeeded",
    outputUrl: "https://result.oss-cn-shanghai.aliyuncs.com/result.png",
  });
  assert.deepEqual(output, Buffer.from([1, 2, 3]));
  assert.equal(requests[0].url, `${config.baseUrl}/api/v1/services/aigc/image-generation/generation`);
  assert.equal(requests[0].init.headers["x-dashscope-async"], "enable");
  const requestBody = JSON.parse(requests[0].init.body);
  assert.equal(requestBody.model, "qwen-image-3.0");
  assert.equal(requestBody.input.messages[0].role, "user");
  assert.equal(requestBody.input.messages[0].content.length, 2);
  assert.match(requestBody.input.messages[0].content[0].image, /^data:image\/png;base64,/);
  assert.equal(requestBody.input.messages[0].content[1].text, "生成精致图片");
  assert.equal(requestBody.parameters.n, 1);
  assert.equal(requestBody.parameters.prompt_extend_mode, "direct");
  assert.equal(requestBody.parameters.enable_thinking, true);
  assert.equal(JSON.stringify({ taskId, result }).includes(config.apiKey), false);
});

test("Qwen provider normalizes quota and temporary upstream failures without leaking raw details", async () => {
  const quotaProvider = new QwenImageProvider(config, async () => Response.json({
    code: "AllocationQuota.FreeTierOnly",
    message: "sensitive provider response",
  }, { status: 403 }));
  await assert.rejects(
    () => quotaProvider.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error instanceof ProviderError
      && error.code === "AI_SERVICE_UNAVAILABLE"
      && error.failure.kind === "QUOTA_EXHAUSTED"
      && error.failure.providerCode === "AllocationQuota.FreeTierOnly",
  );

  const busyProvider = new QwenImageProvider(config, async () => new Response(null, { status: 503 }));
  await assert.rejects(
    () => busyProvider.getTask("task_123"),
    (error) => error instanceof ProviderError
      && error.failure.kind === "UNAVAILABLE"
      && error.failure.httpStatus === 503,
  );

  const forbiddenProvider = new QwenImageProvider(config, async () => Response.json({ code: "Forbidden" }, { status: 403 }));
  await assert.rejects(
    () => forbiddenProvider.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error instanceof ProviderError
      && error.code === "AI_SERVICE_UNAVAILABLE"
      && error.failure.kind === "UNAVAILABLE"
      && error.failure.httpStatus === 403,
  );
});

test("Qwen provider maps terminal task statuses to stable provider results", async () => {
  for (const status of ["FAILED", "CANCELED", "UNKNOWN"]) {
    const provider = new QwenImageProvider(config, async () => Response.json({ output: { task_status: status } }));
    const result = await provider.getTask("task_123");
    assert.deepEqual(result, { status: "failed" });
  }
});

test("Qwen provider is safely disabled and rejects untrusted output URLs", async () => {
  const disabled = new QwenImageProvider({ enabled: false });
  await assert.rejects(
    () => disabled.createTask("data:image/png;base64,AA==", "prompt"),
    (error) => error.code === "AI_PROVIDER_NOT_CONFIGURED",
  );

  const provider = new QwenImageProvider(config, async () => {
    throw new Error("network must not be called");
  });
  await assert.rejects(
    () => provider.downloadOutput("https://attacker.example/output.png"),
    (error) => error.code === "AI_PROVIDER_OUTPUT_INVALID",
  );

  await assert.rejects(
    () => provider.downloadOutput("https://result.aliyuncs.com.evil.example/output.png"),
    (error) => error.code === "AI_PROVIDER_OUTPUT_INVALID",
  );
});

test("Qwen output downloads do not follow redirects", async () => {
  let requestInit;
  const provider = new QwenImageProvider(config, async (_url, init) => {
    requestInit = init;
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/output.png" } });
  });

  await assert.rejects(
    () => provider.downloadOutput("https://result.oss-cn-shanghai.aliyuncs.com/result.png"),
    (error) => error.code === "AI_PROVIDER_OUTPUT_INVALID",
  );
  assert.equal(requestInit.redirect, "error");
});

test("Qwen provider rejects output that is not PNG", async () => {
  const provider = new QwenImageProvider(config, async () => new Response(Buffer.from([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "3" },
  }));

  await assert.rejects(
    () => provider.downloadOutput("https://result.oss-cn-shanghai.aliyuncs.com/result.jpg"),
    (error) => error.code === "AI_PROVIDER_OUTPUT_INVALID",
  );
});
