#!/usr/bin/env bash
# ============================================================================
#  dsh-multitenant 一键停止脚本
# ============================================================================
#  停止入口服务与所有租户容器。命名数据卷（dsh-data-<id>）全部保留，
#  下次 start 后租户数据原样恢复。
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")"

# 停止所有租户容器（保留卷，容器本身也可复用）
docker ps -a --filter name=dsh-u- --format '{{.Names}}' | xargs -r docker stop || true

# 停止入口服务（匹配本项目目录下的 node entry-server.mjs 进程）
pkill -f "node entry-server.mjs" 2>/dev/null || true
echo ">> stopped entry server and all tenant containers (volumes preserved)"
