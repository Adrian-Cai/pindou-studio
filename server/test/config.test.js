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
