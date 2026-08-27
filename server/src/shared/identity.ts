import { createHash, createHmac, randomBytes } from "node:crypto";

export function createEntityId(prefix: "usr" | "ses" | "file" | "work"): string {
  return `${prefix}_${randomBytes(15).toString("base64url")}`;
}

export function createIdempotentWorkId(userId: string, idempotencyKey: string): string {
  const digest = createHmac("sha256", "pindou-work-idempotency-v1")
    .update(userId, "utf8")
    .update("\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest("hex");
  return `work_${digest.slice(0, 27)}`;
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashOpenid(openid: string, secret: string): string {
  return createHmac("sha256", secret).update(openid, "utf8").digest("hex");
}
