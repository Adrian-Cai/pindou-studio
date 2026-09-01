const assert = require("node:assert/strict");
const test = require("node:test");
const { QwenImageProvider } = require("../dist/modules/ai/qwen-image-provider.js");

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
  assert.equal(requestBody.parameters.n, 1);
  assert.equal(JSON.stringify({ taskId, result }).includes(config.apiKey), false);
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
});
