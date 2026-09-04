CREATE TABLE IF NOT EXISTS pindou_content_security_checks (
  id varchar(32) PRIMARY KEY,
  user_id varchar(32) NOT NULL,
  check_type varchar(20) NOT NULL,
  trace_id varchar(128),
  status varchar(20) NOT NULL,
  label int4,
  error_code int4,
  media_object_key varchar(512),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz,
  CONSTRAINT fk_pindou_content_security_checks_user
    FOREIGN KEY (user_id) REFERENCES pindou_users(id) ON DELETE RESTRICT,
  CONSTRAINT ck_pindou_content_security_checks_type
    CHECK (check_type IN ('text', 'media')),
  CONSTRAINT ck_pindou_content_security_checks_status
    CHECK (status IN ('pending', 'pass', 'review', 'risky', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pindou_content_security_checks_trace
  ON pindou_content_security_checks (trace_id)
  WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_pindou_content_security_checks_expiry
  ON pindou_content_security_checks (status, expires_at);

CREATE INDEX IF NOT EXISTS ix_pindou_content_security_checks_user_created
  ON pindou_content_security_checks (user_id, created_at DESC);

COMMENT ON TABLE pindou_content_security_checks IS '微信内容安全审核记录，追踪文本和图片检测状态及异步回调。';
COMMENT ON COLUMN pindou_content_security_checks.id IS '服务端生成的审核记录 ID。';
COMMENT ON COLUMN pindou_content_security_checks.user_id IS '发起审核的用户，确保审核记录归属正确。';
COMMENT ON COLUMN pindou_content_security_checks.check_type IS '审核类型：text 为作品名称，media 为上传图片。';
COMMENT ON COLUMN pindou_content_security_checks.trace_id IS '微信内容安全接口返回的异步任务标识。';
COMMENT ON COLUMN pindou_content_security_checks.status IS '审核状态：pending、pass、review、risky 或 failed。';
COMMENT ON COLUMN pindou_content_security_checks.label IS '微信返回的风险标签编号，不向小程序用户展示。';
COMMENT ON COLUMN pindou_content_security_checks.error_code IS '微信审核错误码，仅用于服务端排查。';
COMMENT ON COLUMN pindou_content_security_checks.media_object_key IS '临时审核图片对象键，回调或过期后清理。';
COMMENT ON COLUMN pindou_content_security_checks.created_at IS '审核记录创建时间。';
COMMENT ON COLUMN pindou_content_security_checks.updated_at IS '审核记录最近更新时间。';
COMMENT ON COLUMN pindou_content_security_checks.expires_at IS '临时媒体和未完成审核记录的过期时间。';
