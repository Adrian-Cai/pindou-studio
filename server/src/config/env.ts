import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

export type AppEnvironment = "development" | "test" | "production";
export type DatabaseSslMode = "disable" | "require" | "verify-full";

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

export type QwenImageConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly model: "qwen-image-3.0" | "qwen-image-3.0-pro";
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
  readonly qwenImage: QwenImageConfig;
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

function parseQwenImageConfig(env: NodeJS.ProcessEnv, issues: string[]): QwenImageConfig {
  const apiKey = env.QWEN_IMAGE_API_KEY?.trim();
  const baseUrl = env.QWEN_IMAGE_BASE_URL?.trim();
  if (!apiKey && !baseUrl) return { enabled: false };
  if (!apiKey) issues.push("QWEN_IMAGE_API_KEY 未配置");
  if (!baseUrl) issues.push("QWEN_IMAGE_BASE_URL 未配置");

  let normalizedBaseUrl = baseUrl ?? "";
  try {
    const parsed = new URL(normalizedBaseUrl);
    if (parsed.protocol !== "https:") issues.push("QWEN_IMAGE_BASE_URL 必须使用 HTTPS");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      issues.push("QWEN_IMAGE_BASE_URL 不能包含凭据、查询参数或片段");
    }
    normalizedBaseUrl = parsed.href.replace(/\/$/u, "");
  } catch {
    issues.push("QWEN_IMAGE_BASE_URL 必须是合法 URL");
    normalizedBaseUrl = "";
  }

  const model = env.QWEN_IMAGE_MODEL?.trim() || "qwen-image-3.0";
  if (model !== "qwen-image-3.0" && model !== "qwen-image-3.0-pro") {
    issues.push("QWEN_IMAGE_MODEL 必须是 qwen-image-3.0 或 qwen-image-3.0-pro");
  }
  return {
    enabled: true,
    apiKey: apiKey ?? "",
    baseUrl: normalizedBaseUrl,
    model: model === "qwen-image-3.0-pro" ? model : "qwen-image-3.0",
    timeoutMs: integer(env, "QWEN_IMAGE_TIMEOUT_MS", 30_000, 1_000, 60_000, issues),
    maximumOutputBytes: integer(
      env,
      "QWEN_IMAGE_MAX_OUTPUT_BYTES",
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
    qwenImage: parseQwenImageConfig(env, issues),
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
    if (!config.qwenImage.enabled) issues.push("生产环境必须配置千问图像服务");
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
