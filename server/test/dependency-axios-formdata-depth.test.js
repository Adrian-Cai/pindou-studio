const assert = require("node:assert/strict");
const test = require("node:test");

const axios = require("axios");

/**
 * axios `formDataToJSON` 深度守卫（CVE-2026-67313）。
 *
 * 漏洞：`axios.formToJSON()` / 命名导出 `formToJSON` / `application/json` 请求体里的
 * FormData 默认转换器，都会走 `formDataToJSON`。该实现按 `a[x][x][x]...` 字段名递归构树，
 * 攻击者可控的字段名带几千层括号即可耗尽调用栈，抛
 * `RangeError: Maximum call stack size exceeded`，进程未捕获时直接终止。
 *
 * 版本正确性由 `dependency-axios-version.test.js` 用 package-lock 兜底；
 * 这里从**可执行行为**上验证：恶意深度字段名必须被转成受控错误，而不是 RangeError。
 * 用例依赖 axios 的深度上限实现，若将来 axios 移除该限制，本用例会转红。
 */

test("axios.formToJSON 面对 20000 层嵌套字段名抛出受控错误，而不是栈溢出", () => {
  const form = new FormData();
  form.append("a" + "[x]".repeat(20000), "v");

  assert.throws(() => axios.formToJSON(form), /too deeply nested/i);
});
