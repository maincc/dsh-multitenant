/**
 * 管理域路由 · 会话与登录（refactor-giant-files P1 首批迁入，源 admin.routes.js 判例区）
 *
 * 四条都是 /api/admin 的"身份前门"：challenge（登录挑战+操作挑战双形态）、
 * login（验签+消费挑战+isAdmSync 三闸）、logout（吊销合流后的唯一 user_session）、
 * check（匿名可达的管理员预检，2026-10 审计 #5 点名限流）。
 *
 * 搬运纪律：handler 主体逐字来自原 if 链；唯二结构改动——
 *   ① check 的首句 rateLimit 改为注册表 rateLimit 字段（dispatch 先限流后进 handler，
 *      顺序与原一致）；
 *   ② 分支尾的 return true 自然消失（dispatch 命中即收敛为已处理）。
 */

import {
  tenantConfigService,
  SIGN_PURPOSE,
  buildSignedMessage,
} from '../../services/tenant-config.service.js'
import { credentialService } from '../../services/credential.service.js'
import { userSessionStore } from '../../middleware/user-auth.middleware.js'
import { dataService } from '../../services/data.service.js'
import { getAdminSession } from '../../middleware/auth.middleware.js'
import { issueAdminSignatureChallenge } from '../../middleware/admin-signature.middleware.js'
import { validateSwtcAddress } from '../../middleware/validate.middleware.js'
import { secureFlag } from '../../utils/cookie-flags.js'
import { normalizeAddress } from '../../utils/address.js'
import { handleError } from '../../utils/errors.js'
import { parseBody } from '../../utils/parse-body.js'
import { defineRoute } from '../registry.js'

