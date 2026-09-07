/**
 * 租户路由模块
 */

import { CONFIG, isAdmin } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { tenantConfigService } from '../services/tenant-config.service.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { rateLimit } from '../middleware/rate-limit.middleware.js'
import { normalizeAddress, swtcVolumeName } from '../utils/address.js'
import { handleError } from '../utils/errors.js'

/**
 * 处理租户路由
 */
export async function handleTenantRoutes(req, res, path, url) {
  // 未认证端点按 IP 限流（security-hardening-plan P0-2）
  // /connect 创建容器、/connect-status 状态轮询、/leave 销毁容器
  if (path === '/connect' || path === '/connect-status' || path.startsWith('/leave/')) {
    const key = path === '/connect' ? 'connect' : path === '/connect-status' ? 'status' : 'leave'
    const max = path === '/connect-status' ? 30 : 10
    if (!rateLimit(req, res, { max, keyPrefix: key })) return true
  }

  // GET /connect：CCDAO 插件连接端点
  // （P0-2 所有权口径 B：容器已存在→免签名直连；需要创建→钱包签名证明地址归属）
  if (path === '/connect') {
    let address = url.searchParams.get('address')
    if (!validateSwtcAddress(address, res)) return true

    address = normalizeAddress(address)

    try {
      // 只有"需要创建"才要求签名；已存在的容器直接连接
      const exists = await userService.containerExists(address)
      if (!exists) {
        const nonce = url.searchParams.get('nonce')
        const signature = url.searchParams.get('signature')
        const publicKey = url.searchParams.get('publicKey')
        if (!nonce || !signature || !publicKey) {
          // 未携带签名材料 → 401 + 下发一次性挑战（签名后带参重试）
          const challenge = tenantConfigService.issueChallenge(address)
          if (!challenge) {
            res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: '挑战发放过载，请稍后重试', code: 'OVERLOAD' }))
            return true
          }
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
          res.end(
            JSON.stringify({
              error: '需要签名验证容器所有权',
              code: 'SIGNATURE_REQUIRED',
              nonce: challenge,
              address,
            }),
          )
          return true
        }
        // 验签（公钥推导地址 === 声称地址）
        if (!tenantConfigService.verifySignature(address, nonce, signature, publicKey)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '签名验证失败', code: 'FORBIDDEN' }))
          return true
        }
        // 挑战一次性（防重放）
        if (!tenantConfigService.consumeChallenge(address, nonce)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '挑战已失效，请重新获取', code: 'FORBIDDEN' }))
          return true
        }
      }

      // 连接/创建容器
      const port = await userService.ensureContainer(address)
      const PUBLIC_HOST = process.env.PUBLIC_HOST || CONFIG.server.publicHost
      res.writeHead(302, { location: `http://${PUBLIC_HOST}:${port}/` })
      res.end()
    } catch (err) {
      // 资源不足，进入等待队列
      if (err.code === 'RESOURCE_EXHAUSTED') {
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: '资源不足，请等待',
            code: 'RESOURCE_EXHAUSTED',
            queuePosition: err.queuePosition,
            failedResources: err.failedResources,
            message: '系统资源不足，您已进入等待队列，资源释放后将自动为您创建容器',
          }),
        )
      } else if (err.code === 'USAGE_LIMIT_REACHED') {
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: err.message,
            code: 'USAGE_LIMIT_REACHED',
            usedMinutes: err.usedMinutes,
            dailyLimit: err.dailyLimit,
            message: `今日使用时长已达上限（${err.dailyLimit} 分钟），请明日再试，或完成 CWT 验证解锁`,
          }),
        )
      } else if (err.code === 'QUEUE_FULL') {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: 'QUEUE_FULL' }))
      } else {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`SWTC tenant provisioning failed: ${err.message}\n${err.stderr ?? ''}`)
      }
    }
    return true
  }

  // GET /connect-status：检查 SWTC 地址的容器状态
  if (path === '/connect-status') {
    let address = url.searchParams.get('address')
    if (!validateSwtcAddress(address, res)) return true

    address = normalizeAddress(address)

    // 检查是否在等待队列中
    const queueInfo = userService.getQueuePosition(address)
    if (queueInfo) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          exists: false,
          address,
          status: 'waiting',
          queuePosition: queueInfo.position,
          queueTotal: queueInfo.total,
          waitingSince: queueInfo.timestamp,
          message: '资源不足，正在等待中',
        }),
      )
      return true
    }

    const user = userService.state.swtcUsers?.[address]
    if (!user) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ exists: false, address }))
      return true
    }

    const idle = Date.now() - user.lastSeenAt
    const usageCfg = userService.usageLimitConfig()
    const exempt = userService.isUsageExempt(address)
    const used = userService.getUsedMinutes(address)
    const limit = usageCfg.enabled ? usageCfg.dailyMinutes : null
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
        usage: {
          enabled: Boolean(usageCfg.enabled),
          dailyMinutes: limit,
          usedMinutes: used,
          remainingMinutes: limit !== null && !exempt ? Math.max(0, limit - used) : null,
          exempt,
        },
      }),
    )
    return true
  }

  // GET /leave/<address>：显式销毁指定 SWTC 用户的容器
  // （security-hardening-plan P0-2：本人或管理员；前端当前无调用方，不影响 UX）
  if (path.startsWith('/leave/')) {
    const { getSessionAddress } = await import('../middleware/auth.middleware.js')
    const session = getSessionAddress(req)
    const isAdminUser = session && isAdmin(session)

    let address = decodeURIComponent(path.slice('/leave/'.length))
    if (!validateSwtcAddress(address, res)) return true

    address = normalizeAddress(address)

    // 权限检查：只能销毁自己的容器，或者是管理员
    if (session !== address && !isAdminUser) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '没有权限销毁此容器', code: 'FORBIDDEN' }))
      return true
    }

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

  // POST /api/user/:address/restart - 重启容器（用于安装插件后重启 DSH 服务）
  if (path.startsWith('/api/user/') && path.endsWith('/restart') && req.method === 'POST') {
    const { getSessionAddress, requireAdmin } = await import('../middleware/auth.middleware.js')
    const session = getSessionAddress(req)
    const isAdminUser = session && isAdmin(session)

    // 提取地址：/api/user/<address>/restart
    const match = path.match(/^\/api\/user\/(.+)\/restart$/)
    if (!match) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Invalid path', code: 'BAD_REQUEST' }))
      return true
    }

    let address = match[1]
    if (!validateSwtcAddress(address, res)) return true
    address = normalizeAddress(address)

    // 权限检查：只能重启自己的容器，或者是管理员
    if (session !== address && !isAdminUser) {
      if (!res.headersSent) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '没有权限重启此容器', code: 'FORBIDDEN' }))
      }
      return true
    }

    try {
      const result = await userService.restartContainer(address)
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

  // POST /api/user/:address/stop - 用户主动停止自己的容器（保全每日限时额度）
  if (path.startsWith('/api/user/') && path.endsWith('/stop') && req.method === 'POST') {
    const { getSessionAddress } = await import('../middleware/auth.middleware.js')
    const session = getSessionAddress(req)
    const isAdminUser = session && isAdmin(session)

    // 提取地址：/api/user/<address>/stop
    const match = path.match(/^\/api\/user\/(.+)\/stop$/)
    if (!match) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Invalid path', code: 'BAD_REQUEST' }))
      return true
    }

    let address = match[1]
    if (!validateSwtcAddress(address, res)) return true
    address = normalizeAddress(address)

    // 权限检查：只能停止自己的容器，或者是管理员
    if (session !== address && !isAdminUser) {
      if (!res.headersSent) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '没有权限停止此容器', code: 'FORBIDDEN' }))
      }
      return true
    }

    try {
      const result = await userService.stopContainerForUser(address)
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

  // POST /api/user/:address/reset - 删除数据卷并重建容器（放弃当前配置重新开始）
  if (path.startsWith('/api/user/') && path.endsWith('/reset') && req.method === 'POST') {
    const { getSessionAddress, requireAdmin } = await import('../middleware/auth.middleware.js')
    const session = getSessionAddress(req)
    const isAdminUser = session && isAdmin(session)

    // 提取地址：/api/user/<address>/reset
    const match = path.match(/^\/api\/user\/(.+)\/reset$/)
    if (!match) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Invalid path', code: 'BAD_REQUEST' }))
      return true
    }

    let address = match[1]
    if (!validateSwtcAddress(address, res)) return true
    address = normalizeAddress(address)

    // 权限检查：只能重置自己的容器，或者是管理员
    if (session !== address && !isAdminUser) {
      if (!res.headersSent) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '没有权限重置此容器', code: 'FORBIDDEN' }))
      }
      return true
    }

    try {
      const result = await userService.resetContainer(address)
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
