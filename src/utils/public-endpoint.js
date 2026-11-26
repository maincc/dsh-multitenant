/**
 * 对外形态单点（隧道/反代部署适配，2026-11-12 用户需求：https 隧道 + 端口变换）。
 *
 * 背景：平台是"入口一个端口 + 每租户一个网关端口"的多端口形态。部署经隧道
 * （frp/nps 等）时，浏览器侧的 scheme 与端口和服务器进程侧**不一致**（外部
 * https:8550 → 内部 http:8090），且隧道终结 TLS 后不会透传协议信息。此前
 * 面向用户的 URL 四处硬编码 `http://`、返回平台链接用内网端口——隧道形态下
 * 全部跳错。本模块把"对外怎么说"收成一个口径：
 *
 *   scheme = PUBLIC_SCHEME env / server.publicScheme 配置（'https'|'http'）
 *            > 本请求 TLS 判形（socket.encrypted 或 x-forwarded-proto 首跳 https）
 *            > 'http'
 *   入口端口 = PUBLIC_PORT / server.publicPort > server.port
 *
 * 一致性红线：publicScheme 一旦设 'https'，**所有映射出去的端口（入口 + 各租户
 * 31xxx）都必须 https 终结**——cookie 按 host 共享不分端口，Secure 票发得出
 * 收不回（http 端口收不到），混形态必现"网关 403"。设 'http' 或不设则无此约束。
 */
import { CONFIG } from '../config/config.js'

/** 本请求是否 TLS 直连或反代声明 https（自动判形，与 cookie secure 同源） */
export function tlsContext(req) {
  const fwd = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return Boolean(req?.socket?.encrypted) || fwd === 'https'
}

/** 对外 scheme：配置显式 > 请求判形 > http */
export function publicScheme(req) {
  const cfg = String(process.env.PUBLIC_SCHEME || CONFIG?.server?.publicScheme || '')
    .trim()
    .toLowerCase()
  if (cfg === 'https' || cfg === 'http') return cfg
  return tlsContext(req) ? 'https' : 'http'
}

/** 入口对外端口（隧道外口 ≠ 进程口时由配置/环境变量声明） */
export function publicEntryPort() {
  const p = Number(process.env.PUBLIC_PORT || CONFIG?.server?.publicPort || 0)
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : Number(CONFIG?.server?.port) || 8090
}

/** 租户 URL 模板（env 优先，与 PUBLIC_* 家族同口径）；''=未启用子域形态 */
export function tenantUrlTemplate() {
  return String(process.env.TENANT_URL_TEMPLATE || CONFIG?.server?.tenantUrlTemplate || '').trim()
}

/** 纯 IPv4/IPv6 字面 Host（含可选 :port）——局域网/回环直连形态的判据 */
const IP_HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i

/** 请求入口 Host 的纯主机名（去端口小写） */
function reqHostOf(req) {
  const h = String(req?.headers?.host || '')
    .trim()
    .toLowerCase()
  try {
    return new URL(`http://${h}`).hostname
  } catch {
    return h.replace(/:\d+$/, '')
  }
}

/**
 * 租户对外 base（不含尾斜杠与 query）。**入口感知**：
 * - 请求 Host 是 IP/localhost/空 → null（调用方走旧形态 host:租户端口——本机
 *   测试与局域网直连体验原样保留）；
 * - 域名入口且配置了模板 → 模板代入 {port}/{address}；
 * - 未配置模板 → null（全旧形态）。
 */
export function tenantBaseUrl(port, req, address = '') {
  const tpl = tenantUrlTemplate()
  if (!tpl || !Number.isInteger(port) || port <= 0) return null
  const host = reqHostOf(req)
  if (!host || host === 'localhost' || IP_HOST_RE.test(host)) return null
  return tpl
    .replace(/\{port\}/g, String(port))
    .replace(/\{address\}/g, String(address || ''))
    .replace(/\/+$/, '')
}

/**
 * 租户对外 authority（host[:port]，去 scheme 去尾斜杠）：进容器 trustedHosts。
 * 不受入口感知限制（patch 烘死时需列出**全部**可能入口），只要模板启用即派生。
 */
export function tenantAuthority(port, address = '') {
  const tpl = tenantUrlTemplate()
  if (!tpl || !Number.isInteger(port) || port <= 0) return null
  const bare = tpl
    .replace(/\{port\}/g, String(port))
    .replace(/\{address\}/g, String(address || ''))
    .replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(bare)) return null // 必须显式 scheme：'host:port' 串会被 URL 解析当成协议吃掉
  try {
    const u = new URL(bare + '/')
    return u.port && u.port !== '443' && u.port !== '80' ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return null
  }
}
