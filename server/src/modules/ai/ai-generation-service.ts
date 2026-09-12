import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { ServerConfig } from "../../config/env";
import { AppError, idempotencyConflict, notFound, quotaInsufficient } from "../../shared/app-error";
import { toIso } from "../../shared/date-time";
import { createEntityId } from "../../shared/identity";
import { shanghaiDate } from "../../shared/shanghai-time";
import { rollbackTransaction } from "../../shared/transaction";
import type { AiFileStorage, StoredAiFile } from "../files/ai-file-storage";
import {
  availableQuota,
  debitBucket,
  ensureDailyGrant,
  lockQuotaUser,
  readQuota,
} from "../quota/quota-ledger";
import type { AiGenerationProvider } from "./qwen-image-provider";
import { AI_PROMPT_VERSION, buildAiPrompt } from "./prompt-template";

export type AiGenerationStatus = "queued" | "processing" | "succeeded" | "failed" | "canceled";
export type AiGenerationStyle = "natural" | "cartoon" | "minimal";
export type AiGenerationDetailLevel = "low" | "medium" | "high";
export type AiGenerationBackgroundMode = "keep" | "simplify" | "remove";

export interface CreateAiGenerationInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly inputFileId: string;
  readonly style: AiGenerationStyle;
  readonly detailLevel: AiGenerationDetailLevel;
  readonly backgroundMode: AiGenerationBackgroundMode;
}

export interface AiGenerationResponse {
  readonly id: string;
  readonly status: AiGenerationStatus;
  readonly inputFileId: string;
  readonly outputFile: {
    readonly id: string;
    readonly url: string;
    readonly contentType: string;
    readonly size: number;
  } | null;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly style: AiGenerationStyle;
  readonly detailLevel: AiGenerationDetailLevel;
  readonly backgroundMode: AiGenerationBackgroundMode;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface AiJobRow extends QueryResultRow {
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
  readonly provider_request_id: string | null;
  readonly idempotency_key: string;
  readonly error_code: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly started_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly expires_at: Date | string;
}

interface FileRow extends QueryResultRow {
  readonly user_id: string;
  readonly file_type: string;
  readonly object_key: string;
  readonly content_type: string;
  readonly deleted_at: Date | string | null;
}

const ACTIVE_STATUSES = ["queued", "processing"] as const;
const PROVIDER_SUBMISSION_TIMEOUT_MS = 2 * 60 * 1_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PUBLIC_FAILURE_CODES = new Set([
  "AI_GENERATION_INTERNAL_ERROR",
  "AI_INPUT_FILE_UNAVAILABLE",
  "AI_SUBMISSION_TIMEOUT",
  "AI_TASK_EXPIRED",
  "AI_RESULT_EXPIRED",
  "AI_PROVIDER_TASK_FAILED",
  "AI_PROVIDER_ERROR",
  "AI_PROVIDER_TIMEOUT",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_PROVIDER_OUTPUT_INVALID",
  "AI_PROVIDER_OUTPUT_TOO_LARGE",
  "AI_QUOTA_UNAVAILABLE_AT_COMPLETION",
]);

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapJob(row: AiJobRow): AiGenerationResponse {
  if (
    !ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number])
    && row.status !== "succeeded"
    && row.status !== "failed"
    && row.status !== "canceled"
  ) throw new Error("数据库 AI 任务状态无效");
  if (row.style !== "natural" && row.style !== "cartoon" && row.style !== "minimal") {
    throw new Error("数据库 AI 任务风格无效");
  }
  if (row.detail_level !== "low" && row.detail_level !== "medium" && row.detail_level !== "high") {
    throw new Error("数据库 AI 任务细节等级无效");
  }
  if (row.background_mode !== "keep" && row.background_mode !== "simplify" && row.background_mode !== "remove") {
    throw new Error("数据库 AI 任务背景模式无效");
  }
  const hasOutput = row.output_file_id && row.output_public_url && row.output_content_type
    && row.output_byte_size !== null;
  if (row.status === "succeeded" && !hasOutput) throw new Error("成功 AI 任务缺少输出文件");
  return {
    id: row.id,
    status: row.status as AiGenerationStatus,
    inputFileId: row.input_file_id,
    outputFile: hasOutput ? {
      id: row.output_file_id!,
      url: row.output_public_url!,
      contentType: row.output_content_type!,
      size: Number(row.output_byte_size),
    } : null,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    style: row.style,
    detailLevel: row.detail_level,
    backgroundMode: row.background_mode,
    errorCode: publicFailureCode(row.error_code),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: nullableIso(row.completed_at),
  };
}

