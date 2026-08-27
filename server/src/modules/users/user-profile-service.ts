import type { Pool, QueryResultRow } from "pg";
import type { ServerConfig } from "../../config/env";
import { unauthorized } from "../../shared/app-error";
import { nextShanghaiMidnight, shanghaiDate } from "../../shared/shanghai-time";

interface ProfileRow extends QueryResultRow {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatar_url: string | null;
  readonly created_at: Date;
  readonly work_count: string;
  readonly favorite_count: string;
  readonly download_count: string;
}

interface UserRow extends QueryResultRow {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatar_url: string | null;
  readonly created_at: Date;
}

interface QuotaRow extends QueryResultRow {
  readonly used_today: string;
  readonly purchased: string;
}

export interface CurrentUserResponse {
  readonly user: {
    readonly id: string;
    readonly nickname: string | null;
    readonly avatarUrl: string | null;
    readonly createdAt: string;
  };
  readonly stats: {
    readonly workCount: number;
    readonly favoriteCount: number;
    readonly downloadCount: number;
  };
  readonly quota: {
    readonly dailyFree: number;
    readonly usedToday: number;
    readonly purchased: number;
    readonly remaining: number;
    readonly resetsAt: string;
  };
}

export type CurrentUser = CurrentUserResponse["user"];

export interface AvatarUpdateResult {
  readonly user: CurrentUser;
  readonly previousAvatarUrl: string | null;
}

export interface UserProfileReader {
  getCurrentUser(userId: string): Promise<CurrentUserResponse>;
}

export interface UserProfileWriter {
  updateNickname(userId: string, nickname: string): Promise<CurrentUser>;
  updateProfileWithAvatar(
    userId: string,
    nickname: string,
    avatarUrl: string,
  ): Promise<AvatarUpdateResult>;
}

export type UserProfileService = UserProfileReader & UserProfileWriter;

function nonNegativeInteger(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export class PostgresUserProfileService implements UserProfileService {
  public constructor(
    private readonly pool: Pool,
    private readonly quotaConfig: ServerConfig["quota"],
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getCurrentUser(userId: string): Promise<CurrentUserResponse> {
    const currentTime = this.now();
    const [profileResult, quotaResult] = await Promise.all([
      this.pool.query<ProfileRow>(
        `SELECT users.id,
                users.nickname,
                users.avatar_url,
                users.created_at,
                (SELECT COUNT(*)
                   FROM pindou_works works
                  WHERE works.user_id = users.id AND works.deleted_at IS NULL) AS work_count,
                (SELECT COUNT(*)
                   FROM pindou_favorites favorites
                   JOIN pindou_works works ON works.id = favorites.work_id
                  WHERE favorites.user_id = users.id AND works.deleted_at IS NULL) AS favorite_count,
                (SELECT COUNT(*)
                   FROM pindou_download_records downloads
                  WHERE downloads.user_id = users.id) AS download_count
           FROM pindou_users users
          WHERE users.id = $1 AND users.deleted_at IS NULL
          LIMIT 1`,
        [userId],
      ),
      this.pool.query<QuotaRow>(
        `SELECT COALESCE(
                  -SUM(amount) FILTER (
                    WHERE bucket = 'daily_free' AND quota_date = $2::date AND amount < 0
                  ),
                  0
                )::text AS used_today,
                COALESCE(SUM(amount) FILTER (WHERE bucket = 'purchased'), 0)::text AS purchased
           FROM pindou_quota_transactions
          WHERE user_id = $1`,
        [userId, shanghaiDate(currentTime)],
      ),
    ]);

    const profile = profileResult.rows[0];
    if (!profile) throw unauthorized("用户不存在或已失效");
    const quota = quotaResult.rows[0];
    const usedToday = nonNegativeInteger(quota?.used_today ?? "0");
    const purchased = nonNegativeInteger(quota?.purchased ?? "0");
    const dailyRemaining = Math.max(0, this.quotaConfig.dailyFree - usedToday);

    return {
      user: {
        id: profile.id,
        nickname: profile.nickname,
        avatarUrl: profile.avatar_url,
        createdAt: profile.created_at.toISOString(),
      },
      stats: {
        workCount: nonNegativeInteger(profile.work_count),
        favoriteCount: nonNegativeInteger(profile.favorite_count),
        downloadCount: nonNegativeInteger(profile.download_count),
      },
      quota: {
        dailyFree: this.quotaConfig.dailyFree,
        usedToday,
        purchased,
        remaining: dailyRemaining + purchased,
        resetsAt: nextShanghaiMidnight(currentTime),
      },
    };
  }

  public async updateNickname(userId: string, nickname: string): Promise<CurrentUser> {
    const result = await this.pool.query<UserRow>(
      `UPDATE pindou_users
          SET nickname = $2, updated_at = $3
        WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, nickname, avatar_url, created_at`,
      [userId, nickname, this.now()],
    );
    const user = result.rows[0];
    if (!user) throw unauthorized("用户不存在或已失效");
    return mapUser(user);
  }

  public async updateProfileWithAvatar(
    userId: string,
    nickname: string,
    avatarUrl: string,
  ): Promise<AvatarUpdateResult> {
    const result = await this.pool.query<UserRow & { readonly previous_avatar_url: string | null }>(
      `WITH previous AS (
         SELECT avatar_url
           FROM pindou_users
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE
       ), updated AS (
         UPDATE pindou_users
            SET nickname = $2, avatar_url = $3, updated_at = $4
          WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, nickname, avatar_url, created_at
       )
       SELECT updated.*, previous.avatar_url AS previous_avatar_url
         FROM updated, previous`,
      [userId, nickname, avatarUrl, this.now()],
    );
    const user = result.rows[0];
    if (!user) throw unauthorized("用户不存在或已失效");
    return { user: mapUser(user), previousAvatarUrl: user.previous_avatar_url };
  }
}

function mapUser(row: UserRow): CurrentUser {
  return {
    id: row.id,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at.toISOString(),
  };
}
