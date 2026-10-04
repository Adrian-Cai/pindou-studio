const assert = require("node:assert/strict");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

/**
 * 云函数依赖守卫：云函数依赖树不经过流水线，只在微信侧人工安装，
 * 平台 SCA（漏洞 / License / SBOM）扫描看到的 lock 与线上实际依赖树之间
 * 原本没有任何自动校验，这个文件补上这道校验。
 */

const CLOUD_FUNCTIONS_DIR = path.resolve(__dirname, "../../cloudfunctions");

const functionNames = readdirSync(CLOUD_FUNCTIONS_DIR, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

test("每个云函数都提交了 package-lock.json", () => {
  assert.ok(functionNames.length > 0, "cloudfunctions 下没有云函数目录");

  for (const name of functionNames) {
    assert.ok(
      existsSync(path.join(CLOUD_FUNCTIONS_DIR, name, "package-lock.json")),
      `${name} 没有 package-lock.json，SCA 扫描看不到它的依赖树`,
    );
  }
});

test("云函数 lock 与 package.json 的根依赖完全一致", () => {
  for (const name of functionNames) {
    const dir = path.join(CLOUD_FUNCTIONS_DIR, name);
    const manifest = readJson(path.join(dir, "package.json"));
    const lock = readJson(path.join(dir, "package-lock.json"));

    const root = lock.packages?.[""];
    assert.ok(root, `${name}/package-lock.json 缺少根 packages[""] 条目`);

    assert.deepEqual(
      root.dependencies ?? {},
      manifest.dependencies ?? {},
      `${name} 的 package.json 与 package-lock.json 根依赖不一致，需重新生成 lock`,
    );
  }
});

// 上游 package.json 里根本没有 license 字段的传递依赖，不是本仓库能修的。
// 这里是已知清单，出现新条目即报错。
const KNOWN_UNLICENSED = [
  "node_modules/@cloudbase/database/vendor/lodash.set-safe",
  "node_modules/@cloudbase/signature-nodejs",
  "node_modules/@cloudbase/wx-cloud-client-sdk",
];

test("云函数依赖树不出现已知清单之外的无 license 条目", () => {
  for (const name of functionNames) {
    const lock = readJson(
      path.join(CLOUD_FUNCTIONS_DIR, name, "package-lock.json"),
    );

    const unlicensed = Object.entries(lock.packages ?? {})
      .filter(([key, entry]) => {
        if (key === "" || entry.link || entry.version === undefined) {
          return false;
        }
        return !entry.license && !KNOWN_UNLICENSED.includes(key);
      })
      .map(([key]) => key);

    assert.deepEqual(
      unlicensed,
      [],
      `${name} 新增了无 license 声明的依赖，License 扫描会看不见它们`,
    );
  }
});
