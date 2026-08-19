/**
 * 租户路由模块
 */

import { CONFIG } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { normalizeAddress, swtcVolumeName } from '../utils/address.js'
import { handleError } from '../utils/errors.js'

/**
 * 处理租户路由
 */
export async function handleTenantRoutes(req, res, path, url) {
  // GET /connect：CCDAO 插件连接端点
  if (path === '/connect') {
    let address = url.searchParams.get('address')
    if (!validateSwtcAddress(address, res)) return true

    address = normalizeAddress(address)

    try {
      const port = await userService.ensureContainer(address)
      const PUBLIC_HOST = process.env.PUBLIC_HOST || CONFIG.server.publicHost
      res.writeHead(302, { location: `http://${PUBLIC_HOST}:${port}/` })
      res.end()
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`SWTC tenant provisioning failed: ${err.message}\n${err.stderr ?? ''}`)
    }
    return true
  }

  // GET /connect-status：检查 SWTC 地址的容器状态
  if (path === '/connect-status') {
    let address = url.searchParams.get('address')
    if (!validateSwtcAddress(address, res)) return true

    address = normalizeAddress(address)

    const user = userService.state.swtcUsers?.[address]
    if (!user) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ exists: false, address }))
      return true
    }

    const idle = Date.now() - user.lastSeenAt
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        exists: true,
        address,
        port: user.port,
        status: user.containerStatus ?? 'running',
        idleMs: idle,
        idleHuman:
          idle < 60000
            ? `${Math.floor(idle / 1000)}s`
            : idle < 3600000
              ? `${Math.floor(idle / 60000)}min`
              : `${(idle / 3600000).toFixed(1)}h`,
      }),
    )
    return true
  }

  // GET /leave/<address>：显式销毁指定 SWTC 用户的容器
  if (path.startsWith('/leave/')) {
    let address = decodeURIComponent(path.slice('/leave/'.length))
    if (!validateSwtcAddress(address, res)) return true

    address = normalizeAddress(address)

    try {
      const result = await userService.destroyContainer(address)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(err.message)
      } else {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`failed to destroy container: ${err.message}`)
      }
    }
    return true
  }

  // POST /api/user/:address/remove - 彻底删除用户记录并释放端口（需要管理员权限）
  if (path.startsWith('/api/user/') && path.endsWith('/remove') && req.method === 'POST') {
    const { requireAdmin } = await import('../middleware/auth.middleware.js')
    if (!requireAdmin(req, res)) return true

    // 提取地址：/api/user/<address>/remove
    const match = path.match(/^\/api\/user\/(.+)\/remove$/)
    if (!match) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Invalid path', code: 'BAD_REQUEST' }))
      return true
    }

    let address = match[1]
    if (!validateSwtcAddress(address, res)) return true
    address = normalizeAddress(address)

    try {
      const result = await userService.destroyContainer(address, true)
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      }
    } catch (err) {
      if (!res.headersSent) {
        if (err.code === 'NOT_FOUND') {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: err.message, code: 'NOT_FOUND' }))
        } else {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: err.message, code: 'INTERNAL_ERROR' }))
        }
      }
    }
    return true
  }

  return false
}
