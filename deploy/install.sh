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
#    DSH_VERSION      可选：镜像内安装的 DSH 版本（默认 0.1.1-rc.2）
#                             默认值是"最后一个不需要浏览器认证的 DSH 版本"
#                             （保守默认；≥0.1.2-alpha.2 也能用——平台已代做
#                              launch token 激活；详见 Dockerfile 注释）。
#                             传确切版本可复现构建，如 DSH_VERSION=0.1.5-rc.2
#                             传 latest 会装上当时最新版（可用；已支持代激活）。
#    SKIP_IMAGE=1     跳过 docker build；SKIP_FRONTEND=1 跳过前端构建
#    FORCE=1          已存在 config.json 时也重新生成
#    STORAGE          存储形态：mongodb(默认)=权威在库；json=回退文件轨
#                     （对应 docs/storage-design.md 的集中存储；应急回退用 json）
#    MONGODB_URI      存储连接串（默认 mongodb://127.0.0.1:27018/dsh_prod?replicaSet=dsh-rs）
#                     库名必须写在 URI path——dbName 默认值 'dsh' 是历史诱饵，勿依赖
#    SKIP_MONGO_CHECK=1  跳过 Mongo 预检（mongod 在远端且本机无 mongosh 时用）
#    MONGO_CONTAINER    mongod 跑在 Docker 容器里（服务器装不了 mongodb 的形态）时
#                       指定容器名，预检借道容器内 mongosh；配方见手册 1b 节
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
    DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}" \
    SKIP_IMAGE="${SKIP_IMAGE:-0}" \
    SKIP_FRONTEND="${SKIP_FRONTEND:-0}" \
    SKIP_MONGO_CHECK="${SKIP_MONGO_CHECK:-0}" \
    STORAGE="${STORAGE:-mongodb}" \
    MONGODB_URI="${MONGODB_URI:-}" \
    MONGO_CONTAINER="${MONGO_CONTAINER:-}" \
    FORCE="${FORCE:-0}" \
    "$0" "$@"
fi

: "${ADMIN_ADDRESS:?请设置 ADMIN_ADDRESS（管理员 SWTC 地址）}"
: "${PUBLIC_HOST:?请设置 PUBLIC_HOST（对外主机名/公网 IP）}"
PUBLIC_TRUST="${PUBLIC_TRUST:-$PUBLIC_HOST}"
PORT="${PORT:-8090}"
RUN_USER="${RUN_USER:-root}"
IMAGE="${DSH_TENANT_IMAGE:-dsh-multitenant:latest}"
DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}"
STORAGE="${STORAGE:-mongodb}"
# 库名写死在默认 URI path（dsh_prod）——config.js 的 dbName 默认 'dsh' 是历史诱饵
MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27018/dsh_prod?replicaSet=dsh-rs}"

echo ">> 项目目录: $ROOT"
echo ">> PUBLIC_HOST=$PUBLIC_HOST  PORT=$PORT  RUN_USER=$RUN_USER  IMAGE=$IMAGE  DSH_VERSION=$DSH_VERSION"
echo ">> STORAGE=$STORAGE  MONGODB_URI=$MONGODB_URI"

# ---- 依赖检查 ----
command -v docker >/dev/null || { echo "[错误] 未安装 docker"; exit 1; }
# node 版本硬线：mongodb driver engines 要求 >=20.19（前端构建也够），装低了 npm ci 会炸
command -v node >/dev/null || { echo "[错误] 未安装 node（平台要求 >=20.19）"; exit 1; }
node -e "
const [a, b] = process.versions.node.split('.').map(Number)
if (a < 20 || (a === 20 && b < 19)) {
  console.error('[错误] node 版本过低: ' + process.version + '（平台要求 >=20.19，mongodb driver 硬线）')
  process.exit(1)
}"

