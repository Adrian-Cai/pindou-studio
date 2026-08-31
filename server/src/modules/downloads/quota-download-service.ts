import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { ServerConfig } from "../../config/env";
import {
  forbidden,
  idempotencyConflict,
  notFound,
  quotaInsufficient,
  unauthorized,
} from "../../shared/app-error";
import { createEntityId } from "../../shared/identity";
import { nextShanghaiMidnight, shanghaiDate } from "../../shared/shanghai-time";

export type DownloadFileType = "preview" | "chart" | "materials";

export interface QuotaResponse {
  readonly dailyFree: number;
  readonly usedToday: number;
  readonly purchased: number;
  readonly remaining: number;
  readonly membershipType: null;
  readonly membershipExpiresAt: null;
  readonly resetsAt: string;
}

export interface DownloadRecord {
  readonly id: string;
  readonly workId: string | null;
  readonly title: string;
  readonly fileType: DownloadFileType;
  readonly consumedQuota: true;
  readonly quotaTransactionId: string;
  readonly downloadedAt: string;
}

export interface DownloadListOptions {
  readonly userId: string;
  readonly fileType?: DownloadFileType;
  readonly page: number;
  readonly pageSize: number;
  readonly query?: string;
}

export interface DownloadListResponse {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly items: readonly DownloadRecord[];
}

export interface CreateDownloadInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly workId: string;
  readonly fileType: DownloadFileType;
}

export interface CreateDownloadResponse {
  readonly downloadRecord: DownloadRecord;
  readonly quota: Pick<QuotaResponse, "remaining" | "usedToday" | "purchased">;
}

export interface QuotaDownloadService {
  getQuota(userId: string): Promise<QuotaResponse>;
  listDownloads(options: DownloadListOptions): Promise<DownloadListResponse>;
  createDownload(input: CreateDownloadInput): Promise<CreateDownloadResponse>;
}

interface QuotaRow extends QueryResultRow {
  readonly daily_free: string;
  readonly used_today: string;
  readonly daily_remaining: string;
  readonly purchased: string;
}

interface DownloadRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly work_id: string | null;
  readonly work_title_snapshot: string;
  readonly file_type: string;
  readonly consumed_quota: boolean;
  readonly quota_transaction_id: string | null;
  readonly idempotency_key: string;
  readonly downloaded_at: Date | string;
}

interface WorkRow extends QueryResultRow {
  readonly user_id: string;
  readonly title: string;
  readonly deleted_at: Date | string | null;
}

interface QuotaValues {
  readonly dailyFree: number;
  readonly usedToday: number;
  readonly dailyRemaining: number;
  readonly purchased: number;
}

function nonNegativeInteger(value: string | number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("数据库返回了无效下载时间");
  return date.toISOString();
}

function mapQuota(row: QuotaRow | undefined): QuotaValues {
  return {
    dailyFree: nonNegativeInteger(row?.daily_free ?? "0"),
    usedToday: nonNegativeInteger(row?.used_today ?? "0"),
    dailyRemaining: nonNegativeInteger(row?.daily_remaining ?? "0"),
    purchased: nonNegativeInteger(row?.purchased ?? "0"),
  };
}

function quotaResponse(values: QuotaValues, currentTime: Date): QuotaResponse {
  return {
    dailyFree: values.dailyFree,
    usedToday: values.usedToday,
    purchased: values.purchased,
    remaining: values.dailyRemaining + values.purchased,
    membershipType: null,
    membershipExpiresAt: null,
    resetsAt: nextShanghaiMidnight(currentTime),
  };
}

function responseQuota(values: QuotaValues): CreateDownloadResponse["quota"] {
  return {
    remaining: values.dailyRemaining + values.purchased,
    usedToday: values.usedToday,
    purchased: values.purchased,
  };
}

function mapDownload(row: DownloadRow): DownloadRecord {
  if (
    (row.file_type !== "preview" && row.file_type !== "chart" && row.file_type !== "materials")
    || row.consumed_quota !== true
    || !row.quota_transaction_id
  ) {
    throw new Error("数据库下载记录不符合业务约束");
  }
  return {
    id: row.id,
    workId: row.work_id,
    title: row.work_title_snapshot,
    fileType: row.file_type,
    consumedQuota: true,
    quotaTransactionId: row.quota_transaction_id,
    downloadedAt: toIsoString(row.downloaded_at),
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure when the connection has already failed.
  }
}

