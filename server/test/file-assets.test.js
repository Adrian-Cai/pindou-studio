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
