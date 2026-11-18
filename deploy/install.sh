#!/usr/bin/env bash
# ============================================================================
#  服务器首次部署脚本（在服务器上执行）
#  用法（示例）：
#    ADMIN_ADDRESS=jndwretndumoqbt2uauclmfmx7xbqjykva \
#    PUBLIC_HOST=dsh.example.com \
#    ./deploy/install.sh
#
#  迁移部署（带备份包 + 双段端口）示例：
#    ADMIN_ADDRESS=<同旧机> PUBLIC_HOST=<新机地址> \
#    PORT_BASE=40000 PORT_MAX=40099 PORT_INT_BASE=47010 PORT_INT_MAX=47109 \
#    BUNDLE=/tmp/bundle-<TS>.tgz ./deploy/install.sh
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
#    SKIP_SYSTEMD=1   跳过服务注册（本地彩排/非 systemd 环境：预检+导入+依赖照走，
#                     到 systemd 前停住；起服务手工 node src/server.js）
#    FORCE=1          已存在 config.json 时也重新生成
#    STORAGE          存储形态：显式参数 > 现场 config.json 的 storage.provider > 默认 mongodb
#                     （mongodb=权威在库；json=回退文件轨，对应 docs/storage-design.md）
#    MONGODB_URI      存储连接串：显式参数 > 现场 config.json 的 storage.mongodbUri
#                     > 默认 mongodb://127.0.0.1:27018/dsh_prod?replicaSet=dsh-rs
#                     库名必须写在 URI path——dbName 默认值 'dsh' 是历史诱饵，勿依赖
#                     注：现场 config 有 storage 段时以它为准（config 为第一现场的部署
#                     姿势），预检/迁移预览/systemd env 三处统一用同一个解析结果
#    SKIP_MONGO_CHECK=1  跳过 Mongo 预检（mongod 在远端且本机无 mongosh 时用）
#    PUBLIC_SCHEME    可选：对外协议声明（隧道/反代 https 形态填 https；留空=按请求
#                     自动判形）。⚠️ 填 https 的前提：入口与【全部租户网关端口
#                     31xxx】都经隧道 https 终结——cookie 跨端口共享，混形态断会话
#    PUBLIC_PORT      可选：对外入口端口（隧道外口≠进程口时填，如 8550→8090 填 8550）
#    TUNNEL_SYNC_TOKEN 可选：GET /api/admin/gateway-ports 远程访问口令（frpc 异机
#                     轮询补端口用；同机回环免口令）
#    MONGO_CONTAINER    mongod 跑在 Docker 容器里（服务器装不了 mongodb 的形态）时
#                       指定容器名，预检借道容器内 mongosh；配方见手册 1b 节
#    PORT_BASE / PORT_MAX       可选：租户【对外】端口段（默认 31000/65535）——
#                       隧道/防火墙只放行一段时收窄到这里，免装完手改 config.json
#    PORT_INT_BASE / PORT_INT_MAX 可选：【内部配对】回环端口段；两者同 >0 启用
#                       双段配对（internal = 内段基 + (对外号 - 外段基)，跨度须
#                       相等否则启动告警）。留 0 = 随机回环口（默认，旧形态）
#    BUNDLE             可选：deploy/backup.sh 产出的 bundle-<TS>.tgz 路径。给出即
#                       【迁移部署】——库快照 --drop 还原、keys/入口数据件/工作区
#                       快照与活工作区/租户卷/镜像自动导入，随后照常构建与服务
#                       注册。部署参数以本次 install 为准（包内 config.json/
#                       state.json 不覆盖现场）；库为整包覆盖语义（--drop）。
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ---- 非 root 时通过 sudo 重新执行 ----
# 非 Linux（开发机彩排形态）自动降级：不提权、后续 systemd 段同样自动跳过——
# Linux 服务器上此逻辑零影响（照常严格 root）。NO_SUDO=1 仍可手动触发降级。
if [ "$(id -u)" -ne 0 ] && [ "${NO_SUDO:-0}" != "1" ]; then
  if [ "$(uname)" != "Linux" ]; then
    echo ">> 非 Linux 环境：跳过提权，以当前用户执行（彩排形态；systemd 注册段将自动跳过）"
  else
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
    SKIP_SYSTEMD="${SKIP_SYSTEMD:-0}" \
    SKIP_MONGO_CHECK="${SKIP_MONGO_CHECK:-0}" \
    STORAGE="${STORAGE:-}" \
    MONGODB_URI="${MONGODB_URI:-}" \
    MONGO_CONTAINER="${MONGO_CONTAINER:-}" \
    PUBLIC_SCHEME="${PUBLIC_SCHEME:-}" \
    PUBLIC_PORT="${PUBLIC_PORT:-}" \
    TUNNEL_SYNC_TOKEN="${TUNNEL_SYNC_TOKEN:-}" \
    PORT_BASE="${PORT_BASE:-}" \
    PORT_MAX="${PORT_MAX:-}" \
    PORT_INT_BASE="${PORT_INT_BASE:-}" \
    PORT_INT_MAX="${PORT_INT_MAX:-}" \
    BUNDLE="${BUNDLE:-}" \
    FORCE="${FORCE:-0}" \
    "$0" "$@"
  fi
