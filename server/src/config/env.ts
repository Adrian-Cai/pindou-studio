import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

export type AppEnvironment = "development" | "test" | "production";
export type DatabaseSslMode = "disable" | "require" | "verify-full";

export const HUNYUAN_IMAGE_MODEL = "HY-Image-v3.0-I2I-ToB-v1.0.1" as const;

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly name: string;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly sslMode: DatabaseSslMode;
  readonly connectTimeoutMs: number;
  readonly poolMax: number;
}

export type WeChatPayConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly appId: string;
      readonly merchantId: string;
      readonly merchantSerialNumber: string;
      readonly merchantPrivateKeyPath: string;
      readonly apiV3Key: string;
      readonly platformSerialNumber: string;
      readonly platformPublicKeyPath: string;
      readonly notifyUrl: string;
      readonly timeoutMs: number;
      readonly callbackToleranceSeconds: number;
    };

/**
 * 小程序虚拟支付配置。
 *
 * 与 WeChatPayConfig 是两套独立凭据：**虚拟商品必须走虚拟支付**（OfferID + AppKey），
 * 普通商户号 APIv3 链路在 iOS 端不可用，官方也不允许用于虚拟商品。
 * AppKey 属于支付密钥，只允许经环境变量注入，禁止写入源码或日志。
 */
export type VirtualPayConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly appId: string;
      /** MP 后台「虚拟支付 → 基本配置」中的 offerid。 */
      readonly offerId: string;
      /** 现网 AppKey；沙箱 AppKey 不得用于生产。 */
      readonly appKey: string;
      readonly timeoutMs: number;
      readonly apiBaseUrl: string;
    };

/**
 * 虚拟支付发货补单（发货轮询）的调度参数。
 *
 * 官方要求「发货推送分支与发货轮询分支至少实现一个」；推送负责实时，轮询负责兜住
 * 推送丢失的那部分订单，否则用户会遇到「钱扣了、次数没到账」且系统毫无告警。
 * 与开关类配置不同，这里**不因虚拟支付未启用而整体关闭**：轮询内部会自行短路。
 */
export interface VirtualPayReconcileConfig {
  /** 轮询间隔。不宜低于 1 分钟：查单是带 AppKey 签名的上游请求，太密会被限流。 */
  readonly intervalMs: number;
  /** 下单后多久才纳入补单，给发货推送留出正常到达的时间。 */
  readonly graceMs: number;
  /** pending 持续多久仍查不到已支付就升级为告警。 */
  readonly staleAfterMs: number;
  /**
   * pending 持续多久且查单确认未支付就自动关单（置 closed，此后不再扫描）。
   *
   * 为什么必须有：用户下单后没付钱的订单会永远停在 pending，而补单轮询每扫到一笔
   * 就记一条「需要人工介入」的告警 —— 一天下来真实漏发货会被这些噪音彻底淹没。
   */
  readonly closeAfterMs: number;
  /** 单轮最多处置多少笔。 */
  readonly batchSize: number;
}

/**
 * 虚拟支付消息推送（MP 后台「消息推送配置」）的凭据。
 *
 * 与虚拟支付本身的 OfferID/AppKey 是两回事：那两个用来**调微信接口**，这两个用来
 * **收微信推送**——握手校验 Token、安全模式下解密消息体。两者都从 MP 后台同一片
 * 配置区生成，但作用面不同，密钥也应当分开，避免一处泄露连带另一处。
 *
 * 全空是合法的：表示后台走明文模式且服务端不校验来源（推送本身不被信任，
 * 放款依然靠 query_order 验真）。一旦配了 encodingAesKey 就必须同时配 token，
 * 否则解开了密文却不知道是谁发的。
 */
export interface VirtualPayPushConfig {
  readonly token: string;
  readonly encodingAesKey: string;
  readonly appId: string;
}

export type HunyuanImageConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly environmentId: string;
      readonly model: typeof HUNYUAN_IMAGE_MODEL;
      readonly timeoutMs: number;
      readonly maximumOutputBytes: number;
    };

