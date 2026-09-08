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

const PROMPT_VERSION = "v1";
const ACTIVE_STATUSES = ["queued", "processing"] as const;

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
    errorCode: row.error_code,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: nullableIso(row.completed_at),
  };
}

function prompt(input: Pick<CreateAiGenerationInput, "style" | "detailLevel" | "backgroundMode">): string {
  const styles = {
    natural: "保留原图主体特征，使用自然柔和、写实干净的视觉风格",
    cartoon: "保留原图主体特征，转换为精致、轮廓清楚的卡通插画风格",
    minimal: "保留原图主体特征，简化为色块明确、边缘清晰的极简插画风格",
  } as const;
  const details = {
    low: "适度减少细碎纹理和小物件",
    medium: "保留主要纹理，同时合并不重要的小细节",
    high: "尽量保留主体层次与关键细节",
  } as const;
  const backgrounds = {
    keep: "保留原有背景构图",
    simplify: "简化背景，只保留有助于识别场景的主要元素",
    remove: "移除背景，使用干净的纯色浅背景",
  } as const;
  return `${styles[input.style]}；${details[input.detailLevel]}；${backgrounds[input.backgroundMode]}输出一张完整 PNG，不添加文字、水印、边框或拼豆网格`;
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
        const expiresAt = new Date(currentTime.getTime() + 24 * 60 * 60 * 1_000);
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
            PROMPT_VERSION, input.style, input.detailLevel, input.backgroundMode,
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
    return this.advance(job);
  }

  public async get(userId: string, jobId: string): Promise<AiGenerationResponse> {
    const job = await this.readJob(this.pool, userId, jobId);
    return this.advance(job);
  }

  private async advance(job: AiJobRow): Promise<AiGenerationResponse> {
    if (job.status === "queued") job = await this.submit(job.user_id, job.id);
    if (job.status !== "processing") return mapJob(job);
    if (new Date(job.expires_at).getTime() <= this.now().getTime()) {
      return mapJob(await this.markFailed(job.user_id, job.id, "AI_TASK_EXPIRED"));
    }
    const providerResult = await this.provider.getTask(job.provider_request_id!);
    if (providerResult.status === "pending") return mapJob(job);
    if (providerResult.status === "failed") {
      return mapJob(await this.markFailed(job.user_id, job.id, `PROVIDER_${providerResult.errorCode}`));
    }
    const output = await this.provider.downloadOutput(providerResult.outputUrl);
    const stored = await this.storage.save("ai_output", output, "output.png", "image/png");
    return mapJob(await this.complete(job.user_id, job.id, stored));
  }

  private async submit(userId: string, jobId: string): Promise<AiJobRow> {
    const client = await this.pool.connect();
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
      const input = current.input_object_key
        ? await this.storage.readObject(current.input_object_key)
        : null;
      if (!input || !current.input_content_type) {
        const failed = await this.updateFailed(client, current.id, "AI_INPUT_FILE_UNAVAILABLE");
        await client.query("COMMIT");
        return failed;
      }
      let providerTaskId: string;
      try {
        const imageDataUrl = `data:${current.input_content_type};base64,${input.buffer.toString("base64")}`;
        providerTaskId = await this.provider.createTask(
          imageDataUrl,
          prompt({
            style: current.style as AiGenerationStyle,
            detailLevel: current.detail_level as AiGenerationDetailLevel,
            backgroundMode: current.background_mode as AiGenerationBackgroundMode,
          }),
        );
      } catch (error: unknown) {
        await this.updateFailed(client, current.id, failureCode(error));
        await client.query("COMMIT");
        throw error;
      }
      const updated = await client.query<AiJobRow>(
        `UPDATE pindou_ai_generation_jobs
            SET status = 'processing', provider_request_id = $2,
                started_at = $3, updated_at = $3
          WHERE id = $1
          RETURNING *, $4::text AS input_object_key, $5::text AS input_content_type,
                    NULL::text AS output_public_url, NULL::text AS output_content_type,
                    NULL::bigint AS output_byte_size`,
        [current.id, providerTaskId, this.now(), current.input_object_key, current.input_content_type],
      );
      await client.query("COMMIT");
      return updated.rows[0]!;
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
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
}
