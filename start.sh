#!/usr/bin/env bash
# ============================================================================
#  dsh-multitenant 一键启动脚本
# ============================================================================
#  职责：
#    1. 若租户镜像不存在，先 docker build 构建（首次运行）
#    2. 启动入口服务（前台运行，Ctrl+C 可停）
#
#  用法：
#    ./start.sh                      # 默认端口 8090
#    PORT=9000 ./start.sh            # 自定义入口端口
#    PUBLIC_HOST=192.168.1.5 ./start.sh   # 局域网访问时指定对外主机名
# ============================================================================

set -euo pipefail          # 出错即停；未定义变量报错；管道失败也视为失败
cd "$(dirname "$0")"       # 无论从哪个目录调用，都切到本项目目录

IMAGE="dsh-multitenant:latest"

# 镜像不存在才构建（避免每次启动都重新 build）
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo ">> building tenant image $IMAGE ..."
  docker build -t "$IMAGE" .
fi

echo ">> starting entry server on http://127.0.0.1:${PORT:-8090}/"
# exec 让 node 进程取代本 shell，信号（Ctrl+C/SIGTERM）直接送达入口服务
# 注意：必须用模块化入口 src/server.js（旧 entry-server.mjs 已废弃，仅为重定向层）
exec node src/server.js