export const SESSION_ROUTES = [
  // POST /api/admin/challenge - 领取一次性签名挑战（security-hardening-plan P0-1）
  //   不带 operation  → 登录挑战（对裸 nonce 签名，旧行为）
  //   带 operation    → 破坏性操作挑战：服务端推导 binding，钱包签 `${nonce}|${binding}`
  defineRoute({
    method: 'POST',
    path: '/api/admin/challenge',
    guard: 'public',
    note: '免鉴权是设计使然（登录前必须能领登录挑战）；操作挑战分支在 handler 内自验会话+本人同一性',
    handler: async (req, res) => {
      try {
        const body = await parseBody(req)
        const { address, operation, payload } = JSON.parse(body || '{}')
        if (!validateSwtcAddress(address, res)) return true

        // 带 operation：只有**已登录管理员**能为本人的破坏性操作领挑战
        if (operation) {
          const session = getAdminSession(req)
          if (!session) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: '需要管理员权限', code: 'FORBIDDEN' }))
            return true
          }
          if (normalizeAddress(session) !== normalizeAddress(address)) {
            // 挑战要绑在会话身份上，否则可以骗管理员为别的地址签一次。
            // 文案必须把"本人"讲清楚：绑的是【登录会话 ↔ 签名钱包】同一性，
            // 不是"只能操作自己的数据"——目标地址在 payload 里，本就可以是别人。
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(
              JSON.stringify({
                error:
                  '签名钱包与登录会话不是同一账户（防会话劫持，与操作对象是谁无关）。' +
                  '请在 CCDAO 插件切回登录时的账户，或退出后重新签名登录再试。',
                code: 'FORBIDDEN',
              }),
            )
            return true
          }
          const issued = issueAdminSignatureChallenge(address, operation, payload)
          if (!issued) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(
              JSON.stringify({
                error: `不支持的签名操作或缺少目标：${operation}`,
                code: 'SIGNATURE_NOT_APPLICABLE',
              }),
            )
            return true
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          // message 是钱包里要签的原文（含操作语义，管理员可在弹窗里核对）
          res.end(JSON.stringify({ ok: true, ...issued }))
          return true
        }

        // 登录挑战：nonce 按 LOGIN 用途分池，且下发 message（用途绑定后的被签内容）
        const challenge = tenantConfigService.issueChallenge(
          normalizeAddress(address),
          SIGN_PURPOSE.LOGIN,
        )
        if (!challenge) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '挑战发放过载，请稍后重试', code: 'OVERLOAD' }))
          return true
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, nonce: challenge.nonce, message: challenge.message }))
      } catch (err) {
        if (!res.headersSent) handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/admin/login - 管理员钱包签名登录（P0-1：nonce 挑战 + 验签 + 地址归属）
  defineRoute({
    method: 'POST',
    path: '/api/admin/login',
    guard: 'public',
    note: '登录入口自身免会话——判权三闸（验签/一次性/isAdmSync）在 handler 内，一闸不过都 403',
    handler: async (req, res) => {
      try {
        const body = await parseBody(req)
        const { address, nonce, signature, publicKey } = JSON.parse(body || '{}')

        if (!validateSwtcAddress(address, res)) return true

        const addrLower = normalizeAddress(address)

        // ① 验签：**用途绑定消息**的签名有效且公钥推导地址 === 声称地址。
        //    签的是服务端构造的 `dsh-multitenant|login|<地址>|<nonce>`（hex），
        //    因此为其它用途（connect / gateway-verify / skills …）取得的签名
        //    在这里一律验不过 —— 这是本次安全加固要堵的那条链。
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
        // ② 挑战一次性（不可重放）+ 必须是为 LOGIN 用途发放的
        if (!tenantConfigService.consumeChallenge(addrLower, nonce, SIGN_PURPOSE.LOGIN)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '挑战已失效，请重新获取', code: 'FORBIDDEN' }))
          return true
        }
        // ③ 必须是管理员地址（v1.5：凭证结论快照，名册兜底见 isAdmSync）
        if (!credentialService.isAdmSync(addrLower)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '不是管理员地址', code: 'FORBIDDEN' }))
          return true
        }

        // ④ 签发服务端随机会话（判例 2026-10-30：admin_session 已废止——管理票
        // 与租户票合流为唯一 user_session；isAdmSync 的登录闸留在 ③，非管理员签不进）
        const token = userSessionStore.create(addrLower)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': `user_session=${token}; path=/; httponly; samesite=strict${secureFlag(req)}`,
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
    },
  }),

  // POST /api/admin/logout - 吊销当前会话（单源 user_session；旧 admin_session
  // cookie 一并下发清除指令，做浏览器卫生）
  defineRoute({
    method: 'POST',
    path: '/api/admin/logout',
    guard: 'public',
    note: '无会话也回 200+清 cookie（浏览器卫生语义，不是鉴权面）',
    handler: async (req, res) => {
      const cookie = req.headers.cookie || ''
      const match = cookie.match(/user_session=([^;]+)/)
      const who = getAdminSession(req) // 先取操作人：吊销之后就查不到了
      if (match) {
        try {
          await userSessionStore.revoke(decodeURIComponent(match[1]))
          // 会话吊销也是"改变世界的动作"——进录像
          dataService.logOperation('admin_logout', { address: who })
        } catch {
          // 忽略损坏的 token
        }
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `user_session=; path=/; max-age=0; httponly; samesite=strict${secureFlag(req)}, admin_session=; path=/; max-age=0; httponly; samesite=strict${secureFlag(req)}`,
      })
      res.end(JSON.stringify({ ok: true }))
      return true
    },
  }),

  // GET /api/admin/check - 检查管理员权限
  defineRoute({
    method: null, // 原分支不查 method，行为对齐
    path: '/api/admin/check',
    guard: 'public',
    // 匿名可达有正当成因（登录前预检"当前钱包是不是管理员"），但必须限流——
    // 2026-10 审计点名它是无界的管理员名单枚举面（2026-10 审计 #5）
    rateLimit: { max: 20, keyPrefix: 'admincheck' },
    handler: async (req, res, path, url) => {
      const session = getAdminSession(req)
      const queryAddress = url.searchParams.get('address')

      // 如果传入了 address 参数，检查该地址是否是管理员
      if (queryAddress) {
        const addrLower = normalizeAddress(queryAddress)
        const isAdm = credentialService.isAdmSync(addrLower)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ isAdmin: isAdm, address: addrLower, checkedAddress: addrLower }))
        return true
      }

      // 否则检查 cookie 中的 session
      const isAdm = session && credentialService.isAdmSync(session)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ isAdmin: isAdm, address: session || null }))
      return true
    },
  }),
]
