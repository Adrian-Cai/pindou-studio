/** AI 任务的数据投影、响应映射与诊断；由任务服务和持久化函数复用。 */
import type { QueryResultRow } from "pg";
import { AppError } from "../../shared/app-error";
import { toIso } from "../../shared/date-time";
import { ProviderError, type SupportedOutputFormat } from "./provider";
import { aiPublicFailure, type AiPublicFailure } from "./error-contract";

export const ACTIVE_STATUSES = ["queued", "processing"] as const;

export type AiGenerationStatus = "queued" | "processing" | "succeeded" | "failed" | "canceled";
export type AiGenerationStyle = "kawaii" | "natural" | "cartoon" | "minimal";
export type AiGenerationDetailLevel = "low" | "medium" | "high";
export type AiGenerationBackgroundMode = "keep" | "simplify" | "remove";

export interface CreateAiGenerationInput {
  readonly userId: string;
  readonly requestId?: string;
  readonly idempotencyKey: string;
  readonly inputFileId: string;
  readonly style: AiGenerationStyle;
  readonly detailLevel: AiGenerationDetailLevel;
  readonly backgroundMode: AiGenerationBackgroundMode;
}

export interface AiGenerationResponse {
  readonly id: string;
  readonly generationMode: "ai";
  readonly status: AiGenerationStatus;
  readonly inputFileId: string;
  readonly outputFile: {
    readonly id: string;
    readonly url: string;
    readonly contentType: string;
    readonly size: number;
  } | null;
  readonly style: AiGenerationStyle;
  readonly detailLevel: AiGenerationDetailLevel;
  readonly backgroundMode: AiGenerationBackgroundMode;
  readonly failure: AiPublicFailure | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface AiJobRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly input_file_id: string;
  readonly input_object_key: string | null;
  readonly input_content_type: string | null;
  readonly output_file_id: string | null;
  readonly output_public_url: string | null;
  readonly output_content_type: string | null;
  readonly output_byte_size: string | number | null;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly prompt_version: string;
  readonly style: string;
  readonly detail_level: string;
  readonly background_mode: string;
  readonly generation_mode?: string;
  readonly provider_request_id: string | null;
  readonly provider_output_url: string | null;
  readonly provider_next_poll_at: Date | string | null;
  readonly idempotency_key: string;
  readonly error_code: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly started_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly expires_at: Date | string;
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function mapJob(row: AiJobRow): AiGenerationResponse {
  if (
    !ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number])
    && row.status !== "succeeded"
    && row.status !== "failed"
    && row.status !== "canceled"
  ) throw new Error("数据库 AI 任务状态无效");
  if (row.style !== "kawaii" && row.style !== "natural" && row.style !== "cartoon" && row.style !== "minimal") {
    throw new Error("数据库 AI 任务风格无效");
  }
  if (row.detail_level !== "low" && row.detail_level !== "medium" && row.detail_level !== "high") {
    throw new Error("数据库 AI 任务细节等级无效");
  }
  if (row.background_mode !== "keep" && row.background_mode !== "simplify" && row.background_mode !== "remove") {
    throw new Error("数据库 AI 任务背景模式无效");
  }
  if (row.generation_mode !== undefined && row.generation_mode !== "ai") {
    throw new Error("数据库 AI 任务生成模式无效");
  }
  const hasOutput = row.output_file_id && row.output_public_url && row.output_content_type
    && row.output_byte_size !== null;
  if (row.status === "succeeded" && !hasOutput) throw new Error("成功 AI 任务缺少输出文件");
  const failure = row.status === "failed" || row.status === "canceled"
    ? (aiPublicFailure(row.error_code) ?? aiPublicFailure("AI_GENERATION_FAILED"))
    : null;
  return {
    id: row.id,
    generationMode: "ai",
    status: row.status as AiGenerationStatus,
    inputFileId: row.input_file_id,
    outputFile: hasOutput ? {
      id: row.output_file_id!,
      url: row.output_public_url!,
      contentType: row.output_content_type!,
      size: Number(row.output_byte_size),
    } : null,
    style: row.style,
    detailLevel: row.detail_level,
    backgroundMode: row.background_mode,
    failure,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: nullableIso(row.completed_at),
  };
}

