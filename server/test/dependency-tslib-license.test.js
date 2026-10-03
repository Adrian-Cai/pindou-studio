const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

/**
 * tslib 版本 / 许可证守卫（BSD-ZERO 0BSD 合规项）。
 *
 * 背景：`cloudfunctions/generateImage` 的依赖树里存在一份 tslib@1.14.1，
 * 由 `wx-server-sdk@4.0.2` 的 manifest 声明（`tslib: ^1.9.3`）带进来，
 * 但该 SDK 的 `index.js` 版本早于 `^1.9.3` 声明（发布前未同步 manifest），
 * 打包产物里已把用到的 helper 内联，**源码与依赖树中均无任何 `require('tslib')`**，
 * 属于 manifest 级别的死依赖。上报视角只看得到「低版本 tslib 存在」，
 * 因此这里按合规口径把它收敛到当前稳定版 `2.8.1`（许可证同为 0BSD）。
 *
 * 收敛手段是 `package.json` 的 `overrides.tslib`：lock 与安装树必须一致收敛到
 * 该版本，且不能出现嵌套的第二份 tslib。直接用 lock 判定，`npm ci` 的安装结果
 * 就是 lock 本身，漏加 / 被移除 overrides 都会让这个用例转红。
 *
 * 兼容性依据：`wx-server-sdk` 声明的是 `^1.9.3`，tslib 2.x 的 CJS 入口是 1.x
 * 导出面的严格超集（1.14.1 的 23 个导出在 2.8.1 中全部保留，2.8.1 另有 9 个新增），
 * 且项目源码本身不 require tslib，升级无行为影响。
 */

const LOCK_PATH = path.resolve(
  __dirname,
  "../../cloudfunctions/generateImage/package-lock.json",
);
const MANIFEST_PATH = path.resolve(
  __dirname,
  "../../cloudfunctions/generateImage/package.json",
);

const REQUIRED_VERSION = "2.8.1";
const REQUIRED_LICENSE = "0BSD";

test("generateImage 依赖树中的 tslib 已收敛到 2.8.1（0BSD）", () => {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));

  const entries = Object.entries(lock.packages).filter(
    ([key]) => key === "node_modules/tslib" || key.endsWith("/tslib"),
  );

  assert.ok(entries.length > 0, "package-lock 里没有 tslib 条目");
  assert.deepEqual(
    entries.map(([key, entry]) => [key, entry.version, entry.license]).filter(
      ([, version, license]) =>
        version !== REQUIRED_VERSION || license !== REQUIRED_LICENSE,
    ),
    [],
  );
});

test("package.json 用 overrides 锁死 tslib，避免回退到 1.x", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

  assert.equal(
    manifest.overrides?.tslib,
    REQUIRED_VERSION,
    "overrides.tslib 缺失会让 wx-server-sdk 拉回 tslib@1.14.1",
  );
});
