/** AI 任务收口、失败与过期清理；保留原有事务、行锁和成功扣次规则。 */
import type { Pool, PoolClient } from "pg";
import type { ServerConfig } from "../../config/env";
import { notFound } from "../../shared/app-error";
import { createEntityId } from "../../shared/identity";
import { shanghaiDate } from "../../shared/shanghai-time";
import { rollbackTransaction } from "../../shared/transaction";
import type { AiFileStorage, StoredAiFile } from "../files/ai-file-storage";
import { debitBucket, ensureDailyGrant, lockQuotaUser, readQuota } from "../quota/quota-ledger";
import { JOB_SELECT, type AiJobRow } from "./ai-generation-model";

/** 同一事务写入输出资产、扣次流水和任务终态，行锁防止重复扣次。 */
export async function completeAiJob(pool: Pool, storage: AiFileStorage, now: () => Date, quotaConfig: ServerConfig["quota"], userId: string, jobId: string, stored: StoredAiFile): Promise<AiJobRow> {
  const client = await pool.connect();
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
      await storage.remove(stored.objectKey);
      return current;
    }
    const currentTime = now();
    const quotaDate = shanghaiDate(currentTime);
    await ensureDailyGrant(
      client, userId, "ai_generation", quotaDate,
      quotaConfig.dailyAiGenerations, currentTime,
    );
    const quota = await readQuota(client, userId, "ai_generation", quotaDate);
    // 扣一次额度；若当日额度已用尽则判失败并清理落库产物（避免产生无法计费的产出）。
    const bucket = debitBucket(quota);
    if (!bucket) {
      const failed = await updateFailed(now, client, current.id, "AI_QUOTA_UNAVAILABLE_AT_COMPLETION");
      await client.query("COMMIT");
      await storage.remove(stored.objectKey);
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
          SET status = 'succeeded', output_file_id = $2, provider_output_url = NULL, provider_next_poll_at = NULL, error_code = NULL,
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
    await storage.remove(stored.objectKey);
    throw error;
  } finally {
    client.release();
  }
}

/** 按用户归属读取任务；失败事务可请求行锁。 */
export async function readAiJob(
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

/** 仅将活跃任务置失败，保留已完成的终态。 */
export async function markAiJobFailed(pool: Pool, now: () => Date, userId: string, jobId: string, errorCode: string): Promise<AiJobRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await readAiJob(client, userId, jobId, true);
    if (current.status !== "queued" && current.status !== "processing") {
      await client.query("COMMIT");
      return current;
    }
    const failed = await updateFailed(now, client, jobId, errorCode);
    await client.query("COMMIT");
    return failed;
  } catch (error: unknown) {
    await rollbackTransaction(client);
    throw error;
  } finally {
    client.release();
  }
}

/** 实际写入 failed 状态 + error_code（截断 80 字符）+ completed_at，并打失败日志。 */
async function updateFailed(now: () => Date, client: PoolClient, jobId: string, errorCode: string): Promise<AiJobRow> {
  const currentTime = now();
  const result = await client.query<AiJobRow>(
    `UPDATE pindou_ai_generation_jobs
        SET status = 'failed', provider_output_url = NULL, provider_next_poll_at = NULL, error_code = $2, completed_at = $3, updated_at = $3
      WHERE id = $1
      RETURNING *, NULL::text AS input_object_key, NULL::text AS input_content_type,
                NULL::text AS output_public_url, NULL::text AS output_content_type,
                NULL::bigint AS output_byte_size`,
    [jobId, errorCode.slice(0, 80), currentTime],
  );
  console.error(JSON.stringify({ event: "ai_generation_failed", jobId, errorCode: errorCode.slice(0, 80) }));
  return result.rows[0]!;
}

/**
 * 批量清理过期任务：由进程启动 + 每小时定时器驱动。
 * 1) 把已到 expires_at 的未终结任务（及已 succeeded 的过期结果）置失败并软删关联文件；
 * 2) 清理从未被任何任务引用的孤儿输入文件。
 * 用 FOR UPDATE SKIP LOCKED 避免与其它清理/推进事务互相阻塞。
 */
export async function cleanupExpiredAiJobs(pool: Pool, storage: AiFileStorage, now: () => Date, retentionMs: number): Promise<void> {
  const currentTime = now();
  const client = await pool.connect();
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
          -- 一次性守卫：已终结的任务（completed_at 已写入）不再命中，
          -- 只有 succeeded 还需再走一轮，把过期结果置为 AI_RESULT_EXPIRED。
          -- 缺了这行守卫时，每轮清理都会把整批过期历史重新选中、重写一遍 updated_at，
          -- 表现为整表 updated_at 被周期性刷新，失去"最后业务变更时间"的意义。
          AND (jobs.completed_at IS NULL OR jobs.status = 'succeeded')
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
      [new Date(currentTime.getTime() - retentionMs)],
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
  await Promise.all(objectKeys.map((objectKey) => storage.remove(objectKey)));
}
