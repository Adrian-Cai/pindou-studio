import {
  createDecipheriv,
  randomBytes,
  sign as createSignature,
  verify as verifySignature,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { AppError } from "../../shared/app-error";
import type { WeChatPayConfig } from "../../config/env";

export interface PaymentParameters {
  readonly timeStamp: string;
  readonly nonceStr: string;
  readonly package: string;
  readonly signType: "RSA";
  readonly paySign: string;
}

export interface CreateWeChatPaymentInput {
  readonly orderId: string;
  readonly description: string;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly payerOpenid: string;
}

export interface VerifiedPaymentNotification {
  readonly eventType: string;
  readonly merchantId: string;
  readonly appId: string;
  readonly orderId: string;
  readonly transactionId: string;
  readonly tradeState: string;
  readonly amountFen: number;
  readonly currency: string;
  readonly payerOpenid: string;
  readonly paidAt: Date | null;
}

export interface PaymentNotificationInput {
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface WeChatPaymentGateway {
  readonly configured: boolean;
  readonly appId: string;
  readonly merchantId: string;
  createPayment(input: CreateWeChatPaymentInput): Promise<{
    readonly prepayId: string;
    readonly payment: PaymentParameters;
  }>;
  paymentParameters(prepayId: string): PaymentParameters;
  verifyNotification(input: PaymentNotificationInput): VerifiedPaymentNotification;
}

interface ClientConfig {
  readonly appId: string;
  readonly merchantId: string;
  readonly merchantSerialNumber: string;
  readonly merchantPrivateKey: string;
  readonly apiV3Key: string;
  readonly platformSerialNumber: string;
  readonly platformPublicKey: string;
  readonly notifyUrl: string;
  readonly timeoutMs: number;
  readonly callbackToleranceSeconds: number;
}

function unavailable(): AppError {
  return new AppError(503, "PAYMENT_NOT_CONFIGURED", "微信支付尚未完成服务端配置");
}

export class UnavailableWeChatPaymentGateway implements WeChatPaymentGateway {
  public readonly configured = false;
  public readonly appId = "";
  public readonly merchantId = "";

  public async createPayment(): Promise<never> {
    throw unavailable();
  }

  public paymentParameters(): never {
    throw unavailable();
  }

  public verifyNotification(): never {
    throw unavailable();
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new AppError(400, "PAYMENT_NOTIFY_INVALID", `微信支付回调缺少 ${name}`);
  }
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AppError(400, "PAYMENT_NOTIFY_INVALID", `微信支付回调的 ${name} 无效`);
  }
  return value as number;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "PAYMENT_NOTIFY_INVALID", `微信支付回调的 ${name} 无效`);
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(rawBody: string, errorCode: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(rawBody) as unknown, "JSON");
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, errorCode, "微信支付返回了无效 JSON");
  }
}

export class OfficialWeChatPaymentGateway implements WeChatPaymentGateway {
  public readonly configured = true;
  public readonly appId: string;
  public readonly merchantId: string;

  public constructor(
    private readonly config: ClientConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.appId = config.appId;
    this.merchantId = config.merchantId;
  }

  private sign(message: string): string {
    return createSignature("RSA-SHA256", Buffer.from(message, "utf8"), this.config.merchantPrivateKey)
      .toString("base64");
  }

  private verifyWechatSignature(
    timestamp: string,
    nonce: string,
    rawBody: string,
    serial: string,
    signature: string,
    enforceFreshness: boolean,
  ): void {
    if (serial !== this.config.platformSerialNumber || signature.startsWith("WECHATPAY/SIGNTEST/")) {
      throw new AppError(401, "PAYMENT_NOTIFY_SIGNATURE_INVALID", "微信支付签名校验失败");
    }
    const timestampSeconds = Number(timestamp);
    if (!Number.isSafeInteger(timestampSeconds)) {
      throw new AppError(401, "PAYMENT_NOTIFY_SIGNATURE_INVALID", "微信支付签名时间戳无效");
    }
    if (
      enforceFreshness
      && Math.abs(Math.floor(this.now().getTime() / 1_000) - timestampSeconds)
        > this.config.callbackToleranceSeconds
    ) {
      throw new AppError(401, "PAYMENT_NOTIFY_SIGNATURE_INVALID", "微信支付回调已过期");
    }
    const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
    let valid = false;
    try {
      valid = verifySignature(
        "RSA-SHA256",
        Buffer.from(message, "utf8"),
        this.config.platformPublicKey,
        Buffer.from(signature, "base64"),
      );
    } catch {
      valid = false;
    }
    if (!valid) throw new AppError(401, "PAYMENT_NOTIFY_SIGNATURE_INVALID", "微信支付签名校验失败");
  }

  public paymentParameters(prepayId: string): PaymentParameters {
    const timeStamp = Math.floor(this.now().getTime() / 1_000).toString();
    const nonceStr = randomBytes(16).toString("hex");
    const packageValue = `prepay_id=${prepayId}`;
    return {
      timeStamp,
      nonceStr,
      package: packageValue,
      signType: "RSA",
      paySign: this.sign(`${this.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`),
    };
  }

