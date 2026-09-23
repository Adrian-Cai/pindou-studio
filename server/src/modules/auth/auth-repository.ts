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
import type { Pool, QueryResultRow } from "pg";
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
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly user_deleted_at: Date | null;
}

export interface CreateLoginInput {
  readonly openidHash: string;
  readonly openidCiphertext: string;
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

export interface AuthRepository {
  createLogin(input: CreateLoginInput): Promise<UserRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
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
      const users = await client.query<UserRow>(
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
        [
          input.proposedUserId,
          input.openidHash,
          input.openidCiphertext,
          input.sessionKeyCiphertext,
          input.now,
        ],
      );
      const user = users.rows[0];
      if (!user) throw new Error("用户幂等创建后无法读取记录");
      if (user.deleted_at) throw new AppError(403, "ACCOUNT_DISABLED", "账号不可用");

      await client.query(
        `INSERT INTO pindou_auth_sessions (
           id, user_id, token_hash, expires_at, revoked_at, created_at, last_used_at
         )
         VALUES ($1, $2, $3, $4, NULL, $5, NULL)`,
        [input.sessionId, user.id, input.tokenHash, input.expiresAt, input.now],
      );
      await client.query("COMMIT");
      return userRecord(user);
    } catch (error: unknown) {
      await rollbackTransaction(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 按 token 哈希查会话，并带出用户是否已注销；查不到返回 null（交由上层抛 401）。 */
  public async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT session.user_id,
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
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      userDeletedAt: row.user_deleted_at,
    };
  }
}
