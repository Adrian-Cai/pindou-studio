const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

/**
 * 锁死 axios 的解析版本不低于推荐的修复版本。
 *
 * 背景：`axios` 不是直接使用的依赖，而是 `@cloudbase/node-sdk` / `wx-server-sdk`
 * 拉进来的间接依赖。`@cloudbase/node-sdk` 在已发布 manifest 里**硬声明**
 * `axios: 0.27.2`（截至 4.1.0 仍未改），缺少 `overrides` 时 npm 会在
 * `node_modules/@cloudbase/node-sdk/node_modules/axios` 额外装一份 0.27.2，
 * 与顶层的修复版本并存。package.json 里的 `axios` 直接依赖 + `overrides`
 * 是整棵树收敛到修复版本的唯一手段。
 *
 * 直接校验 lock：lock 就是 `npm ci` 的实际安装结果，一个包出现低版本即转红。
 * 低版本 axios 已知问题：CVE-2023-45857 / CVE-2026-42034 / CVE-2026-67319 等。
 */

const REQUIRED_VERSION = "1.20.0";

test(`package-lock 中所有 axios 均为 ${REQUIRED_VERSION}`, () => {
  const lock = JSON.parse(
    readFileSync(path.resolve(__dirname, "../package-lock.json"), "utf8"),
  );

  const versions = Object.entries(lock.packages)
    .filter(([key]) => key === "node_modules/axios" || key.endsWith("/axios"))
    .map(([key, entry]) => `${key}=${entry.version}`);

  assert.ok(versions.length > 0, "package-lock 里没有 axios 条目");
  assert.deepEqual(
    versions.filter((entry) => !entry.endsWith(`=${REQUIRED_VERSION}`)),
    [],
  );
});