  public async createPayment(input: CreateWeChatPaymentInput): Promise<{
    readonly prepayId: string;
    readonly payment: PaymentParameters;
  }> {
    const method = "POST";
    const canonicalUrl = "/v3/pay/transactions/jsapi";
    const body = JSON.stringify({
      appid: this.appId,
      mchid: this.merchantId,
      description: input.description,
      out_trade_no: input.orderId,
      notify_url: this.config.notifyUrl,
      amount: { total: input.amountFen, currency: input.currency },
      payer: { openid: input.payerOpenid },
    });
    const timestamp = Math.floor(this.now().getTime() / 1_000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signature = this.sign(`${method}\n${canonicalUrl}\n${timestamp}\n${nonce}\n${body}\n`);
    const authorization = "WECHATPAY2-SHA256-RSA2048 "
      + `mchid="${this.merchantId}",nonce_str="${nonce}",signature="${signature}",`
      + `timestamp="${timestamp}",serial_no="${this.config.merchantSerialNumber}"`;

    let response: Response;
    try {
      response = await this.fetchImplementation(`https://api.mch.weixin.qq.com${canonicalUrl}`, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization,
        },
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new AppError(502, "PAYMENT_PROVIDER_UNAVAILABLE", "微信支付服务暂时不可用");
    }
    const rawResponse = await response.text();
    const responseTimestamp = response.headers.get("wechatpay-timestamp");
    const responseNonce = response.headers.get("wechatpay-nonce");
    const responseSerial = response.headers.get("wechatpay-serial");
    const responseSignature = response.headers.get("wechatpay-signature");
    if (!responseTimestamp || !responseNonce || !responseSerial || !responseSignature) {
      throw new AppError(502, "PAYMENT_PROVIDER_SIGNATURE_INVALID", "微信支付响应缺少验签信息");
    }
    try {
      this.verifyWechatSignature(
        responseTimestamp,
        responseNonce,
        rawResponse,
        responseSerial,
        responseSignature,
        true,
      );
    } catch {
      throw new AppError(502, "PAYMENT_PROVIDER_SIGNATURE_INVALID", "微信支付响应验签失败");
    }
    if (!response.ok) {
      throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "微信支付下单失败");
    }
    const payload = parseJsonObject(rawResponse, "PAYMENT_PROVIDER_ERROR");
    const prepayId = requiredString(payload.prepay_id, "prepay_id");
    return { prepayId, payment: this.paymentParameters(prepayId) };
  }

  public verifyNotification(input: PaymentNotificationInput): VerifiedPaymentNotification {
    const timestamp = input.headers["wechatpay-timestamp"];
    const nonce = input.headers["wechatpay-nonce"];
    const serial = input.headers["wechatpay-serial"];
    const signature = input.headers["wechatpay-signature"];
    if (!timestamp || !nonce || !serial || !signature) {
      throw new AppError(401, "PAYMENT_NOTIFY_SIGNATURE_INVALID", "微信支付回调缺少验签请求头");
    }
    this.verifyWechatSignature(timestamp, nonce, input.rawBody, serial, signature, true);

    const envelope = parseJsonObject(input.rawBody, "PAYMENT_NOTIFY_INVALID");
    const resource = objectValue(envelope.resource, "resource");
    if (resource.algorithm !== "AEAD_AES_256_GCM") {
      throw new AppError(400, "PAYMENT_NOTIFY_INVALID", "微信支付回调加密算法不受支持");
    }
    const nonceBuffer = Buffer.from(requiredString(resource.nonce, "resource.nonce"), "utf8");
    const associatedData = requiredString(resource.associated_data, "resource.associated_data");
    const encrypted = Buffer.from(requiredString(resource.ciphertext, "resource.ciphertext"), "base64");
    if (encrypted.length <= 16) throw new AppError(400, "PAYMENT_NOTIFY_INVALID", "微信支付回调密文无效");
    let plaintext: string;
    try {
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(this.config.apiV3Key, "utf8"), nonceBuffer);
      decipher.setAAD(Buffer.from(associatedData, "utf8"));
      decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
      plaintext = Buffer.concat([
        decipher.update(encrypted.subarray(0, encrypted.length - 16)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new AppError(400, "PAYMENT_NOTIFY_INVALID", "微信支付回调解密失败");
    }
    const transaction = parseJsonObject(plaintext, "PAYMENT_NOTIFY_INVALID");
    const amount = objectValue(transaction.amount, "amount");
    const payer = objectValue(transaction.payer, "payer");
    const successTime = typeof transaction.success_time === "string"
      ? new Date(transaction.success_time)
      : null;
    return {
      eventType: requiredString(envelope.event_type, "event_type"),
      merchantId: requiredString(transaction.mchid, "mchid"),
      appId: requiredString(transaction.appid, "appid"),
      orderId: requiredString(transaction.out_trade_no, "out_trade_no"),
      transactionId: requiredString(transaction.transaction_id, "transaction_id"),
      tradeState: requiredString(transaction.trade_state, "trade_state"),
      amountFen: requiredInteger(amount.total, "amount.total"),
      currency: requiredString(amount.currency, "amount.currency"),
      payerOpenid: requiredString(payer.openid, "payer.openid"),
      paidAt: successTime && Number.isFinite(successTime.getTime()) ? successTime : null,
    };
  }
}

export async function createWeChatPaymentGateway(
  config: WeChatPayConfig,
): Promise<WeChatPaymentGateway> {
  if (!config.enabled) return new UnavailableWeChatPaymentGateway();
  const [merchantPrivateKey, platformPublicKey] = await Promise.all([
    readFile(config.merchantPrivateKeyPath, "utf8"),
    readFile(config.platformPublicKeyPath, "utf8"),
  ]);
  return new OfficialWeChatPaymentGateway({
    ...config,
    merchantPrivateKey,
    platformPublicKey,
  });
}
