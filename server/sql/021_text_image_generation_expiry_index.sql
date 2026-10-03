-- 为文生图过期任务清理提供按过期时间扫描的索引。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pindou_text_image_jobs_expiry
  ON pindou_text_image_generation_jobs (expires_at);