export interface ServerConfig {
  readonly appEnvironment: AppEnvironment;
  readonly host: string;
  readonly port: number;
  readonly database: DatabaseConfig;
  readonly wechat: {
    readonly appId: string;
    readonly appSecret: string;
    readonly timeoutMs: number;
  };
  readonly wechatPay: WeChatPayConfig;
  readonly virtualPay: VirtualPayConfig;
  readonly virtualPayReconcile: VirtualPayReconcileConfig;
  readonly virtualPayPush: VirtualPayPushConfig;
  /**
   * 新人测试套餐（0.1 元 / 5 次）的「每人限购一次」开关。
   *
   * 默认 true（限购生效）。联调时设 `PAYMENT_NEW_USER_GATE_ENABLED=false` 可让同一账号反复购买，
   * 否则走完一次真实支付后就会一直被 409 NEW_USER_PACKAGE_NOT_ELIGIBLE 挡住，没法二测。
   * 默认保持开启是因为这个套餐只有 0.1 元——关掉又忘了开回来，等于对外无限量卖 5 次生成。
   */
  readonly newUserPackageGateEnabled: boolean;
  readonly hunyuanImage: HunyuanImageConfig;
  readonly auth: {
    readonly openidHashSecret: string;
    readonly tokenTtlDays: number;
  };
  readonly quota: {
    readonly dailyStandardDownloads: number;
    readonly dailyAiGenerations: number;
  };
  readonly avatars: {
    readonly storageDirectory: string;
    readonly maximumBytes: number;
  };
  readonly covers: {
    readonly storageDirectory: string;
    readonly publicBaseUrl: string;
    readonly maximumBytes: number;
  };
  readonly aiFiles: {
    readonly storageDirectory: string;
    readonly publicBaseUrl: string;
    readonly maximumBytes: number;
    readonly maximumWidth: number;
    readonly maximumHeight: number;
    readonly maximumPixels: number;
    readonly retentionMs: number;
  };
  readonly aiRateLimit: {
    readonly maximumRequests: number;
    readonly windowMs: number;
  };
  readonly contentSecurity: {
    readonly messageToken: string;
    readonly mediaStorageDirectory: string;
    readonly mediaPublicBaseUrl: string;
    readonly mediaMaximumBytes: number;
    readonly asyncMediaCheckEnabled: boolean;
  };
  readonly deployment: {
    readonly persistentStorageMounted: boolean;
    readonly monitoringAlertsConfigured: boolean;
  };
}

