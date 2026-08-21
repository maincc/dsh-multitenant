#!/usr/bin/env bash
# ============================================================================
#  服务器首次部署脚本（在服务器上执行）
#  用法（示例）：
#    ADMIN_ADDRESS=jndwretndumoqbt2uauclmfmx7xbqjykva \
#    PUBLIC_HOST=dsh.example.com \
#    ./deploy/install.sh
#
#  环境变量：
#    ADMIN_ADDRESS    必填：管理员 SWTC 地址（小写）
#    PUBLIC_HOST      必填：对外主机名/公网 IP（302 跳转目标 + trustedHosts）
#    PUBLIC_TRUST     可选：追加信任的浏览器 authority（逗号分隔，默认同 PUBLIC_HOST）
#    PORT             可选：入口端口（默认 8090）
#    RUN_USER         可选：运行入口服务的系统用户（默认 root；非 root 时自动建用户并加入 docker 组）
#    DSH_TENANT_IMAGE 可选：租户镜像名（默认 dsh-multitenant:latest）
#    SKIP_IMAGE=1     跳过 docker build；SKIP_FRONTEND=1 跳过前端构建
#    FORCE=1          已存在 config.json 时也重新生成
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ---- 非 root 时通过 sudo 重新执行 ----
if [ "$(id -u)" -ne 0 ]; then
  echo ">> 需要 root 权限，正在通过 sudo 重新执行..."
  exec sudo env \
    ADMIN_ADDRESS="${ADMIN_ADDRESS:-}" \
    PUBLIC_HOST="${PUBLIC_HOST:-}" \
    PUBLIC_TRUST="${PUBLIC_TRUST:-}" \
    PORT="${PORT:-}" \
    RUN_USER="${RUN_USER:-root}" \
    DSH_TENANT_IMAGE="${DSH_TENANT_IMAGE:-dsh-multitenant:latest}" \
    SKIP_IMAGE="${SKIP_IMAGE:-0}" \
    SKIP_FRONTEND="${SKIP_FRONTEND:-0}" \
    FORCE="${FORCE:-0}" \
    "$0" "$@"
fi

: "${ADMIN_ADDRESS:?请设置 ADMIN_ADDRESS（管理员 SWTC 地址）}"
: "${PUBLIC_HOST:?请设置 PUBLIC_HOST（对外主机名/公网 IP）}"
PUBLIC_TRUST="${PUBLIC_TRUST:-$PUBLIC_HOST}"
PORT="${PORT:-8090}"
RUN_USER="${RUN_USER:-root}"
IMAGE="${DSH_TENANT_IMAGE:-dsh-multitenant:latest}"

echo ">> 项目目录: $ROOT"
echo ">> PUBLIC_HOST=$PUBLIC_HOST  PORT=$PORT  RUN_USER=$RUN_USER  IMAGE=$IMAGE"

# ---- 依赖检查 ----
command -v docker >/dev/null || { echo "[错误] 未安装 docker"; exit 1; }
if [ "${SKIP_FRONTEND:-0}" != "1" ]; then
  command -v node >/dev/null || { echo "[错误] 未安装 node（>=18），或设置 SKIP_FRONTEND=1 跳过前端构建"; exit 1; }
  node -e "if (+process.versions.node.split('.')[0] < 18) { console.error('[错误] node 版本过低: ' + process.version); process.exit(1) }"
fi

# ---- 运行用户（非 root 时创建并加入 docker 组）----
if [ "$RUN_USER" != "root" ]; then
  id "$RUN_USER" >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin "$RUN_USER"
  usermod -aG docker "$RUN_USER"
  chown -R "$RUN_USER":"$RUN_USER" "$ROOT"
fi

# ---- 运行时目录 ----
mkdir -p patches data/config data/users data/stats data/logs

# ---- 生成 config.json ----
if [ -f config.json ] && [ "${FORCE:-0}" != "1" ]; then
  echo ">> config.json 已存在，跳过生成（FORCE=1 可覆盖）"
