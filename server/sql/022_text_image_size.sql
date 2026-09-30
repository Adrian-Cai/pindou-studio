-- 文生图尺寸随任务持久化，恢复和重试保持原选择。
ALTER TABLE pindou_text_image_generation_jobs
  ADD COLUMN IF NOT EXISTS image_size text NOT NULL DEFAULT '1024x1024'
  CHECK (image_size IN ('1024x1024', '1280x720', '720x1280', '1280x1280'));
