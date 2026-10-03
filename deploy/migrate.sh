#!/bin/sh

set -eu

MIGRATION_DIR=${1:?用法：sh deploy/migrate.sh <迁移目录>}

: "${DB_HOST:?DB_HOST 未配置}"
: "${DB_NAME:?DB_NAME 未配置}"
: "${DB_USER:?DB_USER 未配置}"
: "${DB_PASSWORD:?DB_PASSWORD 未配置}"
DB_PORT=${DB_PORT:-5432}
DB_SCHEMA=${DB_SCHEMA:-public}
DB_SSL_MODE=${DB_SSL_MODE:-disable}

command -v psql >/dev/null 2>&1 || {
  echo "未找到 psql，无法执行数据库迁移" >&2
  exit 1
}
command -v sha256sum >/dev/null 2>&1 || {
  echo "未找到 sha256sum，无法校验迁移文件" >&2
  exit 1
}

psql_run() {
  PGPASSWORD="$DB_PASSWORD" PGSSLMODE="$DB_SSL_MODE" \
    PGOPTIONS="-c search_path=$DB_SCHEMA,public" psql \
    -X -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" "$@"
}

bootstrap="$MIGRATION_DIR/000_schema_migrations.sql"
test -f "$bootstrap" || {
  echo "缺少迁移记录表脚本：$bootstrap" >&2
  exit 1
}

# 迁移包含 ALTER TABLE / COMMENT ON / CREATE INDEX，必须由表 owner 或超级用户执行。
not_owned=$(psql_run -At -c "
  SELECT tablename || ' (owner ' || tableowner || ')'
    FROM pg_tables
   WHERE schemaname = current_schema()
     AND tablename LIKE 'pindou_%'
     AND tableowner <> current_user
   ORDER BY tablename
")
test -z "$not_owned" || {
  echo "迁移账号 $DB_USER 不是以下表的 owner，无法安全执行迁移：" >&2
  echo "$not_owned" >&2
  exit 1
}

# 000 本身只负责创建记录表，可安全重复执行；之后所有迁移都通过记录表去重。
psql_run -v ON_ERROR_STOP=1 -f "$bootstrap"

checksum_for() {
  sha256sum "$1" | awk '{print $1}'
}

record_migration() {
  migration_version=$1
  migration_filename=$2
  migration_checksum=$3
  psql_run -v ON_ERROR_STOP=1 \
    -v migration_version="$migration_version" \
    -v migration_filename="$migration_filename" \
    -v migration_checksum="$migration_checksum" \
    -c "
      INSERT INTO pindou_schema_migrations (version, filename, checksum)
      VALUES (:migration_version, :'migration_filename', :'migration_checksum');
    "
}

for migration in "$MIGRATION_DIR"/[0-9][0-9][0-9]_*.sql; do
  test -f "$migration" || continue
  filename=${migration##*/}
  version=${filename%%_*}
  checksum=$(checksum_for "$migration")
  recorded=$(psql_run -At -F '|' \
    -v migration_version="$version" \
    -c "SELECT filename, checksum FROM pindou_schema_migrations WHERE version = :migration_version;")

  if [ -n "$recorded" ]; then
    recorded_filename=${recorded%%|*}
    recorded_checksum=${recorded#*|}
    test "$recorded_filename" = "$filename" || {
      echo "迁移编号 $version 已绑定到 $recorded_filename，当前文件为 $filename" >&2
      exit 1
    }
    test "$recorded_checksum" = "$checksum" || {
      echo "已执行迁移 $filename 的 SHA-256 已变化，拒绝继续部署" >&2
      exit 1
    }
    echo "跳过已执行迁移 $filename"
    continue
  fi

  echo "执行迁移 $filename"
  psql_run -v ON_ERROR_STOP=1 -f "$migration"
  record_migration "$version" "$filename" "$checksum"
done
