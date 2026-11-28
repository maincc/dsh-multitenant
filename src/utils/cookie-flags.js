/**
 * 会话 cookie 属性组装（S2 配套 · TLS 条件化，2026-11-12 审计批次）。
 *
 * 判例：user_session/admin_session 此前恒不带 secure——纯 http 形态带了浏览器
 * 会直接丢弃 cookie，会话当场死（本机 8090 形态必须零 secure）。服务器 https
 * 终结形态则必须带 secure，否则会话票可被明文链路截获。本函数单点判形，
 * 两形态共存不破。
 *
 * 2026-11-12 隧道适配：判形升级走 publicScheme 口径——隧道终结 TLS 且不回传
 * 协议信息时，x-forwarded-proto/socket 都看不见 https，须由 PUBLIC_SCHEME/
 * server.publicScheme 显式声明（一致性红线见 public-endpoint.js 头注）。
 */
import { publicScheme } from './public-endpoint.js'

export function secureFlag(req) {
  return publicScheme(req) === 'https' ? '; secure' : ''
}
