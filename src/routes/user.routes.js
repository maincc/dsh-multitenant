/**
 * 用户路由模块
 */

import { CONFIG, isAdmin } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { tenantConfigService } from '../services/tenant-config.service.js'
import { cwtAdminService } from '../services/cwt-admin.service.js'
import { cwtService } from '../services/cwt.service.js'
import { cwtStore } from '../services/cwt.store.js'
import { userSessionStore } from '../middleware/user-auth.middleware.js'
import { getAdminSession, getRequestAddress } from '../middleware/auth.middleware.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { normalizeAddress } from '../utils/address.js'
import { NotFoundError, ForbiddenError, handleError } from '../utils/errors.js'
import { parseBody, parseJsonBody } from '../utils/parse-body.js'
import { tenantGateway } from '../services/tenant-proxy.service.js'

/**
 * 处理用户路由
 */
export async function handleUserRoutes(req, res, path) {
  // ---- 租户密钥配置（钱包签名验证身份）----

  // POST /api/user/cwt/apply - 提交 CWT 授权申请（token 即凭证，服务端解析+预验签）
  if (path === '/api/user/cwt/apply' && req.method === 'POST') {
    const body = await parseJsonBody(req, res)
    if (!body) return true
    try {
      const result = await cwtAdminService.submitApplication(body.token)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    } catch (err) {
      const status = err.statusCode || (err.code ? 400 : 500)
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL_ERROR' }))
      }
    }
    return true
  }

  // GET /api/user/cwt/status - 我的注册状态 / 申请进度（地址公开可查，无敏感信息）
  if (path === '/api/user/cwt/status' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const address = url.searchParams.get('address')
    if (!validateSwtcAddress(address, res)) return true
    try {
      const status = cwtAdminService.getStatus(address)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, ...status }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/user/session-info - 查询当前 user_session 绑定的地址（无会话 → address: null）
  // 用途：前端初始化时比对"插件当前地址 vs cookie 会话地址"，
  //       不一致则自动吊销旧钥匙（插件切了钱包但旧会话未过期的场景）
  if (path === '/api/user/session-info' && req.method === 'GET') {
    const cookie = req.headers.cookie || ''
    const m = cookie.match(/user_session=([^;]+)/)
    const address = m ? userSessionStore.resolve(decodeURIComponent(m[1])) : null
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, address }))
    return true
  }

  // POST /api/user/logout - 吊销当前 user_session 并清除 cookie
  // 用途：插件切换钱包地址时前端立即调用，让旧地址的网关门禁钥匙即刻作废，
  //       防止"切了钱包但旧 URL 凭旧 cookie 仍能进入"。
  if (path === '/api/user/logout' && req.method === 'POST') {
    const cookie = req.headers.cookie || ''
    const m = cookie.match(/user_session=([^;]+)/)
    if (m) userSessionStore.revoke(decodeURIComponent(m[1]))
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': 'user_session=; path=/; max-age=0; httponly; samesite=strict',
    })
    res.end(JSON.stringify({ ok: true }))
    return true
  }

  // POST /api/cwt/gateway-enter - 凭 CWT 出示入场（网关门禁凭证）
  // CWT 出示 = 验签（token 由该地址私钥在新鲜度窗口内签发）+ registry approved
  // 通过 → 换取 user_session cookie（12h，与钱包签名同一执行链，仅准入协议不同）
  // 防滥用：token 5 分钟新鲜窗口（不可长期分享）；expectedAddress 必须 == token 推导地址
  if (path === '/api/cwt/gateway-enter' && req.method === 'POST') {
    const body = await parseJsonBody(req, res)
    if (!body) return true
    let address = body.address
    if (!validateSwtcAddress(address, res)) return true
    address = normalizeAddress(address)
    const token = String(body.token || '').trim()
    if (!token) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '缺少 CWT token', code: 'BAD_REQUEST' }))
      return true
    }

    // 验签 + 注册表授权判定（CWT 出示的核心：必须是"验签通过"的 token，不能只查 registry）
    const result = await cwtService.verifyForAccess(token, {
      registry: cwtStore.getRegistry(),
      expectedAddress: address,
    })
    if (!result.ok || !result.valid || !result.authorized) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          error: result.error || 'CWT 出示验证失败',
          code: 'FORBIDDEN',
        }),
      )
      return true
    }

    // 确保容器存在（CWT 用户与钱包签名用户走同一条创建/进入链）
    let port
    try {
      port = await userService.ensureContainer(address)
    } catch (err) {
      if (err.code === 'RESOURCE_EXHAUSTED') {
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: '资源不足，请等待',
            code: 'RESOURCE_EXHAUSTED',
            queuePosition: err.queuePosition,
            message: '系统资源不足，您已进入等待队列，资源释放后将自动为您创建容器',
          }),
        )
        return true
      }
      if (err.code === 'USAGE_LIMIT_REACHED') {
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: err.message,
            code: 'USAGE_LIMIT_REACHED',
            message: `今日使用时长已达上限，请明日再试`,
          }),
        )
        return true
      }
      throw err
    }

    // 出示成功 → 换发正式会话（一次性换取：token 不再参与后续请求；CWT 入场短钥匙 30min，
    // 过期后需重新出示 CWT，避免"切钱包后旧 URL 仍可进"）
    const sessionToken = userSessionStore.create(address, 30 * 60 * 1000)
    const PUBLIC_HOST = process.env.PUBLIC_HOST || CONFIG.server.publicHost
    // 进入 URL 附带一次性 ticket：官网进入路径经网关时直接放行（平台已验证过身份），
    // 复制 URL 直访则在 ticket 失效后走签名校验页
    const gwTicket = tenantGateway.issueTicket(address)
    const enterUrl =
      `http://${PUBLIC_HOST}:${port}/` + (gwTicket ? `?gateway_ticket=${gwTicket}` : '')
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `user_session=${sessionToken}; path=/; max-age=43200; httponly; samesite=strict`,
    })
    res.end(JSON.stringify({ ok: true, url: enterUrl, address, port }))
    return true
  }

  // POST /api/user/config-challenge - 获取一次性签名挑战
  if (path === '/api/user/config-challenge' && req.method === 'POST') {
    const body = await parseJsonBody(req, res)
    if (!body) return true
    if (!validateSwtcAddress(body.address, res)) return true
    const nonce = tenantConfigService.issueChallenge(body.address)
    if (!nonce) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '挑战发放过载，请稍后重试', code: 'OVERLOAD' }))
      return true
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, nonce }))
    return true
  }

  // POST /api/user/tenant-config - 签名验证后写入/覆盖 API Key、模型配置与自定义 Provider
  if (path === '/api/user/tenant-config' && req.method === 'POST') {
    const body = await parseJsonBody(req, res)
    if (!body) return true
    if (!validateSwtcAddress(body.address, res)) return true
    try {
      await tenantConfigService.configure(body.address, {
        nonce: body.nonce,
        signature: body.signature,
        publicKey: body.publicKey,
        apiKey: body.apiKey,
        baseURL: body.baseURL,
        models: body.models,
        providers: body.providers,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, configured: true }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // POST /api/user/tenant-config/discover - 签名验证后探测 baseURL 的模型列表
  if (path === '/api/user/tenant-config/discover' && req.method === 'POST') {
    const body = await parseJsonBody(req, res)
    if (!body) return true
    if (!validateSwtcAddress(body.address, res)) return true
    try {
      const models = await tenantConfigService.discoverWithAuth(body.address, {
        nonce: body.nonce,
        signature: body.signature,
        publicKey: body.publicKey,
        baseURL: body.baseURL,
        apiKey: body.apiKey,
        credentialRef: body.credentialRef,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, models }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // DELETE /api/user/tenant-config - 签名验证后清除配置
  //   scope='official-key'：只删官方 key；默认（不传）：清全部（恢复默认）
  if (path === '/api/user/tenant-config' && req.method === 'DELETE') {
    const body = await parseJsonBody(req, res)
    if (!body) return true
    if (!validateSwtcAddress(body.address, res)) return true
    try {
      await tenantConfigService.clear(body.address, {
        nonce: body.nonce,
        signature: body.signature,
        publicKey: body.publicKey,
        scope: body.scope,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, configured: false }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/user/tenant-config - 查询配置状态（永不回显 key）
  if (path === '/api/user/tenant-config' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const address = url.searchParams.get('address')
    if (!validateSwtcAddress(address, res)) return true
    try {
      const status = await tenantConfigService.getStatus(address)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: true,
          address: normalizeAddress(address),
          configured: status.apiKeyConfigured,
          apiKeyConfigured: status.apiKeyConfigured,
          baseURL: status.baseURL,
          models: status.models,
          providers: status.providers ?? [],
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/user/:address - 获取单个用户详情
  // 排除 /restart /reset /remove 路径（由 tenant.routes 处理）
  if (
    path.startsWith('/api/user/') &&
    !path.endsWith('/restart') &&
    !path.endsWith('/reset') &&
    !path.endsWith('/remove') &&
    !path.endsWith('/stop')
  ) {
    let address = path.slice('/api/user/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    // 权限验证（P1-3）：本人（user_session / admin_session）或管理员可看全量；
    // 无会话 → 只回"脱敏存在性"（不含 port/tier/用量，地址保密不破，首屏可正常加载）；
    // 已登录但非本人 → 403
    const session = getRequestAddress(req)
    const isAdm = session && isAdmin(session)
    if (session && session !== address && !isAdm) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '无权查看其他用户信息', code: 'FORBIDDEN' }))
      return true
    }
    // 无会话：脱敏壳（前端首屏"未签名"也能渲染，签名后自动补全）
    if (!session) {
      const user = userService.state.swtcUsers?.[address]
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          address,
          exists: Boolean(user),
          status: user?.containerStatus ?? null,
        }),
      )
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
