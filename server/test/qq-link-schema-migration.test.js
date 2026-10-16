const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("QQ link challenge migration documents every column required by schema inspection", () => {
  const migration = readFileSync(join(__dirname, "../sql/025_qq_link_challenge_column_comments.sql"), "utf8");

  for (const column of ["token_hash", "user_id", "expires_at", "consumed_at", "created_at"]) {
    assert.match(migration, new RegExp(`COMMENT ON COLUMN pindou_qq_link_challenges\\.${column} IS '.+';`, "u"));
  }
});
