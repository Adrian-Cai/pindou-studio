-- 迁移执行记录表。该表只保存部署元数据，不属于业务数据。
BEGIN;

CREATE TABLE IF NOT EXISTS pindou_schema_migrations (
  version int4 NOT NULL,
  filename varchar(255) NOT NULL,
  checksum varchar(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_pindou_schema_migrations PRIMARY KEY (version),
  CONSTRAINT uq_pindou_schema_migrations_filename UNIQUE (filename),
  CONSTRAINT ck_pindou_schema_migrations_version CHECK (version >= 0),
  CONSTRAINT ck_pindou_schema_migrations_checksum
    CHECK (checksum ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE pindou_schema_migrations IS '数据库迁移执行记录，仅保存迁移版本、文件和校验值';
COMMENT ON COLUMN pindou_schema_migrations.version IS '迁移编号，例如 000、009、010';
COMMENT ON COLUMN pindou_schema_migrations.filename IS '已执行的迁移文件名';
COMMENT ON COLUMN pindou_schema_migrations.checksum IS '迁移文件内容的 SHA-256 小写十六进制摘要';
COMMENT ON COLUMN pindou_schema_migrations.applied_at IS '迁移成功完成时间（UTC）';

COMMIT;
