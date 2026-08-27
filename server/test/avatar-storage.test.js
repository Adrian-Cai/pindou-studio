const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { FileSystemAvatarStorage } = require("../dist/modules/users/avatar-storage.js");

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

test("avatar storage validates image bytes and never trusts the client filename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pindou-avatar-test-"));
  try {
    const storage = new FileSystemAvatarStorage(directory);
    const saved = await storage.save(PNG, "image/png");
    assert.match(saved.publicPath, /^\/api\/media\/avatars\/avatar_[a-f0-9]{32}\.png$/);

    const loaded = await storage.read(saved.publicPath);
    assert.equal(loaded.contentType, "image/png");
    assert.deepEqual(loaded.buffer, PNG);

    await storage.remove(saved.publicPath);
    assert.equal(await storage.read(saved.publicPath), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("avatar storage rejects disguised or mismatched image content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pindou-avatar-test-"));
  try {
    const storage = new FileSystemAvatarStorage(directory);
    await assert.rejects(() => storage.save(Buffer.from("not-an-image"), "image/png"), (error) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    });
    await assert.rejects(() => storage.save(PNG, "image/jpeg"), (error) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
