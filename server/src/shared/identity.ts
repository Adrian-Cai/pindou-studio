import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

export function createEntityId(prefix: "usr" | "ses" | "file" | "work" | "dl" | "qt" | "order" | "aijob" | "sec"): string {
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

export function createIdempotentOrderId(userId: string, idempotencyKey: string): string {
  const digest = createHmac("sha256", "pindou-payment-order-idempotency-v1")
    .update(userId, "utf8")
    .update("\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest("hex");
  return `order_${digest.slice(0, 26)}`;
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

function openidEncryptionKey(secret: string): Buffer {
  return createHash("sha256")
    .update("pindou-openid-encryption-v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

export function encryptOpenid(openid: string, secret: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", openidEncryptionKey(secret), nonce);
  const ciphertext = Buffer.concat([cipher.update(openid, "utf8"), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  return `v1.${nonce.toString("base64url")}.${Buffer.concat([ciphertext, authenticationTag]).toString("base64url")}`;
}

export function decryptOpenid(value: string, secret: string): string {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    throw new Error("openid 密文格式无效");
  }
  const nonce = Buffer.from(parts[1], "base64url");
  const encrypted = Buffer.from(parts[2], "base64url");
  if (nonce.length !== 12 || encrypted.length <= 16) throw new Error("openid 密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", openidEncryptionKey(secret), nonce);
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  return Buffer.concat([
    decipher.update(encrypted.subarray(0, encrypted.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}
