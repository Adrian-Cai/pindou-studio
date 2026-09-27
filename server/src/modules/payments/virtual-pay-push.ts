import { createDecipheriv, createHash } from "node:crypto";
import { AppError } from "../../shared/app-error";

/**
 * 虚拟支付消息推送的握手校验与消息解密。
 *
 * 为什么单独成文件：MP 后台「消息推送配置」保存时会先对 URL 发一次 GET 握手，
 * 只有服务端按 SHA1(token, timestamp, nonce) 校验通过并**原样回显 echostr**，
 * 配置才会生效；没有这一步，后面的发货 / 退款 / iOS 问询推送一条都收不到。
 * 而一旦后台选了安全模式，POST 过来的又是 AES 密文，取不到 Event 就等于全部漏处理。
 * 这两件事都属于「协议编解码」，跟订单业务无关，放在 payment-service 里会把它撑成两坨。
 */

/** EncodingAESKey 固定 43 个 base64 字符，补一个 "=" 后正好解出 32 字节密钥。 */
const ENCODING_AES_KEY_LENGTH = 43;
const AES_KEY_BYTES = 32;
/** 解密后明文前缀：16 字节随机串 + 4 字节大端长度。 */
const MESSAGE_HEADER_BYTES = 20;

export interface VirtualPayPushCredentials {
  /** MP 后台「消息推送」里填的 Token。空串表示未配置。 */
  readonly token: string;
  /** MP 后台的 EncodingAESKey。空串表示后台选的是明文模式。 */
  readonly encodingAesKey: string;
  /** 解密后要核对的 AppId，用于确认这条消息确实是投给本小程序的。 */
  readonly appId: string;
}

export interface PushQueryParameters {
  readonly signature?: string | undefined;
  readonly msgSignature?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly nonce?: string | undefined;
}

/**
 * 明文模式的来源校验：SHA1(字典序排序后的 token、timestamp、nonce 直接拼接)。
 *
 * 与微信官方口径一致 —— 三个参数排序后**无分隔符**拼接，这一点错了就永远验不过。
 */
export function verifyPushSignature(
  token: string,
  parameters: PushQueryParameters,
): boolean {
  const { signature, timestamp, nonce } = parameters;
  if (!token || !signature || !timestamp || !nonce) return false;
  return sha1Hex([token, timestamp, nonce]) === signature.toLowerCase();
}

/**
 * 安全模式的来源校验：msg_signature 把密文也算进签名里，
 * 因此换一封密文重放会验不过，比明文模式的 signature 更严。
 */
export function verifyPushMessageSignature(
  token: string,
  parameters: PushQueryParameters,
  ciphertext: string,
): boolean {
  const { msgSignature, timestamp, nonce } = parameters;
  if (!token || !msgSignature || !timestamp || !nonce) return false;
  return sha1Hex([token, timestamp, nonce, ciphertext]) === msgSignature.toLowerCase();
}

/**
 * 判断一次推送请求是否来自微信，并按需选择校验方式。
 *
 * 支付和退款推送必须 fail closed：没有 Token 或签名时拒绝；安全模式下必须验证
 * 覆盖密文的 msg_signature，不能退回只覆盖 timestamp/nonce 的明文签名。
 */
export function verifyPushRequest(
  credentials: VirtualPayPushCredentials,
  parameters: PushQueryParameters,
  ciphertext: string | null,
): boolean {
  if (!credentials.token) return false;
  if (ciphertext) return verifyPushMessageSignature(credentials.token, parameters, ciphertext);
  return verifyPushSignature(credentials.token, parameters);
}

/**
 * 从推送体里取出密文；返回 null 表示这是明文推送。
 *
 * 安全模式下**无论数据格式选 XML 还是 JSON**，消息体都是密文，区别只在包装：
 * XML 是 <Encrypt>，JSON 是 Encrypt 字段。
 */
export function extractPushCiphertext(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).Encrypt;
    return typeof value === "string" && value ? value : null;
  }

  const matched = /<Encrypt>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/Encrypt>/.exec(trimmed);
  return matched?.[1]?.trim() || null;
}

/**
 * 解开安全模式的消息体，返回可直接交给解析层的明文（JSON 或 XML）。
 *
 * 密钥 = base64decode(EncodingAESKey + "=")，IV = 密钥前 16 字节，算法 AES-256-CBC。
 * 明文布局：random(16B) + msg_len(4B 大端) + msg + appid，**末尾的 appid 一定要比对**：
 * 少了这一步，别的小程序拿自己的消息投过来我们也会照单全收。
 */
export function decryptPushBody(
  ciphertext: string,
  encodingAesKey: string,
  expectedAppId: string,
): string {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== AES_KEY_BYTES) {
    throw new AppError(
      500,
      "VIRTUAL_PAY_PUSH_KEY_INVALID",
      `VIRTUAL_PAY_ENCODING_AES_KEY 必须是 ${ENCODING_AES_KEY_LENGTH} 个字符`,
    );
  }

  let decrypted: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  } catch {
    throw new AppError(400, "VIRTUAL_PAY_PUSH_DECRYPT_FAILED", "虚拟支付推送解密失败");
  }

  if (decrypted.length < MESSAGE_HEADER_BYTES) {
    throw new AppError(400, "VIRTUAL_PAY_PUSH_DECRYPT_FAILED", "虚拟支付推送解密结果长度异常");
  }
  const length = decrypted.readUInt32BE(16);
  if (length < 0 || MESSAGE_HEADER_BYTES + length > decrypted.length) {
    throw new AppError(400, "VIRTUAL_PAY_PUSH_DECRYPT_FAILED", "虚拟支付推送解密结果长度异常");
  }

  const appId = decrypted.subarray(MESSAGE_HEADER_BYTES + length).toString("utf8");
  if (expectedAppId && appId !== expectedAppId) {
    throw new AppError(403, "VIRTUAL_PAY_PUSH_APP_ID_MISMATCH", "虚拟支付推送的 AppId 不匹配");
  }
  return decrypted.subarray(MESSAGE_HEADER_BYTES, MESSAGE_HEADER_BYTES + length).toString("utf8");
}

function sha1Hex(parts: readonly string[]): string {
  return createHash("sha1").update([...parts].sort().join(""), "utf8").digest("hex");
}
