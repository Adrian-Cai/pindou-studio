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
  assert.equal(config.quota.dailyFree, 3);
  assert.deepEqual(config.wechatPay, { enabled: false });
  assert.equal(config.avatars.maximumBytes, 2 * 1024 * 1024);
  assert.match(config.avatars.storageDirectory, /data[\\/]avatars$/);
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
