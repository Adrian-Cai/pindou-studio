const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { FileSystemCoverStorage } = require("../dist/modules/files/cover-storage.js");
const { validateCoverImage } = require("../dist/modules/files/image-validation.js");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("cover validation checks real format, extension and decodability", () => {
  const image = validateCoverImage(PNG, "preview.png", "image/png");
  assert.deepEqual(image, { extension: "png", contentType: "image/png", width: 1, height: 1 });
  assert.throws(() => validateCoverImage(PNG, "preview.jpg", "image/png"), /扩展名/);
  assert.throws(() => validateCoverImage(Buffer.from("not-an-image"), "preview.png", "image/png"), /可解码/);
});

test("cover storage validates before writing and stores only the generated object", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pindou-cover-test-"));
  try {
    const storage = new FileSystemCoverStorage(directory, "https://cdn.example/covers");
    const saved = await storage.save(PNG, "client-name.png", "image/png");
    assert.match(saved.objectKey, /^covers\/cover_[a-f0-9]{32}\.png$/);
    assert.equal(saved.publicUrl, `https://cdn.example/covers/${saved.objectKey.slice("covers/".length)}`);
    assert.deepEqual(await readFile(join(directory, saved.objectKey.slice("covers/".length))), PNG);
    await storage.remove(saved.objectKey);
    await assert.rejects(() => readFile(join(directory, saved.objectKey.slice("covers/".length))), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
