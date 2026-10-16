/**
 * 认证仓储：用户与登录会话的持久化。
 *
 * 职责：只做 pindou_users / pindou_auth_sessions 两表的读写；不负责微信 code2session 调用
 *      （见 wechat-client）与 token 签发（见 authenticator）。
 * 调用方：auth/auth-service（登录流程编排）。
 * 关键点：用户靠 openid_hash 唯一，同一微信号重复登录走 UPSERT，不会重复建号；
 *         只存 openid 的哈希与密文，不明文落库；token 同样只存哈希，泄露数据库也无法伪造登录态；
 *         会话是否过期/吊销/用户注销由 authenticator 判定，这里只原样返回字段。
 */
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { AppError } from "../../shared/app-error";
import { rollbackTransaction } from "../../shared/transaction";
import type { SessionRecord, UserRecord } from "./types";

interface UserRow extends QueryResultRow {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatar_url: string | null;
  readonly deleted_at: Date | null;
}

interface SessionRow extends QueryResultRow {
  readonly user_id: string;
  readonly login_provider: "wechat" | "qq";
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly user_deleted_at: Date | null;
}

export interface CreateLoginInput {
  readonly provider: "wechat" | "qq";
  readonly identityHash: string;
  readonly identityCiphertext: string;
  /**
   * 加密后的 session_key。可为 null（未能取到登录态密钥），
   * 此时仍应完成登录，虚拟支付环节再提示用户重新登录。
   */
  readonly sessionKeyCiphertext: string | null;
  readonly proposedUserId: string;
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly now: Date;
  readonly expiresAt: Date;
}

export interface CreateQqLinkCodeInput {
  readonly userId: string;
  readonly codeHash: string;
  readonly now: Date;
  readonly expiresAt: Date;
}

export interface LinkQqAndCreateLoginInput extends CreateLoginInput {
  readonly provider: "qq";
  readonly linkCodeHash: string;
}

export interface AuthRepository {
  createLogin(input: CreateLoginInput): Promise<UserRecord>;
  createQqLinkCode(input: CreateQqLinkCodeInput): Promise<void>;
  linkQqAndCreateLogin(input: LinkQqAndCreateLoginInput): Promise<UserRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /** 按 token 哈希吊销单个会话。 */
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  /** 吊销指定用户的所有会话。 */
  revokeUserSessions(userId: string, now: Date): Promise<void>;
}

function userRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    deletedAt: row.deleted_at,
  };
}

