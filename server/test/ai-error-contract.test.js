const assert = require("node:assert/strict");
const test = require("node:test");
const {
  aiPublicFailure,
  aiPublicHttpStatus,
  AI_INTERNAL_FAILURE_CODES,
} = require("../dist/modules/ai/error-contract.js");

/**
 * 这一组用例锁的是同一条不变式：**AI 链路会写进 error_code 的每一个内部码，
 * 都必须能翻译成带文案的公开失败**。
 *
 * 漏登记不会抛错，只会在 mapJob 里静默兜底成 AI_GENERATION_FAILED ——
 * 用户看到「AI 生成失败，请稍后重试」并被引导去重试，真实原因（额度耗尽、
 * 存储未配置…）在界面上完全消失。AI_PROVIDER_QUOTA_EXHAUSTED 曾经就是这样丢的。
 *
 * 因此下面的清单必须与产生点保持同步：新增 provider 码 / 状态机码时，
 * 要么登记进 INTERNAL_TO_PUBLIC_CODE，要么同步更新这里的清单，让差异显式暴露。
 */

// 来源：hunyuan-image-provider.ts —— providerFailure(...) 显式传入的 code
//      + providerErrorCode(kind) 的默认取值。
const PROVIDER_INTERNAL_CODES = [
  "AI_PROVIDER_ERROR",
  "AI_PROVIDER_TIMEOUT",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_PROVIDER_OUTPUT_INVALID",
  "AI_PROVIDER_OUTPUT_TOO_LARGE",
  "AI_PROVIDER_RATE_LIMITED",
  "AI_PROVIDER_QUOTA_EXHAUSTED",
  "AI_SERVICE_UNAVAILABLE",
];

// 来源：ai-generation-service.ts —— markFailed(...) 的显式码 + failureCode() 的兜底码。
const JOB_INTERNAL_CODES = [
  "AI_SUBMISSION_TIMEOUT",
  "AI_SUBMISSION_UNKNOWN",
  "AI_TASK_EXPIRED",
  "AI_RESULT_EXPIRED",
  "AI_INPUT_FILE_UNAVAILABLE",
  "AI_QUOTA_UNAVAILABLE_AT_COMPLETION",
  "AI_GENERATION_INTERNAL_ERROR",
  "AI_PROVIDER_OUTPUT_INVALID",
];

// 来源：file-asset-service.ts（AI 输入图上传前的存储校验）。
const FILE_INTERNAL_CODES = ["AI_STORAGE_NOT_CONFIGURED"];

function muteUnmappedDiagnostics(callback) {
  const original = console.error;
  console.error = () => {};
  try {
    return callback();
  } finally {
    console.error = original;
  }
}

test("provider / 状态机 / 存储侧的内部码全部能翻译成公开失败", () => {
  const codes = [...PROVIDER_INTERNAL_CODES, ...JOB_INTERNAL_CODES, ...FILE_INTERNAL_CODES];
  for (const code of codes) {
    const failure = aiPublicFailure(code);
    assert.ok(failure, `${code} 未在 INTERNAL_TO_PUBLIC_CODE / FAILURE_DEFINITIONS 登记，会被兜底成 AI_GENERATION_FAILED`);
    assert.equal(typeof failure.message, "string");
    assert.ok(failure.message.length > 0, `${code} 的公开文案为空`);
    assert.ok(failure.code !== "AI_GENERATION_FAILED" || code === "AI_GENERATION_INTERNAL_ERROR",
      `${code} 被翻译成了兜底码 AI_GENERATION_FAILED，等于丢掉真实原因`);
  }
});

test("导出的内部码清单与实际情况一致且每项可翻译", () => {
  assert.ok(AI_INTERNAL_FAILURE_CODES.length > 0);
  assert.equal(new Set(AI_INTERNAL_FAILURE_CODES).size, AI_INTERNAL_FAILURE_CODES.length, "清单里有重复项");
  for (const code of AI_INTERNAL_FAILURE_CODES) {
    assert.ok(aiPublicFailure(code), `${code} 登记了映射却翻译不出公开失败`);
  }
});

test("额度耗尽与存储未配置按「服务端暂时不可用」处理，而不是丢成可重试的生成失败", () => {
  // 这两个码共同的特点是：用户重试同一张图必然失败，需要的是「换路 / 稍后再来」。
  for (const code of ["AI_PROVIDER_QUOTA_EXHAUSTED", "AI_STORAGE_NOT_CONFIGURED"]) {
    const failure = aiPublicFailure(code);
    assert.equal(failure.code, "AI_SERVICE_UNAVAILABLE");
    assert.equal(failure.action, "USE_STANDARD_MODE");
    assert.equal(failure.retryable, false);
  }
});

test("未登记的码保持兜底语义：返回 null 而不是编一个码出来", () => {
  muteUnmappedDiagnostics(() => {
    assert.equal(aiPublicFailure("AI_PROVIDER_TOTALLY_NEW_CODE"), null);
    assert.equal(aiPublicFailure(""), null);
    assert.equal(aiPublicFailure(null), null);
  });
});

test("公开失败都带可用的 HTTP 状态码", () => {
  for (const code of [...PROVIDER_INTERNAL_CODES, ...JOB_INTERNAL_CODES, ...FILE_INTERNAL_CODES]) {
    const status = aiPublicHttpStatus(code, 500);
    assert.ok(Number.isInteger(status) && status >= 400 && status < 600, `${code} 的 HTTP 状态码异常：${status}`);
  }
});
