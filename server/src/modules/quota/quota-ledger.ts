/**
 * 额度账本：以「流水账」方式管理用户的下载次数与 AI 生成次数。
 *
 * 职责：只做额度的发放（每日免费额度）、读取与扣减桶判定，不直接写扣减流水（由各业务服务自己写 transaction）。
 * 调用方：downloads/quota-download-service（下载扣次）、payments/payment-service（充值到账）、
 *         http 路由层（查询额度）。
 * 关键点：额度不存余额字段，而是对 pindou_quota_transactions 求和得出，避免并发下余额被覆盖；
 *         所有调用方必须先 lockQuotaUser 行锁用户，再读写额度；
 *         PG 的 bigint 返回为字符串，统一经 nonNegativeInteger 转换，防止 JS 数值精度问题。
 */
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { unauthorized } from "../../shared/app-error";
import { createEntityId } from "../../shared/identity";

/** 额度种类：标准模式下载次数、AI 生成次数。 */
export type QuotaKind = "standard_download" | "ai_generation";
/** 额度桶：每日免费额度、购买所得额度；扣减时优先用免费额度。 */
export type QuotaBucket = "daily_free" | "purchased";

/** 额度聚合查询的单行结果，PG bigint 以字符串返回。 */
interface QuotaRow extends QueryResultRow {
  readonly daily_free: string;
  readonly used_today: string;
  readonly daily_remaining: string;
  readonly purchased: string;
}

export interface QuotaValues {
  readonly dailyFree: number;
  readonly usedToday: number;
  readonly dailyRemaining: number;
  readonly purchased: number;
}

function nonNegativeInteger(value: string | number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 对额度用户加行锁（SELECT ... FOR UPDATE），必须在同一事务内先于任何额度读写调用。
 * 用户不存在或已软删除时抛 401，防止给失效用户记账。
 */
export async function lockQuotaUser(client: PoolClient, userId: string): Promise<void> {
  const result = await client.query(
    `SELECT id
       FROM pindou_users
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [userId],
  );
  if (!result.rows[0]) throw unauthorized("用户不存在或已失效");
}

export async function ensureDailyGrant(
  client: PoolClient,
  userId: string,
  quotaKind: QuotaKind,
  quotaDate: string,
  amount: number,
  currentTime: Date,
): Promise<void> {
  if (amount <= 0) return;
  await client.query(
    `INSERT INTO pindou_quota_transactions (
       id, user_id, quota_kind, type, amount, source, bucket, quota_date, order_id,
       download_record_id, idempotency_key, note, created_at
     )
     VALUES ($1, $2, $3, 'daily_grant', $4, 'daily_free', 'daily_free', $5::date,
             NULL, NULL, NULL, NULL, $6)
     ON CONFLICT DO NOTHING`,
    [createEntityId("qt"), userId, quotaKind, amount, quotaDate, currentTime],
  );
}

/**
 * 聚合某用户某类额度的当前状态。
 * 未落账时只读预览配置中的每日额度；已发放则以流水为准，消费仍先发放再读取。
 * 注意：purchased（购买所得）不受 quota_date 限制，只有 daily_free 才按天统计并跨天重置。
 */
export async function readQuota(
  client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  userId: string,
  quotaKind: QuotaKind,
  quotaDate: string,
  defaultDailyFree = 0,
): Promise<QuotaValues> {
  const result = await client.query<QuotaRow>(
    `SELECT COALESCE(
              SUM(amount) FILTER (
                WHERE bucket = 'daily_free'
                  AND quota_date = $3::date
                  AND type = 'daily_grant'
              ),
              $4::int
            )::text AS daily_free,
            COALESCE(
              -SUM(amount) FILTER (
                WHERE bucket = 'daily_free'
                  AND quota_date = $3::date
                  AND amount < 0
              ),
              0
            )::text AS used_today,
            COALESCE(
              SUM(amount) FILTER (
                WHERE bucket = 'daily_free' AND quota_date = $3::date
              ),
              0
            ) + CASE WHEN COUNT(*) FILTER (
                WHERE bucket = 'daily_free' AND quota_date = $3::date AND type = 'daily_grant'
              ) = 0 THEN $4::int ELSE 0 END AS daily_remaining,
            COALESCE(SUM(amount) FILTER (WHERE bucket = 'purchased'), 0)::text AS purchased
       FROM pindou_quota_transactions
      WHERE user_id = $1 AND quota_kind = $2`,
    [userId, quotaKind, quotaDate, defaultDailyFree],
  );
  const row = result.rows[0];
  return {
    dailyFree: nonNegativeInteger(row?.daily_free ?? "0"),
    usedToday: nonNegativeInteger(row?.used_today ?? "0"),
    dailyRemaining: nonNegativeInteger(row?.daily_remaining ?? "0"),
    purchased: nonNegativeInteger(row?.purchased ?? "0"),
  };
}

export function availableQuota(quota: QuotaValues): number {
  return quota.dailyRemaining + quota.purchased;
}

/** 决定本次扣减走哪个桶：先用免费额度，用完再用购买额度；都为 0 时返回 null 表示额度不足。 */
export function debitBucket(quota: QuotaValues): QuotaBucket | null {
  if (quota.dailyRemaining > 0) return "daily_free";
  if (quota.purchased > 0) return "purchased";
  return null;
}