fi

: "${ADMIN_ADDRESS:?请设置 ADMIN_ADDRESS（管理员 SWTC 地址）}"
: "${PUBLIC_HOST:?请设置 PUBLIC_HOST（对外主机名/公网 IP）}"
PUBLIC_TRUST="${PUBLIC_TRUST:-$PUBLIC_HOST}"
PORT="${PORT:-8090}"
RUN_USER="${RUN_USER:-root}"
IMAGE="${DSH_TENANT_IMAGE:-dsh-multitenant:latest}"
DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}"
PUBLIC_SCHEME="${PUBLIC_SCHEME:-}"
PUBLIC_PORT="${PUBLIC_PORT:-}"
TUNNEL_SYNC_TOKEN="${TUNNEL_SYNC_TOKEN:-}"
# 租户端口段（写入 config.json 的 docker 段）：默认保持历史行为 31000-65535 随机内口
PORT_BASE="${PORT_BASE:-31000}"
PORT_MAX="${PORT_MAX:-65535}"
PORT_INT_BASE="${PORT_INT_BASE:-0}"
PORT_INT_MAX="${PORT_INT_MAX:-0}"
# ---- 存储形态解析：参数 > 现场 config.json 的 storage 段 > 内置默认 ----
# 为什么必须先读现场 config：install 注入的 systemd env 是三级优先里最高层，
# 不读现场 config 就按内置默认注入/预检，会把"以 config.json 为第一现场"的
# 部署悄悄架空（测试服务器实证：现场 config 写 27017/dsh_test，脚本默认
# 27018/dsh_prod 预检直接拦死——预检没错，错在没尊重现场声明）。
STORAGE="${STORAGE:-}"
MONGODB_URI="${MONGODB_URI:-}"
if [ -f config.json ] && command -v node >/dev/null; then
  CFG_STORAGE=$(node -e '
    try {
      const s = JSON.parse(require("fs").readFileSync("config.json", "utf8")).storage || {}
      process.stdout.write((s.provider || "") + "\t" + (s.mongodbUri || ""))
    } catch (e) { process.exit(1) }
  ' 2>/dev/null) || echo ">> [提示] config.json 解析失败，storage 现场读取跳过（生成/预检将按参数或默认走）"
  CFG_PROVIDER="${CFG_STORAGE%%	*}"
  CFG_URI="${CFG_STORAGE#*	}"
  if [ -z "$STORAGE" ] && { [ "$CFG_PROVIDER" = "mongodb" ] || [ "$CFG_PROVIDER" = "json" ]; }; then
    STORAGE="$CFG_PROVIDER"
    echo ">> STORAGE 取自现场 config.json: $STORAGE"
  fi
  if [ -z "$MONGODB_URI" ] && [ -n "$CFG_URI" ]; then
    MONGODB_URI="$CFG_URI"
    echo ">> MONGODB_URI 取自现场 config.json: $MONGODB_URI"
  fi
fi
# 无参数且现场无声明时的兜底默认：
STORAGE="${STORAGE:-mongodb}"
# 库名写死在默认 URI path（dsh_prod）——config.js 的 dbName 默认 'dsh' 是历史诱饵
MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27018/dsh_prod?replicaSet=dsh-rs}"