# ---- Mongo 预检（mongodb 形态必需）----
# 平台是 fail-closed 的：库连不上/非副本集 → 拒绝启动。预检把这一点在部署
# 时就摊开，免得 systemd 反复重启看起来像"平台坏了"。事务要求副本集，
# 单成员 rs 即可（安装与 rs.initiate 见 docs/deploy-test-server.md 三.1）。
if [ "$STORAGE" = "mongodb" ] && [ "${SKIP_MONGO_CHECK:-0}" != "1" ]; then
  # mongod 跑在容器里（服务器装不了 mongodb 的常态）时，预检借道容器内的 mongosh：
  # URI 里的 127.0.0.1 在容器网络命名空间内即本机 mongod，同一条 URI 照样成立
  mongo_rs_check() {
    if [ -n "${MONGO_CONTAINER:-}" ]; then
      docker exec "$MONGO_CONTAINER" mongosh --quiet "$MONGODB_URI" --eval 'rs.status().ok' >/dev/null 2>&1
    else
      command -v mongosh >/dev/null || return 127
      mongosh --quiet "$MONGODB_URI" --eval 'rs.status().ok' >/dev/null 2>&1
    fi
  }
  if ! mongo_rs_check; then
    if [ -z "${MONGO_CONTAINER:-}" ] && ! command -v mongosh >/dev/null 2>&1; then
      echo "[错误] 宿主机没有 mongosh 且未指定 MONGO_CONTAINER，无法预检"
      echo "       mongod 在容器里跑的场景：MONGO_CONTAINER=<容器名> 重跑本脚本"
      echo "       （Docker 部署配方见 docs/deploy-test-server.md 三.1 替代）"
      echo "       或 SKIP_MONGO_CHECK=1 跳过自担风险"
    else
      echo "[错误] MongoDB 不可达或不是副本集：$MONGODB_URI$([ -n "${MONGO_CONTAINER:-}" ] && echo "（经容器 $MONGO_CONTAINER 探测）")"
      echo "       请先按 docs/deploy-test-server.md 装 mongod（副本集 dsh-rs）"
      echo "       并执行 rs.initiate（判据：mongosh 里 rs.status().ok == 1）"
      echo "       应急回退文件形态：STORAGE=json 重跑本脚本"
    fi
    exit 1
  fi
  echo ">> mongod 预检通过（副本集可事务）$([ -n "${MONGO_CONTAINER:-}" ] && echo " · 经容器 $MONGO_CONTAINER")"
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
  echo "   注：存储形态由 systemd unit 注入的 env（DSH_STORAGE_PROVIDER/MONGODB_URI）"
  echo "       优先生效，老 config.json 无 storage 段不影响切换"
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
    "activityWindowMs": 180000,
    "processBaseline": 2,
    "stopGraceSeconds": 60,
    "comment": "stopTimeoutMs: 空闲多久后停止容器（毫秒），默认 15 分钟；destroyTimeoutMs: 停止多久后销毁容器（毫秒），默认 1 小时；checkIntervalMs: 检查间隔（毫秒），默认 5 分钟；activityWindowMs: 会话文件多久没写入视为内部空闲（毫秒），默认 3 分钟，有写入说明容器内 DSH 仍在干活不会停；processBaseline: docker top 进程数超过此值视为有外部程序在跑，默认 2；stopGraceSeconds: 停止前的 SIGTERM 宽限（秒），默认 60"
  },
  "resource": {
    "monitorIntervalMs": 30000,
    "autoUpgradeThreshold": 80,
    "autoUpgradeCooldownMs": 600000,
    "diskCheckIntervalMs": 300000,
    "comment": "monitorIntervalMs: 资源监控间隔（毫秒），默认 30 秒；autoUpgradeThreshold: 内存使用率超过此值自动升级配额（百分比）；autoUpgradeCooldownMs: 自动升级后冷却期（毫秒），防止反复升级重启；diskCheckIntervalMs: 磁盘使用采集间隔（毫秒），默认 5 分钟"
  },
  "usageLimit": {
    "enabled": true,
    "dailyMinutes": 120,
    "checkIntervalMs": 60000,
    "comment": "每日使用时限：enabled 开关；dailyMinutes 每个地址每天累计使用上限（分钟），容器运行即计时，超过后优雅停止，次日重置；已通过 CWT 验证的用户豁免；checkIntervalMs 超时检查间隔（毫秒）"
  },
  "cwt": {
    "enabled": true,
    "ttlMs": 300000,
    "allowCwtEnt": false,
    "comment": "CWT 申请-审批-出示：enabled 开关；ttlMs 出示 token 全局时效（毫秒，用于申请/出示时的防重放窗口）；审批时只复核签名、不校验时效（人工审批延迟不应失败）；allowCwtEnt CWT_ENT 组形态预留（本期关闭）"
  },
  "skills": {
    "autoInvoke": false,
    "comment": "技能市场信任边界（P0-4）：autoInvoke=false 时，市场技能安装到用户卷的副本强制注入 disable-model-invocation: true，模型不会自动调用，仅供用户显式使用；改 true 则放行自动调用（风险自担）"
  },
  "tiers": {
    "1": { "label": "基础", "memory": "512m", "disk": "1g", "cpus": "1.0", "pids": 256 },
    "2": { "label": "增强", "memory": "1g", "disk": "2g", "cpus": "2.0", "pids": 512 },
    "3": { "label": "高性能", "memory": "2g", "disk": "4g", "cpus": "4.0", "pids": 1024 }
  },
  "docker": {
    "image": "${IMAGE}",
    "basePort": 31000,
    "maxPort": 65535,
    "startupTimeoutMs": 120000,
    "comment": "image: Docker 镜像名称；basePort: 起始端口；maxPort: 最大端口；startupTimeoutMs: 容器启动超时（毫秒）"
  },
  "storage": {
    "provider": "${STORAGE}",
    "mongodbUri": "${MONGODB_URI}",
    "comment": "存储形态（docs/storage-design.md 9 集合合同）：mongodb=权威在库（事务+TTL），json=文件轨。库名以 URI path（dsh_prod）为准，勿依赖 config.dbName 默认值。运行时 env DSH_STORAGE_PROVIDER/MONGODB_URI 可覆盖本段（灰度/应急切换）"
  }
}
EOF
  echo ">> 已生成 config.json（管理员: $ADMIN_ADDRESS, publicHost: $PUBLIC_HOST, storage: $STORAGE）"
