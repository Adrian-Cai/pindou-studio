ALTER TABLE pindou_content_security_checks
  ADD COLUMN IF NOT EXISTS media_sha256 varchar(64);

ALTER TABLE pindou_content_security_checks
  DROP CONSTRAINT IF EXISTS ck_pindou_content_security_checks_media_sha256;

ALTER TABLE pindou_content_security_checks
  ADD CONSTRAINT ck_pindou_content_security_checks_media_sha256
  CHECK (media_sha256 IS NULL OR media_sha256 ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN pindou_content_security_checks.media_sha256 IS
  '审核图片 SHA-256，用于短期内校验并复用同一图片的检测结果';
