#!/usr/bin/env bash
# ============================================================================
#  服务器更新脚本（在服务器上执行）
#  用法：./deploy/update.sh        （非 root 时自动 sudo）
#  环境变量：
#    FORCE_IMAGE=1    强制重建租户镜像
#    SKIP_GIT_PULL=1  跳过 git pull（rsync 上传 / 服务器无法访问 GitHub 时）
#                     不设置时也会自动检测：git 远端不可达则跳过 pull
#
#  三种部署模式：
#    A. git 模式（可访问 GitHub）    ：git pull --ff-only + 按 diff 增量构建
#    B. rsync/离线模式（推荐离线）   ：跳过 git pull（文件已由 rsync 上传），
#                                     因无 git 版本基线，前端与镜像默认全量构建
#    C. 手动跳过                    ：SKIP_GIT_PULL=1 强制跳过 pull
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  exec sudo env FORCE_IMAGE="${FORCE_IMAGE:-0}" SKIP_GIT_PULL="${SKIP_GIT_PULL:-0}" "$0" "$@"
fi

# ---------------------------------------------------------------------------
# 1. 代码同步（git pull）
# ---------------------------------------------------------------------------
GIT_BASELINE=0
if [ "${SKIP_GIT_PULL:-0}" = "1" ]; then
  echo ">> SKIP_GIT_PULL=1，跳过 git pull（请确认代码已通过 rsync 上传）"
elif ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo ">> 非 git 仓库，跳过 git pull（代码已由 rsync 上传）"
elif timeout 15 git ls-remote --exit-code origin HEAD >/dev/null 2>&1; then
  echo ">> git pull --ff-only ..."
  git pull --ff-only
  GIT_BASELINE=1
else
  echo ">> git 远端不可达（无法访问 GitHub），跳过 git pull——请确认代码已通过 rsync 上传"
fi

# ---------------------------------------------------------------------------
# 2. 安装/更新入口服务依赖（package.json 有变更时 npm ci 会自动生效）
# ---------------------------------------------------------------------------
npm ci --omit=dev

# ---------------------------------------------------------------------------
# 3. 前端变更检测
#    git 模式且有版本基线（HEAD@{1}）时按 diff 增量构建；
#    rsync/离线模式无法可靠比较，默认全量构建。
# ---------------------------------------------------------------------------
NEED_FRONTEND=0
NEED_IMAGE=0
if [ "${GIT_BASELINE:-0}" = "1" ] && git rev-parse HEAD@{1} >/dev/null 2>&1; then
  if git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -qE '^(frontend/|package)'; then
    NEED_FRONTEND=1
  fi
  if git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -q '^Dockerfile$'; then
    NEED_IMAGE=1
  fi
else
  echo ">> 无 git 版本基线（rsync/离线部署），默认全量构建前端与镜像"
  NEED_FRONTEND=1
  NEED_IMAGE=1
fi

# 前端产物缺失时必须构建
if [ ! -d frontend/dist ]; then
  NEED_FRONTEND=1
fi

if [ "${NEED_FRONTEND:-0}" = "1" ]; then
  echo ">> 前端有变更，重新构建 ..."
  (cd frontend && npm ci && npm run build)
else
  echo ">> 前端无变更，跳过构建"
fi

# ---------------------------------------------------------------------------
# 4. 租户镜像（Dockerfile 有变更时重建；FORCE_IMAGE=1 强制）
# ---------------------------------------------------------------------------
if [ "${FORCE_IMAGE:-0}" = "1" ] || [ "${NEED_IMAGE:-0}" = "1" ]; then
  echo ">> 重建租户镜像 dsh-multitenant:latest ...（需几分钟，编译 node-pty）"
  docker build -t dsh-multitenant:latest .
else
  echo ">> 镜像无需重建（FORCE_IMAGE=1 可强制）"
fi

# ---------------------------------------------------------------------------
# 5. 重启服务
# ---------------------------------------------------------------------------
systemctl restart dsh-multitenant
echo ">> 更新完成，服务已重启"
systemctl status dsh-multitenant --no-pager | head -8