#!/usr/bin/env bash
# ============================================================================
#  本地执行：把 dsh-multitenant 上传到服务器（rsync）
#  用法：
#    SERVER_HOST=1.2.3.4 ./deploy/rsync-upload.sh
#    SERVER_USER=ubuntu SERVER_HOST=1.2.3.4 REMOTE_DIR=/opt/dsh ./deploy/rsync-upload.sh
#
#  排除项说明：node_modules / data / patches / state.json / config.json 等
#  运行时与敏感文件不上传（服务器上由 install.sh 生成）；--delete 会同步
#  删除服务器上多余文件，但被排除的文件不会被删（rsync 的 exclude 同时
#  作用于删除），所以服务器端 data/、config.json 等在重新上传时保留。
# ============================================================================
set -euo pipefail

SERVER_HOST="${SERVER_HOST:?请设置 SERVER_HOST（服务器 IP 或域名）}"
SERVER_USER="${SERVER_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/srv/dsh-multitenant}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo ">> 上传 ${LOCAL_DIR}/ -> ${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/"

# 确保远端目录存在（rsync 不创建中间目录）
ssh "${SERVER_USER}@${SERVER_HOST}" "mkdir -p '${REMOTE_DIR}'"

rsync -avz --delete -e ssh \
  --exclude='node_modules/' \
  --exclude='frontend/node_modules/' \
  --exclude='frontend/dist/' \
  --exclude='data/' \
  --exclude='patches/' \
  --exclude='state.json' \
  --exclude='config.json' \
  --exclude='*.log' \
  --exclude='logs/' \
  --exclude='.DS_Store' \
  "${LOCAL_DIR}/" "${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/"

echo ""
echo ">> 上传完成。下一步在服务器上执行首次安装："
echo "   ssh ${SERVER_USER}@${SERVER_HOST}"
echo "   cd ${REMOTE_DIR}"
echo "   ADMIN_ADDRESS=<你的SWTC地址> PUBLIC_HOST=<公网IP或域名> ./deploy/install.sh"
