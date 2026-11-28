#!/usr/bin/env node
/**
 * apisix-tenant-sync.js —— DSH 租户端口 → APISIX 路由同步器（2026-11-26）
 *
 * 配合 dsh 的 server.tenantUrlTemplate 子域形态（泛域名反代部署）：
 *   浏览器 → https://t{port}.泛域:入口口 → APISIX 按 host 路由 → 发布服务器:{port}
 * 本脚本轮询 DSH 的 /api/admin/gateway-ports（即 frpc 隧道同款数据面），把
 * running 租户对账成 APISIX routes（只动自己 labels 管的，别人的路由不碰）。
 *
 * 用法（与 dsh 同机或任意可达两侧的网络位）：
 *   APISIX_ADMIN_URL=http://192.168.200.122:9180 \
 *   APISIX_ADMIN_KEY=xxx \
 *   DSH_BASE_URL=http://127.0.0.1:8090 \
 *   TUNNEL_SYNC_TOKEN=xxx \
 *   TENANT_HOST_TEMPLATE='t{port}.wh.jccdex.cn' \
 *   UPSTREAM_HOST=192.168.200.114 \
 *   node scripts/apisix-tenant-sync.js            # 常驻（60s 一轮）
 *   node scripts/apisix-tenant-sync.js --once     # 单轮（cron/排障）
 *
 * 说明：
 * - APISIX 3.x Admin API（X-API-KEY 鉴权）。route 走 host 精确匹配 +
 *   scheme=http 明文回源（TLS 在 apisix 8550 终结），enable_websocket 常开
 *   （租户内 VS Code Web 等重度 ws）。
 * - UPSTREAM_HOST 缺省用 gateway-ports 回的 entry.host；部署里 entry.host 若
 *   配的是公网域名（apisix 解不了/绕发夹）时务必显式给内网 IP。
 * - 幂等：route id 固定 `${ROUTE_PREFIX}{port}`，PUT 全量覆盖 + 孤儿 DELETE。
 */

const {
  APISIX_ADMIN_URL = 'http://127.0.0.1:9180',
  APISIX_ADMIN_KEY,
  DSH_BASE_URL = 'http://127.0.0.1:8090',
  TUNNEL_SYNC_TOKEN,
  TENANT_HOST_TEMPLATE = 't{port}.wh.jccdex.cn',
  UPSTREAM_HOST = '',
  ROUTE_PREFIX = 'dsh-tenant-',
  INTERVAL_SEC = '60',
} = process.env

if (!APISIX_ADMIN_KEY) die('缺 APISIX_ADMIN_KEY（apisix config-admin.yaml 的 admin_key）')
if (!TUNNEL_SYNC_TOKEN) die('缺 TUNNEL_SYNC_TOKEN（与 dsh 服务端同值）')

function die(msg) {
  console.error(`[apisix-sync] FATAL ${msg}`)
  process.exit(1)
}
const log = (...a) => console.log(`[apisix-sync] ${new Date().toISOString().slice(11, 19)}`, ...a)

async function jfetch(url, opts = {}, label) {
  let res
  try {
    res = await fetch(url, opts)
  } catch (e) {
    throw new Error(`${label} 网络失败: ${e.message}`)
  }
  const body = await res.text()
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 200)}`)
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`${label} 非 JSON: ${body.slice(0, 120)}`)
  }
}

async function fetchPorts() {
  return jfetch(
    `${DSH_BASE_URL}/api/admin/gateway-ports`,
    { headers: { authorization: `Bearer ${TUNNEL_SYNC_TOKEN}` } },
    'gateway-ports',
  )
}
function desiredRoutes(data, upstreamHost) {
  const ports = (data.ports || []).filter((p) => p.status === 'running')
  return {
    ports,
    want: ports.map((p) => {
      const host = TENANT_HOST_TEMPLATE.replace(/\{port\}/g, String(p.port))
      return {
        id: `${ROUTE_PREFIX}${p.port}`,
        body: {
          name: `dsh tenant ${p.port}`,
          host,
          labels: { 'managed-by': 'dsh-apisix-sync' },
          upstream: {
            type: 'roundrobin',
            nodes: { [`${upstreamHost || data?.entry?.host || '127.0.0.1'}:${p.port}`]: 1 },
            scheme: 'http',
            timeout: { connect: 5000, send: 30000, read: 30000 },
          },
          enable_websocket: true,
          status: 1,
        },
      }
    }),
  }
}

async function existingOwned() {
  const data = await jfetch(
    `${APISIX_ADMIN_URL}/apisix/admin/routes?label=managed-by=dsh-apisix-sync`,
    { headers: { 'X-API-KEY': APISIX_ADMIN_KEY } },
    'apisix list',
  )
  const out = new Map()
  for (const it of data.list || []) {
    const id =
      it.value && it.value.id
        ? String(it.value.id)
        : String(it.key || '')
            .split('/')
            .pop()
    out.set(id, it.value || {})
  }
  return out
}

async function reconcile() {
  const data = await fetchPorts()
  const upstreamHost = UPSTREAM_HOST || (data.entry && data.entry.host) || ''
  if (!upstreamHost) die('UPSTREAM_HOST 未给且 gateway-ports.entry.host 为空，无从指路')
  const want = desiredRoutes(data, upstreamHost)
  const have = await existingOwned()
  const wantIds = new Map(want.want.map((r) => [r.id, r]))
  let put = 0
  let del = 0
  for (const [id, route] of wantIds) {
    const cur = have.get(id)
    const same =
      cur &&
      cur.host === route.body.host &&
      JSON.stringify(cur.upstream && cur.upstream.nodes) ===
        JSON.stringify(route.body.upstream.nodes)
    if (same) continue
    await jfetch(
      `${APISIX_ADMIN_URL}/apisix/admin/routes/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: { 'X-API-KEY': APISIX_ADMIN_KEY, 'content-type': 'application/json' },
        body: JSON.stringify(route.body),
      },
      `PUT ${id}`,
    )
    put++
  }
  for (const id of have.keys()) {
    if (wantIds.has(id)) continue
    await jfetch(
      `${APISIX_ADMIN_URL}/apisix/admin/routes/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { 'X-API-KEY': APISIX_ADMIN_KEY } },
      `DELETE ${id}`,
    )
    del++
  }
  log(`租户 ${want.want.length} → 路由更新 ${put} 删除 ${del}（upstream=${upstreamHost}）`)
}

const once = process.argv.includes('--once')
;(async () => {
  for (;;) {
    try {
      await reconcile()
    } catch (e) {
      log(`本轮失败（下轮重试）: ${e.message}`)
    }
    if (once) return
    await new Promise((r) => setTimeout(r, Number(INTERVAL_SEC) * 1000))
  }
})()
