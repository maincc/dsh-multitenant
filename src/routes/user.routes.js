/**
 * 用户路由模块
 */

import { CONFIG, isAdmin } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { getAdminSession } from '../middleware/auth.middleware.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { normalizeAddress } from '../utils/address.js'
import { NotFoundError, ForbiddenError, handleError } from '../utils/errors.js'

/**
 * 解析请求体
 */
function parseBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

/**
 * 处理用户路由
 */
export async function handleUserRoutes(req, res, path) {
  // GET /api/user/:address - 获取单个用户详情
  // 排除 /restart 和 /reset 路径（由 tenant.routes 处理）
  if (path.startsWith('/api/user/') && !path.endsWith('/restart') && !path.endsWith('/reset')) {
    let address = path.slice('/api/user/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    // 权限验证：用户可以查看自己的信息，管理员可以查看所有
    const session = getAdminSession(req)
    const isAdm = session && isAdmin(session)

    // 只有当有 session 且不是自己也不是管理员时才拒绝
    if (session && session !== address && !isAdm) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '无权查看其他用户信息', code: 'FORBIDDEN' }))
      return true
    }

    try {
      const userInfo = await userService.getUserInfo(address)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(userInfo))
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: err.code }))
      } else {
        handleError(err, res)
      }
    }
    return true
  }

  // POST /api/upgrade/:address - 升级用户配额
  if (path.startsWith('/api/upgrade/') && req.method === 'POST') {
    const { requireAdmin } = await import('../middleware/auth.middleware.js')
    if (!requireAdmin(req, res)) return

    let address = path.slice('/api/upgrade/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    const user = userService.state.swtcUsers?.[address]
    if (!user) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'User not found', code: 'NOT_FOUND' }))
      return true
    }

    try {
      const body = await parseBody(req)
      const { tier } = JSON.parse(body || '{}')

      if (!tier || !CONFIG.tiers[tier]) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'Invalid tier', code: 'BAD_REQUEST' }))
        return true
      }

      const result = await userService.upgradeContainer(address, tier)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  return false
}
