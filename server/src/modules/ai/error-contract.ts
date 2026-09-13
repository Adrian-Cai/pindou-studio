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

export function aiPublicFailure(code: string | null): AiPublicFailure | null {
  if (!code) return null;
  const publicCode = INTERNAL_TO_PUBLIC_CODE[code] ?? code;
  const definition = FAILURE_DEFINITIONS[publicCode];
  if (!definition) return null;
  return {
    code: definition.code,
    message: definition.message,
    category: definition.category,
    retryable: definition.retryable,
    action: definition.action,
  };
}

export function aiPublicHttpStatus(code: string, fallback: number): number {
  const publicCode = INTERNAL_TO_PUBLIC_CODE[code] ?? code;
  return FAILURE_DEFINITIONS[publicCode]?.httpStatus ?? fallback;
}