echo ">> 项目目录: $ROOT"
echo ">> PUBLIC_HOST=$PUBLIC_HOST  PORT=$PORT  RUN_USER=$RUN_USER  IMAGE=$IMAGE  DSH_VERSION=$DSH_VERSION"
echo ">> STORAGE=$STORAGE  MONGODB_URI=$MONGODB_URI"
echo ">> 对外形态：PUBLIC_SCHEME=${PUBLIC_SCHEME:-（自动判形）}  PUBLIC_PORT=${PUBLIC_PORT:-（同进程端口）}"
echo ">> 租户端口段：对外 ${PORT_BASE}-${PORT_MAX}  内部配对 ${PORT_INT_BASE}-${PORT_INT_MAX}$([ "$PORT_INT_BASE" = "0" ] && echo "（0=随机回环口）")"

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
  PRECHECK_DEGRADED=0
  if ! mongo_rs_check; then
    if [ -z "${MONGO_CONTAINER:-}" ] && ! command -v mongosh >/dev/null 2>&1; then
      # 没 CLI ≠ 库有病（mongosh 与 mongod 是分家包）——退而求其次做 TCP 可达
      # 探测：端口通=放行（拓扑核验交给平台首启的 fail-closed 底线）；不通=拦死。
      # 解析先剥协议、再贪婪剥凭据（.*@）、再截 host 段——host/port 从同一干净串拆，
      # 带不带 user:pass@、单/多 host 都覆盖（2026-11-18 判例两连：首版漏冒号、
      # 次版 MP 正则不认凭据形，均为"解析与形态脱节"，故以矩阵单测锁死）。
      HOSTSEC="$(echo "$MONGODB_URI" | sed -E 's#^mongodb(\+srv)?://##; s#.*@##; s#[/,?].*$##')"
      MH="$(echo "$HOSTSEC" | sed -E 's#[:/].*$##')"
      MP="$(echo "$HOSTSEC" | sed -nE 's#^[^:/]+:([0-9]+).*#\1#p')"
      if [ -z "$MP" ] && echo "$MONGODB_URI" | grep -q 'mongodb+srv://'; then
        echo ">> ⚠ srv 型 URI 无显式端口，TCP 探测无从下手——跳过核验（平台首启 fail-closed 兜底）"
        PRECHECK_DEGRADED=1
      elif [ -n "$MH" ] && node -e "
        const s = require('net').connect({ host: '$MH', port: ${MP:-27017} })
        s.setTimeout(3000)
        s.on('connect', () => { s.destroy(); process.exit(0) })
        s.on('error', () => process.exit(1))
        s.on('timeout', () => { s.destroy(); process.exit(1) })" 2>/dev/null; then
        echo ">> ⚠ 无 mongosh，预检降级为 TCP 探测：$MH:${MP:-27017} 可达 ✓（副本集拓扑未核验——平台首启 fail-closed 兜底；补 CLI：brew install mongodb/brew/mongodb-mongosh）"
        PRECHECK_DEGRADED=1
      else
        echo "[错误] MongoDB 不可达（TCP 探测失败）：$MONGODB_URI"
        echo "       确认 mongod 已启动、URI 的 host:port 正确"
        exit 1
      fi
    else
      echo "[错误] MongoDB 不可达或不是副本集：$MONGODB_URI$([ -n "${MONGO_CONTAINER:-}" ] && echo "（经容器 $MONGO_CONTAINER 探测）")"
      echo "       请先按 docs/deploy-test-server.md 装 mongod（副本集 dsh-rs）"
      echo "       并执行 rs.initiate（判据：mongosh 里 rs.status().ok == 1）"
      echo "       应急回退文件形态：STORAGE=json 重跑本脚本"
      exit 1
    fi
  fi
  if [ "$PRECHECK_DEGRADED" = "0" ]; then
    echo ">> mongod 预检通过（副本集可事务）$([ -n "${MONGO_CONTAINER:-}" ] && echo " · 经容器 $MONGO_CONTAINER")"
  fi
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
  echo "   注：PORT_BASE/PORT_INT_* 等参数只影响【生成】——改端口段请现场编辑 config.json"
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
    "basePort": ${PORT_BASE},
    "maxPort": ${PORT_MAX},
    "internalBasePort": ${PORT_INT_BASE},
    "internalMaxPort": ${PORT_INT_MAX},
    "startupTimeoutMs": 120000,
    "comment": "image: Docker 镜像名称；basePort/maxPort: 对外端口段（URL/隧道面）；internalBasePort/internalMaxPort 同 >0 时启用双段配对（内部回环口=内段基+对外偏移，跨度须与对外段相等），留 0=随机回环口；startupTimeoutMs: 容器启动超时（毫秒）"
  },
  "storage": {
    "provider": "${STORAGE}",
    "mongodbUri": "${MONGODB_URI}",
    "comment": "存储形态（docs/storage-design.md 9 集合合同）：mongodb=权威在库（事务+TTL），json=文件轨。库名以 URI path（dsh_prod）为准，勿依赖 config.dbName 默认值。运行时 env DSH_STORAGE_PROVIDER/MONGODB_URI 可覆盖本段（灰度/应急切换）"
  }
}
EOF
  echo ">> 已生成 config.json（管理员: $ADMIN_ADDRESS, publicHost: $PUBLIC_HOST, storage: ${STORAGE}）"
