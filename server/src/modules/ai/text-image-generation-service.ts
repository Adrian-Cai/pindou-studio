import type { Pool, PoolClient, QueryResultRow } from "pg";
import { HUNYUAN_TEXT_IMAGE_MODEL } from "../../config/env";
import { aiQuotaInsufficient, AppError, idempotencyConflict, notFound } from "../../shared/app-error";
import { createEntityId } from "../../shared/identity";
import { rollbackTransaction } from "../../shared/transaction";
import { shanghaiDate } from "../../shared/shanghai-time";
import {
  availableQuota,
  debitBucket,
  ensureDailyGrant,
  lockQuotaUser,
  readQuota,
  type QuotaBucket,
} from "../quota/quota-ledger";
import type { AiFileStorage, StoredAiFile } from "../files/ai-file-storage";

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const RECOVER_STALE_AFTER_MS = 5 * 60 * 1_000;
const MAX_OUTPUT_SIZE = 50;

export interface TextImageProvider {
  readonly name: string;
  readonly configured: boolean;
  generateTextImage(prompt: string): Promise<{ readonly requestId: string; readonly buffer: Buffer; readonly contentType: string }>;
}

export type TextImageGenerationStatus = "queued" | "processing" | "succeeded" | "failed";

export interface TextImageGenerationResponse {
  readonly id: string;
  readonly prompt: string;
  readonly status: TextImageGenerationStatus;
  readonly outputFile: { readonly id: string; readonly url: string; readonly contentType: string; readonly size: number } | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface TextJobRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly output_file_id: string | null;
  readonly output_public_url: string | null;
  readonly output_content_type: string | null;
  readonly output_byte_size: string | number | null;
  readonly output_object_key?: string | null;
  readonly provider_request_id: string | null;
  readonly idempotency_key: string;
  readonly error_code: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly started_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly expires_at: Date | string;
  readonly consumed_at?: Date | string | null;
}

export interface CreateTextImageGenerationInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly prompt: string;
}

export class PostgresTextImageGenerationService {
  private readonly running = new Map<string, Promise<void>>();

  public constructor(
    private readonly pool: Pool,
    private readonly provider: TextImageProvider,
    private readonly storage: AiFileStorage,
    private readonly quotaConfig: { readonly dailyAiGenerations: number },
    private readonly now: () => Date = () => new Date(),
    private readonly retentionMs = DEFAULT_RETENTION_MS,
  ) {}