fi

# ---- 构建租户镜像 ----
# 传确切版本时额外打一个版本 tag（dsh-multitenant:<版本>）：
# 这是回滚的唯一退路——latest 被下一个版本覆盖后，旧版本只能靠版本 tag 找回。
if [ "${SKIP_IMAGE:-0}" != "1" ]; then
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo ">> 构建租户镜像 $IMAGE ...（首次需几分钟，需编译 node-pty）"
    if [ "$DSH_VERSION" != "latest" ]; then
      docker build --build-arg "DSH_VERSION=$DSH_VERSION" \
        -t "$IMAGE" -t "${IMAGE%%:*}:$DSH_VERSION" .
    else
      docker build --build-arg "DSH_VERSION=$DSH_VERSION" -t "$IMAGE" .
    fi
  else
    echo ">> 镜像 $IMAGE 已存在，跳过构建（如需强制：FORCE 或手动 docker build）"
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
# URI 里的 & 在 sed 替换侧有 specials 含义，先行转义（将来带凭据的 URI 同样安全）
ESC_MONGODB_URI="${MONGODB_URI//&/\\&}"
sed -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    -e "s|__REMOTE_DIR__|${ROOT}|g" \
    -e "s|__PORT__|${PORT}|g" \
    -e "s|__PUBLIC_HOST__|${PUBLIC_HOST}|g" \
    -e "s|__PUBLIC_TRUST__|${PUBLIC_TRUST}|g" \
    -e "s|__RUN_USER__|${RUN_USER}|g" \
    -e "s|__STORAGE_PROVIDER__|${STORAGE}|g" \
    -e "s|__MONGODB_URI__|${ESC_MONGODB_URI}|g" \
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
if [ "$STORAGE" = "mongodb" ]; then
  echo "   存储对账（真操作后库里应有行）:"
  echo "   mongosh '$MONGODB_URI' --eval 'const d=db;print(\"users=\"+d.users.countDocuments({})+\" sessions=\"+d.sessions.countDocuments({})+\" audit=\"+d.audit.countDocuments({}))'"
  echo "   登录一次后 audit 应新增 kind:'ops' admin_login 行（留痕链路）"
fi
echo ">> ============================================================"
