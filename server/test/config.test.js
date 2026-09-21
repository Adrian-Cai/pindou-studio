const assert = require("node:assert/strict");
const test = require("node:test");
const { ConfigError, readConfig, readDatabaseConfig } = require("../dist/config/env.js");

const validEnvironment = {
  APP_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "3001",
  DB_HOST: "db.example.test",
  DB_PORT: "5432",
  DB_NAME: "pindou",
  DB_USER: "test_user",
  DB_PASSWORD: "test_password",
  WECHAT_APP_ID: "test_app_id",
  WECHAT_APP_SECRET: "test_app_secret",
  OPENID_HASH_SECRET: "test_openid_hash_secret_32_characters_long",
};

test("readConfig loads validated server and database settings", () => {
  const config = readConfig(validEnvironment);
  assert.equal(config.appEnvironment, "test");
  assert.equal(config.port, 3001);
  assert.equal(config.database.schema, "public");
  assert.equal(config.database.sslMode, "disable");
  assert.equal(config.auth.tokenTtlDays, 30);
  assert.equal(config.quota.dailyStandardDownloads, 9);
  assert.equal(config.quota.dailyAiGenerations, 3);
  assert.deepEqual(config.hunyuanImage, { enabled: false });
  assert.deepEqual(config.wechatPay, { enabled: false });
  assert.equal(config.avatars.maximumBytes, 2 * 1024 * 1024);
  assert.equal(config.aiFiles.maximumBytes, 10 * 1024 * 1024);
  assert.equal(config.aiFiles.maximumWidth, 4096);
  assert.equal(config.aiFiles.maximumHeight, 4096);
  assert.equal(config.aiFiles.maximumPixels, 16 * 1024 * 1024);
  assert.equal(config.aiFiles.retentionMs, 24 * 60 * 60 * 1000);
  assert.deepEqual(config.aiRateLimit, { maximumRequests: 5, windowMs: 10 * 60 * 1000 });
  assert.match(config.avatars.storageDirectory, /data[\\/]avatars$/);
  assert.equal(config.deployment.persistentStorageMounted, false);
  assert.equal(config.deployment.monitoringAlertsConfigured, false);
  assert.equal(config.contentSecurity.asyncMediaCheckEnabled, false);
});

test("readConfig uses the shared local development port for defaults", () => {
  const config = readConfig({ ...validEnvironment, PORT: undefined });
  assert.equal(config.port, 4000);
  assert.equal(config.covers.publicBaseUrl, "http://127.0.0.1:4000/api/media/covers");
  assert.equal(config.aiFiles.publicBaseUrl, "http://127.0.0.1:4000/api/media/ai");
  assert.equal(
    config.contentSecurity.mediaPublicBaseUrl,
    "http://127.0.0.1:4000/api/content-security/media",
  );
});

test("readConfig validates the TokenHub Hunyuan image configuration", () => {
  const config = readConfig({
    ...validEnvironment,
    HUNYUAN_IMAGE_API_KEY: "test-hunyuan-api-key",
    HUNYUAN_IMAGE_BASE_URL: "https://tokenhub.tencentmaas.com/",
    HUNYUAN_IMAGE_MODEL: "HY-Image-v3.0-I2I-ToB-v1.0.1",
  });
  assert.deepEqual(config.hunyuanImage, {
    enabled: true,
    apiKey: "test-hunyuan-api-key",
    baseUrl: "https://tokenhub.tencentmaas.com",
    model: "HY-Image-v3.0-I2I-ToB-v1.0.1",
    timeoutMs: 60_000,
    maximumOutputBytes: 10 * 1024 * 1024,
  });
});

test("readConfig rejects missing sensitive database configuration without exposing values", () => {
  assert.throws(
    () => readConfig({ DB_HOST: "localhost" }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.issues.includes("DB_PASSWORD 未配置"));
      assert.ok(error.issues.includes("WECHAT_APP_SECRET 未配置"));
      assert.doesNotMatch(error.message, /test_password/);
      return true;
    },
  );
});

test("readConfig rejects invalid numeric configuration", () => {
  assert.throws(() => readConfig({ ...validEnvironment, PORT: "70000" }), ConfigError);
});

test("WeChat Pay configuration is all-or-none and validates the API v3 key", () => {
  assert.throws(
    () => readConfig({ ...validEnvironment, WECHAT_PAY_MERCHANT_ID: "mch-1" }),
    (error) => error instanceof ConfigError
      && error.issues.includes("WECHAT_PAY_API_V3_KEY 未配置")
      && error.issues.includes("WECHAT_PAY_NOTIFY_URL 未配置"),
  );
  assert.throws(
    () => readConfig({
      ...validEnvironment,
      WECHAT_PAY_MERCHANT_ID: "mch-1",
      WECHAT_PAY_MERCHANT_SERIAL_NUMBER: "merchant-serial",
      WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: "./merchant.pem",
      WECHAT_PAY_API_V3_KEY: "too-short",
      WECHAT_PAY_PLATFORM_SERIAL_NUMBER: "platform-serial",
      WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH: "./platform.pem",
      WECHAT_PAY_NOTIFY_URL: "http://example.test/notify",
    }),
    (error) => error instanceof ConfigError
      && error.issues.includes("WECHAT_PAY_API_V3_KEY 必须正好是 32 字节")
      && error.issues.includes("WECHAT_PAY_NOTIFY_URL 必须使用 HTTPS"),
  );
});

test("database inspection config does not require WeChat secrets", () => {
  const database = readDatabaseConfig({
    DB_HOST: "db.example.test",
    DB_NAME: "pindou",
    DB_USER: "test_user",
    DB_PASSWORD: "test_password",
  });
  assert.equal(database.port, 5432);
  assert.equal(database.schema, "public");
});

test("production configuration refuses incomplete payment, AI, HTTPS, storage and monitoring", () => {
  assert.throws(
    () => readConfig({ ...validEnvironment, APP_ENV: "production" }),
    (error) => error instanceof ConfigError
      && error.issues.includes("生产环境必须配置微信支付")
      && error.issues.includes("生产环境必须配置混元图像服务")
      && error.issues.includes("生产环境 COVER_PUBLIC_BASE_URL 必须使用 HTTPS")
      && error.issues.includes("生产环境 AI_FILE_PUBLIC_BASE_URL 必须使用 HTTPS")
      && error.issues.includes("生产环境必须确认 PERSISTENT_STORAGE_MOUNTED=true")
      && error.issues.includes("生产环境必须确认 MONITORING_ALERTS_CONFIGURED=true"),
  );
});

test("content security async media checking is enabled for production and cannot be disabled", () => {
  const production = {
    ...validEnvironment,
    APP_ENV: "production",
    CONTENT_SECURITY_ASYNC_MEDIA_CHECK_ENABLED: "true",
  };
  assert.throws(
    () => readConfig({ ...production, CONTENT_SECURITY_ASYNC_MEDIA_CHECK_ENABLED: "false" }),
    (error) => error instanceof ConfigError
      && error.issues.includes("生产环境 CONTENT_SECURITY_ASYNC_MEDIA_CHECK_ENABLED 必须为 true"),
  );
});
