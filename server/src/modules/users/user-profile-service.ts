import type { Pool, QueryResultRow } from "pg";
import type { ServerConfig } from "../../config/env";
import { unauthorized } from "../../shared/app-error";
import { nextShanghaiMidnight, shanghaiDate } from "../../shared/shanghai-time";
import { rollbackTransaction } from "../../shared/transaction";

interface ProfileRow extends QueryResultRow {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatar_url: string | null;
  readonly created_at: Date;
  readonly updated_at?: Date;
  readonly work_count: string;
  readonly favorite_count: string;
  readonly download_count: string;
  readonly privacy_local_only: boolean | null;
  readonly privacy_cloud_sync: boolean | null;
  readonly privacy_service_notices: boolean | null;
  readonly privacy_personalized_recommendations: boolean | null;
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
  readonly privacy: PrivacyPreferences;
}

export interface PrivacyPreferences {
  readonly localOnly: boolean;
  readonly cloudSync: boolean;
  readonly serviceNotices: boolean;
  readonly personalizedRecommendations: boolean;
  readonly updatedAt: string;
}

export type PrivacyPreferencesPatch = Partial<Pick<
  PrivacyPreferences,
  "localOnly" | "cloudSync" | "serviceNotices" | "personalizedRecommendations"
>>;

export type CurrentUser = CurrentUserResponse["user"];

export interface AvatarUpdateResult {
  readonly user: CurrentUser;
  readonly previousAvatarUrl: string | null;
}

export interface UserProfileReader {
  getCurrentUser(userId: string): Promise<CurrentUserResponse>;
  getPrivacyPreferences(userId: string): Promise<PrivacyPreferences>;
}

export interface UserProfileWriter {
  updateNickname(userId: string, nickname: string): Promise<CurrentUser>;
  updateProfileWithAvatar(
    userId: string,
    nickname: string,
    avatarUrl: string,
  ): Promise<AvatarUpdateResult>;
  updatePrivacyPreferences(userId: string, patch: PrivacyPreferencesPatch): Promise<PrivacyPreferences>;
  deleteAccount(userId: string): Promise<void>;
}

export type UserProfileService = UserProfileReader & UserProfileWriter;

