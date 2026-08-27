import { createHash, createHmac, randomBytes } from "node:crypto";

export function createEntityId(prefix: "usr" | "ses"): string {
  return `${prefix}_${randomBytes(15).toString("base64url")}`;
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