fi

# ---- 备份 bundle 导入（BUNDLE=<路径>，迁移部署核心段）----
# 时序纪律：一切导入必须在下方 systemd enable --now 之前落位——平台首启会
# 读库建容器，晚一步就是"先空跑再覆盖"的脏窗口。库还原用 --drop（包为权威）；
# 部署参数不跟包走（config.json 由上方生成逻辑决定，entry 只取数据件）。
# keys 解在 RUN_USER chown 段之后，属主/权限当场收死。
# 注意本脚本 set -e：所有"[ 条件 ] && 动作"必须写成显式 if（左失败=整脚本死）。
if [ -n "${BUNDLE:-}" ]; then
  # 判例 2026-11-18：BUNDLE="~/x" 带引号时 shell 不做波浪号展开，-f 拿着字面 ~
  # 报"不存在"。脚本自摊平，引号党免疫。
  BUNDLE="${BUNDLE/#\~/$HOME}"
  if [ ! -f "$BUNDLE" ]; then echo "[错误] BUNDLE 文件不存在：$BUNDLE"; exit 1; fi
  # 判例 2026-11-18：sudo 通道取回的包常是 root 0600，非提权跑时 tar 现场暴毙且
  # 零提示。可读性预检——两种病因（属主/沙箱级弹窗权限）的修法直接印脸上。
  if [ ! -r "$BUNDLE" ]; then
    echo "[错误] BUNDLE 对当前用户($(id -un))不可读：$(ls -l "$BUNDLE" 2>/dev/null || echo 属性不详)"
    echo "       属主是 root（sudo/scp 提权通道带下来的）→ sudo chown $(id -un) \"$BUNDLE\""
    echo "       macOS 报 Operation not permitted → 系统设置·隐私与安全性·文件与文件夹：给终端 App 勾『下载文件夹』"
    exit 1
  fi
  echo ">> 迁移部署：导入 $BUNDLE"
  BUN="$(mktemp -d)"
  trap 'rm -rf "$BUN"' EXIT
  tar xzf "$BUNDLE" -C "$BUN"
  # || true：pipefail+set -e 下 ls 无匹配会把本赋值变致命退出，抢掉下面的友好报错
  SRC="$(ls -d "$BUN"/bundle-* 2>/dev/null | head -1 || true)"
  if [ -z "$SRC" ]; then echo "[错误] 包内未见 bundle-<时间戳>/ 结构（不是 deploy/backup.sh 的产物？）"; exit 1; fi

  # 1) 库快照 → 整库覆盖还原
  if [ "$STORAGE" = "mongodb" ]; then
    # 判例 2026-11-18：服务器平台连的是 dsh_test，现场 URI 是 dsh_prod——
    # mongorestore 语义"目录名=库名"，407 文档原样落进 dsh_test；平台读空 dsh_prod，
    # 首启触发文件迁移灌入陈旧数据。"包为权威"不等于"包决定库名"：数据跟包走，
    # 名字跟现场走。故 dump 源库名 ≠ 现场目标库名时，rename 导入（nsFrom/nsTo）。
    # URI 剥库名与 query——还原目标名由下面显式决定
    HOST_URI="$(echo "$MONGODB_URI" | sed -E 's#^((mongodb(\+srv)?://[^/]+)).*#\1/#')"
    TARGET_DB="$(echo "$MONGODB_URI" | sed -E 's#^mongodb(\+srv)?://##; s#.*@##; s#^[^/]*/*##; s#\?.*##')"
    TARGET_DB="${TARGET_DB:-dsh_prod}"
    SRC_DBS="$(find "$SRC/mongo" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null || true)"
    DB_N="$(echo "$SRC_DBS" | grep -c . || true)"
    if [ "$DB_N" = "0" ]; then
      echo "[错误] 包内 mongo/ 下没有库目录（不是 mongodump 产物？）"; exit 1
    elif [ "$DB_N" -gt 1 ]; then
      echo "[错误] 包内含多库（$(echo $SRC_DBS | tr '\n' ' ')）——backup.sh 只导单库，此包非其所出"; exit 1
    fi
    NS_ARGS=()
    if [ "$SRC_DBS" != "$TARGET_DB" ]; then
      echo "   包源库 $SRC_DBS → 现场目标库 ${TARGET_DB}（rename 导入：数据跟包走，名字跟现场走）"
      NS_ARGS=(--nsInclude="$SRC_DBS.*" --nsFrom="$SRC_DBS.*" --nsTo="$TARGET_DB.*")
    fi
    if [ -n "${MONGO_CONTAINER:-}" ]; then
      docker run --rm --network host -v "$SRC/mongo:/dump:ro" mongo:7 \
        mongorestore --uri="$HOST_URI" --drop --dir=/dump ${NS_ARGS[@]+"${NS_ARGS[@]}"}
    elif command -v mongorestore >/dev/null 2>&1; then
      mongorestore --uri="$HOST_URI" --drop --dir="$SRC/mongo" ${NS_ARGS[@]+"${NS_ARGS[@]}"}
    else
      echo "[错误] 无 mongorestore 且未指定 MONGO_CONTAINER；装 mongodb-database-tools 或借道容器重试"
      exit 1
    fi
    echo "   ✓ 库已还原（--drop，包为权威；目标库 ${TARGET_DB}）"
  else
    echo "   ⚠ STORAGE=json：包内库快照不导入——身份/凭证/会话都在包里没搬走，迁移场景请勿这么装"
  fi

  # 2) 入口数据件（config/state 除外——现场部署参数为王）
  tar xzf "$SRC/entry/entry.tgz" --exclude=config.json --exclude=state.json
  echo "   ✓ 入口件解包（config.json/state.json 不覆盖现场）"

  # 3) 签发根（"只进不出"的东西，从这里进）
  tar xzf "$SRC/keys/keys.tgz"
  if [ "$RUN_USER" != "root" ]; then
    chown -R "$RUN_USER":"$RUN_USER" data/keys
  fi
  chmod 700 data/keys 2>/dev/null || true
  # 只收文件——glob 撞上子目录会 chmod 600 目录本身（不可遍历=签发读档案拒启）
  find data/keys -type f -exec chmod 600 {} + 2>/dev/null || true
  echo "   ✓ keys 落位并收权（600/700，属主 ${RUN_USER}）"

  # 4) 工作区：归档槽 + 活容器现值（live 更新鲜，同名覆盖槽——平台建容器时自动合回）
  if [ -f "$SRC/snapshots/ws-snapshots.tgz" ]; then
    tar xzf "$SRC/snapshots/ws-snapshots.tgz"
  fi
  mkdir -p data/workspace-snapshots
  LIVE_CT=0
  for f in "$SRC"/workspace-live/ws-*.tar; do
    if [ -e "$f" ]; then
      cp -f "$f" data/workspace-snapshots/
      LIVE_CT=$((LIVE_CT + 1))
    fi
  done
  echo "   ✓ 工作区快照入槽（live 覆盖 $LIVE_CT 份）"

  # 5) 租户卷（/dsh-home 持久层；同名卷直接灌）
  VOL_CT=0
  for f in "$SRC"/volumes/vol-*.tgz; do
    if [ -e "$f" ]; then
      a="$(basename "$f" .tgz)"
      v="dsh-data-swtc-${a#vol-}"
      docker volume create "$v" >/dev/null
      if docker run --rm -v "$v:/dsh-home" -v "$SRC/volumes:/bk:ro" alpine \
          tar xzf "/bk/$a.tgz" -C /dsh-home; then
        VOL_CT=$((VOL_CT + 1))
      else
        echo "   ⚠ 卷 $v 灌入失败（继续；对照包内 volumes/ 手工补）"
      fi
    fi
  done
  echo "   ✓ 租户卷 $VOL_CT 只"

  # 6) 镜像（IMAGE_SAVE=1 装的 tar 直接 load；load 后"镜像已存在跳过构建"自然生效）
  for f in "$SRC"/images/*.tar; do
    if [ -e "$f" ]; then
      echo "   docker load $(basename "$f")"
      docker load -i "$f"
    fi
  done
  if [ -f "$SRC/images/manifest.txt" ]; then
    echo "   ▸ 源机被引用镜像清单（本机缺 tag 则钉版本租户起不来，务必补 build/load）："
    sed 's/^/     /' "$SRC/images/manifest.txt"
  fi

  echo ">> bundle 导入完成；后续构建/服务注册照常"
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

# ---- BUNDLE 落库验收 + schema 戳（mongodb 形态，判例 2026-11-18）----
# 服务器老库可能没有 meta#schema（老代码时代迁的库）——不补戳，首启 runMigration
# 会把 entry 顺来的 data/config 陈旧文件当"迁移源"灌进目标库，盖住包的真实数据。
# $setOnInsert 幂等：包内本来有戳则分毫不动。计数为 0 = rename/还原没落地，当场拦死。
if [ -n "${BUNDLE:-}" ] && [ "$STORAGE" = "mongodb" ]; then
  DSH_BUNDLE_URI="$MONGODB_URI" node --input-type=module -e "
    import { MongoClient } from 'mongodb'
    const uri = process.env.DSH_BUNDLE_URI
    const dbName = ((uri.match(/^mongodb(?:\+srv)?:\/\/[^@/]*(?:@[^/]*)?\/([^?/]*)/) || [])[1] || '') || 'dsh_prod'
    const c = new MongoClient(uri)
    await c.connect()
    const db = c.db(dbName)
    let tot = 0
    for (const { name } of await db.listCollections().toArray())
      tot += await db.collection(name).countDocuments({})
    if (!tot) { console.error('[错误] 导入验收失败：目标库 ' + dbName + ' 是空的'); process.exit(1) }
    await db.collection('meta').findOneAndUpdate({ _id: 'schema' },
      { \$setOnInsert: { version: 1, migratedAt: Date.now(),
        migratedBy: 'deploy/install.sh BUNDLE', sourceStats: { bundleDocs: tot } } },
      { upsert: true })
    console.log('   ✓ 导入验收：库 ' + dbName + ' 共 ' + tot + ' 文档；schema 戳已就位')
    await c.close()
  "
fi

# ---- 迁移预览（dry-run，只读）：把"首启会暗地里搬哪些家"摊在 install 屏幕上 ----
# 迁移本体由平台首启自动完成（读服务器本地 data/ → 写入 MongoDB → 打"已迁移"
# 戳，幂等）；这里仅用演练脚本先出一份账，让部署人亲眼确认料在、量对。
# 失败不阻塞部署（无料/库不可达都只提示，首启逻辑不依赖本段）。
# BUNDLE 模式跳过：库以包为准，现场 data/ 是源机残留文件，"首启搬本地"预览会误导。
if [ "$STORAGE" = "mongodb" ] && [ -z "${BUNDLE:-}" ] && { [ -d data/config ] || [ -f state.json ]; }; then
  echo ">> 发现服务器本地数据文件，出迁移预览（dry-run 只读，一行不写）..."
  URI_NO_QUERY="${MONGODB_URI%%\?*}"
  DB_NAME="${URI_NO_QUERY##*/}"
  [ -z "$DB_NAME" ] && DB_NAME='dsh_prod'
  node scripts/migrate-to-mongo.mjs --uri "$MONGODB_URI" --db "$DB_NAME" --dry-run \
    || echo "   （预览未成功：不影响部署，首启按服务器 data/ 自动处理）"
  echo "   ↑ 若数字符合预期，服务启动后首启将自动完成同样的搬家（只做一次）"
