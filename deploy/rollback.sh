#!/bin/sh

# 用法（服务器上执行）：
#   sh deploy/rollback.sh              # 回滚到部署历史中的上一个版本
#   sh deploy/rollback.sh <镜像 tag>    # 回滚到指定 tag
#
# 必需环境变量：IMAGE_REPO
# 可选环境变量：DEPLOY_DIR（默认 /opt/pindou/deploy）
#               RUNTIME_ENV_FILE（默认 /opt/pindou/config/api.env）
#               STATE_DIR（默认 /opt/pindou/state）
#               API_HEALTH_URL（默认 http://127.0.0.1:3100/health）
#
# 只使用本地已有的镜像，不联网拉取：网络故障或制品库不可用时回滚依然要能用，
# 这是回滚脚本唯一不能妥协的地方。

set -eu

DEPLOY_DIR=${DEPLOY_DIR:-/opt/pindou/deploy}
RUNTIME_ENV_FILE=${RUNTIME_ENV_FILE:-/opt/pindou/config/api.env}
STATE_DIR=${STATE_DIR:-/opt/pindou/state}
API_HEALTH_URL=${API_HEALTH_URL:-http://127.0.0.1:3100/health}

: "${IMAGE_REPO:?IMAGE_REPO 未配置}"

# deploy-history.log 每行只存一个 tag（按部署顺序追加），供回滚时定位上一个版本。
# 带时间和动作的记录在 deploy-events.log，两者分开是为了让这里能按整行精确匹配。
HISTORY_FILE="$STATE_DIR/deploy-history.log"
EVENTS_FILE="$STATE_DIR/deploy-events.log"
CURRENT_TAG_FILE="$STATE_DIR/current-tag"

# 返回 history 中指定 tag 最后一次出现位置的前一行，也就是它的上一个版本。
# 连续回滚时靠它逐级回退，而不是跳回「最后一个不等于当前版本」的 tag。
previous_of() {
  target=$1
  test -f "$HISTORY_FILE" || return 0
  line_no=$(grep -Fxn "$target" "$HISTORY_FILE" | tail -n 1 | cut -d: -f1)
  test -n "$line_no" || return 0
  test "$line_no" -gt 1 || return 0
  sed -n "$((line_no - 1))p" "$HISTORY_FILE"
}

TARGET_TAG=${1:-}

if [ -z "$TARGET_TAG" ]; then
  test -f "$HISTORY_FILE" || {
    echo "没有部署历史：$HISTORY_FILE 不存在，无法自动选择回滚点" >&2
    echo "可改为显式指定：sh deploy/rollback.sh <镜像 tag>" >&2
    exit 1
  }

  CURRENT_TAG=$(cat "$CURRENT_TAG_FILE" 2>/dev/null || true)
  if [ -z "$CURRENT_TAG" ]; then
    # 没有当前版本记录时，历史最后一行就是当前在跑的版本，取它前面那一行。
    TARGET_TAG=$(tail -n 2 "$HISTORY_FILE" | head -n 1)
  else
    TARGET_TAG=$(previous_of "$CURRENT_TAG")
  fi

  test -n "$TARGET_TAG" || {
    echo "部署历史里没有更早的版本可以回滚" >&2
    exit 1
  }
fi

echo "回滚目标：$IMAGE_REPO:$TARGET_TAG"

# 本地没有镜像就拒绝执行，而不是尝试 docker pull —— 回滚路径不应依赖外部可用性。
docker image inspect "$IMAGE_REPO:$TARGET_TAG" > /dev/null 2>&1 || {
  echo "本地缺少镜像 $IMAGE_REPO:$TARGET_TAG" >&2
  echo "可先手动执行 docker pull $IMAGE_REPO:$TARGET_TAG 后重试" >&2
  exit 1
}

cd "$DEPLOY_DIR"

if ! IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$TARGET_TAG" \
    docker compose --env-file "$RUNTIME_ENV_FILE" up -d --wait --wait-timeout 120 api; then
  echo "回滚容器未通过健康等待，输出最近日志" >&2
  docker inspect --format '{{json .State.Health}}' pindou-api || true
  IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$TARGET_TAG" \
    docker compose --env-file "$RUNTIME_ENV_FILE" logs --tail=100 api || true
  exit 1
fi

if ! curl --fail --silent --show-error \
    --retry 20 --retry-delay 3 --retry-connrefused \
    "$API_HEALTH_URL" > /dev/null; then
  echo "回滚后健康检查失败：$API_HEALTH_URL" >&2
  IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$TARGET_TAG" \
    docker compose --env-file "$RUNTIME_ENV_FILE" logs --tail=100 api || true
  exit 1
fi

echo "$TARGET_TAG" > "$CURRENT_TAG_FILE"
echo "$(date -Is) rollback $TARGET_TAG" >> "$EVENTS_FILE"
echo "回滚完成：$TARGET_TAG"
