-- 文生图任务与作品来源；任务输出复用 AI 文件资产和现有额度账本。
BEGIN;

ALTER TABLE pindou_works
  ADD COLUMN IF NOT EXISTS creation_source varchar(20) NOT NULL DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS source_prompt text;
ALTER TABLE pindou_works
  DROP CONSTRAINT IF EXISTS ck_pindou_works_creation_source,
  DROP CONSTRAINT IF EXISTS ck_pindou_works_source_prompt;
ALTER TABLE pindou_works
  ADD CONSTRAINT ck_pindou_works_creation_source
    CHECK (creation_source IN ('image', 'text')),
  ADD CONSTRAINT ck_pindou_works_source_prompt
    CHECK ((creation_source = 'image' AND source_prompt IS NULL)
      OR (creation_source = 'text' AND source_prompt IS NOT NULL
        AND char_length(source_prompt) BETWEEN 1 AND 500));
COMMENT ON COLUMN pindou_works.creation_source IS '创作输入来源：image 或 text；与拼豆转换模式分开';
COMMENT ON COLUMN pindou_works.source_prompt IS '文字创作时用户提交的描述；随作品保留';

CREATE TABLE IF NOT EXISTS pindou_text_image_generation_jobs (
  id varchar(32) PRIMARY KEY,
  user_id varchar(32) NOT NULL REFERENCES pindou_users(id) ON DELETE RESTRICT,
  prompt varchar(500) NOT NULL,
  provider varchar(40) NOT NULL,
  model varchar(80) NOT NULL,
  status varchar(20) NOT NULL,
  output_file_id varchar(32) REFERENCES pindou_file_assets(id) ON DELETE RESTRICT,
  provider_request_id varchar(128),
  idempotency_key varchar(128) NOT NULL,
  error_code varchar(80),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT ck_pindou_text_image_generation_jobs_status
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  CONSTRAINT ck_pindou_text_image_generation_jobs_prompt
    CHECK (char_length(prompt) BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pindou_text_image_jobs_user_idempotency
  ON pindou_text_image_generation_jobs (user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_pindou_text_image_jobs_user_created
  ON pindou_text_image_generation_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pindou_text_image_jobs_queue
  ON pindou_text_image_generation_jobs (status, updated_at)
  WHERE status IN ('queued', 'processing');
CREATE INDEX IF NOT EXISTS idx_pindou_text_image_jobs_unconsumed
  ON pindou_text_image_generation_jobs (user_id, expires_at)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE pindou_text_image_generation_jobs IS '用户文字生成参考图任务及短期恢复状态';
COMMENT ON COLUMN pindou_text_image_generation_jobs.prompt IS '用户提交的提示词，最多 500 字；不写入运行日志';
COMMENT ON COLUMN pindou_text_image_generation_jobs.consumed_at IS '客户端确认生成拼豆草稿后标记，避免恢复列表重复展示';

COMMIT;