/** 从异常取内部错误码；是 AppError 取其 code（截断 80 字符），否则兜底内部错误码。 */
export function failureCode(error: unknown): string {
  if (error instanceof AppError) return error.code.slice(0, 80);
  return "AI_GENERATION_INTERNAL_ERROR";
}

/** 按真实检测到的产物格式决定落库文件名与 contentType（jpg/jpeg、webp、默认 png）。 */
export function outputFileName(
  format: SupportedOutputFormat,
): { readonly filename: string; readonly contentType: string } {
  if (format === "jpeg") return { filename: "output.jpg", contentType: "image/jpeg" };
  if (format === "webp") return { filename: "output.webp", contentType: "image/webp" };
  return { filename: "output.png", contentType: "image/png" };
}

export const JOB_SELECT = `SELECT jobs.id, jobs.user_id, jobs.input_file_id,
       input_file.object_key AS input_object_key,
       input_file.content_type AS input_content_type,
       jobs.output_file_id, output_file.public_url AS output_public_url,
       output_file.content_type AS output_content_type,
       output_file.byte_size AS output_byte_size,
       jobs.provider, jobs.model, jobs.status, jobs.prompt_version,
       jobs.style, jobs.detail_level, jobs.background_mode, jobs.generation_mode,
       jobs.provider_request_id, jobs.provider_output_url, jobs.provider_next_poll_at,
       jobs.idempotency_key, jobs.error_code,
       jobs.created_at, jobs.updated_at, jobs.started_at, jobs.completed_at, jobs.expires_at
  FROM pindou_ai_generation_jobs jobs
  JOIN pindou_file_assets input_file ON input_file.id = jobs.input_file_id
  LEFT JOIN pindou_file_assets output_file ON output_file.id = jobs.output_file_id`;


export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

export function isTransientProviderError(error: unknown): boolean {
  if (isProviderError(error)) {
    return error.failure.kind === "RATE_LIMITED"
      || error.failure.kind === "TIMEOUT"
      || (error.failure.kind === "UNAVAILABLE"
        && error.failure.httpStatus !== 401
        && error.failure.httpStatus !== 403
        && error.code !== "AI_SERVICE_UNAVAILABLE");
  }
  if (error instanceof AppError) {
    return error.code === "AI_PROVIDER_RATE_LIMITED"
      || error.code === "AI_PROVIDER_TIMEOUT"
      || error.code === "AI_PROVIDER_UNAVAILABLE";
  }
  return false;
}

/** 把 ProviderError 的失败种类翻译成对外公开的错误码（配额/超时/繁忙/失败等）。 */
export function providerPublicCode(error: ProviderError): string {
  if (error.code === "CONTENT_REJECTED") return "CONTENT_REJECTED";
  if (error.failure.kind === "QUOTA_EXHAUSTED") return "AI_SERVICE_UNAVAILABLE";
  if (error.failure.kind === "TIMEOUT") return "AI_TIMEOUT";
  if (error.failure.kind === "INVALID_OUTPUT") return "AI_RESULT_INVALID";
  if (error.failure.kind === "UNAVAILABLE"
    && (error.failure.httpStatus === 401 || error.failure.httpStatus === 403
      || error.code === "AI_SERVICE_UNAVAILABLE")) return "AI_SERVICE_UNAVAILABLE";
  if (error.failure.kind === "RATE_LIMITED" || error.failure.kind === "UNAVAILABLE") {
    return "AI_SERVICE_BUSY";
  }
  return "AI_GENERATION_FAILED";
}

export function logProviderFailure(
  job: AiJobRow,
  error: ProviderError | null,
  requestId: string | undefined,
  stage: "submit" | "poll" | "download",
  publicCode: string,
  duration: number,
  outputHostValue?: string | null,
): void {
  console.error(JSON.stringify({
    event: "ai_provider_failure",
    requestId: requestId ?? null,
    jobId: job.id,
    provider: job.provider,
    model: job.model,
    stage,
    promptVersion: job.prompt_version,
    publicErrorCode: aiPublicFailure(publicCode)?.code ?? "AI_GENERATION_FAILED",
    internalProviderCode: error?.failure.providerCode ?? null,
    providerFailureKind: error?.failure.kind ?? null,
    httpStatus: error?.failure.httpStatus ?? null,
    message: error?.message ? error.message.slice(0, 240) : null,
    ...(outputHostValue ? { outputHost: outputHostValue } : {}),
    duration,
  }));
}

export function outputHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