function failureCode(error: unknown): string {
  if (error instanceof AppError) return error.code.slice(0, 80);
  return "AI_GENERATION_INTERNAL_ERROR";
}

const JOB_SELECT = `SELECT jobs.id, jobs.user_id, jobs.input_file_id,
       input_file.object_key AS input_object_key,
       input_file.content_type AS input_content_type,
       jobs.output_file_id, output_file.public_url AS output_public_url,
       output_file.content_type AS output_content_type,
       output_file.byte_size AS output_byte_size,
       jobs.provider, jobs.model, jobs.status, jobs.prompt_version,
       jobs.style, jobs.detail_level, jobs.background_mode,
       jobs.provider_request_id, jobs.idempotency_key, jobs.error_code,
       jobs.created_at, jobs.updated_at, jobs.started_at, jobs.completed_at, jobs.expires_at
  FROM pindou_ai_generation_jobs jobs
  JOIN pindou_file_assets input_file ON input_file.id = jobs.input_file_id
  LEFT JOIN pindou_file_assets output_file ON output_file.id = jobs.output_file_id`;

export class PostgresAiGenerationService {
  public constructor(
    private readonly pool: Pool,
    private readonly provider: AiGenerationProvider,
    private readonly storage: AiFileStorage,
    private readonly quotaConfig: ServerConfig["quota"],
    private readonly now: () => Date = () => new Date(),
    private readonly retentionMs = DEFAULT_RETENTION_MS,
  ) {}

