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

  public async createLogin(input: CreateLoginInput): Promise<UserRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const users = await client.query<UserRow>(
        `INSERT INTO pindou_users (
           id, openid_hash, openid_ciphertext, nickname, avatar_url, created_at, updated_at, deleted_at
         )
         VALUES ($1, $2, $3, NULL, NULL, $4, $4, NULL)
         ON CONFLICT (openid_hash) DO UPDATE
           SET openid_ciphertext = EXCLUDED.openid_ciphertext,
               updated_at = EXCLUDED.updated_at
         RETURNING id, nickname, avatar_url, deleted_at`,
        [input.proposedUserId, input.openidHash, input.openidCiphertext, input.now],
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
