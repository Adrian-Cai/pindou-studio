/**
 * AI 生成链路的公开错误码契约。
 *
 * 职责：把内部错误码（如 AI_PROVIDER_TIMEOUT）统一翻译成面向小程序前端的
 *       安全错误（code/message/category/retryable/action），并附带 HTTP 状态码；
 *       不暴露内部 provider 细节，不抛错误，不做任何业务逻辑。
 * 调用方：ai-generation-service.ts（mapJob 输出 failure、按 http 状态回包）。
 * 关键点：内部码漏登记会静默兜底成 AI_GENERATION_FAILED，用户侧只剩一句笼统文案，
 *       所以未命中映射表时补一条 ai_failure_code_unmapped 日志，并导出
 *       AI_INTERNAL_FAILURE_CODES 供测试守卫「新码必须登记」这条不变式。
 */

/** 错误归属分类：决定前端如何提示（用户额度 / 输入 / 内容审核 / provider / 内部）。 */
export type AiErrorCategory = "USER" | "INPUT" | "CONTENT" | "PROVIDER" | "INTERNAL";
export type AiErrorAction = "VIEW_BENEFITS" | "SELECT_IMAGE" | "USE_STANDARD_MODE" | "RETRY";

export interface AiPublicFailure {
  readonly code: string;
  readonly message: string;
  readonly category: AiErrorCategory;
  readonly retryable: boolean;
  readonly action: AiErrorAction;
}

interface AiFailureDefinition extends AiPublicFailure {
  readonly httpStatus: number;
}

const FAILURE_DEFINITIONS: Record<string, AiFailureDefinition> = {
  USER_AI_QUOTA_EXHAUSTED: {
    code: "USER_AI_QUOTA_EXHAUSTED",
    message: "AI 生成次数已用完",
    category: "USER",
    retryable: false,
    action: "VIEW_BENEFITS",
    httpStatus: 402,
  },
  INVALID_IMAGE: {
    code: "INVALID_IMAGE",
    message: "当前图片暂不支持生成",
    category: "INPUT",
    retryable: false,
    action: "SELECT_IMAGE",
    httpStatus: 400,
  },
  AI_INPUT_FILE_UNAVAILABLE: {
    code: "AI_INPUT_FILE_UNAVAILABLE",
    message: "输入图片已失效，请重新选择图片",
    category: "INPUT",
    retryable: false,
    action: "SELECT_IMAGE",
    httpStatus: 400,
  },
  CONTENT_REJECTED: {
    code: "CONTENT_REJECTED",
    message: "当前图片内容不支持生成",
    category: "CONTENT",
    retryable: false,
    action: "SELECT_IMAGE",
    httpStatus: 400,
  },
  AI_SERVICE_UNAVAILABLE: {
    code: "AI_SERVICE_UNAVAILABLE",
    message: "AI 生成暂时不可用",
    category: "PROVIDER",
    retryable: false,
    action: "USE_STANDARD_MODE",
    httpStatus: 503,
  },
  AI_SERVICE_BUSY: {
    code: "AI_SERVICE_BUSY",
    message: "AI 生成服务繁忙，请稍后重试",
    category: "PROVIDER",
    retryable: true,
    action: "RETRY",
    httpStatus: 503,
  },
  AI_TIMEOUT: {
    code: "AI_TIMEOUT",
    message: "AI 生成超时，请稍后重试",
    category: "PROVIDER",
    retryable: true,
    action: "RETRY",
    httpStatus: 504,
  },
  AI_RESULT_INVALID: {
    code: "AI_RESULT_INVALID",
    message: "AI 生成结果不可用，请重新生成",
    category: "PROVIDER",
    retryable: true,
    action: "RETRY",
    httpStatus: 502,
  },
  AI_GENERATION_FAILED: {
    code: "AI_GENERATION_FAILED",
    message: "AI 生成失败，请稍后重试",
    category: "INTERNAL",
    retryable: true,
    action: "RETRY",
    httpStatus: 500,
  },
};

