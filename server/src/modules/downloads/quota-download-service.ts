/**
 * 下载额度服务：图纸下载扣次 + 下载记录读写 + 额度查询。
 *
 * 职责：下载这一条链路的额度扣减与记录持久化；不负责文件内容生成（由 works / files 模块处理）。
 * 调用方：http 路由层的 /api/downloads、/api/quota 相关接口。
 * 关键点：扣次用 pg_advisory_xact_lock + idempotencyKey 做幂等，重复提交同一 key 不会重复扣费；
 *         扣减顺序为「写下载记录 → 写额度流水 → 回填 quota_transaction_id」，全程在同一事务内；
 *         额度日期用上海时区，跨天重置；免费额度优先于购买额度消耗。
 */
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
import { rollbackTransaction } from "../../shared/transaction";
import {
  availableQuota,
  debitBucket,
  ensureDailyGrant,
  lockQuotaUser,
  readQuota,
  type QuotaValues,
} from "../quota/quota-ledger";

/** 可下载的文件类型：预览图 / 图纸 / 材料清单 / 色号表。 */
export type DownloadFileType = "preview" | "chart" | "materials" | "palette";

export interface QuotaResponse {
  readonly dailyFree: number;
  readonly usedToday: number;
  readonly purchased: number;
  readonly remaining: number;
  readonly membershipType: null;
  readonly membershipExpiresAt: null;
  readonly resetsAt: string;
  readonly aiGeneration: {
    readonly dailyFree: number;
    readonly usedToday: number;
    readonly purchased: number;
    readonly remaining: number;
    readonly resetsAt: string;
  };
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

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("数据库返回了无效下载时间");
  return date.toISOString();
}

function quotaResponse(
  values: QuotaValues,
  aiGeneration: QuotaValues,
  currentTime: Date,
): QuotaResponse {
  const resetsAt = nextShanghaiMidnight(currentTime);
  return {
    dailyFree: values.dailyFree,
    usedToday: values.usedToday,
    purchased: values.purchased,
    remaining: availableQuota(values),
    membershipType: null,
    membershipExpiresAt: null,
    resetsAt,
    aiGeneration: {
      dailyFree: aiGeneration.dailyFree,
      usedToday: aiGeneration.usedToday,
      purchased: aiGeneration.purchased,
      remaining: availableQuota(aiGeneration),
      resetsAt,
    },
  };
}

function responseQuota(values: QuotaValues): CreateDownloadResponse["quota"] {
  return {
    remaining: availableQuota(values),
    usedToday: values.usedToday,
    purchased: values.purchased,
  };
}

function mapDownload(row: DownloadRow): DownloadRecord {
  if (
    (row.file_type !== "preview" && row.file_type !== "chart" && row.file_type !== "materials" && row.file_type !== "palette")
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

export class PostgresQuotaDownloadService {
  public constructor(
    private readonly pool: Pool,
    private readonly quotaConfig: ServerConfig["quota"],
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getQuota(userId: string): Promise<QuotaResponse> {
    const currentTime = this.now();
    const quotaDate = shanghaiDate(currentTime);
    const user = await this.pool.query("SELECT id FROM pindou_users WHERE id = $1 AND deleted_at IS NULL", [userId]);
    if (!user.rows[0]) throw unauthorized("用户不存在或已失效");
    const [quota, aiQuota] = await Promise.all([
      readQuota(this.pool, userId, "standard_download", quotaDate, this.quotaConfig.dailyStandardDownloads),
      readQuota(this.pool, userId, "ai_generation", quotaDate, this.quotaConfig.dailyAiGenerations),
    ]);
    return quotaResponse(quota, aiQuota, currentTime);
  }

  /**
   * 分页查询下载记录，支持按文件类型与标题模糊匹配（ILIKE 大小写不敏感）。
   * 条件与参数按数组下标拼装占位符，避免字符串拼接导致 SQL 注入。
   */
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

  /**
   * 创建一条下载记录并扣减 1 次下载额度。
   *
   * @param input.idempotencyKey 客户端生成的幂等键；相同 key 重复调用直接返回首次结果，不重复扣费
   * @throws idempotencyConflict 幂等键被不同用户/作品/类型复用
   * @throws notFound 作品不存在或已删除
   * @throws forbidden 作品不属于当前用户
   * @throws quotaInsufficient 当日免费额度与购买额度均已耗尽
   */
  public async createDownload(input: CreateDownloadInput): Promise<CreateDownloadResponse> {
    const currentTime = this.now();
    const quotaDate = shanghaiDate(currentTime);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 事务级 advisory lock：把并发的同一幂等键串行化，防止同一请求被处理两次
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `pindou-download:${input.idempotencyKey}`,
      ]);
      await lockQuotaUser(client, input.userId);

      const existing = await readDownloadByIdempotencyKey(client, input.idempotencyKey);
      if (existing) {
        if (
          existing.user_id !== input.userId
          || existing.work_id !== input.workId
          || existing.file_type !== input.fileType
        ) {
          throw idempotencyConflict();
        }
        await ensureDailyGrant(client, input.userId, "standard_download", quotaDate, this.quotaConfig.dailyStandardDownloads, currentTime);
        const quota = await readQuota(client, input.userId, "standard_download", quotaDate);
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

      await ensureDailyGrant(client, input.userId, "standard_download", quotaDate, this.quotaConfig.dailyStandardDownloads, currentTime);
      const quotaBefore = await readQuota(client, input.userId, "standard_download", quotaDate);
      const bucket = debitBucket(quotaBefore);
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
           id, user_id, quota_kind, type, amount, source, bucket, quota_date, order_id,
           download_record_id, idempotency_key, note, created_at
         )
          VALUES ($1, $2, 'standard_download', 'download_debit', -1, 'download', $3,
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
      const quotaAfter = await readQuota(client, input.userId, "standard_download", quotaDate);
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
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
