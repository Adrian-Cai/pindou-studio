const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const test = require("node:test");
const { loadLocalEnv, readConfig } = require("../dist/config/env.js");
const { createPool } = require("../dist/db/pool.js");
const { PostgresAiGenerationService } = require("../dist/modules/ai/ai-generation-service.js");

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";

async function waitForTerminal(service, userId, jobId) {
  let result = await service.get(userId, jobId);
  for (let attempt = 0; attempt < 10 && (result.status === "queued" || result.status === "processing"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await service.processQueued();
    result = await service.get(userId, jobId);
  }
  return result;
}

test("stage 6 real database flow: AI success, failure, output asset and idempotent debit", { skip: !enabled }, async () => {
  loadLocalEnv();
  const config = readConfig();
  const pool = createPool(config.database);
  const suffix = randomBytes(6).toString("hex");
  const userId = `usr_ai_${suffix}`;
  const inputFileId = `file_ai_${suffix}`;
  const now = new Date("2026-09-01T04:00:00.000Z");
  let providerCreateCount = 0;
  let outputNumber = 0;
  const provider = {
    configured: true,
    name: "hunyuan",
    model: "HY-Image-v3.0-I2I-ToB-v1.0.1",
    async createTask(input, legacyPrompt) {
      providerCreateCount += 1;
      const prompt = typeof input === "string" ? legacyPrompt : input.prompt;
      assert.match(prompt, /不要生成拼豆网格、方格、材料标记、施工图、边框、Logo、水印或额外文字/);
      if (providerCreateCount > 1) throw new Error("provider rejected image");
      return {
        requestId: `request_success_${suffix}`,
        outputUrl: "https://aigc-image.cos.myqcloud.com/output.png",
      };
    },
    async downloadOutput() { return Buffer.from("verified-provider-output"); },
  };
  const storage = {
    async readObject() { return { buffer: Buffer.from("verified-input"), contentType: "image/png" }; },
    async save() {
      outputNumber += 1;
      return {
        objectKey: `ai/ai_output_${suffix}${String(outputNumber).padStart(20, "0")}.png`,
        publicUrl: `https://cdn.example/ai/output-${suffix}-${outputNumber}.png`,
        contentType: "image/png",
        byteSize: 24,
        width: 1024,
        height: 1024,
      };
    },
    async remove() {},
  };

  try {
    await pool.query(
      `INSERT INTO pindou_users (
         id, openid_hash, openid_ciphertext, nickname, avatar_url, created_at, updated_at, deleted_at
       ) VALUES ($1, $2, NULL, 'AI 联调用户', NULL, $3, $3, NULL)`,
      [userId, `ai_${suffix}`, now],
    );
    await pool.query(
      `INSERT INTO pindou_file_assets (
         id, user_id, file_type, object_key, public_url, content_type,
         byte_size, width, height, created_at, deleted_at
       ) VALUES ($1, $2, 'ai_input', $3, $4, 'image/png', 16, 512, 512, $5, NULL)`,
      [inputFileId, userId, `ai/ai_input_${suffix}.png`, `https://cdn.example/ai/input-${suffix}.png`, now],
    );
    const service = new PostgresAiGenerationService(
      pool,
      provider,
      storage,
      { dailyStandardDownloads: 9, dailyAiGenerations: 3 },
      () => now,
    );
    const successInput = {
      userId,
      idempotencyKey: `stage6-success-${suffix}`,
      inputFileId,
      style: "natural",
      detailLevel: "medium",
      backgroundMode: "simplify",
    };
    const created = await service.create(successInput);
    assert.equal(created.status, "queued");
    const succeeded = await waitForTerminal(service, userId, created.id);
    const duplicate = await service.create(successInput);
    assert.equal(succeeded.status, "succeeded");
    assert.equal(duplicate.id, succeeded.id);
    assert.equal(providerCreateCount, 1);

    const failedCreated = await service.create({
      ...successInput,
      idempotencyKey: `stage6-failed-${suffix}`,
      style: "cartoon",
    });
    const failed = await waitForTerminal(service, userId, failedCreated.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure.code, "AI_GENERATION_FAILED");

    const audit = await pool.query(
      `SELECT jobs.status, jobs.output_file_id, files.file_type,
              COUNT(transactions.id)::int AS debit_count,
              COALESCE(SUM(transactions.amount), 0)::int AS debited
         FROM pindou_ai_generation_jobs jobs
         LEFT JOIN pindou_file_assets files ON files.id = jobs.output_file_id
         LEFT JOIN pindou_quota_transactions transactions
           ON transactions.idempotency_key = 'ai-generation:' || jobs.id
          AND transactions.quota_kind = 'ai_generation'
          AND transactions.type = 'usage_debit'
        WHERE jobs.id = $1
        GROUP BY jobs.id, files.file_type`,
      [succeeded.id],
    );
    assert.equal(audit.rows[0].status, "succeeded");
    assert.equal(audit.rows[0].file_type, "ai_output");
    assert.equal(audit.rows[0].debit_count, 1);
    assert.equal(audit.rows[0].debited, -1);
  } finally {
    const jobs = await pool.query("SELECT output_file_id FROM pindou_ai_generation_jobs WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM pindou_quota_transactions WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM pindou_ai_generation_jobs WHERE user_id = $1", [userId]);
    const outputIds = jobs.rows.map((row) => row.output_file_id).filter(Boolean);
    if (outputIds.length > 0) await pool.query("DELETE FROM pindou_file_assets WHERE id = ANY($1::varchar[])", [outputIds]);
    await pool.query("DELETE FROM pindou_file_assets WHERE id = $1", [inputFileId]);
    await pool.query("DELETE FROM pindou_users WHERE id = $1", [userId]);
    await pool.end();
  }
});
