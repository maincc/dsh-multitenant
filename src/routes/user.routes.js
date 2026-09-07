/**
 * 用户路由模块
 */

import { CONFIG, isAdmin } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { tenantConfigService } from '../services/tenant-config.service.js'
import { cwtAdminService } from '../services/cwt-admin.service.js'
import { getAdminSession } from '../middleware/auth.middleware.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { normalizeAddress } from '../utils/address.js'
import { NotFoundError, ForbiddenError, handleError } from '../utils/errors.js'
import { parseBody, parseJsonBody } from '../utils/parse-body.js'

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
