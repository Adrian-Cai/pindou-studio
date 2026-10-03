ALTER TABLE pindou_ai_generation_jobs
  ADD COLUMN IF NOT EXISTS provider_next_poll_at timestamptz;

COMMENT ON COLUMN pindou_ai_generation_jobs.provider_next_poll_at IS '异步图像 provider 下一次允许查询状态的时间，支持重启恢复与限流保护';
