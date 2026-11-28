/**
 * 认证中间件（判例 2026-10-30：admin_session 废止，单源身份 = user_session）
 *
 * 历史：管理员曾持独立 admin_session 票（12h 硬到期、不滑动、单独钱包登录），与
 * 租户侧 user_session（12h 滑动）并行。一个浏览器两张票必然打架——残留 admin
 * cookie **抢占**插件当前钱包的身份（F9"会话主人不一致"循环、凭证端点串号、
 * 撤板签名被"同账户"闸拒……同根因族）。裁定：**去除 admin_session**，全平台
 * 只有登录钱包一张票。
 *
 * 判权与反劫持的承重不变：
 *   - 身份 = user_session 解析出的登录钱包地址（随机会话 token，查表+过期校验，
 *     废止旧行为"cookie 值=地址"可伪造）；
 *   - 管理权 = isAdmSync(地址)——VC 凭证结论快照 ∪ config/admin.json 名册兜底
 *     （对账完成前/凭证停用自动落名册，升级期绝不上锁）；
 *   - 破坏性操作仍当场验钱包签名，challenge 绑在这个地址上——只偷到 cookie 没有
 *     这把钱包的签名钥匙，一样办不了事（P0-1 墙原样）。
 *
 * getAdminSession 保留函数名：调用面（46+ 处）语义本就是"操作人会话地址"，
 * 判权一律在 requireAdmin/isAdmSync，不在取地址这一步。
 */

import { credentialService } from '../services/credential.service.js'
import { getUserSession } from './user-auth.middleware.js'

/**
 * 当前会话地址（user_session 单源；无效/过期返回 null）
 */
export function getAdminSession(req) {
  return getUserSession(req)
}

/**
 * 管理员权限守卫：会话地址 + isAdmSync（凭证结论∪名册兜底）。
 * 返回 true 有权限；false 已发送 403。
 */
export function requireAdmin(req, res) {
  const session = getAdminSession(req)
  if (!session || !credentialService.isAdmSync(session)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: '需要管理员权限', code: 'FORBIDDEN' }))
    return false
  }
  return true
}

/**
 * 获取当前会话地址（与 getAdminSession 同源别名——同为登录钱包身份）
 */
export function getSessionAddress(req) {
  return getAdminSession(req)
}

/**
 * 获取请求身份（单源：登录钱包）。
 * 历史注释保留：曾"admin 优先"矫枉为"user 优先+admin 回退"，根因（双票抢占）
 * 随 admin_session 废止一并根治——现在没有第二张票可抢。
 */
export function getRequestAddress(req) {
  return getUserSession(req)
}
