-- 为草稿、作品和 AI 任务保存统一的生成模式。
BEGIN;

ALTER TABLE pindou_works
  ADD COLUMN IF NOT EXISTS generation_mode varchar(20) NOT NULL DEFAULT 'standard';
ALTER TABLE pindou_works
  ALTER COLUMN generation_mode DROP DEFAULT;
ALTER TABLE pindou_works
  DROP CONSTRAINT IF EXISTS ck_pindou_works_generation_mode;
ALTER TABLE pindou_works
  ADD CONSTRAINT ck_pindou_works_generation_mode
    CHECK (generation_mode IN ('standard', 'ai'));
COMMENT ON COLUMN pindou_works.generation_mode IS '作品生成模式：standard 或 ai';

ALTER TABLE pindou_ai_generation_jobs
  ADD COLUMN IF NOT EXISTS generation_mode varchar(20) NOT NULL DEFAULT 'ai';
ALTER TABLE pindou_ai_generation_jobs
  ALTER COLUMN generation_mode DROP DEFAULT;
ALTER TABLE pindou_ai_generation_jobs
  DROP CONSTRAINT IF EXISTS ck_pindou_ai_generation_jobs_generation_mode;
ALTER TABLE pindou_ai_generation_jobs
  ADD CONSTRAINT ck_pindou_ai_generation_jobs_generation_mode
    CHECK (generation_mode = 'ai');
COMMENT ON COLUMN pindou_ai_generation_jobs.generation_mode IS 'AI 任务固定为 ai 模式';

COMMIT;
