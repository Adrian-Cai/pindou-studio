-- 前置条件：pindou_* 基础业务表已按 docs/backend/database/DATABASE_DESIGN.md 建立。
BEGIN;

ALTER TABLE pindou_quota_transactions
  ADD COLUMN IF NOT EXISTS quota_kind varchar(30) NOT NULL DEFAULT 'standard_download';
ALTER TABLE pindou_quota_transactions
  ALTER COLUMN quota_kind DROP DEFAULT;
COMMENT ON COLUMN pindou_quota_transactions.quota_kind IS '额度资源类型：standard_download 或 ai_generation';

ALTER TABLE pindou_packages
  ADD COLUMN IF NOT EXISTS quota_kind varchar(30) NOT NULL DEFAULT 'ai_generation';
ALTER TABLE pindou_packages
  ALTER COLUMN quota_kind DROP DEFAULT;
COMMENT ON COLUMN pindou_packages.quota_kind IS '套餐发放的额度资源类型';

ALTER TABLE pindou_orders
  ADD COLUMN IF NOT EXISTS quota_kind_snapshot varchar(30) NOT NULL DEFAULT 'standard_download';
UPDATE pindou_orders AS orders
   SET quota_kind_snapshot = packages.quota_kind
  FROM pindou_packages AS packages
 WHERE orders.package_id = packages.id
   AND orders.status = 'pending';
ALTER TABLE pindou_orders
  ALTER COLUMN quota_kind_snapshot DROP DEFAULT;
COMMENT ON COLUMN pindou_orders.quota_kind_snapshot IS '下单时的额度资源类型快照';

ALTER TABLE pindou_quota_transactions
  DROP CONSTRAINT IF EXISTS ck_pindou_quota_transactions_type,
  DROP CONSTRAINT IF EXISTS ck_pindou_quota_transactions_quota_kind;
ALTER TABLE pindou_quota_transactions
  ADD CONSTRAINT ck_pindou_quota_transactions_type
    CHECK (type IN ('daily_grant', 'download_debit', 'usage_debit', 'purchase_grant', 'refund', 'adjustment')),
  ADD CONSTRAINT ck_pindou_quota_transactions_quota_kind
    CHECK (quota_kind IN ('standard_download', 'ai_generation'));

ALTER TABLE pindou_packages
  DROP CONSTRAINT IF EXISTS ck_pindou_packages_quota_kind;
ALTER TABLE pindou_packages
  ADD CONSTRAINT ck_pindou_packages_quota_kind
    CHECK (quota_kind IN ('standard_download', 'ai_generation'));

ALTER TABLE pindou_orders
  DROP CONSTRAINT IF EXISTS ck_pindou_orders_quota_kind_snapshot;
ALTER TABLE pindou_orders
  ADD CONSTRAINT ck_pindou_orders_quota_kind_snapshot
    CHECK (quota_kind_snapshot IN ('standard_download', 'ai_generation'));

DROP INDEX IF EXISTS uq_pindou_quota_transactions_daily_grant;
CREATE UNIQUE INDEX uq_pindou_quota_transactions_daily_grant
  ON pindou_quota_transactions (user_id, type, quota_kind, quota_date)
  WHERE type = 'daily_grant' AND quota_date IS NOT NULL;

DROP INDEX IF EXISTS uq_pindou_quota_transactions_ai_usage;
CREATE UNIQUE INDEX uq_pindou_quota_transactions_ai_usage
  ON pindou_quota_transactions (idempotency_key)
  WHERE type = 'usage_debit'
    AND quota_kind = 'ai_generation'
    AND idempotency_key IS NOT NULL;

ALTER TABLE pindou_file_assets
  DROP CONSTRAINT IF EXISTS ck_pindou_file_assets_file_type;
ALTER TABLE pindou_file_assets
  ADD CONSTRAINT ck_pindou_file_assets_file_type
    CHECK (file_type IN ('cover', 'ai_input', 'ai_output'));

ALTER TABLE pindou_download_records
  DROP CONSTRAINT IF EXISTS ck_pindou_download_records_file_type;
ALTER TABLE pindou_download_records
  ADD CONSTRAINT ck_pindou_download_records_file_type
    CHECK (file_type IN ('preview', 'chart', 'materials', 'palette'));

