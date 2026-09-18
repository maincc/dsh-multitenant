/**
 * 租户路由模块
 */

import { CONFIG, isAdmin } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { tenantConfigService } from '../services/tenant-config.service.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { rateLimit } from '../middleware/rate-limit.middleware.js'
import { userSessionStore } from '../middleware/user-auth.middleware.js'
import { normalizeAddress, swtcVolumeName } from '../utils/address.js'
import { handleError } from '../utils/errors.js'
import { tenantGateway } from '../services/tenant-proxy.service.js'

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
  // 签名是所有路径的前提：容器不存在时需要证明地址归属（创建），
  // 容器已存在时也要换发 user_session cookie 过网关门禁。
  // 无签名的匿名请求一律 401 挑战——绝不在 302/JSON 响应里带出容器端口（P2-3）。
  if (path === '/connect') {
    let address = url.searchParams.get('address')
    if (!validateSwtcAddress(address, res)) return true

    address = normalizeAddress(address)

    try {
      const nonce = url.searchParams.get('nonce')
      const signature = url.searchParams.get('signature')
      const publicKey = url.searchParams.get('publicKey')
      const hasAuth = Boolean(nonce && signature && publicKey)

      if (!hasAuth) {
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

      // 连接/创建容器
      const port = await userService.ensureContainer(address)
      // 跳转/返回的 host 跟随请求 Host（浏览器当前 origin）：127 入口跳 127 容器页
      // （cookie 与 DSH 回环护栏一致，host.listDirectory 等宿主管道可用）；
      // 局域网 IP 入口则跳该 IP（DSH 宿主管道按设计 403，属安全护栏）。
      // PUBLIC_HOST 仍用于容器 patch 的 trustedHosts（容器端 Host 检查）。
      const PUBLIC_HOST = process.env.PUBLIC_HOST || CONFIG.server.publicHost
      let targetHost = PUBLIC_HOST
      const requestHost = (req.headers?.host || '').trim().toLowerCase()
      if (requestHost && requestHost !== 'undefined') {
        try {
          targetHost = new URL(`http://${requestHost}`).hostname // 去端口（Host 头含 :8090）
        } catch {
          targetHost = PUBLIC_HOST
        }
      }
      const gwTicket = tenantGateway.issueTicket(address)
      const containerUrl =
        `http://${targetHost}:${port}/` + (gwTicket ? `?gateway_ticket=${gwTicket}` : '')
      // 签名验证通过 → 签发普通用户会话（网关门禁凭据，2h；切钱包时前端会主动吊销）
      const sessionToken = userSessionStore.create(address, 2 * 60 * 60 * 1000)
      const cookieHeader = `user_session=${sessionToken}; path=/; max-age=43200; httponly; samesite=strict`
      // 前端 XHR/fetch 场景：浏览器 fetch 的 redirect:manual 会把 302 包成 opaque
      // (status 0)，前端拿不到 location。format=json 时直接给 200 JSON + cookie，
      // 由前端 window.open；地址栏直开（无 format）保持 302 跳转语义不变。
      if (url.searchParams.get('format') === 'json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          ...(cookieHeader ? { 'set-cookie': cookieHeader } : {}),
        })
        res.end(JSON.stringify({ ok: true, url: containerUrl, address, port }))
        return true
      }
      const headers = { location: containerUrl }
      if (cookieHeader) headers['set-cookie'] = cookieHeader
      res.writeHead(302, headers)
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

    // 匿名 / 非本人：只回存在性与粗略状态，不泄露端口/用量（P1-3：
    // 端口即"地址保密"的最后一道侦察口，必须会话化）
    const { getRequestAddress } = await import('../middleware/auth.middleware.js')
    const viewer = getRequestAddress(req)
    const isViewer = viewer === address || (viewer && isAdmin(viewer))
    if (!isViewer) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          exists: true,
          address,
          status: user.containerStatus ?? 'running',
        }),
      )
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
    const { getRequestAddress } = await import('../middleware/auth.middleware.js')
    const session = getRequestAddress(req)
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
    const { getRequestAddress, requireAdmin } = await import('../middleware/auth.middleware.js')
    const session = getRequestAddress(req)
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
    const { getRequestAddress } = await import('../middleware/auth.middleware.js')
    const session = getRequestAddress(req)
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
      // 重置 = 清空后立即重建：构造新容器 url（跟随请求 Host，同 /connect），
      // 并签发该地址的会话 cookie，前端直接一步进入新容器
      let containerUrl = null
      if (result.port) {
        const PUBLIC_HOST = process.env.PUBLIC_HOST || CONFIG.server.publicHost
        let targetHost = PUBLIC_HOST
        const requestHost = (req.headers?.host || '').trim().toLowerCase()
        if (requestHost && requestHost !== 'undefined') {
          try {
            targetHost = new URL(`http://${requestHost}`).hostname
          } catch {
            targetHost = PUBLIC_HOST
          }
        }
        const gwTicket = tenantGateway.issueTicket(address)
        containerUrl =
          `http://${targetHost}:${result.port}/` + (gwTicket ? `?gateway_ticket=${gwTicket}` : '')
      }
      if (!res.headersSent) {
        const headers = { 'content-type': 'application/json; charset=utf-8' }
        if (containerUrl) {
          const sessionToken = userSessionStore.create(address, 2 * 60 * 60 * 1000)
          headers['set-cookie'] =
            `user_session=${sessionToken}; path=/; max-age=43200; httponly; samesite=strict`
          result.url = containerUrl
        }
        res.writeHead(200, headers)
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

    // 删除租户（默认连数据卷一起删）是不可逆的 → 除会话外还要求当场钱包签名。
    // 签名走请求头，这里显式挂一次（本文件不走 admin.routes 的统一解析）。
    const { requireAdminSignature, attachAdminSignature } =
      await import('../middleware/admin-signature.middleware.js')
    const { getAdminSession } = await import('../middleware/auth.middleware.js')
    attachAdminSignature(req)
    if (
      !requireAdminSignature(
        req,
        res,
        'remove',
        { address, keepVolume: url.searchParams.get('keepVolume') === '1' },
        getAdminSession(req),
      )
    ) {
      return true
    }

    try {
      // 管理端删除：默认连数据卷一起删（不留孤儿卷）；?keepVolume=1 保留数据卷（留档/审计）
      const keepVolume = url.searchParams.get('keepVolume') === '1'
      const result = await userService.destroyContainer(address, true, { keepVolume })
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
