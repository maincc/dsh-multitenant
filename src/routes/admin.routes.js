/**
 * 管理路由模块
 */

import { CONFIG, isAdmin } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { dataService } from '../services/data.service.js'
import { dockerService } from '../services/docker.service.js'
import { cwtAdminService } from '../services/cwt-admin.service.js'
import { requireAdmin, getAdminSession } from '../middleware/auth.middleware.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { normalizeAddress } from '../utils/address.js'
import { BadRequestError, NotFoundError, handleError } from '../utils/errors.js'
import { parseBody } from '../utils/parse-body.js'

/**
 * 处理管理路由
 */
export async function handleAdminRoutes(req, res, path, url) {
  // POST /api/admin/login - 管理员登录
  if (path === '/api/admin/login' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      const { address } = JSON.parse(body || '{}')

      if (!validateSwtcAddress(address, res)) return true

      const addrLower = normalizeAddress(address)
      if (!isAdmin(addrLower)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '不是管理员地址', code: 'FORBIDDEN' }))
        return true
      }

      // 设置管理员会话 Cookie
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `admin_session=${addrLower}; path=/; max-age=86400; httponly; samesite=strict`,
      })
      res.end(JSON.stringify({ ok: true, address: addrLower, isAdmin: true }))

      // 记录日志
      dataService.logOperation('admin_login', { address: addrLower })
    } catch (err) {
      // 只有在 headers 还没发送时才处理错误
      if (!res.headersSent) {
        handleError(err, res)
      }
    }
    return true
  }

  // GET /api/admin/check - 检查管理员权限
  if (path === '/api/admin/check') {
    const session = getAdminSession(req)
    const queryAddress = url.searchParams.get('address')

    // 如果传入了 address 参数，检查该地址是否是管理员
    if (queryAddress) {
      const addrLower = normalizeAddress(queryAddress)
      const isAdm = isAdmin(addrLower)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ isAdmin: isAdm, address: addrLower, checkedAddress: addrLower }))
      return true
    }

    // 否则检查 cookie 中的 session
    const isAdm = session && isAdmin(session)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ isAdmin: isAdm, address: session || null }))
    return true
  }

  // GET /api/docker/status - 检查 Docker 状态
  if (path === '/api/docker/status') {
    try {
      const available = await dockerService.isDockerAvailable()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ available, timestamp: Date.now() }))
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ available: false, error: err.message, timestamp: Date.now() }))
    }
    return true
  }

  // POST /api/admin/merge-duplicates - 合并重复地址
  if (path === '/api/admin/merge-duplicates' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true

    try {
      const merged = await userService.mergeDuplicateAddresses()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, merged, count: merged.length }))
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: 'INTERNAL_ERROR' }))
      }
    }
    return true
  }

  // POST /api/admin/promote/:address - 提权用户为管理员
  if (path.startsWith('/api/admin/promote/') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true

    let address = path.slice('/api/admin/promote/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    // 添加到管理员列表（运行时 + 持久化）
    const added = dataService.addAdmin(address, getAdminSession(req) || 'system')

    if (added) {
      console.log(`[admin] promoted ${address} to admin`)
      dataService.logOperation('admin_promote', { address, operator: getAdminSession(req) })
    }

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, address, promoted: added }))
    return true
  }

  // GET /api/users - 获取所有用户列表
  if (path === '/api/users') {
    if (!requireAdmin(req, res)) return
    try {
      const users = await userService.getAllUsers()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ users, tiers: CONFIG.tiers }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/stats - 系统统计
  if (path === '/api/stats') {
    if (!requireAdmin(req, res)) return
    const stats = userService.getStats()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(stats))
    return true
  }

  // POST /api/admin/force-stop/:address - 强制下线容器
  if (path.startsWith('/api/admin/force-stop/') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return

    let address = path.slice('/api/admin/force-stop/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    try {
      const result = await userService.forceStopContainer(address)
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      }
    } catch (err) {
      if (!res.headersSent) {
        const status = err.statusCode || 500
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL_ERROR' }))
      }
    }
    return true
  }

  // GET /api/admin/cwt/applications - CWT 待审批列表
  if (path === '/api/admin/cwt/applications' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const list = cwtAdminService.listApplications()
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, applications: list }))
      }
    } catch (err) {
      if (!res.headersSent) handleError(err, res)
    }
    return true
  }

  // POST /api/admin/cwt/applications/:id/approve - 批准（复核验签后入库）
  if (
    path.startsWith('/api/admin/cwt/applications/') &&
    path.endsWith('/approve') &&
    req.method === 'POST'
  ) {
    if (!requireAdmin(req, res)) return
    const id = path.slice('/api/admin/cwt/applications/'.length, -'/approve'.length)
    try {
      const adminAddr = getAdminSession(req)
      const result = await cwtAdminService.approveApplication(id, adminAddr)
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      }
    } catch (err) {
      if (!res.headersSent) {
        const status = err.statusCode || (err.code ? 400 : 500)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL_ERROR' }))
      }
    }
    return true
  }

  // POST /api/admin/cwt/applications/:id/reject - 拒绝
  if (
    path.startsWith('/api/admin/cwt/applications/') &&
    path.endsWith('/reject') &&
    req.method === 'POST'
  ) {
    if (!requireAdmin(req, res)) return
    const id = path.slice('/api/admin/cwt/applications/'.length, -'/reject'.length)
    try {
      const adminAddr = getAdminSession(req)
      const result = await cwtAdminService.rejectApplication(id, adminAddr)
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      }
    } catch (err) {
      if (!res.headersSent) {
        const status = err.statusCode || (err.code ? 400 : 500)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL_ERROR' }))
      }
    }
    return true
  }

  // GET /api/admin/cwt/registry - 已批准注册表
  if (path === '/api/admin/cwt/registry' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const registry = cwtAdminService.listRegistry()
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, registry }))
      }
    } catch (err) {
      if (!res.headersSent) handleError(err, res)
    }
    return true
  }

  // POST /api/admin/cwt/registry/:address/revoke - 撤销授权
  if (
    path.startsWith('/api/admin/cwt/registry/') &&
    path.endsWith('/revoke') &&
    req.method === 'POST'
  ) {
    if (!requireAdmin(req, res)) return
    let address = path.slice('/api/admin/cwt/registry/'.length, -'/revoke'.length)
    if (!validateSwtcAddress(address, res)) return
    address = normalizeAddress(address)
    try {
      const adminAddr = getAdminSession(req)
      const result = await cwtAdminService.revokeRegistry(address, adminAddr)
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      }
    } catch (err) {
      if (!res.headersSent) {
        const status = err.statusCode || (err.code ? 400 : 500)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL_ERROR' }))
      }
    }
    return true
  }

  // GET /api/admin/cwt/records - 审计记录（token 原文可查可重验）
  if (path === '/api/admin/cwt/records' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const records = cwtAdminService.listRecords()
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, records }))
      }
    } catch (err) {
      if (!res.headersSent) handleError(err, res)
    }
    return true
  }

  // POST /api/admin/delete-volume/:address - 删除数据卷
  if (path.startsWith('/api/admin/delete-volume/') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return

    let address = path.slice('/api/admin/delete-volume/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    try {
      const result = await userService.deleteUserVolume(address)
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      }
    } catch (err) {
      if (!res.headersSent) {
        const status = err.statusCode || 500
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL_ERROR' }))
      }
    }
    return true
  }

  return false
}
