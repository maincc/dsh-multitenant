/**
 * 用户域路由 · 钱包会话登录（refactor-giant-files P1 迁入，源 user.routes.js）
 *
 * 2026-10 补门成因（原注释照录）：user_session 此前只在 /connect 签发，普通用户
 * 不点进容器就永远没有会话——数字身份 tab 全走非本人隐私分支。此组端点给用户中心
 * 一扇正门：与 admin 登录同构（LOGIN 用途挑战→验签→一次性→发会话 cookie），
 * 只证明钱包地址归属，不创建/触碰容器。
 * 限流保留在 handler 原位（顺序=原样：先限流后解析）。
 */

import { userService } from '../../services/user.service.js'
import {
  tenantConfigService,
  SIGN_PURPOSE,
  buildSignedMessage,
} from '../../services/tenant-config.service.js'
import { userSessionStore } from '../../middleware/user-auth.middleware.js'
import { getRequestAddress } from '../../middleware/auth.middleware.js'
import { rateLimit } from '../../middleware/rate-limit.middleware.js'
import { validateSwtcAddress } from '../../middleware/validate.middleware.js'
import { secureFlag } from '../../utils/cookie-flags.js'
import { normalizeAddress } from '../../utils/address.js'
import { dataService } from '../../services/data.service.js'
import { parseBody } from '../../utils/parse-body.js'
import { defineRoute } from '../registry.js'

export const USER_AUTH_ROUTES = [
  // POST /api/user/wallet-login-challenge - 领登录挑战（免会话：登录前必须可达）
  defineRoute({
    method: 'POST',
    path: '/api/user/wallet-login-challenge',
    guard: 'public',
    note: '免会话是登录前门；身份判权在 wallet-login 的验签三闸',
    handler: async (req, res) => {
      if (!rateLimit(req, res, { max: 20, keyPrefix: 'wallet-login' })) return true
      const body = await parseBody(req)
      let address
      try {
        address = JSON.parse(body || '{}').address
      } catch {
        address = null
      }
      if (!validateSwtcAddress(address, res)) return true
      const addrLower = normalizeAddress(address)
      if (!userService.state.swtcUsers?.[addrLower]) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({ error: '账号不存在（先用钱包连接进入一次平台）', code: 'NO_ACCOUNT' }),
        )
        return true
      }
      const challenge = tenantConfigService.issueChallenge(addrLower, SIGN_PURPOSE.LOGIN)
      if (!challenge) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '挑战发放过载，请稍后重试', code: 'OVERLOAD' }))
        return true
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, nonce: challenge.nonce, message: challenge.message }))
      return true
    },
  }),

  // POST /api/user/wallet-login - 完成登录：{address, nonce, signature, publicKey}
  defineRoute({
    method: 'POST',
    path: '/api/user/wallet-login',
    guard: 'public',
    handler: async (req, res) => {
      if (!rateLimit(req, res, { max: 20, keyPrefix: 'wallet-login' })) return true
      const body = await parseBody(req)
      const { address, nonce, signature, publicKey } = JSON.parse(body || '{}')
      if (!validateSwtcAddress(address, res)) return true
      const addrLower = normalizeAddress(address)
      if (
        !tenantConfigService.verifySignature(
          addrLower,
          buildSignedMessage(SIGN_PURPOSE.LOGIN, addrLower, nonce),
          signature,
          publicKey,
        )
      ) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '签名验证失败', code: 'FORBIDDEN' }))
        return true
      }
      if (!tenantConfigService.consumeChallenge(addrLower, nonce, SIGN_PURPOSE.LOGIN)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '挑战已失效，请重新获取', code: 'FORBIDDEN' }))
        return true
      }
      if (!userService.state.swtcUsers?.[addrLower]) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '账号不存在', code: 'NO_ACCOUNT' }))
        return true
      }
      const sessionToken = userSessionStore.create(addrLower)
      // 票据签发 2026-11-10：user_session 全平台改发会话 cookie（无 max-age，活到浏览器
      // 关闭）。此前固定 max-age=43200（12h）与服务端滑动续期错位：浏览器照丢、服务端
      // 表还活着 → 挂机超 12h 的请求集体 401，手机端无声跌回登录引导（用户报障根因）。
      // 会话生死只由服务端 12h 滑动过期说了算；退出清理走 max-age=0 不受影响。
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `user_session=${sessionToken}; path=/; httponly; samesite=strict${secureFlag(req)}`,
      })
      res.end(JSON.stringify({ ok: true, address: addrLower }))
      return true
    },
  }),

  // GET /api/user/session-info - 查询当前 user_session 绑定的地址（无会话 → address: null）
  // 用途：前端初始化时比对"插件当前地址 vs cookie 会话地址"，
  //       不一致则自动吊销旧钥匙（插件切了钱包但旧会话未过期的场景）
  defineRoute({
    method: 'GET',
    path: '/api/user/session-info',
    guard: 'public',
    note: '无会话也正常应答（address:null 是前端对表用的正路，不是错误面）',
    handler: async (req, res) => {
      const cookie = req.headers.cookie || ''
      const m = cookie.match(/user_session=([^;]+)/)
      const address = m ? userSessionStore.resolve(decodeURIComponent(m[1])) : null
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, address }))
      return true
    },
  }),

  // POST /api/user/logout - 吊销当前 user_session 并清除 cookie
  // 用途：插件切换钱包地址时前端立即调用，让旧地址的网关门禁钥匙即刻作废，
  //       防止"切了钱包但旧 URL 凭旧 cookie 仍能进入"。
  defineRoute({
    method: 'POST',
    path: '/api/user/logout',
    guard: 'public',
    note: '无会话也回 200+清 cookie（浏览器卫生语义，与 admin logout 同款）',
    handler: async (req, res) => {
      const cookie = req.headers.cookie || ''
      const m = cookie.match(/user_session=([^;]+)/)
      const who = getRequestAddress(req) // 先取操作人：吊销之后就查不到了
      if (m) {
        await userSessionStore.revoke(decodeURIComponent(m[1]))
        // 会话吊销留痕（换钱包场景高频、单行成本可忽略）
        dataService.logOperation('user_logout', { address: who })
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `user_session=; path=/; max-age=0; httponly; samesite=strict${secureFlag(req)}`,
      })
      res.end(JSON.stringify({ ok: true }))
      return true
    },
  }),
]
