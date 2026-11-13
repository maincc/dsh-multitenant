/**
 * 会话 cookie 属性组装（S2 配套 · TLS 条件化，2026-11-12 审计批次）。
 *
 * 判例：user_session/admin_session 此前恒不带 secure——纯 http 形态带了浏览器
 * 会直接丢弃 cookie，会话当场死（本机 8090 形态必须零 secure）。服务器 https
 * 终结形态（原生 TLS 或反代 x-forwarded-proto=https）则必须带 secure，否则
 * 会话票可被明文链路截获。本函数单点判形，两形态共存不破。
 */
export function secureFlag(req) {
  const fwd = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return req?.socket?.encrypted || fwd === 'https' ? '; secure' : ''
}
