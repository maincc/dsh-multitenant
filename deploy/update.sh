#!/usr/bin/env bash
# ============================================================================
#  服务器更新脚本（在服务器上执行）
#  用法：./deploy/update.sh        （非 root 时自动 sudo）
#  环境变量：FORCE_IMAGE=1 强制重建租户镜像
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  exec sudo env FORCE_IMAGE="${FORCE_IMAGE:-0}" "$0" "$@"
fi

# 1. 拉取最新代码
git pull --ff-only

# 2. 前端有变更（或 dist 缺失）时重新构建
if [ ! -d frontend/dist ] || git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -qE '^(frontend/|package)'; then
  echo ">> 前端有变更，重新构建 ..."
  (cd frontend && npm ci && npm run build)
else
  echo ">> 前端无变更，跳过构建"
fi

# 3. Dockerfile 有变更时重建租户镜像
if [ "${FORCE_IMAGE:-0}" = "1" ] || git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -q '^Dockerfile$'; then
  echo ">> 重建租户镜像 dsh-multitenant:latest ..."
  docker build -t dsh-multitenant:latest .
else
  echo ">> 镜像无需重建（FORCE_IMAGE=1 可强制）"
fi

# 4. 重启服务
systemctl restart dsh-multitenant
echo ">> 更新完成，服务已重启"
systemctl status dsh-multitenant --no-pager | head -8
