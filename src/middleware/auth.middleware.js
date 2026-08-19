/**
 * 认证中间件
 */

import { isAdmin } from '../config/config.js'

/**
 * 从 Cookie 或 Header 中获取管理员会话
 */
export function getAdminSession(req) {
  const cookie = req.headers.cookie || ''
  const match = cookie.match(/admin_session=([^;]+)/)
  return match ? match[1] : null
}

/**
 * 管理员权限守卫
 * 返回 true 表示有权限，false 表示无权限（已发送响应）
 */
export function requireAdmin(req, res) {
  const session = getAdminSession(req)
  if (!session || !isAdmin(session)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: '需要管理员权限', code: 'FORBIDDEN' }))
    return false
  }
  return true
}

/**
 * 获取当前会话地址
 */
export function getSessionAddress(req) {
  return getAdminSession(req)
}