export class ConfigError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`配置校验失败：${issues.join("；")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function required(env: NodeJS.ProcessEnv, key: string, issues: string[]): string {
  const value = env[key]?.trim();
  if (!value) {
    issues.push(`${key} 未配置`);
    return "";
  }
  return value;
}

function requiredSecret(
  env: NodeJS.ProcessEnv,
  key: string,
  minimumLength: number,
  issues: string[],
): string {
  const value = required(env, key, issues);
  if (value && value.length < minimumLength) {
    issues.push(`${key} 长度不能少于 ${minimumLength} 个字符`);
  }
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  issues: string[],
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push(`${key} 必须是 ${minimum} 到 ${maximum} 的整数`);
    return fallback;
  }
  return parsed;
}

function booleanValue(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
  issues: string[],
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  issues.push(`${key} 必须是 true 或 false`);
  return fallback;
}

function appEnvironment(env: NodeJS.ProcessEnv, issues: string[]): AppEnvironment {
  const value = env.APP_ENV?.trim() ?? "development";
  if (value === "development" || value === "test" || value === "production") return value;
  issues.push("APP_ENV 必须是 development、test 或 production");
  return "development";
}

function sslMode(env: NodeJS.ProcessEnv, issues: string[]): DatabaseSslMode {
  const value = env.DB_SSL_MODE?.trim() ?? "disable";
  if (value === "disable" || value === "require" || value === "verify-full") return value;
  issues.push("DB_SSL_MODE 必须是 disable、require 或 verify-full");
  return "disable";
}

function parseDatabaseConfig(env: NodeJS.ProcessEnv, issues: string[]): DatabaseConfig {
  return {
    host: required(env, "DB_HOST", issues),
    port: integer(env, "DB_PORT", 5432, 1, 65_535, issues),
    name: required(env, "DB_NAME", issues),
    user: required(env, "DB_USER", issues),
    password: required(env, "DB_PASSWORD", issues),
    schema: env.DB_SCHEMA?.trim() || "public",
    sslMode: sslMode(env, issues),
    connectTimeoutMs: integer(env, "DB_CONNECT_TIMEOUT_MS", 10_000, 1_000, 60_000, issues),
    poolMax: integer(env, "DB_POOL_MAX", 5, 1, 20, issues),
  };
}

function parseWeChatPayConfig(
  env: NodeJS.ProcessEnv,
  appId: string,
  issues: string[],
): WeChatPayConfig {
  const requiredKeys = [
    "WECHAT_PAY_MERCHANT_ID",
    "WECHAT_PAY_MERCHANT_SERIAL_NUMBER",
    "WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH",
    "WECHAT_PAY_API_V3_KEY",
    "WECHAT_PAY_PLATFORM_SERIAL_NUMBER",
    "WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH",
    "WECHAT_PAY_NOTIFY_URL",
  ] as const;
  const configuredKeys = requiredKeys.filter((key) => Boolean(env[key]?.trim()));
  if (configuredKeys.length === 0) return { enabled: false };

  const values = Object.fromEntries(
    requiredKeys.map((key) => [key, required(env, key, issues)]),
  ) as Record<(typeof requiredKeys)[number], string>;
  if (values.WECHAT_PAY_API_V3_KEY && Buffer.byteLength(values.WECHAT_PAY_API_V3_KEY, "utf8") !== 32) {
    issues.push("WECHAT_PAY_API_V3_KEY 必须正好是 32 字节");
  }
  let notifyUrl = values.WECHAT_PAY_NOTIFY_URL;
  try {
    const parsed = new URL(notifyUrl);
    if (parsed.protocol !== "https:") issues.push("WECHAT_PAY_NOTIFY_URL 必须使用 HTTPS");
    if (parsed.username || parsed.password || parsed.hash) issues.push("WECHAT_PAY_NOTIFY_URL 不能包含凭据或片段");
  } catch {
    issues.push("WECHAT_PAY_NOTIFY_URL 必须是合法 URL");
    notifyUrl = "";
  }

  return {
    enabled: true,
    appId,
    merchantId: values.WECHAT_PAY_MERCHANT_ID,
    merchantSerialNumber: values.WECHAT_PAY_MERCHANT_SERIAL_NUMBER,
    merchantPrivateKeyPath: resolve(values.WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH),
    apiV3Key: values.WECHAT_PAY_API_V3_KEY,
    platformSerialNumber: values.WECHAT_PAY_PLATFORM_SERIAL_NUMBER,
    platformPublicKeyPath: resolve(values.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH),
    notifyUrl,
    timeoutMs: integer(env, "WECHAT_PAY_TIMEOUT_MS", 8_000, 1_000, 30_000, issues),
    callbackToleranceSeconds: integer(
      env,
      "WECHAT_PAY_CALLBACK_TOLERANCE_SECONDS",
      300,
      60,
      600,
      issues,
    ),
  };
}

/**
 * 解析虚拟支付配置。
 *
 * 沿用 WeChatPayConfig 的降级约定：三项必备参数一个都没配时返回 enabled:false，
 * 让 UnavailableVirtualPayGateway 顶上 —— 服务照常启动，只有真正调用支付时才报 503。
 * 配了但不全则是配置错误，必须显式报错而不是静默降级，否则上线后才发现支付吊不通。
 */
function parseVirtualPayConfig(
  env: NodeJS.ProcessEnv,
  appId: string,
  issues: string[],
): VirtualPayConfig {
  const offerId = env.VIRTUAL_PAY_OFFER_ID?.trim() ?? "";
  const appKey = env.VIRTUAL_PAY_APP_KEY?.trim() ?? "";
  const hasAny = Boolean(offerId || appKey);
  if (!hasAny) return { enabled: false };
  if (!offerId) issues.push("VIRTUAL_PAY_OFFER_ID 未配置");
  if (!appKey) issues.push("VIRTUAL_PAY_APP_KEY 未配置");
  if (!offerId || !appKey) return { enabled: false };

  const baseUrl = env.VIRTUAL_PAY_API_BASE_URL?.trim() || "https://api.weixin.qq.com";
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") issues.push("VIRTUAL_PAY_API_BASE_URL 必须使用 HTTPS");
  } catch {
    issues.push("VIRTUAL_PAY_API_BASE_URL 必须是合法 URL");
  }

  return {
    enabled: true,
    appId,
    offerId,
    appKey,
    timeoutMs: integer(env, "VIRTUAL_PAY_TIMEOUT_MS", 8_000, 1_000, 30_000, issues),
    apiBaseUrl: baseUrl,
  };
}

function parseVirtualPayReconcileConfig(
  env: NodeJS.ProcessEnv,
  issues: string[],
): VirtualPayReconcileConfig {
  const graceMs = integer(env, "VIRTUAL_PAY_RECONCILE_GRACE_MS", 3 * 60_000, 30_000, 30 * 60_000, issues);
  // 兜底窗口必须不小于静默期，否则订单刚过静默期就被判 stalled，等于把每个正常下单的用户都告警一遍
  const staleAfterMs = integer(env, "VIRTUAL_PAY_RECONCILE_STALE_AFTER_MS", 30 * 60_000, graceMs, 7 * 24 * 60 * 60_000, issues);
  return {
    intervalMs: integer(env, "VIRTUAL_PAY_RECONCILE_INTERVAL_MS", 5 * 60_000, 60_000, 60 * 60_000, issues),
    graceMs,
    staleAfterMs,
    /**
     * 关单窗口必须不小于告警窗口：先告警一阵子再关，才留出人工发现「其实付了钱但查单异常」的余地。
     * 关单是不可逆的（closed 之后即便迟到的发货推送也只会得到 ORDER_NOT_PAYABLE），
     * 因此默认给 1 小时，远大于 30 分钟的告警窗口。
     */
    closeAfterMs: integer(env, "VIRTUAL_PAY_RECONCILE_CLOSE_AFTER_MS", 60 * 60_000, staleAfterMs, 7 * 24 * 60 * 60_000, issues),
    batchSize: integer(env, "VIRTUAL_PAY_RECONCILE_BATCH_SIZE", 100, 1, 1_000, issues),
  };
}

/**
 * 解析虚拟支付推送凭据。
 *
 * EncodingAESKey 的长度必须严格校验：它不是自由文本，微信生成时固定 43 个字符，
 * 长度不对会在解密那一刻才炸（而且表现为「所有推送都解密失败」这种很难归因的故障），
 * 不如在启动阶段就挡住。
 */
function parseVirtualPayPushConfig(
  env: NodeJS.ProcessEnv,
  appId: string,
  issues: string[],
): VirtualPayPushConfig {
  const token = env.VIRTUAL_PAY_PUSH_TOKEN?.trim() ?? "";
  const encodingAesKey = env.VIRTUAL_PAY_ENCODING_AES_KEY?.trim() ?? "";
  if (encodingAesKey && encodingAesKey.length !== 43) {
    issues.push("VIRTUAL_PAY_ENCODING_AES_KEY 必须是 43 个字符");
  }
  if (encodingAesKey && !token) {
    issues.push("配置了 VIRTUAL_PAY_ENCODING_AES_KEY 时必须同时配置 VIRTUAL_PAY_PUSH_TOKEN");
  }
  if (token && /\s/.test(token)) {
    issues.push("VIRTUAL_PAY_PUSH_TOKEN 不能包含空白字符");
  }
  return { token, encodingAesKey, appId };
}

function parseHunyuanImageConfig(env: NodeJS.ProcessEnv, issues: string[]): HunyuanImageConfig {
  const apiKey = env.HUNYUAN_IMAGE_API_KEY?.trim();
  const baseUrl = env.HUNYUAN_IMAGE_BASE_URL?.trim();
  if (!apiKey && !baseUrl) return { enabled: false };
  if (!apiKey) issues.push("HUNYUAN_IMAGE_API_KEY 未配置");
  if (!baseUrl) issues.push("HUNYUAN_IMAGE_BASE_URL 未配置");

  let normalizedBaseUrl = baseUrl ?? "";
  let environmentId = "";
  try {
    const parsed = new URL(normalizedBaseUrl);
    if (parsed.protocol !== "https:") issues.push("HUNYUAN_IMAGE_BASE_URL 必须使用 HTTPS");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      issues.push("HUNYUAN_IMAGE_BASE_URL 不能包含凭据、查询参数或片段");
    }
    normalizedBaseUrl = parsed.href.replace(/\/$/u, "");
    const environmentMatch = /^([a-z0-9-]+)\.api\.tcloudbasegateway\.com$/iu.exec(parsed.hostname);
    if (!environmentMatch?.[1]) {
      issues.push("HUNYUAN_IMAGE_BASE_URL 必须使用 CloudBase 网关地址");
    } else {
      environmentId = environmentMatch[1];
    }
  } catch {
    issues.push("HUNYUAN_IMAGE_BASE_URL 必须是合法 URL");
    normalizedBaseUrl = "";
  }

  const model = env.HUNYUAN_IMAGE_MODEL?.trim() || HUNYUAN_IMAGE_MODEL;
  if (model !== HUNYUAN_IMAGE_MODEL) {
    issues.push(`HUNYUAN_IMAGE_MODEL 必须是 ${HUNYUAN_IMAGE_MODEL}`);
  }
  return {
    enabled: true,
    apiKey: apiKey ?? "",
    baseUrl: normalizedBaseUrl,
    environmentId,
    model: HUNYUAN_IMAGE_MODEL,
    timeoutMs: integer(env, "HUNYUAN_IMAGE_TIMEOUT_MS", 150_000, 1_000, 900_000, issues),
    maximumOutputBytes: integer(
      env,
      "HUNYUAN_IMAGE_MAX_OUTPUT_BYTES",
      10 * 1_024 * 1_024,
      64 * 1_024,
      20 * 1_024 * 1_024,
      issues,
    ),
  };
}

export function loadLocalEnv(): void {
  const envPath = resolve(__dirname, "../../.env");
  try {
    loadEnvFile(envPath);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const issues: string[] = [];
  const wechatAppId = required(env, "WECHAT_APP_ID", issues);
  const environment = appEnvironment(env, issues);
  const config: ServerConfig = {
    appEnvironment: environment,
    host: env.HOST?.trim() || "127.0.0.1",
    port: integer(env, "PORT", 4000, 1, 65_535, issues),
    database: parseDatabaseConfig(env, issues),
    wechat: {
      appId: wechatAppId,
      appSecret: required(env, "WECHAT_APP_SECRET", issues),
      timeoutMs: integer(env, "WECHAT_API_TIMEOUT_MS", 8_000, 1_000, 30_000, issues),
    },
    wechatPay: parseWeChatPayConfig(env, wechatAppId, issues),
    virtualPay: parseVirtualPayConfig(env, wechatAppId, issues),
    virtualPayReconcile: parseVirtualPayReconcileConfig(env, issues),
    newUserPackageGateEnabled: booleanValue(
      env,
      "PAYMENT_NEW_USER_GATE_ENABLED",
      true,
      issues,
    ),
    virtualPayPush: parseVirtualPayPushConfig(env, wechatAppId, issues),
    hunyuanImage: parseHunyuanImageConfig(env, issues),
    auth: {
      openidHashSecret: requiredSecret(env, "OPENID_HASH_SECRET", 32, issues),
      tokenTtlDays: integer(env, "AUTH_TOKEN_TTL_DAYS", 30, 1, 365, issues),
    },
    quota: {
      dailyStandardDownloads: integer(env, "STANDARD_DOWNLOAD_DAILY_FREE", 9, 0, 100, issues),
      dailyAiGenerations: integer(env, "AI_GENERATION_DAILY_FREE", 3, 0, 100, issues),
    },
    avatars: {
      storageDirectory: resolve(
        env.AVATAR_STORAGE_DIR?.trim() || resolve(__dirname, "../../data/avatars"),
      ),
      maximumBytes: integer(env, "AVATAR_MAX_BYTES", 2 * 1_024 * 1_024, 64 * 1_024, 10 * 1_024 * 1_024, issues),
    },
    covers: {
      storageDirectory: resolve(
        env.COVER_STORAGE_DIR?.trim() || resolve(__dirname, "../../data/covers"),
      ),
      publicBaseUrl: env.COVER_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000/api/media/covers",
      maximumBytes: integer(env, "COVER_MAX_BYTES", 10 * 1_024 * 1_024, 64 * 1_024, 20 * 1_024 * 1_024, issues),
    },
    aiFiles: {
      storageDirectory: resolve(
        env.AI_FILE_STORAGE_DIR?.trim() || resolve(__dirname, "../../data/ai"),
      ),
      publicBaseUrl: env.AI_FILE_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000/api/media/ai",
      maximumBytes: integer(env, "AI_FILE_MAX_BYTES", 10 * 1_024 * 1_024, 64 * 1_024, 20 * 1_024 * 1_024, issues),
      maximumWidth: integer(env, "AI_IMAGE_MAX_WIDTH", 4_096, 1, 16_384, issues),
      maximumHeight: integer(env, "AI_IMAGE_MAX_HEIGHT", 4_096, 1, 16_384, issues),
      maximumPixels: integer(env, "AI_IMAGE_MAX_PIXELS", 16 * 1_024 * 1_024, 1, 256 * 1_024 * 1_024, issues),
      retentionMs: integer(env, "AI_FILE_RETENTION_HOURS", 24, 1, 168, issues) * 60 * 60 * 1_000,
    },
    aiRateLimit: {
      maximumRequests: integer(env, "AI_RATE_LIMIT_MAX_REQUESTS", 5, 1, 100, issues),
      windowMs: integer(env, "AI_RATE_LIMIT_WINDOW_MS", 10 * 60 * 1_000, 1_000, 24 * 60 * 60 * 1_000, issues),
    },
    contentSecurity: {
      messageToken: env.WECHAT_CONTENT_SECURITY_TOKEN?.trim() || "",
      mediaStorageDirectory: resolve(
        env.CONTENT_SECURITY_MEDIA_STORAGE_DIR?.trim() || resolve(__dirname, "../../data/content-security"),
      ),
      mediaPublicBaseUrl: env.CONTENT_SECURITY_MEDIA_PUBLIC_BASE_URL?.trim()
        || "http://127.0.0.1:4000/api/content-security/media",
      mediaMaximumBytes: integer(
        env,
        "CONTENT_SECURITY_MEDIA_MAX_BYTES",
        10 * 1_024 * 1_024,
        64 * 1_024,
        10 * 1_024 * 1_024,
        issues,
      ),
      asyncMediaCheckEnabled: booleanValue(
        env,
        "CONTENT_SECURITY_ASYNC_MEDIA_CHECK_ENABLED",
        environment === "production",
        issues,
      ),
    },
    deployment: {
      persistentStorageMounted: booleanValue(
        env,
        "PERSISTENT_STORAGE_MOUNTED",
        false,
        issues,
      ),
      monitoringAlertsConfigured: booleanValue(
        env,
        "MONITORING_ALERTS_CONFIGURED",
        false,
        issues,
      ),
    },
  };

  if (config.appEnvironment === "production") {
    if (!config.contentSecurity.asyncMediaCheckEnabled) {
      issues.push("生产环境 CONTENT_SECURITY_ASYNC_MEDIA_CHECK_ENABLED 必须为 true");
    }
    if (!config.wechatPay.enabled) issues.push("生产环境必须配置微信支付");
    if (!config.hunyuanImage.enabled) issues.push("生产环境必须配置混元图像服务");
    if (!config.covers.publicBaseUrl.startsWith("https://")) {
      issues.push("生产环境 COVER_PUBLIC_BASE_URL 必须使用 HTTPS");
    }
    if (!config.aiFiles.publicBaseUrl.startsWith("https://")) {
      issues.push("生产环境 AI_FILE_PUBLIC_BASE_URL 必须使用 HTTPS");
    }
    if (!config.deployment.persistentStorageMounted) {
      issues.push("生产环境必须确认 PERSISTENT_STORAGE_MOUNTED=true");
    }
    if (!config.deployment.monitoringAlertsConfigured) {
      issues.push("生产环境必须确认 MONITORING_ALERTS_CONFIGURED=true");
    }
    if (!config.contentSecurity.messageToken) {
      issues.push("生产环境必须配置 WECHAT_CONTENT_SECURITY_TOKEN");
    }
    if (!config.contentSecurity.mediaPublicBaseUrl.startsWith("https://")) {
      issues.push("生产环境 CONTENT_SECURITY_MEDIA_PUBLIC_BASE_URL 必须使用 HTTPS");
    }
    /**
     * 启用虚拟支付就必须配推送 Token：MP 后台保存推送配置时会对 URL 做一次 GET 握手，
     * 服务端没有同一个 Token 就永远验不过，配置存不下来，发货 / 退款 / iOS 问询
     * 三条推送全断。这项这里直接判死，是因为它失败得极其安静 —— 服务照常起来、
     * 下单照常走通，只有「付了钱收不到次数」和「退款了额度没扣回」会在很久之后
     * 才以客诉的形式冒出来。
     */
    if (config.virtualPay.enabled && !config.virtualPayPush.token) {
      issues.push("生产环境启用虚拟支付时必须配置 VIRTUAL_PAY_PUSH_TOKEN");
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const issues: string[] = [];
  const config = parseDatabaseConfig(env, issues);
  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}