  public async create(input: CreateTextImageGenerationInput): Promise<TextImageGenerationResponse> {
    if (!this.provider.configured) throw new AppError(503, "AI_SERVICE_UNAVAILABLE", "AI 生成暂时不可用");
    const currentTime = this.now();
    const client = await this.pool.connect();
    let job: TextJobRow;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `pindou-text-image:${input.userId}:${input.idempotencyKey}`,
      ]);
      await lockQuotaUser(client, input.userId);
      const existingResult = await client.query<TextJobRow>(
        `${TEXT_JOB_SELECT} WHERE jobs.user_id = $1 AND jobs.idempotency_key = $2 LIMIT 1 FOR UPDATE OF jobs`,
        [input.userId, input.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.prompt !== input.prompt) throw idempotencyConflict("文生图幂等键已用于另一份描述");
        job = existing.status === "failed" && new Date(existing.expires_at).getTime() > currentTime.getTime()
          ? await this.requeueFailed(client, existing, currentTime)
          : existing;
      } else {
        await this.ensureSubmissionQuota(client, input.userId, currentTime);
        const id = createEntityId("txtjob");
        const expiresAt = new Date(currentTime.getTime() + this.retentionMs);
        const inserted = await client.query<TextJobRow>(
          `INSERT INTO pindou_text_image_generation_jobs (
             id, user_id, prompt, provider, model, status, output_file_id, provider_request_id,
             idempotency_key, error_code, created_at, updated_at, started_at, completed_at,
             expires_at, consumed_at
           ) VALUES ($1, $2, $3, $4, $5, 'queued', NULL, NULL, $6, NULL, $7, $7, NULL, NULL, $8, NULL)
           RETURNING *, NULL::text AS output_public_url, NULL::text AS output_content_type,
                     NULL::bigint AS output_byte_size`,
          [id, input.userId, input.prompt, this.provider.name, HUNYUAN_TEXT_IMAGE_MODEL, input.idempotencyKey, currentTime, expiresAt],
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
    if (job.status === "queued") void this.process(job.id).catch((error: unknown) => {
      console.error(JSON.stringify({ event: "text_image_generation_worker_failed", jobId: job.id, errorCode: error instanceof AppError ? error.code : "AI_TEXT_GENERATION_FAILED" }));
    });
    return mapTextJob(job);
  }

  public async get(userId: string, jobId: string): Promise<TextImageGenerationResponse> {
    const result = await this.pool.query<TextJobRow>(
      `${TEXT_JOB_SELECT} WHERE jobs.user_id = $1 AND jobs.id = $2 AND jobs.expires_at > $3 LIMIT 1`,
      [userId, jobId, this.now()],
    );
    const job = result.rows[0];
    if (!job) throw notFound("文生图任务不存在");
    return mapTextJob(job);
  }

  public async listRecoverable(userId: string): Promise<readonly TextImageGenerationResponse[]> {
    const result = await this.pool.query<TextJobRow>(
      `${TEXT_JOB_SELECT} WHERE jobs.user_id = $1 AND jobs.consumed_at IS NULL AND jobs.expires_at > $2
       ORDER BY jobs.created_at DESC LIMIT ${MAX_OUTPUT_SIZE}`,
      [userId, this.now()],
    );
    return result.rows.map(mapTextJob);
  }

  public async consume(userId: string, jobId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE pindou_text_image_generation_jobs
          SET consumed_at = COALESCE(consumed_at, $3), updated_at = $3
        WHERE id = $1 AND user_id = $2 AND status = 'succeeded' AND expires_at > $3`,
      [jobId, userId, this.now()],
    );
    if ((result.rowCount ?? 0) === 0) throw notFound("文生图结果不存在或尚未完成");
  }

  public async processQueued(limit = 5): Promise<void> {
    const result = await this.pool.query<{ readonly id: string }>(
      `SELECT id FROM pindou_text_image_generation_jobs
        WHERE status = 'queued' OR (status = 'processing' AND updated_at < $1)
        ORDER BY created_at ASC LIMIT $2`,
      [new Date(this.now().getTime() - RECOVER_STALE_AFTER_MS), limit],
    );
    await Promise.all(result.rows.map(({ id }) => this.process(id)));
  }

  public async cleanupExpired(limit = 100): Promise<void> {
    const client = await this.pool.connect();
    const files: Array<{ readonly objectKey: string; readonly fileId: string }> = [];
    try {
      await client.query("BEGIN");
      const expired = await client.query<TextJobRow>(
        `SELECT jobs.*, files.object_key AS output_object_key
           FROM pindou_text_image_generation_jobs jobs
           LEFT JOIN pindou_file_assets files ON files.id = jobs.output_file_id
          WHERE jobs.expires_at <= $1
          ORDER BY jobs.expires_at ASC LIMIT $2
          FOR UPDATE OF jobs SKIP LOCKED`,
        [this.now(), limit],
      );
      for (const job of expired.rows) {
        if (job.output_file_id && job.output_object_key) files.push({ objectKey: job.output_object_key, fileId: job.output_file_id });
        await client.query("DELETE FROM pindou_text_image_generation_jobs WHERE id = $1", [job.id]);
        if (job.output_file_id) await client.query("DELETE FROM pindou_file_assets WHERE id = $1", [job.output_file_id]);
      }
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
    await Promise.all(files.map(({ objectKey }) => this.storage.remove(objectKey)));
  }

  private async ensureSubmissionQuota(client: PoolClient, userId: string, currentTime: Date): Promise<void> {
    const quotaDate = shanghaiDate(currentTime);
    await ensureDailyGrant(client, userId, "ai_generation", quotaDate, this.quotaConfig.dailyAiGenerations, currentTime);
    const quota = await readQuota(client, userId, "ai_generation", quotaDate);
    const active = await client.query<{ readonly active_count: string }>(
      `SELECT COUNT(*)::text AS active_count
         FROM pindou_text_image_generation_jobs
        WHERE user_id = $1 AND status IN ('queued', 'processing') AND expires_at > $2`,
      [userId, currentTime],
    );
    if (availableQuota(quota) <= Number(active.rows[0]?.active_count ?? "0")) throw aiQuotaInsufficient();
  }

  private async requeueFailed(client: PoolClient, job: TextJobRow, currentTime: Date): Promise<TextJobRow> {
    const quotaDate = shanghaiDate(currentTime);
    await ensureDailyGrant(client, job.user_id, "ai_generation", quotaDate, this.quotaConfig.dailyAiGenerations, currentTime);
    const quota = await readQuota(client, job.user_id, "ai_generation", quotaDate);
    const active = await client.query<{ readonly active_count: string }>(
      `SELECT COUNT(*)::text AS active_count FROM pindou_text_image_generation_jobs
        WHERE user_id = $1 AND status IN ('queued', 'processing') AND expires_at > $2`,
      [job.user_id, currentTime],
    );
    if (availableQuota(quota) <= Number(active.rows[0]?.active_count ?? "0")) throw aiQuotaInsufficient();
    const result = await client.query<TextJobRow>(
      `UPDATE pindou_text_image_generation_jobs
          SET status = 'queued', output_file_id = NULL, provider_request_id = NULL, error_code = NULL,
              started_at = NULL, completed_at = NULL, expires_at = $2, updated_at = $2
        WHERE id = $1
        RETURNING *, NULL::text AS output_public_url, NULL::text AS output_content_type,
                  NULL::bigint AS output_byte_size`,
      [job.id, new Date(currentTime.getTime() + this.retentionMs)],
    );
    return result.rows[0] ?? job;
  }

  private process(jobId: string): Promise<void> {
    const current = this.running.get(jobId);
    if (current) return current;
    const task = this.run(jobId).finally(() => this.running.delete(jobId));
    this.running.set(jobId, task);
    return task;
  }

  private async run(jobId: string): Promise<void> {
    const currentTime = this.now();
    const claim = await this.pool.query<TextJobRow>(
      `UPDATE pindou_text_image_generation_jobs
          SET status = 'processing', started_at = $2, updated_at = $2
        WHERE id = $1 AND (status = 'queued' OR (status = 'processing' AND updated_at < $3))
        RETURNING *, NULL::text AS output_public_url, NULL::text AS output_content_type,
                  NULL::bigint AS output_byte_size`,
      [jobId, currentTime, new Date(currentTime.getTime() - RECOVER_STALE_AFTER_MS)],
    );
    const job = claim.rows[0];
    if (!job) return;
    let stored: StoredAiFile | null = null;
    try {
      const generated = await this.provider.generateTextImage(job.prompt);
      stored = await this.storage.save("ai_output", generated.buffer, "text-generated.png", generated.contentType);
      await this.complete(job, generated.requestId, stored);
      stored = null;
    } catch (error: unknown) {
      if (stored) await this.storage.remove(stored.objectKey);
      const code = error instanceof AppError ? error.code : "AI_TEXT_GENERATION_FAILED";
      await this.fail(job.id, code);
      console.error(JSON.stringify({ event: "text_image_generation_failed", jobId: job.id, provider: job.provider, errorCode: code }));
    }
  }

  private async complete(job: TextJobRow, requestId: string, stored: StoredAiFile): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockQuotaUser(client, job.user_id);
      const current = await client.query<TextJobRow>(
        `SELECT * FROM pindou_text_image_generation_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [job.id, job.user_id],
      );
      if (current.rows[0]?.status !== "processing") {
        await client.query("COMMIT");
        await this.storage.remove(stored.objectKey);
        return;
      }
      const now = this.now();
      const quotaDate = shanghaiDate(now);
      await ensureDailyGrant(client, job.user_id, "ai_generation", quotaDate, this.quotaConfig.dailyAiGenerations, now);
      const bucket = debitBucket(await readQuota(client, job.user_id, "ai_generation", quotaDate));
      if (!bucket) {
        await client.query(
          `UPDATE pindou_text_image_generation_jobs SET status = 'failed', error_code = 'AI_QUOTA_UNAVAILABLE_AT_COMPLETION', completed_at = $2, updated_at = $2 WHERE id = $1`,
          [job.id, now],
        );
        await client.query("COMMIT");
        await this.storage.remove(stored.objectKey);
        return;
      }
      const fileId = createEntityId("file");
      await client.query(
        `INSERT INTO pindou_file_assets (id, user_id, file_type, object_key, public_url, content_type, byte_size, width, height, created_at, deleted_at)
         VALUES ($1, $2, 'ai_output', $3, $4, $5, $6, $7, $8, $9, NULL)`,
        [fileId, job.user_id, stored.objectKey, stored.publicUrl, stored.contentType, stored.byteSize, stored.width, stored.height, now],
      );
      await client.query(
        `INSERT INTO pindou_quota_transactions (
           id, user_id, quota_kind, type, amount, source, bucket, quota_date, order_id,
           download_record_id, idempotency_key, note, created_at
         ) VALUES ($1, $2, 'ai_generation', 'usage_debit', -1, 'ai_generation', $3,
                   $4::date, NULL, NULL, $5, NULL, $6)`,
        [createEntityId("qt"), job.user_id, bucket, bucket === "daily_free" ? quotaDate : null, `text-generation:${job.id}`, now],
      );
      await client.query(
        `UPDATE pindou_text_image_generation_jobs
            SET status = 'succeeded', output_file_id = $2, provider_request_id = $3,
                error_code = NULL, completed_at = $4, updated_at = $4
          WHERE id = $1`,
        [job.id, fileId, requestId, now],
      );
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async fail(jobId: string, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE pindou_text_image_generation_jobs
          SET status = 'failed', error_code = $2, completed_at = $3, updated_at = $3
        WHERE id = $1 AND status = 'processing'`,
      [jobId, errorCode.slice(0, 80), this.now()],
    );
  }
}

const TEXT_JOB_SELECT = `SELECT jobs.*, files.public_url AS output_public_url,
                                files.content_type AS output_content_type,
                                files.byte_size AS output_byte_size
                           FROM pindou_text_image_generation_jobs jobs
                           LEFT JOIN pindou_file_assets files ON files.id = jobs.output_file_id`;

function mapTextJob(job: TextJobRow): TextImageGenerationResponse {
  if (job.status !== "queued" && job.status !== "processing" && job.status !== "succeeded" && job.status !== "failed") {
    throw new AppError(500, "INTERNAL_ERROR", "文生图任务状态无效");
  }
  const hasOutput = job.status === "succeeded" && job.output_file_id && job.output_public_url;
  return {
    id: job.id,
    prompt: job.prompt,
    status: job.status,
    outputFile: hasOutput ? {
      id: job.output_file_id!,
      url: job.output_public_url!,
      contentType: job.output_content_type ?? "image/png",
      size: Number(job.output_byte_size ?? 0),
    } : null,
    errorCode: job.error_code,
    createdAt: iso(job.created_at),
    updatedAt: iso(job.updated_at),
    completedAt: job.completed_at ? iso(job.completed_at) : null,
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
