import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

export function createEntityId(
  prefix: "usr" | "ses" | "file" | "work" | "dl" | "qt" | "order" | "vpay" | "pa" | "pe" | "aijob" | "sec",
): string {
  return `${prefix}_${randomBytes(15).toString("base64url")}`;
}

/**
 * 微信虚拟支付的商户单号（outTradeNo）。
 *
 * 与订单号**刻意解耦**：微信规定一个 outTradeNo 只能用于一次支付尝试，第二次拿它
 * 拉起支付直接报 -15012（ORDER_CLOSED）。而同一笔订单在用户取消/失败后必然会被
 * 反复拉起，所以每次签发支付参数都要换成全新单号，订单号保持不变。
 *
 * 前缀用 `vpay` 而不是 `order`：两者混用正是此前 -15012 的成因，
 * 单号长得像订单号会让人误以为可以按订单号推导。
 * 位数 = 5 + 20 = 25，落在官方要求的 8-32 位内；base64url 字符集合规（数字、字母、- _），
 * 且不以 `_` 开头。
 */
export function createVirtualOutTradeNo(): string {
  return createEntityId("vpay");
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

/**
 * session_key 的加解密。
 *
 * 密钥 Domain separation：与 openid 用不同的 HKDF info 前缀派生子密钥，
 * 两者即使共用同一个 root secret，密文也无法互换 —— 避免一处密文泄漏导致另一处被伪造。
 * session_key 泄露等同他人可伪造该用户的虚拟支付 signature，因此必须加密存储。
 */
function sessionKeyCipherSecret(secret: string): Buffer {
  return createHash("sha256")
    .update("pindou-session-key-encryption-v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

/**
 * 加密 session_key 以便落库。
 *
 * @returns null 表示输入为空 —— 刻意**不抛错**：session_key 缺失只应导致后续虚拟支付
 *          提示用户重新登录，不应让整个**登录**流程失败。把登录搞挂会波及所有
 *          不需要支付的用户，故障半径远大于问题本身。
 */
export function encryptSessionKey(
  sessionKey: string | null | undefined,
  secret: string,
): string | null {
  if (!sessionKey) return null;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKeyCipherSecret(secret), nonce);
  const ciphertext = Buffer.concat([cipher.update(sessionKey, "utf8"), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  return `v1.${nonce.toString("base64url")}.${Buffer.concat([ciphertext, authenticationTag]).toString("base64url")}`;
}

/**
 * 解密 session_key。
 *
 * @returns null 表示密文缺失或已损坏（**不是抛错**）：session_key 过期在日常很常见，
 *          调用方据此提示用户重新登录即可；若抛错会把登录态过期升级成 500，反而掩盖了真实原因。
 */
export function decryptSessionKey(value: string | null | undefined, secret: string): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null;
  try {
    const nonce = Buffer.from(parts[1], "base64url");
    const encrypted = Buffer.from(parts[2], "base64url");
    if (nonce.length !== 12 || encrypted.length <= 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", sessionKeyCipherSecret(secret), nonce);
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
    return Buffer.concat([
      decipher.update(encrypted.subarray(0, encrypted.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
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
