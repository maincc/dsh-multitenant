#!/usr/bin/env bash
# ============================================================================
#  隧道端口自动同步（示例，按需改造适配你的 frp 版本/形态）
#
#  场景：租户网关端口 31xxx 是平台动态分配的——新租户上线/销毁都变。
#  本脚本从平台同步面 GET /api/admin/gateway-ports 拉"当前全部已分配端口"，
#  与上次结果做差集，新端口经 frpc admin API 动态补一个 tcp 代理（老 frpc
#  无 API 就改写 frpc.ini 后 reload）。cron 里 5 分钟一跑即可。
#
#  前提：
#   - frpc 与平台同机：接口走回环免口令。异机：设 TUNNEL_SYNC_TOKEN 与 install.sh 同值。
#   - frpc 开 web_server（frpc.toml: webAddrs=["127.0.0.1"], webPort=7400，
#     如配了 auth 口令记得一并带上）。
#   - 声明 PUBLIC_SCHEME=https 时本示例的 raw tcp 形态不适用（见 README 一致性红线）。
# ============================================================================
set -euo pipefail

PLATFORM="${PLATFORM_URL:-http://127.0.0.1:8090}"
FRPC_ADMIN="${FRPC_ADMIN:-http://127.0.0.1:7400/api/new_proxies}"
STATE="${STATE_FILE:-/var/tmp/dsh-tunnel-ports}"
PREFIX="${NAME_PREFIX:-dsh-gw}"

curl -sf "${PLATFORM}/api/admin/gateway-ports" ${TUNNEL_SYNC_TOKEN:+-H "Authorization: Bearer ${TUNNEL_SYNC_TOKEN}"} \
  | jq -r '.ports[] | select(.status=="running" or .status=="stopped") | .port' | sort -un > "${STATE}.new"

comm -13 "${STATE}" "${STATE}.new" 2>/dev/null | while read -r port; do
  echo ">> 新租户口 $port → frpc 补映射"
  curl -sf "${FRPC_ADMIN}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${PREFIX}-${port}\",\"type\":\"tcp\",\"localPort\":${port},\"remotePort\":${port}}" \
    || echo "!! frpc 添加 $port 失败（检查 web_server 配置）" >&2
done

mv "${STATE}.new" "${STATE}"
