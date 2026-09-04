import { createHash } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { createEntityId, decryptOpenid } from "../../shared/identity";
import { AppError, invalidArgument } from "../../shared/app-error";
import type { ContentSecurityMediaStorage } from "./media-storage";
import type { WeChatContentSecurityClient } from "./wechat-client";

const RISK_MESSAGE = "你发布的内容含违规信息，请修改后重试";
const TEXT_SCENE_WORK_TITLE = 2;
const MEDIA_EXPIRY_MS = 35 * 60 * 1_000;

interface UserIdentityRow extends QueryResultRow {
  readonly openid_ciphertext: string | null;
}

interface CheckRow extends QueryResultRow {
  readonly media_object_key: string | null;
}

export interface ContentSecurityService {
  checkText(userId: string, content: string): Promise<{ readonly safe: true; readonly traceId: string | null }>;
  checkMedia(userId: string, input: { readonly buffer: Buffer; readonly filename: string; readonly contentType: string }): Promise<{ readonly safe: true; readonly checkId: string; readonly traceId: string }>;
  readMedia(path: string): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null>;
  verifyCallback(signature: string | undefined, timestamp: string | undefined, nonce: string | undefined): boolean;
  handleCallback(payload: Record<string, unknown>): Promise<void>;
}

export class PostgresContentSecurityService implements ContentSecurityService {
  public constructor(
    private readonly pool: Pool,
    private readonly client: WeChatContentSecurityClient,
    private readonly mediaStorage: ContentSecurityMediaStorage,
    private readonly appId: string,
    private readonly messageToken: string,
    private readonly openidSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async checkText(userId: string, content: string): Promise<{ readonly safe: true; readonly traceId: string | null }> {
    const normalized = normalizeText(content);
    const openid = await this.openid(userId);
    const result = await this.client.checkText({ openid, content: normalized, scene: TEXT_SCENE_WORK_TITLE });
    await this.record({ userId, kind: "text", traceId: result.traceId, status: result.safe ? "pass" : result.suggest, label: result.label, errorCode: null, mediaObjectKey: null, expiresAt: null });
    if (!result.safe) throw new AppError(400, "CONTENT_RISKY", RISK_MESSAGE);
    return { safe: true, traceId: result.traceId };
  }

  public async checkMedia(userId: string, input: { readonly buffer: Buffer; readonly filename: string; readonly contentType: string }): Promise<{ readonly safe: true; readonly checkId: string; readonly traceId: string }> {
    await this.cleanupExpired();
    const openid = await this.openid(userId);
    const stored = await this.mediaStorage.save(input.buffer, input.filename, input.contentType);
    let traceId = "";
    let checkId = "";
    try {
      const submitted = await this.client.submitMedia({ openid, mediaUrl: stored.publicUrl, scene: TEXT_SCENE_WORK_TITLE });
      traceId = submitted.traceId;
      checkId = createEntityId("sec");
      await this.record({
        id: checkId,
        userId,
        kind: "media",
        traceId,
        status: "pending",
        label: null,
        errorCode: null,
        mediaObjectKey: stored.objectKey,
        expiresAt: new Date(this.now().getTime() + MEDIA_EXPIRY_MS),
      });
      const synchronous = await this.client.checkImage(input.buffer, input.filename, input.contentType);
      if (!synchronous.safe) {
        await this.updateCheck(traceId, synchronous.suggest, synchronous.label, null, false);
        throw new AppError(400, "CONTENT_RISKY", RISK_MESSAGE);
      }
      return { safe: true, checkId, traceId };
    } catch (error: unknown) {
      if (error instanceof AppError && error.code === "CONTENT_RISKY") throw error;
      if (checkId) {
        try {
          await this.updateCheck(traceId, "failed", null, null);
        } catch {
          await this.mediaStorage.remove(stored.objectKey);
        }
      } else {
        await this.mediaStorage.remove(stored.objectKey);
      }
      throw error;
    }
  }

  public readMedia(path: string): Promise<{ readonly buffer: Buffer; readonly contentType: string } | null> {
    return this.mediaStorage.read(path);
  }

  public verifyCallback(signature: string | undefined, timestamp: string | undefined, nonce: string | undefined): boolean {
    if (!signature || !timestamp || !nonce || !this.messageToken) return false;
    const expected = createHash("sha1").update([this.messageToken, timestamp, nonce].sort().join(""), "utf8").digest("hex");
    return expected === signature;
  }

  public async handleCallback(payload: Record<string, unknown>): Promise<void> {
    if (payload.appid !== this.appId || payload.Event !== "wxa_media_check" || typeof payload.trace_id !== "string") return;
    const traceId = payload.trace_id;
    const errcode = typeof payload.errcode === "number" ? payload.errcode : 0;
    const result = isRecord(payload.result) ? payload.result : {};
    const suggest = result.suggest === "risky" || result.suggest === "review" ? result.suggest : errcode === 0 ? "pass" : "failed";
    const label = typeof result.label === "number" ? result.label : null;
    await this.updateCheck(traceId, suggest, label, errcode === 0 ? null : errcode);
  }

  private async openid(userId: string): Promise<string> {
    const result = await this.pool.query<UserIdentityRow>(
      "SELECT openid_ciphertext FROM pindou_users WHERE id = $1 AND deleted_at IS NULL LIMIT 1",
      [userId],
    );
    const encrypted = result.rows[0]?.openid_ciphertext;
    if (!encrypted) throw new AppError(409, "CONTENT_SECURITY_IDENTITY_UNAVAILABLE", "登录身份不可用，请重新登录");
    try {
      return decryptOpenid(encrypted, this.openidSecret);
    } catch {
      throw new AppError(409, "CONTENT_SECURITY_IDENTITY_UNAVAILABLE", "登录身份不可用，请重新登录");
    }
  }

  private async record(input: {
    id?: string;
    userId: string;
    kind: "text" | "media";
    traceId: string | null;
    status: string;
    label: number | null;
    errorCode: number | null;
    mediaObjectKey: string | null;
    expiresAt: Date | null;
  }): Promise<void> {
    const current = this.now();
    await this.pool.query(
      `INSERT INTO pindou_content_security_checks
        (id, user_id, check_type, trace_id, status, label, error_code, media_object_key, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)`,
      [input.id ?? createEntityId("sec"), input.userId, input.kind, input.traceId, input.status, input.label, input.errorCode, input.mediaObjectKey, current, input.expiresAt],
    );
  }

  private async updateCheck(
    traceId: string,
    status: string,
    label: number | null,
    errorCode: number | null,
    removeMedia = true,
  ): Promise<void> {
    const result = await this.pool.query<CheckRow>(
      `UPDATE pindou_content_security_checks
          SET status = CASE WHEN status = 'risky' THEN 'risky' ELSE $2 END,
              label = $3, error_code = $4, updated_at = $5
        WHERE trace_id = $1
          AND status IN ('pending', 'risky')
          AND media_object_key IS NOT NULL
        RETURNING media_object_key`,
      [traceId, status, label, errorCode, this.now()],
    );
    const objectKey = result.rows[0]?.media_object_key;
    if (objectKey && removeMedia) {
      await this.mediaStorage.remove(objectKey);
      await this.pool.query(
        `UPDATE pindou_content_security_checks
            SET media_object_key = NULL
          WHERE trace_id = $1 AND media_object_key = $2`,
        [traceId, objectKey],
      );
    }
  }

  private async cleanupExpired(): Promise<void> {
    const current = this.now();
    const result = await this.pool.query<CheckRow>(
      `UPDATE pindou_content_security_checks
          SET status = 'failed', updated_at = $1
        WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $1
        RETURNING media_object_key`,
      [current],
    );
    await Promise.all(result.rows.map((row) => row.media_object_key ? this.mediaStorage.remove(row.media_object_key) : Promise.resolve()));
  }
}

function normalizeText(value: string): string {
  const normalized = value.trim().normalize("NFC");
  if (!normalized || Array.from(normalized).length > 2_500 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidArgument("待审核文本必须为 1 到 2500 个字符，且不能包含控制字符");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
