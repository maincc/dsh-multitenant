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
