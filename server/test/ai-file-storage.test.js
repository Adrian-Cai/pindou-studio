const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { FileSystemAiFileStorage } = require("../dist/modules/files/ai-file-storage.js");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x00,
  0xff, 0xd9,
]);

test("AI file storage separates input/output object keys and serves only generated paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pindou-ai-file-test-"));
  try {
    const storage = new FileSystemAiFileStorage(directory, "https://cdn.example/ai");
    const input = await storage.save("ai_input", PNG, "input.png", "image/png");
    const output = await storage.save("ai_output", PNG, "output.png", "image/png");
    assert.match(input.objectKey, /^ai\/ai_input_[a-f0-9]{32}\.png$/);
    assert.match(output.objectKey, /^ai\/ai_output_[a-f0-9]{32}\.png$/);
    assert.deepEqual((await storage.readObject(input.objectKey)).buffer, PNG);
    assert.deepEqual(
      (await storage.read(`/api/media/ai/${output.objectKey.slice(3)}`)).buffer,
      PNG,
    );
    assert.equal(await storage.read("/api/media/ai/../../secret"), null);
    await storage.remove(input.objectKey);
    await storage.remove(output.objectKey);
    assert.equal(await storage.readObject(input.objectKey), null);
    assert.equal(await storage.readObject(output.objectKey), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI file storage accepts JPEG output when the upstream model returns JPEG", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pindou-ai-output-jpeg-test-"));
  try {
    const storage = new FileSystemAiFileStorage(directory, "https://cdn.example/ai");
    const output = await storage.save("ai_output", JPEG, "output.jpg", "image/jpeg");
    assert.match(output.objectKey, /^ai\/ai_output_[a-f0-9]{32}\.jpg$/);
    assert.equal(output.contentType, "image/jpeg");
    assert.deepEqual((await storage.readObject(output.objectKey)).buffer, JPEG);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI file storage enforces byte limits and does not trust the filename extension", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pindou-ai-file-limit-test-"));
  try {
    const storage = new FileSystemAiFileStorage(directory, "https://cdn.example/ai", {
      maximumBytes: PNG.length - 1,
      maximumWidth: 1,
      maximumHeight: 1,
      maximumPixels: 1,
    });
    await assert.rejects(
      () => storage.save("ai_input", PNG, "input.png", "image/png"),
      (error) => error.code === "PAYLOAD_TOO_LARGE",
    );

    const regularStorage = new FileSystemAiFileStorage(directory, "https://cdn.example/ai");
    await assert.rejects(
      () => regularStorage.save("ai_input", PNG, "input.jpg", "image/png"),
      (error) => error.code === "INVALID_ARGUMENT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