CREATE TABLE IF NOT EXISTS pindou_ai_generation_jobs (
  id varchar(32) PRIMARY KEY,
  user_id varchar(32) NOT NULL,
  input_file_id varchar(32) NOT NULL,
  output_file_id varchar(32),
  provider varchar(40) NOT NULL,
  model varchar(80) NOT NULL,
  status varchar(20) NOT NULL,
  prompt_version varchar(20) NOT NULL,
  style varchar(20) NOT NULL,
  detail_level varchar(20) NOT NULL,
  background_mode varchar(20) NOT NULL,
  provider_request_id varchar(128),
  idempotency_key varchar(128) NOT NULL,
  error_code varchar(80),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT fk_pindou_ai_generation_jobs_user_id
    FOREIGN KEY (user_id) REFERENCES pindou_users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pindou_ai_generation_jobs_input_file_id
    FOREIGN KEY (input_file_id) REFERENCES pindou_file_assets(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pindou_ai_generation_jobs_output_file_id
    FOREIGN KEY (output_file_id) REFERENCES pindou_file_assets(id) ON DELETE RESTRICT,
  CONSTRAINT ck_pindou_ai_generation_jobs_status
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'canceled')),
  CONSTRAINT ck_pindou_ai_generation_jobs_style
    CHECK (style IN ('natural', 'cartoon', 'minimal')),
  CONSTRAINT ck_pindou_ai_generation_jobs_detail_level
    CHECK (detail_level IN ('low', 'medium', 'high')),
  CONSTRAINT ck_pindou_ai_generation_jobs_background_mode
    CHECK (background_mode IN ('keep', 'simplify', 'remove'))
);

COMMENT ON TABLE pindou_ai_generation_jobs IS 'AI 精致生成任务及状态机';
COMMENT ON COLUMN pindou_ai_generation_jobs.id IS '任务 ID';
COMMENT ON COLUMN pindou_ai_generation_jobs.user_id IS '发起任务的用户 ID';
COMMENT ON COLUMN pindou_ai_generation_jobs.input_file_id IS 'AI 输入文件资产 ID';
COMMENT ON COLUMN pindou_ai_generation_jobs.output_file_id IS '成功输出文件资产 ID';
COMMENT ON COLUMN pindou_ai_generation_jobs.provider IS '模型服务商标识';
COMMENT ON COLUMN pindou_ai_generation_jobs.model IS '模型名称快照';
COMMENT ON COLUMN pindou_ai_generation_jobs.status IS 'queued/processing/succeeded/failed/canceled';
COMMENT ON COLUMN pindou_ai_generation_jobs.prompt_version IS '服务端提示词版本';
COMMENT ON COLUMN pindou_ai_generation_jobs.style IS '效果风格';
COMMENT ON COLUMN pindou_ai_generation_jobs.detail_level IS '细节等级';
COMMENT ON COLUMN pindou_ai_generation_jobs.background_mode IS '背景处理方式';
COMMENT ON COLUMN pindou_ai_generation_jobs.provider_request_id IS '模型服务商任务 ID';
COMMENT ON COLUMN pindou_ai_generation_jobs.idempotency_key IS '同一用户创建任务的幂等键';
COMMENT ON COLUMN pindou_ai_generation_jobs.error_code IS '稳定的失败原因代码';
COMMENT ON COLUMN pindou_ai_generation_jobs.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN pindou_ai_generation_jobs.updated_at IS '最后更新时间（UTC）';
COMMENT ON COLUMN pindou_ai_generation_jobs.started_at IS '进入处理状态时间（UTC）';
COMMENT ON COLUMN pindou_ai_generation_jobs.completed_at IS '终态时间（UTC）';
COMMENT ON COLUMN pindou_ai_generation_jobs.expires_at IS '任务可查询截止时间（UTC）';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pindou_ai_generation_jobs_user_idempotency
  ON pindou_ai_generation_jobs (user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_pindou_ai_generation_jobs_user_created
  ON pindou_ai_generation_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pindou_ai_generation_jobs_active
  ON pindou_ai_generation_jobs (status, updated_at)
  WHERE status IN ('queued', 'processing');

INSERT INTO pindou_packages (
  id, label, quota_amount, quota_kind, membership_type, membership_days,
  price_fen, currency, enabled, sort_order, created_at, updated_at
) VALUES
  ('ai_generation_30', 'AI 精致生成 30 次', 30, 'ai_generation', NULL, NULL, 990, 'CNY', TRUE, 10, NOW(), NOW()),
  ('ai_generation_80', 'AI 精致生成 80 次', 80, 'ai_generation', NULL, NULL, 1990, 'CNY', TRUE, 20, NOW(), NOW()),
  ('ai_generation_150', 'AI 精致生成 150 次', 150, 'ai_generation', NULL, NULL, 2990, 'CNY', TRUE, 30, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

COMMIT;
