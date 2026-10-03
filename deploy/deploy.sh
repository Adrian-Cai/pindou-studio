#!/bin/sh

# 用法（服务器上执行）：
#   IMAGE_REPO=<repo> sh deploy/deploy.sh <镜像 tag>
#
# 部署指定 tag 的 API 容器，并在失败时自动回滚到上一个成功版本。
#
# 必需环境变量：IMAGE_REPO
# 可选环境变量：DEPLOY_DIR（默认 /opt/pindou/deploy）
#               RUNTIME_ENV_FILE（默认 /opt/pindou/config/api.env）
#               STATE_DIR（默认 /opt/pindou/state）
#               API_HEALTH_URL（默认 http://127.0.0.1:3100/health）
#               SKIP_AUTO_ROLLBACK=1（失败时不自动回滚，保留现场用于排查）
#
# 注意：本脚本只做「原地替换」，容器重启期间仍有短暂停机窗口。
# 要做到零停机需要改成蓝绿部署（两套容器 + 上游切流），不在本脚本范围内。

set -eu

TARGET_TAG=${1:?用法：sh deploy/deploy.sh <镜像 tag>}

DEPLOY_DIR=${DEPLOY_DIR:-/opt/pindou/deploy}
RUNTIME_ENV_FILE=${RUNTIME_ENV_FILE:-/opt/pindou/config/api.env}
STATE_DIR=${STATE_DIR:-/opt/pindou/state}
API_HEALTH_URL=${API_HEALTH_URL:-http://127.0.0.1:3100/health}

: "${IMAGE_REPO:?IMAGE_REPO 未配置}"

# deploy-history.log 每行只存一个 tag（按部署顺序追加），供回滚脚本定位上一个版本。
# 带时间和动作的记录写在 deploy-events.log，两者分开是为了按整行精确匹配。
HISTORY_FILE="$STATE_DIR/deploy-history.log"
EVENTS_FILE="$STATE_DIR/deploy-events.log"
CURRENT_TAG_FILE="$STATE_DIR/current-tag"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

cd "$DEPLOY_DIR"
mkdir -p "$STATE_DIR"

# 上一个成功部署的版本，也就是本次失败时要回滚到的目标。
# 它还没有被覆盖：新版本只有验证通过后才会写入 current-tag。
ROLLBACK_TARGET=$(cat "$CURRENT_TAG_FILE" 2>/dev/null || true)

echo "部署目标：$IMAGE_REPO:$TARGET_TAG"
[ -z "$ROLLBACK_TARGET" ] || echo "回滚点：$ROLLBACK_TARGET"

if ! docker image inspect "$IMAGE_REPO:$TARGET_TAG" > /dev/null 2>&1; then
  echo "本地缺少镜像，尝试拉取"
  docker pull "$IMAGE_REPO:$TARGET_TAG"
fi

compose_up() {
  IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$1" \
    docker compose --env-file "$RUNTIME_ENV_FILE" up -d --wait --wait-timeout 120 api
}

dump_logs() {
  docker inspect --format '{{json .State.Health}}' pindou-api || true
  IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$TARGET_TAG" \
    docker compose --env-file "$RUNTIME_ENV_FILE" logs --tail=100 api || true
}

rollback_to_previous() {
  if [ -z "$ROLLBACK_TARGET" ]; then
    echo "没有可用的回滚点（首次部署？），保留现场由人工处理" >&2
    return 1
  fi

  echo "部署失败，自动回滚到 $ROLLBACK_TARGET" >&2
  IMAGE_REPO="$IMAGE_REPO" \
  DEPLOY_DIR="$DEPLOY_DIR" \
  RUNTIME_ENV_FILE="$RUNTIME_ENV_FILE" \
  STATE_DIR="$STATE_DIR" \
  API_HEALTH_URL="$API_HEALTH_URL" \
    sh "$SCRIPT_DIR/rollback.sh" "$ROLLBACK_TARGET"
}

if ! compose_up "$TARGET_TAG"; then
  echo "容器未通过 Compose 健康等待" >&2
  dump_logs
  if [ "${SKIP_AUTO_ROLLBACK:-0}" = "1" ]; then
    exit 1
  fi
  rollback_to_previous || true
  exit 1
fi

if ! curl --fail --silent --show-error \
    --retry 20 --retry-delay 3 --retry-connrefused \
    "$API_HEALTH_URL" > /dev/null; then
  echo "健康检查失败：$API_HEALTH_URL" >&2
  dump_logs
  if [ "${SKIP_AUTO_ROLLBACK:-0}" = "1" ]; then
    exit 1
  fi
  rollback_to_previous || true
  exit 1
fi

echo "$TARGET_TAG" > "$CURRENT_TAG_FILE"
# 连续两次部署同一 tag 时不重复记录，否则回滚会退回到自己。
if ! tail -n 1 "$HISTORY_FILE" 2>/dev/null | grep -Fxq "$TARGET_TAG"; then
  echo "$TARGET_TAG" >> "$HISTORY_FILE"
fi
echo "$(date -Is) deploy $TARGET_TAG" >> "$EVENTS_FILE"
echo "部署完成：$TARGET_TAG"