fi

# ---- 构建前端 ----
if [ "${SKIP_FRONTEND:-0}" != "1" ]; then
  echo ">> 构建前端 ..."
  (cd frontend && npm ci && npm run build)
fi

# ---- SKIP_SYSTEMD 出口 / 非 Linux 自动彩排形态 ----
# 数据导入已全部完成；非 Linux 物理上没有 systemd，自动走此出口（无需开关）。
if [ "${SKIP_SYSTEMD:-0}" = "1" ] || [ "$(uname)" != "Linux" ]; then
  # root 跑的彩排：import 解出的 keys/entry 会是 root 属主，之后【交互用户】手工
  # 起 node 必"读不了签发根拒启"——sudo 自带 SUDO_UID，把现场属主还给原用户。
  if [ "$(id -u)" = "0" ] && [ -n "${SUDO_UID:-}" ]; then
    chown -R "${SUDO_UID}:${SUDO_GID:-0}" "$ROOT"
    echo ">> （彩排形态）项目现场属主已归还 uid=${SUDO_UID}"
  fi
  echo ""
  echo ">> SKIP_SYSTEMD=1：跳过 systemd 注册——【导入到此已全部完成】"
  echo "   手工起服务：  node src/server.js"
  echo "   验证：        curl -s http://127.0.0.1:${PORT}/health"
  echo "   浏览器：      http://${PUBLIC_HOST}:${PORT}/"
  exit 0
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
    -e "s|__PUBLIC_SCHEME__|${PUBLIC_SCHEME}|g" \
    -e "s|__PUBLIC_PORT__|${PUBLIC_PORT}|g" \
    -e "s|__TUNNEL_SYNC_TOKEN__|${TUNNEL_SYNC_TOKEN}|g" \
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