async function lockCurrentUser(client: PoolClient, userId: string): Promise<void> {
  const result = await client.query(
    `SELECT id
       FROM pindou_users
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [userId],
  );
  if (!result.rows[0]) throw unauthorized("用户不存在或已失效");
}

async function ensureDailyGrant(
  client: PoolClient,
  userId: string,
  quotaDate: string,
  amount: number,
  currentTime: Date,
): Promise<void> {
  if (amount <= 0) return;
  await client.query(
    `INSERT INTO pindou_quota_transactions (
       id, user_id, type, amount, source, bucket, quota_date, order_id,
       download_record_id, idempotency_key, note, created_at
     )
     VALUES ($1, $2, 'daily_grant', $3, 'daily_free', 'daily_free', $4::date,
             NULL, NULL, NULL, NULL, $5)
     ON CONFLICT DO NOTHING`,
    [createEntityId("qt"), userId, amount, quotaDate, currentTime],
  );
}

async function readQuota(
  client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  userId: string,
  quotaDate: string,
): Promise<QuotaValues> {
  const result = await client.query<QuotaRow>(
    `SELECT COALESCE(
              SUM(amount) FILTER (
                WHERE bucket = 'daily_free'
                  AND quota_date = $2::date
                  AND type = 'daily_grant'
              ),
              0
            )::text AS daily_free,
            COALESCE(
              -SUM(amount) FILTER (
                WHERE bucket = 'daily_free'
                  AND quota_date = $2::date
                  AND amount < 0
              ),
              0
            )::text AS used_today,
            COALESCE(
              SUM(amount) FILTER (
                WHERE bucket = 'daily_free' AND quota_date = $2::date
              ),
              0
            )::text AS daily_remaining,
            COALESCE(SUM(amount) FILTER (WHERE bucket = 'purchased'), 0)::text AS purchased
       FROM pindou_quota_transactions
      WHERE user_id = $1`,
    [userId, quotaDate],
  );
  return mapQuota(result.rows[0]);
}

async function readDownloadByIdempotencyKey(
  client: PoolClient,
  idempotencyKey: string,
): Promise<DownloadRow | undefined> {
  const result = await client.query<DownloadRow>(
    `SELECT id, user_id, work_id, work_title_snapshot, file_type, consumed_quota,
            quota_transaction_id, idempotency_key, downloaded_at
       FROM pindou_download_records
      WHERE idempotency_key = $1
      LIMIT 1`,
    [idempotencyKey],
  );
  return result.rows[0];
}

export class PostgresQuotaDownloadService implements QuotaDownloadService {
  public constructor(
    private readonly pool: Pool,
    private readonly quotaConfig: ServerConfig["quota"],
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getQuota(userId: string): Promise<QuotaResponse> {
    const currentTime = this.now();
    const quotaDate = shanghaiDate(currentTime);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCurrentUser(client, userId);
      await ensureDailyGrant(client, userId, quotaDate, this.quotaConfig.dailyFree, currentTime);
      const quota = await readQuota(client, userId, quotaDate);
      await client.query("COMMIT");
      return quotaResponse(quota, currentTime);
    } catch (error: unknown) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async listDownloads(options: DownloadListOptions): Promise<DownloadListResponse> {
    const conditions = ["user_id = $1"];
    const parameters: unknown[] = [options.userId];
    if (options.fileType) {
      parameters.push(options.fileType);
      conditions.push(`file_type = $${parameters.length}`);
    }
    if (options.query) {
      parameters.push(`%${options.query}%`);
      conditions.push(`work_title_snapshot ILIKE $${parameters.length}`);
    }
    const countParameters = [...parameters];
    const countResult = await this.pool.query<{ readonly total_count: string }>(
      `SELECT COUNT(*)::text AS total_count
         FROM pindou_download_records
        WHERE ${conditions.join(" AND ")}`,
      countParameters,
    );
    parameters.push(options.pageSize, (options.page - 1) * options.pageSize);
    const result = await this.pool.query<DownloadRow>(
      `SELECT id, user_id, work_id, work_title_snapshot, file_type, consumed_quota,
              quota_transaction_id, idempotency_key, downloaded_at
         FROM pindou_download_records
        WHERE ${conditions.join(" AND ")}
        ORDER BY downloaded_at DESC, id DESC
        LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    );
    const total = Number(countResult.rows[0]?.total_count ?? 0);
    return {
      total: Number.isSafeInteger(total) && total > 0 ? total : 0,
      page: options.page,
      pageSize: options.pageSize,
      items: result.rows.map(mapDownload),
    };
  }

  public async createDownload(input: CreateDownloadInput): Promise<CreateDownloadResponse> {
    const currentTime = this.now();
    const quotaDate = shanghaiDate(currentTime);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `pindou-download:${input.idempotencyKey}`,
      ]);
      await lockCurrentUser(client, input.userId);

      const existing = await readDownloadByIdempotencyKey(client, input.idempotencyKey);
      if (existing) {
        if (
          existing.user_id !== input.userId
          || existing.work_id !== input.workId
          || existing.file_type !== input.fileType
        ) {
          throw idempotencyConflict();
        }
        await ensureDailyGrant(client, input.userId, quotaDate, this.quotaConfig.dailyFree, currentTime);
        const quota = await readQuota(client, input.userId, quotaDate);
        await client.query("COMMIT");
        return { downloadRecord: mapDownload(existing), quota: responseQuota(quota) };
      }

      const workResult = await client.query<WorkRow>(
        `SELECT user_id, title, deleted_at
           FROM pindou_works
          WHERE id = $1
          LIMIT 1
          FOR SHARE`,
        [input.workId],
      );
      const work = workResult.rows[0];
      if (!work || work.deleted_at) throw notFound("作品不存在");
      if (work.user_id !== input.userId) throw forbidden("作品不属于当前用户");

      await ensureDailyGrant(client, input.userId, quotaDate, this.quotaConfig.dailyFree, currentTime);
      const quotaBefore = await readQuota(client, input.userId, quotaDate);
      const bucket = quotaBefore.dailyRemaining > 0
        ? "daily_free"
        : quotaBefore.purchased > 0
          ? "purchased"
          : null;
      if (!bucket) throw quotaInsufficient();

      const downloadId = createEntityId("dl");
      const quotaTransactionId = createEntityId("qt");
      await client.query(
        `INSERT INTO pindou_download_records (
           id, user_id, work_id, work_title_snapshot, file_type, consumed_quota,
           quota_transaction_id, idempotency_key, downloaded_at
         )
         VALUES ($1, $2, $3, $4, $5, TRUE, NULL, $6, $7)`,
        [downloadId, input.userId, input.workId, work.title, input.fileType, input.idempotencyKey, currentTime],
      );
      await client.query(
        `INSERT INTO pindou_quota_transactions (
           id, user_id, type, amount, source, bucket, quota_date, order_id,
           download_record_id, idempotency_key, note, created_at
         )
         VALUES ($1, $2, 'download_debit', -1, 'download', $3,
                 $4::date, NULL, $5, $6, NULL, $7)`,
        [
          quotaTransactionId,
          input.userId,
          bucket,
          bucket === "daily_free" ? quotaDate : null,
          downloadId,
          input.idempotencyKey,
          currentTime,
        ],
      );
      await client.query(
        `UPDATE pindou_download_records
            SET quota_transaction_id = $2
          WHERE id = $1 AND quota_transaction_id IS NULL`,
        [downloadId, quotaTransactionId],
      );
      const quotaAfter = await readQuota(client, input.userId, quotaDate);
      await client.query("COMMIT");
      return {
        downloadRecord: {
          id: downloadId,
          workId: input.workId,
          title: work.title,
          fileType: input.fileType,
          consumedQuota: true,
          quotaTransactionId,
          downloadedAt: currentTime.toISOString(),
        },
        quota: responseQuota(quotaAfter),
      };
    } catch (error: unknown) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