else
  cat > config.json <<EOF
{
  "server": {
    "port": ${PORT},
    "publicHost": "${PUBLIC_HOST}"
  },
  "admin": {
    "addresses": ["${ADMIN_ADDRESS}"],
    "comment": "管理员地址列表（小写），只有这些地址可以访问管理页面"
  },
  "cleanup": {
    "stopTimeoutMs": 900000,
    "destroyTimeoutMs": 3600000,
    "checkIntervalMs": 300000,
    "comment": "stopTimeoutMs: 空闲多久后停止容器（毫秒），默认 15 分钟；destroyTimeoutMs: 停止多久后销毁容器（毫秒），默认 1 小时；checkIntervalMs: 检查间隔（毫秒），默认 5 分钟"
  },
  "resource": {
    "monitorIntervalMs": 30000,
    "autoUpgradeThreshold": 80,
    "comment": "monitorIntervalMs: 资源监控间隔（毫秒），默认 30 秒；autoUpgradeThreshold: 内存使用率超过此值自动升级配额（百分比）"
  },
  "tiers": {
    "1": { "label": "基础", "memory": "512m", "memorySwap": "1g", "cpus": "1.0", "pids": 256 },
    "2": { "label": "增强", "memory": "1g", "memorySwap": "2g", "cpus": "2.0", "pids": 512 },
    "3": { "label": "高性能", "memory": "2g", "memorySwap": "4g", "cpus": "4.0", "pids": 1024 }
  },
  "docker": {
    "image": "${IMAGE}",
    "basePort": 31000,
    "maxPort": 65535,
    "startupTimeoutMs": 120000,
    "comment": "image: Docker 镜像名称；basePort: 起始端口；maxPort: 最大端口；startupTimeoutMs: 容器启动超时（毫秒）"
  }
}
EOF
  echo ">> 已生成 config.json（管理员: $ADMIN_ADDRESS, publicHost: $PUBLIC_HOST）"
fi

# ---- 构建租户镜像 ----
if [ "${SKIP_IMAGE:-0}" != "1" ]; then
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo ">> 构建租户镜像 $IMAGE ...（首次需几分钟，需编译 node-pty）"
    docker build -t "$IMAGE" .
  else
    echo ">> 镜像 $IMAGE 已存在，跳过构建（如需强制：docker build -t $IMAGE .）"
  fi
fi

# ---- 安装入口服务依赖（生产依赖，含 @swtc/keypairs）----
echo ">> 安装入口服务依赖 ..."
npm ci --omit=dev

# ---- 构建前端 ----
if [ "${SKIP_FRONTEND:-0}" != "1" ]; then
  echo ">> 构建前端 ..."
  (cd frontend && npm ci && npm run build)
fi

# ---- 安装 systemd 服务 ----
NODE_BIN="$(command -v node)"
UNIT=/etc/systemd/system/dsh-multitenant.service
sed -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    -e "s|__REMOTE_DIR__|${ROOT}|g" \
    -e "s|__PORT__|${PORT}|g" \
    -e "s|__PUBLIC_HOST__|${PUBLIC_HOST}|g" \
    -e "s|__PUBLIC_TRUST__|${PUBLIC_TRUST}|g" \
    -e "s|__RUN_USER__|${RUN_USER}|g" \
    deploy/dsh-multitenant.service > "$UNIT"
systemctl daemon-reload
systemctl enable --now dsh-multitenant
systemctl restart dsh-multitenant

echo ""
echo ">> ============================================================"
echo ">> 部署完成！验证："
echo "   curl -s http://127.0.0.1:${PORT}/health"
echo "   curl -s \"http://127.0.0.1:${PORT}/connect-status?address=${ADMIN_ADDRESS}\""
echo "   浏览器（装 CCDAO 插件）访问: http://${PUBLIC_HOST}:${PORT}/"
echo "   查看日志:   journalctl -u dsh-multitenant -f"
echo ">> ============================================================"
