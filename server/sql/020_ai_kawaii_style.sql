-- 增加 Q 版图生图风格；保留历史 natural、cartoon、minimal 任务。
BEGIN;

ALTER TABLE pindou_ai_generation_jobs
  DROP CONSTRAINT IF EXISTS ck_pindou_ai_generation_jobs_style;

ALTER TABLE pindou_ai_generation_jobs
  ADD CONSTRAINT ck_pindou_ai_generation_jobs_style
    CHECK (style IN ('kawaii', 'natural', 'cartoon', 'minimal'));

COMMIT;