const INTERNAL_TO_PUBLIC_CODE: Record<string, string> = {
  AI_PROVIDER_NOT_CONFIGURED: "AI_SERVICE_UNAVAILABLE",
  AI_SUBMISSION_UNKNOWN: "AI_SERVICE_UNAVAILABLE",
  AI_PROVIDER_UNAVAILABLE: "AI_SERVICE_BUSY",
  AI_PROVIDER_ERROR: "AI_SERVICE_BUSY",
  AI_PROVIDER_RATE_LIMITED: "AI_SERVICE_BUSY",
  // provider 侧额度（含 429）耗尽：重试必然再失败，属于「换条路走」而不是「稍后再试」，
  // 与 AI_SERVICE_UNAVAILABLE 的语义一致（503 + 用标准模式）。
  // 缺这一条时 mapJob 会兜底成 AI_GENERATION_FAILED，用户看到「AI 生成失败，请稍后重试」
  // 并被引导着重试——真实原因（额度耗尽）在界面上完全消失。
  AI_PROVIDER_QUOTA_EXHAUSTED: "AI_SERVICE_UNAVAILABLE",
  // AI 文件存储未配置（AI_FILE_STORAGE_DIR / 持久卷未就绪）：同样是运维侧不可用，不是用户重试能解的。
  AI_STORAGE_NOT_CONFIGURED: "AI_SERVICE_UNAVAILABLE",
  AI_PROVIDER_TIMEOUT: "AI_TIMEOUT",
  AI_SUBMISSION_TIMEOUT: "AI_SERVICE_UNAVAILABLE",
  AI_TASK_EXPIRED: "AI_TIMEOUT",
  AI_RESULT_EXPIRED: "AI_TIMEOUT",
  AI_PROVIDER_OUTPUT_INVALID: "AI_RESULT_INVALID",
  AI_PROVIDER_OUTPUT_TOO_LARGE: "AI_RESULT_INVALID",
  AI_OUTPUT_INVALID: "AI_RESULT_INVALID",
  AI_PROVIDER_TASK_FAILED: "AI_GENERATION_FAILED",
  AI_GENERATION_INTERNAL_ERROR: "AI_GENERATION_FAILED",
  AI_QUOTA_UNAVAILABLE_AT_COMPLETION: "USER_AI_QUOTA_EXHAUSTED",
  UNSUPPORTED_IMAGE: "INVALID_IMAGE",
  IMAGE_DECODE_ERROR: "INVALID_IMAGE",
  AI_IMAGE_DIMENSIONS_TOO_LARGE: "INVALID_IMAGE",
  PAYLOAD_TOO_LARGE: "INVALID_IMAGE",
};

/**
 * 已登记的内部错误码清单。
 *
 * 存在的意义是给测试一条可断言的不变式：**provider / 存储 / 状态机新产生的内部码
 * 必须同时在 INTERNAL_TO_PUBLIC_CODE 登记**。漏登记不会抛错，只会在 mapJob 里静默兜底成
 * AI_GENERATION_FAILED —— 用户看到「AI 生成失败，请稍后重试」，真实原因整条丢掉，
 * 这正是 AI_PROVIDER_QUOTA_EXHAUSTED 曾经踩过的坑。
 */
export const AI_INTERNAL_FAILURE_CODES: readonly string[] = Object.freeze(
  Object.keys(INTERNAL_TO_PUBLIC_CODE),
);

export function aiPublicFailure(code: string | null): AiPublicFailure | null {
  if (!code) return null;
  const publicCode = INTERNAL_TO_PUBLIC_CODE[code] ?? code;
  const definition = FAILURE_DEFINITIONS[publicCode];
  if (!definition) {
    // 兜底成 AI_GENERATION_FAILED 之前先留痕：没有这条日志时，线上只能看到
    // `ai_generation_failed errorCode=AI_GENERATION_FAILED`，无法区分「真·内部错误」
    // 与「新码漏登记」。日志只带码，不带 provider 细节。
    console.error(JSON.stringify({ event: "ai_failure_code_unmapped", code, publicCode }));
    return null;
  }
  return {
    code: definition.code,
    message: definition.message,
    category: definition.category,
    retryable: definition.retryable,
    action: definition.action,
  };
}

/**
 * 取某内部错误码对应的 HTTP 状态码。
 * @param code 内部错误码。
 * @param fallback 查不到定义时使用的兜底状态码。
 */
export function aiPublicHttpStatus(code: string, fallback: number): number {
  const publicCode = INTERNAL_TO_PUBLIC_CODE[code] ?? code;
  return FAILURE_DEFINITIONS[publicCode]?.httpStatus ?? fallback;
}
