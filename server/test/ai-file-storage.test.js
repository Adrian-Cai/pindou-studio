const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { FileSystemAiFileStorage } = require("../dist/modules/files/ai-file-storage.js");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
