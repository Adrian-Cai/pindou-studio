const assert = require("node:assert/strict");
const test = require("node:test");
const { inspectDatabaseSchema } = require("../dist/db/schema-inspector.js");

test("schema inspection accepts PostgreSQL's rendered pending-order index predicate", async () => {
  let released = false;
  const client = {
    async query(sql) {
      if (sql.includes("current_setting('server_version')")) {
        return { rows: [{ server_version: "17.6", database_version: "PostgreSQL 17.6" }] };
      }
      if (sql.includes("FROM pg_catalog.pg_indexes")) {
        return {
          rows: [{
            table_name: "pindou_orders",
            definition: "CREATE INDEX idx_pindou_orders_active_expiry ON public.pindou_orders USING btree (user_id, expires_at) WHERE ((status)::text = 'pending'::text)",
          }],
        };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };

  const report = await inspectDatabaseSchema({ connect: async () => client }, "public");

  assert.equal(report.differences.includes("pindou_orders 缺少未完成订单到期索引"), false);
  assert.equal(released, true);
});

test("schema inspection accepts PostgreSQL's rendered prompt length checks", async () => {
  const client = {
    async query(sql) {
      if (sql.includes("current_setting('server_version')")) {
        return { rows: [{ server_version: "17.6", database_version: "PostgreSQL 17.6" }] };
      }
      if (sql.includes("FROM pg_catalog.pg_constraint")) {
        return {
          rows: [
            {
              table_name: "pindou_text_image_generation_jobs",
              type: "c",
              definition: "CHECK (char_length(prompt::text) >= 1 AND char_length(prompt::text) <= 500)",
            },
            {
              table_name: "pindou_works",
              type: "c",
              definition: "CHECK (creation_source::text = 'text'::text AND source_prompt IS NOT NULL AND char_length(source_prompt) >= 1 AND char_length(source_prompt) <= 500)",
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };

  const report = await inspectDatabaseSchema({ connect: async () => client }, "public");

  assert.equal(report.differences.includes("pindou_text_image_generation_jobs 缺少文生图提示词长度 CHECK"), false);
  assert.equal(report.differences.includes("pindou_works 缺少作品来源提示词 CHECK"), false);
});
