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
  readonly auth: {
    readonly openidHashSecret: string;
    readonly tokenTtlDays: number;
  };
  readonly quota: {
    readonly dailyFree: number;
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
  const config: ServerConfig = {
    appEnvironment: appEnvironment(env, issues),
    host: env.HOST?.trim() || "127.0.0.1",
    port: integer(env, "PORT", 3000, 1, 65_535, issues),
    database: parseDatabaseConfig(env, issues),
    wechat: {
      appId: required(env, "WECHAT_APP_ID", issues),
      appSecret: required(env, "WECHAT_APP_SECRET", issues),
      timeoutMs: integer(env, "WECHAT_API_TIMEOUT_MS", 8_000, 1_000, 30_000, issues),
    },
    auth: {
      openidHashSecret: requiredSecret(env, "OPENID_HASH_SECRET", 32, issues),
      tokenTtlDays: integer(env, "AUTH_TOKEN_TTL_DAYS", 30, 1, 365, issues),
    },
    quota: {
      dailyFree: integer(env, "DAILY_FREE_QUOTA", 3, 0, 100, issues),
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
      publicBaseUrl: env.COVER_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:3000/api/media/covers",
      maximumBytes: integer(env, "COVER_MAX_BYTES", 10 * 1_024 * 1_024, 64 * 1_024, 20 * 1_024 * 1_024, issues),
    },
  };

  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const issues: string[] = [];
  const config = parseDatabaseConfig(env, issues);
  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}
