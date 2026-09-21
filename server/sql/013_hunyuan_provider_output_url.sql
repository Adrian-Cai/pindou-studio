BEGIN;

ALTER TABLE pindou_ai_generation_jobs
  ADD COLUMN IF NOT EXISTS provider_output_url text;

COMMENT ON COLUMN pindou_ai_generation_jobs.provider_output_url IS '模型服务商临时输出地址，仅在持久化前短暂保存';

COMMIT;