  public async create(input: CreateAiGenerationInput): Promise<AiGenerationResponse> {
    if (!this.provider.configured) {
      throw new AppError(503, "AI_PROVIDER_NOT_CONFIGURED", "AI 图像服务尚未完成配置");
    }
    const currentTime = this.now();
    const client = await this.pool.connect();
    let job: AiJobRow;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `pindou-ai:${input.userId}:${input.idempotencyKey}`,
      ]);
      await lockQuotaUser(client, input.userId);
      const existingResult = await client.query<AiJobRow>(
        `${JOB_SELECT}
          WHERE jobs.user_id = $1 AND jobs.idempotency_key = $2
          LIMIT 1`,
        [input.userId, input.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (
          existing.input_file_id !== input.inputFileId
          || existing.style !== input.style
          || existing.detail_level !== input.detailLevel
          || existing.background_mode !== input.backgroundMode
        ) throw idempotencyConflict("AI 生成幂等键已用于另一份请求");
        job = existing;
      } else {
        const fileResult = await client.query<FileRow>(
          `SELECT user_id, file_type, object_key, content_type, deleted_at
             FROM pindou_file_assets
            WHERE id = $1
            LIMIT 1
            FOR SHARE`,
          [input.inputFileId],
        );
        const file = fileResult.rows[0];
        if (!file || file.deleted_at || file.file_type !== "ai_input" || file.user_id !== input.userId) {
          throw notFound("AI 输入文件不存在");
        }
        const quotaDate = shanghaiDate(currentTime);
        await ensureDailyGrant(
          client,
          input.userId,
          "ai_generation",
          quotaDate,
          this.quotaConfig.dailyAiGenerations,
          currentTime,
        );
        const quota = await readQuota(client, input.userId, "ai_generation", quotaDate);
        const activeResult = await client.query<{ readonly active_count: string }>(
          `SELECT COUNT(*)::text AS active_count
             FROM pindou_ai_generation_jobs
            WHERE user_id = $1
              AND status IN ('queued', 'processing')
              AND expires_at > $2`,
          [input.userId, currentTime],
        );
        const active = Number(activeResult.rows[0]?.active_count ?? "0");
        if (availableQuota(quota) <= active) throw quotaInsufficient("AI 生成额度不足");

        const id = createEntityId("aijob");
        const expiresAt = new Date(currentTime.getTime() + this.retentionMs);
        const inserted = await client.query<AiJobRow>(
          `INSERT INTO pindou_ai_generation_jobs (
             id, user_id, input_file_id, output_file_id, provider, model, status,
             prompt_version, style, detail_level, background_mode, provider_request_id,
             idempotency_key, error_code, created_at, updated_at, started_at,
             completed_at, expires_at
           ) VALUES ($1, $2, $3, NULL, $4, $5, 'queued', $6, $7, $8, $9, NULL,
                     $10, NULL, $11, $11, NULL, NULL, $12)
           RETURNING *, $13::text AS input_object_key, $14::text AS input_content_type,
                     NULL::text AS output_public_url, NULL::text AS output_content_type,
                     NULL::bigint AS output_byte_size`,
          [
            id, input.userId, input.inputFileId, this.provider.name, this.provider.model,
            AI_PROMPT_VERSION, input.style, input.detailLevel, input.backgroundMode,
            input.idempotencyKey, currentTime, expiresAt, file.object_key, file.content_type,
          ],
        );
        job = inserted.rows[0]!;
      }
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
    if (job.status === "queued") {
      void this.advance(job).catch((error: unknown) => {
        console.error(JSON.stringify({
          event: "ai_generation_background_failed",
          jobId: job.id,
          errorCode: failureCode(error),
        }));
      });
    }
    return mapJob(job);
  }

  public async get(userId: string, jobId: string): Promise<AiGenerationResponse> {
    const job = await this.readJob(this.pool, userId, jobId);
    return this.advance(job);
  }

  private async advance(job: AiJobRow): Promise<AiGenerationResponse> {
    if (job.status === "queued") {
      const submitted = await this.submit(job.user_id, job.id);
      return mapJob(submitted);
    }
    if (job.status !== "processing") return mapJob(job);
    if (!job.provider_request_id) {
      if (
        job.started_at
        && this.now().getTime() - new Date(job.started_at).getTime() > PROVIDER_SUBMISSION_TIMEOUT_MS
      ) {
        return mapJob(await this.markFailed(job.user_id, job.id, "AI_SUBMISSION_TIMEOUT"));
      }
      return mapJob(job);
    }
    if (new Date(job.expires_at).getTime() <= this.now().getTime()) {
      return mapJob(await this.markFailed(job.user_id, job.id, "AI_TASK_EXPIRED"));
    }
    let providerResult: Awaited<ReturnType<AiGenerationProvider["getTask"]>>;
    try {
      providerResult = await this.provider.getTask(job.provider_request_id);
    } catch (error: unknown) {
      return mapJob(await this.markFailed(job.user_id, job.id, failureCode(error)));
    }
    if (providerResult.status === "pending") return mapJob(job);
    if (providerResult.status === "failed") {
      return mapJob(await this.markFailed(job.user_id, job.id, "AI_PROVIDER_TASK_FAILED"));
    }
    let output: Buffer;
    try {
      output = await this.provider.downloadOutput(providerResult.outputUrl);
    } catch (error: unknown) {
      return mapJob(await this.markFailed(job.user_id, job.id, failureCode(error)));
    }
    let stored: StoredAiFile;
    try {
      stored = await this.storage.save("ai_output", output, "output.png", "image/png");
    } catch (error: unknown) {
      return mapJob(await this.markFailed(job.user_id, job.id, failureCode(error)));
    }
    return mapJob(await this.complete(job.user_id, job.id, stored));
  }

  private async submit(userId: string, jobId: string): Promise<AiJobRow> {
    const client = await this.pool.connect();
    let claimed: AiJobRow;
    try {
      await client.query("BEGIN");
      const result = await client.query<AiJobRow>(
        `${JOB_SELECT} WHERE jobs.id = $1 AND jobs.user_id = $2 LIMIT 1 FOR UPDATE OF jobs`,
        [jobId, userId],
      );
      const current = result.rows[0];
      if (!current) throw notFound("AI 生成任务不存在");
      if (current.status !== "queued") {
        await client.query("COMMIT");
        return current;
      }
      const updated = await client.query<AiJobRow>(
        `UPDATE pindou_ai_generation_jobs
            SET status = 'processing', started_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'queued'
          RETURNING *, $3::text AS input_object_key, $4::text AS input_content_type,
                    NULL::text AS output_public_url, NULL::text AS output_content_type,
                    NULL::bigint AS output_byte_size`,
        [current.id, this.now(), current.input_object_key, current.input_content_type],
      );
      await client.query("COMMIT");
      claimed = updated.rows[0] ?? current;
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }

    if (claimed.status !== "processing" || claimed.provider_request_id) return claimed;
    let input: Awaited<ReturnType<AiFileStorage["readObject"]>>;
    try {
      input = claimed.input_object_key
        ? await this.storage.readObject(claimed.input_object_key)
        : null;
    } catch (error: unknown) {
      return this.markFailed(userId, jobId, failureCode(error));
    }
    if (!input || !claimed.input_content_type) {
      return this.markFailed(userId, jobId, "AI_INPUT_FILE_UNAVAILABLE");
    }

    let providerTaskId: string;
    try {
      const imageDataUrl = `data:${claimed.input_content_type};base64,${input.buffer.toString("base64")}`;
      providerTaskId = await this.provider.createTask(
        imageDataUrl,
        buildAiPrompt({
          style: claimed.style as AiGenerationStyle,
          detailLevel: claimed.detail_level as AiGenerationDetailLevel,
          backgroundMode: claimed.background_mode as AiGenerationBackgroundMode,
        }).text,
      );
    } catch (error: unknown) {
      return this.markFailed(userId, jobId, failureCode(error));
    }

    const updated = await this.pool.query<AiJobRow>(
      `UPDATE pindou_ai_generation_jobs
          SET provider_request_id = $2, updated_at = $3
        WHERE id = $1 AND user_id = $4
          AND status = 'processing' AND provider_request_id IS NULL
        RETURNING *, $5::text AS input_object_key, $6::text AS input_content_type,
                  NULL::text AS output_public_url, NULL::text AS output_content_type,
                  NULL::bigint AS output_byte_size`,
      [jobId, providerTaskId, this.now(), userId, claimed.input_object_key, claimed.input_content_type],
    );
    return updated.rows[0] ?? this.readJob(this.pool, userId, jobId);
  }

  private async complete(userId: string, jobId: string, stored: StoredAiFile): Promise<AiJobRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockQuotaUser(client, userId);
      const currentResult = await client.query<AiJobRow>(
        `${JOB_SELECT} WHERE jobs.id = $1 AND jobs.user_id = $2 LIMIT 1 FOR UPDATE OF jobs`,
        [jobId, userId],
      );
      const current = currentResult.rows[0];
      if (!current) throw notFound("AI 生成任务不存在");
      if (current.status !== "processing") {
        await client.query("COMMIT");
        await this.storage.remove(stored.objectKey);
        return current;
      }
      const currentTime = this.now();
      const quotaDate = shanghaiDate(currentTime);
      await ensureDailyGrant(
        client, userId, "ai_generation", quotaDate,
        this.quotaConfig.dailyAiGenerations, currentTime,
      );
      const quota = await readQuota(client, userId, "ai_generation", quotaDate);
      const bucket = debitBucket(quota);
      if (!bucket) {
        const failed = await this.updateFailed(client, current.id, "AI_QUOTA_UNAVAILABLE_AT_COMPLETION");
        await client.query("COMMIT");
        await this.storage.remove(stored.objectKey);
        return failed;
      }
      const outputFileId = createEntityId("file");
      await client.query(
        `INSERT INTO pindou_file_assets (
           id, user_id, file_type, object_key, public_url, content_type, byte_size,
           width, height, created_at, deleted_at
         ) VALUES ($1, $2, 'ai_output', $3, $4, $5, $6, $7, $8, $9, NULL)`,
        [
          outputFileId, userId, stored.objectKey, stored.publicUrl, stored.contentType,
          stored.byteSize, stored.width, stored.height, currentTime,
        ],
      );
      await client.query(
        `INSERT INTO pindou_quota_transactions (
           id, user_id, quota_kind, type, amount, source, bucket, quota_date, order_id,
           download_record_id, idempotency_key, note, created_at
         ) VALUES ($1, $2, 'ai_generation', 'usage_debit', -1, 'ai_generation', $3,
                   $4::date, NULL, NULL, $5, NULL, $6)`,
        [
          createEntityId("qt"), userId, bucket,
          bucket === "daily_free" ? quotaDate : null,
          `ai-generation:${jobId}`, currentTime,
        ],
      );
      const updated = await client.query<AiJobRow>(
        `UPDATE pindou_ai_generation_jobs
            SET status = 'succeeded', output_file_id = $2, error_code = NULL,
                completed_at = $3, updated_at = $3
          WHERE id = $1
          RETURNING *, NULL::text AS input_object_key, NULL::text AS input_content_type,
                    $4::text AS output_public_url, $5::text AS output_content_type,
                    $6::bigint AS output_byte_size`,
        [jobId, outputFileId, currentTime, stored.publicUrl, stored.contentType, stored.byteSize],
      );
      await client.query("COMMIT");
      console.log(JSON.stringify({ event: "ai_generation_succeeded", jobId, userId }));
      return updated.rows[0]!;
    } catch (error: unknown) {
      await rollbackTransaction(client);
      await this.storage.remove(stored.objectKey);
      throw error;
    } finally {
      client.release();
    }
  }

  private async readJob(
    conn: Pick<Pool, "query"> | Pick<PoolClient, "query">,
    userId: string,
    jobId: string,
    forUpdate = false,
  ): Promise<AiJobRow> {
    const result = await conn.query<AiJobRow>(
      `${JOB_SELECT} WHERE jobs.id = $1 AND jobs.user_id = $2 LIMIT 1${forUpdate ? " FOR UPDATE OF jobs" : ""}`,
      [jobId, userId],
    );
    const job = result.rows[0];
    if (!job) throw notFound("AI 生成任务不存在");
    return job;
  }

  private async markFailed(userId: string, jobId: string, errorCode: string): Promise<AiJobRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.readJob(client, userId, jobId, true);
      if (current.status !== "queued" && current.status !== "processing") {
        await client.query("COMMIT");
        return current;
      }
      const failed = await this.updateFailed(client, jobId, errorCode);
      await client.query("COMMIT");
      return failed;
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateFailed(client: PoolClient, jobId: string, errorCode: string): Promise<AiJobRow> {
    const currentTime = this.now();
    const result = await client.query<AiJobRow>(
      `UPDATE pindou_ai_generation_jobs
          SET status = 'failed', error_code = $2, completed_at = $3, updated_at = $3
        WHERE id = $1
        RETURNING *, NULL::text AS input_object_key, NULL::text AS input_content_type,
                  NULL::text AS output_public_url, NULL::text AS output_content_type,
                  NULL::bigint AS output_byte_size`,
      [jobId, errorCode.slice(0, 80), currentTime],
    );
    console.error(JSON.stringify({ event: "ai_generation_failed", jobId, errorCode: errorCode.slice(0, 80) }));
    return result.rows[0]!;
  }

  public async cleanupExpired(): Promise<void> {
    const currentTime = this.now();
    const client = await this.pool.connect();
    let objectKeys: string[] = [];
    try {
      await client.query("BEGIN");
      const expired = await client.query<{
        readonly id: string;
        readonly input_file_id: string;
        readonly input_object_key: string;
        readonly output_file_id: string | null;
        readonly output_object_key: string | null;
        readonly status: string;
      }>(
        `SELECT jobs.id, jobs.input_file_id, input_file.object_key AS input_object_key,
                jobs.output_file_id, output_file.object_key AS output_object_key, jobs.status
           FROM pindou_ai_generation_jobs jobs
           JOIN pindou_file_assets input_file ON input_file.id = jobs.input_file_id
           LEFT JOIN pindou_file_assets output_file ON output_file.id = jobs.output_file_id
          WHERE jobs.expires_at <= $1
            AND jobs.status IN ('queued', 'processing', 'succeeded', 'failed', 'canceled')
          FOR UPDATE OF jobs SKIP LOCKED`,
        [currentTime],
      );
      if (expired.rows.length > 0) {
        const jobIds = expired.rows.map((row) => row.id);
        const fileIds = expired.rows.flatMap((row) => [row.input_file_id, row.output_file_id]
          .filter((value): value is string => value !== null));
        await client.query(
          `UPDATE pindou_ai_generation_jobs
              SET status = 'failed',
                  error_code = CASE
                    WHEN status = 'succeeded' THEN 'AI_RESULT_EXPIRED'
                    ELSE COALESCE(error_code, 'AI_TASK_EXPIRED')
                  END,
                  completed_at = COALESCE(completed_at, $2), updated_at = $2
            WHERE id = ANY($1::varchar[])`,
          [jobIds, currentTime],
        );
        await client.query(
          `UPDATE pindou_file_assets
              SET deleted_at = COALESCE(deleted_at, $2)
            WHERE id = ANY($1::varchar[]) AND file_type IN ('ai_input', 'ai_output')`,
          [fileIds, currentTime],
        );
        objectKeys.push(...expired.rows.flatMap((row) => [row.input_object_key, row.output_object_key]
          .filter((value): value is string => value !== null)));
      }

      const orphanedInputs = await client.query<{ readonly id: string; readonly object_key: string }>(
        `SELECT files.id, files.object_key
           FROM pindou_file_assets files
          WHERE files.file_type = 'ai_input'
            AND files.deleted_at IS NULL
            AND files.created_at <= $1
            AND NOT EXISTS (
              SELECT 1 FROM pindou_ai_generation_jobs jobs
               WHERE jobs.input_file_id = files.id
            )
          FOR UPDATE SKIP LOCKED`,
        [new Date(currentTime.getTime() - this.retentionMs)],
      );
      if (orphanedInputs.rows.length > 0) {
        const fileIds = orphanedInputs.rows.map((row) => row.id);
        await client.query(
          `UPDATE pindou_file_assets
              SET deleted_at = $2
            WHERE id = ANY($1::varchar[]) AND file_type = 'ai_input'`,
          [fileIds, currentTime],
        );
        objectKeys.push(...orphanedInputs.rows.map((row) => row.object_key));
      }
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
    await Promise.all(objectKeys.map((objectKey) => this.storage.remove(objectKey)));
  }
}

function publicFailureCode(value: string | null): string | null {
  if (!value) return null;
  return PUBLIC_FAILURE_CODES.has(value) ? value : "AI_GENERATION_INTERNAL_ERROR";
}
