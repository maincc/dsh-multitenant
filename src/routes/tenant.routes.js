/**
 * 租户路由模块
 */

import { CONFIG } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { credentialService } from '../services/credential.service.js'
import { dataService } from '../services/data.service.js'
import { resourceExhaustedPayload } from '../utils/resource-exhausted.js'
import {
  tenantConfigService,
  SIGN_PURPOSE,
  buildSignedMessage,
} from '../services/tenant-config.service.js'
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
        const challenge = tenantConfigService.issueChallenge(address, SIGN_PURPOSE.CONNECT)
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
            nonce: challenge.nonce,
            // message 是交给钱包签的用途绑定内容（hex）；要签的是它，不是 nonce
            message: challenge.message,
            address,
          }),
        )
        return true
      }
      // 验签（公钥推导地址 === 声称地址）：签的是 CONNECT 用途绑定消息
      if (
        !tenantConfigService.verifySignature(
          address,
          buildSignedMessage(SIGN_PURPOSE.CONNECT, address, nonce),
          signature,
          publicKey,
        )
      ) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '签名验证失败', code: 'FORBIDDEN' }))
        return true
      }
      // 挑战一次性（防重放）+ 必须是为 CONNECT 用途发放的
      if (!tenantConfigService.consumeChallenge(address, nonce, SIGN_PURPOSE.CONNECT)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '挑战已失效，请重新获取', code: 'FORBIDDEN' }))
        return true
      }

      // ═══ 登录通道（v1.5）：只换 user_session cookie，**不建容器、不过准入闸** ═══
      // 准入闸（gateConnect）咬的是"进容器"这条路（ensureContainer/网关导航）；
      // 登录只证"是谁"（钱包签名）。若登录也过闸，凭证过期者会被挡在用户中心
      // 门外——而续发（enter→_renewIfExpired）恰在门内，闭环成死锁，违背"绝不上锁"。
      if (url.searchParams.get('action') === 'login') {
        const loginToken = userSessionStore.create(address, 2 * 60 * 60 * 1000)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': `user_session=${loginToken}; path=/; max-age=43200; httponly; samesite=strict`,
        })
        res.end(JSON.stringify({ ok: true, loggedIn: true, address }))
        return true
      }

      // v1.5 刀5B 凭证即准入：签名证"是谁"，台账证"有没有资格"。
      // 自动配发兜底=正常用户永不触发；咬的只是过期/伪造/异常态（license 模式另含 did）。
      const gate = await credentialService.gateConnect(address)
      if (!gate.allowed) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error:
              gate.code === 'CREDENTIAL_EXPIRED'
                ? '凭证已过期，请到用户中心登录后重新连接'
                : '凭证缺失或已失效，请到用户中心连接领取',
            code: 'NO_VALID_CREDENTIAL',
          }),
        )
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
      // 资源不足，进入等待队列（组装与 gateway-enter 单源共用）
      if (err.code === 'RESOURCE_EXHAUSTED') {
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(resourceExhaustedPayload(err)))
      } else if (err.code === 'USAGE_LIMIT_REACHED') {
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: err.message,
            code: 'USAGE_LIMIT_REACHED',
            usedMinutes: err.usedMinutes,
            dailyLimit: err.dailyLimit,
            message: `今日使用时长已达上限（${err.dailyLimit} 分钟），请明日再试`,
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
    const isViewer = viewer === address || (viewer && credentialService.isAdmSync(viewer))
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
    const used = userService.getUsedMinutes(address)
    // 权益判定与凭证体系解耦（2026-10 大拆除）：全员统一按 usageLimit 默认档
    const limit = usageCfg.enabled ? usageCfg.dailyMinutes : null
    // v1.4：持 CWT 解除凭证 = 不限时（与 usage 闸门口径一致的同步快照判据）
    const unlimited =
      limit === null ||
      !Number.isFinite(limit) ||
      limit <= 0 ||
      credentialService.isExemptSync(address)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        exists: true,
        address,
        port: user.port,
        status: user.containerStatus ?? 'running',
        tier: 1,
        idleMs: idle,
        idleHuman:
          idle < 60000
            ? `${Math.floor(idle / 1000)}s`
            : idle < 3600000
              ? `${Math.floor(idle / 60000)}min`
              : `${(idle / 3600000).toFixed(1)}h`,
        usage: {
          enabled: Boolean(usageCfg.enabled),
          dailyMinutes: unlimited ? null : limit,
          usedMinutes: used,
          remainingMinutes: !unlimited ? Math.max(0, limit - used) : null,
        },
      }),
    )
    return true
  }

  // GET /leave/<address>：显式销毁指定 SWTC 用户的容器
  // （security-hardening-plan P0-2：本人或管理员；前端当前无调用方，不影响 UX）
  if (path.startsWith('/leave/')) {
    const { getRequestAddress, getAdminSession } = await import('../middleware/auth.middleware.js')
    const session = getRequestAddress(req)
    const isAdminUser = session && credentialService.isAdmSync(session)

    let address = decodeURIComponent(path.slice('/leave/'.length))
    if (!validateSwtcAddress(address, res)) return true

    address = normalizeAddress(address)

    // 权限检查：只能销毁自己的容器，或者是管理员
    if (session !== address && !isAdminUser) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '没有权限销毁此容器', code: 'FORBIDDEN' }))
      return true
    }

    // 2026-10 审计修复：GET 即销毁 + 免签 + 无留痕 三合一曾是同站 CSRF 的头号
    // 入口（恶意租户页可对管理员浏览器发一次 GET 就毁掉任意他人容器）。
    // 本人销毁自己的容器维持免签（自己的数据自己的会话，历史契约）；
    // **管理员代他人销毁必须当场钱包签名**（与 remove/force-stop 对称，
    // 钱包弹窗无法被页面 JS 伪造，同站驱动就此失效）。全部路径进审计。
    if (session !== address) {
      const { requireAdminSignature, attachAdminSignature } =
        await import('../middleware/admin-signature.middleware.js')
      attachAdminSignature(req)
      if (!requireAdminSignature(req, res, 'leave', { address }, getAdminSession(req))) {
        return true
      }
    }

    try {
      const result = await userService.destroyContainer(address)
      dataService.logOperation(session === address ? 'user_leave' : 'admin_leave_user', {
        address,
        operator: session,
      })
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
    const isAdminUser = session && credentialService.isAdmSync(session)

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

    // 2026-10 审计：管理员**代他人**重启要当场签名（与 force-stop 对称——
    // 同源能力不能一个要签一个免签；同站 CSRF 场景重启=断他人会话）。
    // 本人重启自己的容器维持免签（插件装完重启是日常流，弹窗不可接受）。留痕补齐。
    if (session !== address) {
      const { requireAdminSignature, attachAdminSignature } =
        await import('../middleware/admin-signature.middleware.js')
      const { getAdminSession } = await import('../middleware/auth.middleware.js')
      attachAdminSignature(req)
      if (!requireAdminSignature(req, res, 'restart', { address }, getAdminSession(req))) {
        return true
      }
    }

    try {
      const result = await userService.restartContainer(address)
      dataService.logOperation(session === address ? 'user_restart' : 'admin_restart_user', {
        address,
        operator: session,
      })
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
    const isAdminUser = session && credentialService.isAdmSync(session)

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

    // 2026-10 审计：同 restart——管理员代他人停止（在用租户被断）需当场签名；本人免签。
    if (session !== address) {
      const { requireAdminSignature, attachAdminSignature } =
        await import('../middleware/admin-signature.middleware.js')
      const { getAdminSession } = await import('../middleware/auth.middleware.js')
      attachAdminSignature(req)
      if (!requireAdminSignature(req, res, 'stop', { address }, getAdminSession(req))) {
        return true
      }
    }

    try {
      const result = await userService.stopContainerForUser(address)
      dataService.logOperation(session === address ? 'user_stop' : 'admin_stop_user', {
        address,
        operator: session,
      })
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
    // 必须用 getRequestAddress（管理员会话优先，其次普通用户会话）。
    // 曾经误用 getSessionAddress —— 那个只读**管理员会话**，于是普通用户
    // （只有 user_session）的 session 恒为 null，重置自己的容器永远 403
    // 「没有权限重置此容器」。本文件其它"本人或管理员"判定都用的
    // getRequestAddress，只有这里漏改。
    const { getRequestAddress } = await import('../middleware/auth.middleware.js')
    const session = getRequestAddress(req)
    const isAdminUser = session && credentialService.isAdmSync(session)

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

    // reset 会**删除数据卷**（user.service.resetContainer 第 2 步），破坏性等同
    // delete-volume → 管理员代他人重置时，除会话外还要求当场钱包签名，绑目标地址。
    // 本人重置自己免签：普通用户没有"操作挑战"通道，且前端已强制双重确认。
    if (session !== address) {
      const { requireAdminSignature, attachAdminSignature } =
        await import('../middleware/admin-signature.middleware.js')
      const { getAdminSession } = await import('../middleware/auth.middleware.js')
      attachAdminSignature(req)
      if (!requireAdminSignature(req, res, 'reset', { address }, getAdminSession(req))) {
        return true
      }
    }

    try {
      const result = await userService.resetContainer(address)
      // 抹卷重建=用户侧最毁灭性操作，必留痕（本人重置 vs 管理员代重置分清）
      dataService.logOperation('user_reset', {
        address,
        operator: session,
        byAdmin: session !== address,
      })
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
      // 删租户（默认连卷）不可逆，必留痕
      dataService.logOperation('admin_remove_user', {
        address,
        operator: getAdminSession(req),
        keepVolume,
      })
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
