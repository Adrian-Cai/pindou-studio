const assert = require("node:assert/strict");
const test = require("node:test");
const { PostgresFileAssetService } = require("../dist/modules/files/file-asset-service.js");

test("file asset upload writes only validated cover metadata and cleans the object on DB failure", async () => {
  const calls = [];
  const storage = {
    async save(buffer, filename, declaredContentType) {
      calls.push({ action: "save", buffer, filename, declaredContentType });
      return { objectKey: "covers/cover_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", publicUrl: "https://cdn/cover.png", contentType: "image/png", byteSize: buffer.length, width: 1, height: 1 };
    },
    async remove(objectKey) { calls.push({ action: "remove", objectKey }); },
  };
  const pool = {
    async query(sql, parameters) {
      calls.push({ action: "query", sql, parameters });
      throw new Error("db unavailable");
    },
  };
  const service = new PostgresFileAssetService(pool, storage, () => new Date("2026-08-27T01:00:00.000Z"));
  await assert.rejects(() => service.upload("usr_current", { type: "cover", buffer: Buffer.from([1, 2]), filename: "cover.png", declaredContentType: "image/png" }), /db unavailable/);
  assert.equal(calls[0].action, "save");
  assert.deepEqual(calls.at(-1), { action: "remove", objectKey: "covers/cover_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" });
});

test("AI input upload uses the isolated AI storage and persists ai_input metadata", async () => {
  const calls = [];
  const coverStorage = { async save() { throw new Error("cover storage must not be used"); }, async remove() {} };
  const aiStorage = {
    async save(kind, buffer, filename, declaredContentType) {
      calls.push({ action: "save", kind, buffer, filename, declaredContentType });
      return { objectKey: "ai/ai_input_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", publicUrl: "https://cdn/ai/input.png", contentType: "image/png", byteSize: buffer.length, width: 1, height: 1 };
    },
    async remove() {},
  };
  const now = new Date("2026-09-01T01:00:00.000Z");
  const pool = {
    async query(sql, parameters) {
      calls.push({ action: "query", sql, parameters });
      return { rows: [{ id: parameters[0], user_id: parameters[1], file_type: parameters[2], object_key: parameters[3], public_url: parameters[4], content_type: parameters[5], byte_size: parameters[6], created_at: parameters[9], deleted_at: null }] };
    },
  };
  const service = new PostgresFileAssetService(pool, coverStorage, () => now, aiStorage);
  const file = await service.upload("usr_current", { type: "ai_input", buffer: Buffer.from([1, 2]), filename: "input.png", declaredContentType: "image/png" });
  assert.equal(file.type, "ai_input");
  assert.equal(file.url, "https://cdn/ai/input.png");
  assert.equal(calls[0].kind, "ai_input");
  assert.equal(calls[1].parameters[2], "ai_input");
});