function nonNegativeInteger(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

const DEFAULT_PRIVACY_PREFERENCES = {
  localOnly: true,
  cloudSync: false,
  serviceNotices: true,
  personalizedRecommendations: false,
} as const;

interface PrivacyRow extends QueryResultRow {
  readonly privacy_local_only: boolean | null;
  readonly privacy_cloud_sync: boolean | null;
  readonly privacy_service_notices: boolean | null;
  readonly privacy_personalized_recommendations: boolean | null;
  readonly updated_at?: Date;
  readonly created_at?: Date;
}

function mapPrivacy(row: PrivacyRow): PrivacyPreferences {
  return {
    localOnly: row.privacy_local_only ?? DEFAULT_PRIVACY_PREFERENCES.localOnly,
    cloudSync: row.privacy_cloud_sync ?? DEFAULT_PRIVACY_PREFERENCES.cloudSync,
    serviceNotices: row.privacy_service_notices ?? DEFAULT_PRIVACY_PREFERENCES.serviceNotices,
    personalizedRecommendations: row.privacy_personalized_recommendations ?? DEFAULT_PRIVACY_PREFERENCES.personalizedRecommendations,
    updatedAt: (row.updated_at ?? row.created_at ?? new Date(0)).toISOString(),
  };
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
                users.updated_at,
                users.privacy_local_only,
                users.privacy_cloud_sync,
                users.privacy_service_notices,
                users.privacy_personalized_recommendations,
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
                    WHERE quota_kind = 'standard_download'
                      AND bucket = 'daily_free' AND quota_date = $2::date AND amount < 0
                  ),
                  0
                )::text AS used_today,
                  COALESCE(SUM(amount) FILTER (
                    WHERE quota_kind = 'standard_download' AND bucket = 'purchased'
                  ), 0)::text AS purchased
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
    const dailyRemaining = Math.max(0, this.quotaConfig.dailyStandardDownloads - usedToday);

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
        dailyFree: this.quotaConfig.dailyStandardDownloads,
        usedToday,
        purchased,
        remaining: dailyRemaining + purchased,
        resetsAt: nextShanghaiMidnight(currentTime),
      },
      privacy: mapPrivacy(profile),
    };
  }

  public async getPrivacyPreferences(userId: string): Promise<PrivacyPreferences> {
    const result = await this.pool.query<PrivacyRow>(
      `SELECT privacy_local_only,
              privacy_cloud_sync,
              privacy_service_notices,
              privacy_personalized_recommendations,
              updated_at
         FROM pindou_users
        WHERE id = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw unauthorized("用户不存在或已失效");
    return mapPrivacy(row);
  }

  public async updatePrivacyPreferences(
    userId: string,
    patch: PrivacyPreferencesPatch,
  ): Promise<PrivacyPreferences> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<PrivacyRow>(
        `SELECT privacy_local_only,
                privacy_cloud_sync,
                privacy_service_notices,
                privacy_personalized_recommendations,
                updated_at
           FROM pindou_users
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [userId],
      );
      const current = result.rows[0];
      if (!current) throw unauthorized("用户不存在或已失效");
      const next = {
        localOnly: patch.localOnly ?? current.privacy_local_only ?? DEFAULT_PRIVACY_PREFERENCES.localOnly,
        cloudSync: patch.cloudSync ?? current.privacy_cloud_sync ?? DEFAULT_PRIVACY_PREFERENCES.cloudSync,
        serviceNotices: patch.serviceNotices ?? current.privacy_service_notices ?? DEFAULT_PRIVACY_PREFERENCES.serviceNotices,
        personalizedRecommendations: patch.personalizedRecommendations ?? current.privacy_personalized_recommendations ?? DEFAULT_PRIVACY_PREFERENCES.personalizedRecommendations,
      };
      if (patch.localOnly === true) next.cloudSync = false;
      if (patch.cloudSync === true) next.localOnly = false;
      const updated = await client.query<PrivacyRow>(
        `UPDATE pindou_users
            SET privacy_local_only = $2,
                privacy_cloud_sync = $3,
                privacy_service_notices = $4,
                privacy_personalized_recommendations = $5,
                updated_at = $6
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING privacy_local_only,
                  privacy_cloud_sync,
                  privacy_service_notices,
                  privacy_personalized_recommendations,
                  updated_at`,
        [userId, next.localOnly, next.cloudSync, next.serviceNotices, next.personalizedRecommendations, this.now()],
      );
      await client.query("COMMIT");
      const row = updated.rows[0];
      if (!row) throw unauthorized("用户不存在或已失效");
      return mapPrivacy(row);
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async deleteAccount(userId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = this.now();
      const user = await client.query(
        `UPDATE pindou_users
            SET deleted_at = COALESCE(deleted_at, $2),
                nickname = NULL,
                avatar_url = NULL,
                openid_ciphertext = NULL,
                updated_at = $2
          WHERE id = $1
        RETURNING id`,
        [userId, now],
      );
      if (user.rowCount === 0) throw unauthorized("用户不存在或已失效");
      await client.query(
        `UPDATE pindou_auth_sessions
            SET revoked_at = COALESCE(revoked_at, $2)
          WHERE user_id = $1`,
        [userId, now],
      );
      await client.query(
        `UPDATE pindou_works
            SET deleted_at = COALESCE(deleted_at, $2), updated_at = $2
          WHERE user_id = $1`,
        [userId, now],
      );
      await client.query("DELETE FROM pindou_favorites WHERE user_id = $1", [userId]);
      await client.query(
        `UPDATE pindou_file_assets
            SET deleted_at = COALESCE(deleted_at, $2)
          WHERE user_id = $1`,
        [userId, now],
      );
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
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
