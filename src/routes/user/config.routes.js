/**
 * 用户域路由 · 租户密钥配置（钱包签名验证身份）
 * （refactor-giant-files P1 迁入，源 user.routes.js）
 *
 * 写面四端点（challenge/POST/discover/DELETE）的判权=请求体内 per-request 钱包签名
 * （挑战-响应，tenant-config 用途池），guard:'public' 只表示"传输层免会话"——
 * 身份在 tenantConfigService.configure/clear/discoverWithAuth 内部验签，一闸不过全 4xx。
 * GET 面是会话面（本人或管理员，2026-10 审计后收紧），归属判定留 handler 原位。
 */

import { tenantConfigService, SIGN_PURPOSE } from '../../services/tenant-config.service.js'
import { credentialService } from '../../services/credential.service.js'
import { getRequestAddress } from '../../middleware/auth.middleware.js'
import { rateLimit } from '../../middleware/rate-limit.middleware.js'
import { validateSwtcAddress } from '../../middleware/validate.middleware.js'
import { normalizeAddress } from '../../utils/address.js'
import { ForbiddenError, handleError } from '../../utils/errors.js'
import { parseJsonBody } from '../../utils/parse-body.js'
import { defineRoute } from '../registry.js'

export const USER_CONFIG_ROUTES = [
  // POST /api/user/config-challenge - 获取一次性签名挑战
  defineRoute({
    method: 'POST',
    path: '/api/user/config-challenge',
    guard: 'public',
    note: '免会话=登录无关的钱包签名门（TENANT_CONFIG 用途挑战发放）',
    handler: async (req, res) => {
      const body = await parseJsonBody(req, res)
      if (!body) return true
      if (!validateSwtcAddress(body.address, res)) return true
      const challenge = tenantConfigService.issueChallenge(body.address, SIGN_PURPOSE.TENANT_CONFIG)
      if (!challenge) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '挑战发放过载，请稍后重试', code: 'OVERLOAD' }))
        return true
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      // message 是交给钱包签的用途绑定内容（hex）；要签的是它，不是 nonce
      res.end(JSON.stringify({ ok: true, nonce: challenge.nonce, message: challenge.message }))
      return true
    },
  }),

  // POST /api/user/tenant-config - 签名验证后写入/覆盖 API Key、模型配置与自定义 Provider
  defineRoute({
    method: 'POST',
    path: '/api/user/tenant-config',
    guard: 'public',
    handler: async (req, res) => {
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
    },
  }),

  // POST /api/user/tenant-config/discover - 签名验证后探测 baseURL 的模型列表
  defineRoute({
    method: 'POST',
    path: '/api/user/tenant-config/discover',
    guard: 'public',
    handler: async (req, res) => {
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
    },
  }),

  // DELETE /api/user/tenant-config - 签名验证后清除配置
  //   scope='official-key'：只删官方 key；默认（不传）：清全部（恢复默认）
  defineRoute({
    method: 'DELETE',
    path: '/api/user/tenant-config',
    guard: 'public',
    handler: async (req, res) => {
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
    },
  }),

  // GET /api/user/tenant-config - 查询配置状态（永不回显 key）
  defineRoute({
    method: 'GET',
    path: '/api/user/tenant-config',
    guard: 'public',
    note: '归属闸在 handler 原位：本人（会话===目标）或管理员可读+IP 限流（2026-10 审计——此前匿名+任意地址可枚举任意租户 baseURL/模型拓扑）',
    handler: async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`)
      const address = url.searchParams.get('address')
      if (!validateSwtcAddress(address, res)) return true
      const session = getRequestAddress(req)
      if (!rateLimit(req, res, { max: 30, keyPrefix: 'tcfg' })) return true
      const addrLower = normalizeAddress(address)
      if (session !== addrLower && !(session && credentialService.isAdmSync(session))) {
        handleError(new ForbiddenError('只能查看自己的租户配置', 'FORBIDDEN'), res)
        return true
      }
      try {
        const status = await tenantConfigService.getStatus(addrLower)
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
    },
  }),
]
