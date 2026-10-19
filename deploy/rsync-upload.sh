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

# 日常更新一律【不带 data/】：mongodb 形态权威在库里，上传本地 data/ 只会
# 把服务器镜像轨砸成本机的旧数据（真实事故预案里排第一的坑）。
# 唯一合法场景是"往服务器注入外部数据"（如空测试服务器拿开发机数据当种子，
# 仅此一次），名字里的 UPLOAD 就是它的边界：只管装船，不管搬家。老 json
# 服务器升级进库【不需要】它——迁移原料就是
# 服务器自己的 data/（--exclude 历来的保护让它一直在场），普通上传+install
# 首启即自动搬家（日志 [startup] storage 迁移：{...}）。
EXCLUDES=(
  --exclude='node_modules/'
  --exclude='frontend/node_modules/'
  --exclude='frontend/dist/'
  --exclude='patches/'
  --exclude='state.json'
  --exclude='config.json'
  --exclude='*.log'
  --exclude='logs/'
  --exclude='.DS_Store'
  # 签发私钥保护（did-vc-runbook §3.4，毁灭级红线）：**无条件排除**，
  # UPLOAD_DATA=1 也不上传本地 keys、--delete 也不碰服务器 keys——现场钥只进不出。
  --exclude='data/keys/'
)
if [ "${UPLOAD_DATA:-0}" = "1" ]; then
  echo "!! UPLOAD_DATA=1：本次将【携带本地 data/】覆盖服务器同名文件——仅"注入外部数据"合法（老服务器升级不需要它，原料在服务器本地）！"
else
  EXCLUDES+=(--exclude='data/')
fi

echo ">> 上传 ${LOCAL_DIR}/ -> ${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/"

# 确保远端目录存在（rsync 不创建中间目录）
ssh "${SERVER_USER}@${SERVER_HOST}" "mkdir -p '${REMOTE_DIR}'"

rsync -avz --delete -e ssh "${EXCLUDES[@]}" \
  "${LOCAL_DIR}/" "${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/"

echo ""
echo ">> 上传完成。下一步在服务器上执行首次安装："
echo "   ssh ${SERVER_USER}@${SERVER_HOST}"
echo "   cd ${REMOTE_DIR}"
echo "   ADMIN_ADDRESS=<你的SWTC地址> PUBLIC_HOST=<公网IP或域名> ./deploy/install.sh"
echo "   （存储默认 mongodb 形态连本机 27018 副本集 dsh_prod；"
echo "     应急回退文件形态加 STORAGE=json，详见 deploy/install.sh 头部与"
echo "     docs/deploy-test-server.md）"