export class PostgresAuthRepository implements AuthRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * 登录落库：同一事务内「幂等创建/更新用户」+「插入会话」。
   * 用户已软删除时抛 403 ACCOUNT_DISABLED，会话也不会创建。
   */
  public async createLogin(input: CreateLoginInput): Promise<UserRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const users = input.provider === "wechat"
        ? await client.query<UserRow>(
            `INSERT INTO pindou_users (
               id, openid_hash, openid_ciphertext, session_key_ciphertext,
               nickname, avatar_url, created_at, updated_at, deleted_at
             )
             VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5, NULL)
             ON CONFLICT (openid_hash) DO UPDATE
               SET openid_ciphertext = EXCLUDED.openid_ciphertext,
                   session_key_ciphertext = EXCLUDED.session_key_ciphertext,
                   updated_at = EXCLUDED.updated_at
             RETURNING id, nickname, avatar_url, deleted_at`,
            [input.proposedUserId, input.identityHash, input.identityCiphertext, input.sessionKeyCiphertext, input.now],
          )
        : await client.query<UserRow>(
            `INSERT INTO pindou_users (
               id, qq_openid_hash, qq_openid_ciphertext,
               nickname, avatar_url, created_at, updated_at, deleted_at
             )
             VALUES ($1, $2, $3, NULL, NULL, $4, $4, NULL)
             ON CONFLICT (qq_openid_hash) WHERE qq_openid_hash IS NOT NULL DO UPDATE
               SET qq_openid_ciphertext = EXCLUDED.qq_openid_ciphertext,
                   updated_at = EXCLUDED.updated_at
             RETURNING id, nickname, avatar_url, deleted_at`,
            [input.proposedUserId, input.identityHash, input.identityCiphertext, input.now],
          );
      const user = users.rows[0];
      if (!user) throw new Error("用户幂等创建后无法读取记录");
      if (user.deleted_at) throw new AppError(403, "ACCOUNT_DISABLED", "账号不可用");

      await this.insertSession(client, input, user.id);
      await client.query("COMMIT");
      return userRecord(user);
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async createQqLinkCode(input: CreateQqLinkCodeInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query<{ readonly id: string }>(
        `SELECT id
           FROM pindou_users
          WHERE id = $1 AND deleted_at IS NULL
            AND openid_hash IS NOT NULL AND qq_openid_hash IS NULL
          FOR UPDATE`,
        [input.userId],
      );
      if (!user.rows[0]) {
        throw new AppError(409, "QQ_LINK_UNAVAILABLE", "该账号无法创建 QQ 绑定码");
      }
      await client.query(
        `DELETE FROM pindou_qq_link_challenges
          WHERE user_id = $1 AND consumed_at IS NULL`,
        [input.userId],
      );
      await client.query(
        `INSERT INTO pindou_qq_link_challenges (token_hash, user_id, expires_at, consumed_at, created_at)
         VALUES ($1, $2, $3, NULL, $4)`,
        [input.codeHash, input.userId, input.expiresAt, input.now],
      );
      await client.query("COMMIT");
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async linkQqAndCreateLogin(input: LinkQqAndCreateLoginInput): Promise<UserRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const challenge = await client.query<{ readonly user_id: string }>(
        `SELECT user_id
           FROM pindou_qq_link_challenges
          WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
          FOR UPDATE`,
        [input.linkCodeHash, input.now],
      );
      const challengeRow = challenge.rows[0];
      if (!challengeRow) throw new AppError(409, "QQ_LINK_CODE_INVALID", "QQ 绑定码无效或已过期");

      const users = await client.query<UserRow & { readonly qq_openid_hash: string | null }>(
        `SELECT id, nickname, avatar_url, deleted_at, qq_openid_hash
           FROM pindou_users WHERE id = $1 FOR UPDATE`,
        [challengeRow.user_id],
      );
      const user = users.rows[0];
      if (!user || user.deleted_at) throw new AppError(409, "QQ_LINK_CODE_INVALID", "QQ 绑定码无效或已过期");

      const existing = await client.query<{ readonly id: string }>(
        `SELECT id FROM pindou_users WHERE qq_openid_hash = $1 FOR UPDATE`,
        [input.identityHash],
      );
      if (existing.rows[0] && existing.rows[0].id !== user.id) {
        throw new AppError(409, "QQ_IDENTITY_CONFLICT", "该 QQ 账号已绑定到其他账号");
      }
      if (!existing.rows[0]) {
        await client.query(
          `UPDATE pindou_users
              SET qq_openid_hash = $2, qq_openid_ciphertext = $3, updated_at = $4
            WHERE id = $1`,
          [user.id, input.identityHash, input.identityCiphertext, input.now],
        );
      }
      await this.insertSession(client, input, user.id);
      await client.query(
        `UPDATE pindou_qq_link_challenges SET consumed_at = $2 WHERE token_hash = $1`,
        [input.linkCodeHash, input.now],
      );
      await client.query("COMMIT");
      return userRecord(user);
    } catch (error: unknown) {
      await rollbackTransaction(client);
      if (isQqIdentityUniqueViolation(error)) {
        throw new AppError(409, "QQ_IDENTITY_CONFLICT", "该 QQ 账号已绑定到其他账号");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertSession(
    client: PoolClient,
    input: CreateLoginInput,
    userId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO pindou_auth_sessions (
         id, user_id, token_hash, login_provider, expires_at, revoked_at, created_at, last_used_at
       )
       VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL)`,
      [input.sessionId, userId, input.tokenHash, input.provider, input.expiresAt, input.now],
    );
  }

  /** 按 token 哈希查会话，并带出用户是否已注销；查不到返回 null（交由上层抛 401）。 */
  public async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT session.user_id,
              session.login_provider,
              session.expires_at,
              session.revoked_at,
              users.deleted_at AS user_deleted_at
         FROM pindou_auth_sessions session
         JOIN pindou_users users ON users.id = session.user_id
        WHERE session.token_hash = $1
        LIMIT 1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      provider: row.login_provider,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      userDeletedAt: row.user_deleted_at,
    };
  }

  /** 吊销单个会话；已吊销或不存在也视为目标状态已达成。 */
  public async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE pindou_auth_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
        WHERE token_hash = $1`,
      [tokenHash, now],
    );
  }

  /** 吊销该用户的全部会话，包含当前设备。 */
  public async revokeUserSessions(userId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE pindou_auth_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
        WHERE user_id = $1`,
      [userId, now],
    );
  }
}

function isQqIdentityUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === "23505"
    && "constraint" in error && error.constraint === "uq_pindou_users_qq_openid_hash";
}
