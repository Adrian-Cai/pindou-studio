import { AppError } from "../../shared/app-error";

export type ProviderName = "hunyuan" | "toapis" | "hunyuan-tokenhub-v35";

export type ProviderFailureKind =
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_OUTPUT"
  | "UNKNOWN";

export interface ProviderFailure {
  readonly provider: ProviderName;
  readonly providerCode: string | null;
  readonly httpStatus: number | null;
  readonly kind: ProviderFailureKind;
  readonly retryAfterMs?: number;
}

/** 归一化后的 provider 异常；上层只依赖 failure.kind，不感知具体供应商 SDK。 */
export class ProviderError extends AppError {
  public constructor(
    public readonly failure: ProviderFailure,
    code = providerErrorCode(failure.kind),
    message = "AI 图像服务请求失败",
  ) {
    super(providerErrorStatus(failure.kind), code, message, {
      providerCode: failure.providerCode,
      httpStatus: failure.httpStatus,
      kind: failure.kind,
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    });
    this.name = "ProviderError";
  }
}

export interface ProviderTaskInput {
  /** CloudBase 混元兼容路径使用 data URL；旧 HTTP Provider 使用服务端图片 URL。 */
  readonly imageDataUrl: string | null;
  readonly referenceImageUrl: string | null;
  readonly prompt: string;
  readonly clientBusinessId: string;
}

export interface ProviderTaskSubmission {
  readonly requestId: string;
  readonly outputUrl: string | null;
}

export type ProviderTaskState = "pending" | "queued" | "in_progress" | "completed" | "failed";

export interface ProviderTaskStatus {
  readonly status: ProviderTaskState;
  readonly outputUrl: string | null;
}

export interface AiGenerationProvider {
  readonly configured: boolean;
  readonly name: ProviderName;
  readonly model: string;
  readonly pollIntervalMs?: number;
  createTask(input: ProviderTaskInput): Promise<ProviderTaskSubmission>;
  getTask?(requestId: string): Promise<ProviderTaskStatus>;
  downloadOutput(outputUrl: string): Promise<Buffer>;
}

export type ProviderOutputFormat = "png" | "jpeg" | "webp" | "empty" | "unknown";
export type SupportedOutputFormat = "png" | "jpeg" | "webp";

export function isSupportedOutputFormat(value: ProviderOutputFormat): value is SupportedOutputFormat {
  return value === "png" || value === "jpeg" || value === "webp";
}

export function detectOutputFormat(value: Buffer): ProviderOutputFormat {
  if (value.length === 0) return "empty";
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (value.subarray(0, png.length).equals(png)) return "png";
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return "jpeg";
  if (
    value.length >= 12
    && value.subarray(0, 4).toString("ascii") === "RIFF"
    && value.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "webp";
  return "unknown";
}

export function providerFailure(
  provider: ProviderName,
  kind: ProviderFailureKind = "UNKNOWN",
  providerCode: string | null = null,
  httpStatus: number | null = null,
  code = providerErrorCode(kind),
  message = "AI 图像服务请求失败",
  retryAfterMs?: number,
): ProviderError {
  return new ProviderError({
    provider,
    providerCode,
    httpStatus,
    kind,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }, code, message);
}

export function providerErrorCode(kind: ProviderFailureKind): string {
  if (kind === "TIMEOUT") return "AI_PROVIDER_TIMEOUT";
  if (kind === "UNAVAILABLE") return "AI_PROVIDER_UNAVAILABLE";
  if (kind === "INVALID_OUTPUT") return "AI_PROVIDER_OUTPUT_INVALID";
  if (kind === "RATE_LIMITED") return "AI_PROVIDER_RATE_LIMITED";
  return "AI_PROVIDER_ERROR";
}

function providerErrorStatus(kind: ProviderFailureKind): number {
  if (kind === "TIMEOUT") return 504;
  if (kind === "UNAVAILABLE" || kind === "QUOTA_EXHAUSTED" || kind === "RATE_LIMITED") return 503;
  return 502;
}
