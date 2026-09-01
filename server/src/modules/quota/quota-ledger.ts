import type { Pool, PoolClient, QueryResultRow } from "pg";
import { unauthorized } from "../../shared/app-error";
import { createEntityId } from "../../shared/identity";

export type QuotaKind = "standard_download" | "ai_generation";
export type QuotaBucket = "daily_free" | "purchased";

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

export async function readQuota(
  client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  userId: string,
  quotaKind: QuotaKind,
  quotaDate: string,
): Promise<QuotaValues> {
  const result = await client.query<QuotaRow>(
    `SELECT COALESCE(
              SUM(amount) FILTER (
                WHERE bucket = 'daily_free'
                  AND quota_date = $3::date
                  AND type = 'daily_grant'
              ),
              0
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
            )::text AS daily_remaining,
            COALESCE(SUM(amount) FILTER (WHERE bucket = 'purchased'), 0)::text AS purchased
       FROM pindou_quota_transactions
      WHERE user_id = $1 AND quota_kind = $2`,
    [userId, quotaKind, quotaDate],
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

export function debitBucket(quota: QuotaValues): QuotaBucket | null {
  if (quota.dailyRemaining > 0) return "daily_free";
  if (quota.purchased > 0) return "purchased";
  return null;
}
