/**
 * 用户域路由 · v1.4 凭证体系（DID 普通凭证 / CWT 解限凭证，互斥单记录）
 * （refactor-giant-files P1 迁入，源 user.routes.js）
 *
 * ⚠️ 事故复盘一（2026-10 审计）：曾误用 admin_session 专用会话，导致真实普通用户
 * （只有 user_session）六个凭证端点整体 401，而管理员浏览器双会话自测全通过，
 * service 层测试零 HTTP 用例把断链掩盖成绿灯。
 * ⚠️ 事故复盘二（2026-10-23 "会话主人不一致"循环根因）：当时改用 getRequestAddress
 * （admin 优先）矫枉过正——管理员浏览器遗留的 admin_session 会**抢占**凭证身份。
 * 终局（判例 2026-10-30）：admin_session 整体废止，身份 = user_session 唯一。
 *
 * P1 收敛注记（2026-11）：原六端点逐字重复的 401 块（判例 58 型孪生）已由
 * registry 的 guard:'user' 单源发出——载荷逐字不变（前端据此走登录引导）。
 */

import { credentialService } from '../../services/credential.service.js'
import { dataService } from '../../services/data.service.js'
import { getRequestAddress } from '../../middleware/auth.middleware.js'
import { validateSwtcAddress } from '../../middleware/validate.middleware.js'
import { handleError } from '../../utils/errors.js'
import { parseJsonBody } from '../../utils/parse-body.js'
import { defineRoute } from '../registry.js'

export const USER_CREDENTIAL_ROUTES = [
  // GET /api/user/credential-status - 进入用户中心的判定钩子：
  // 有凭证→原样；无→自动分配（legacy CWT 名单命中=直接发 CWT 解限凭证，否则 DID 普通待领取）。
  // popup=true → 前端弹窗提醒领取；profileHit=false → 领取会撞"无 DID"指引（顺带回给前端做提示条）
  defineRoute({
    method: 'GET',
    path: '/api/user/credential-status',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      try {
        // canonical=插件原始大小写地址（前端凭证区随询带上）：档案优先发现的拼法线索，
        // 服务端校验小写归一确为本会话地址后才用（credential.service.enter 内），
        // 台账丢行时也能直达用户档案——不传/乱传只降级为拼法候选缺失，无害
        const st = await credentialService.enter(addr, {
          canonical: new URL(req.url, `http://${req.headers.host || 'local'}`).searchParams.get(
            'canonical',
          ),
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, address: addr, ...st }))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // GET /api/user/credential-vc - 凭证本体（从用户档案读回平台签发的那张卡，JSON 可复制）
  defineRoute({
    method: 'GET',
    path: '/api/user/credential-vc',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      try {
        const r = await credentialService.getClaimedCredential(addr)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, credential: r.credential, consistent: r.consistent }))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/user/credential-scaffold - 领取第一步：平台签 VC 组装目标档案文档
  // body {canonicalAddress}：插件 requestAccounts 的原始大小写地址（DID 文件名承载它）
  defineRoute({
    method: 'POST',
    path: '/api/user/credential-scaffold',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      const body = await parseJsonBody(req, res)
      if (!body) return true
      if (!validateSwtcAddress(body.canonicalAddress, res)) return true
      try {
        const scf = await credentialService.buildClaimDocument(addr, body.canonicalAddress)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, ...scf }))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/user/credential-upload - 领取第二步：用户插件文件签 → 验签 → relay 写 → 台账 claimed
  // body {document, fileName, publicKey, signature}（signature=插件对 document 字节的文件签 DER hex）
  defineRoute({
    method: 'POST',
    path: '/api/user/credential-upload',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      const body = await parseJsonBody(req, res)
      if (!body) return true
      try {
        const out = await credentialService.claimUpload(addr, body)
        dataService.logOperation('credential_claim', {
          address: addr,
          kind: body.document?.credentials?.slice(-1)[0]?.type?.[1] || '',
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/user/cwt-apply - 申请解除限制（必须已领取 DID 普通凭证）
  defineRoute({
    method: 'POST',
    path: '/api/user/cwt-apply',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      const body = await parseJsonBody(req, res)
      if (!body) return true
      try {
        const out = await credentialService.applyCwt(addr, body)
        dataService.logOperation('cwt_apply', { address: addr, id: out.id })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // GET /api/user/cwt-application - 本人最近一次 CWT 申请状态（账户详情展示）
  defineRoute({
    method: 'GET',
    path: '/api/user/cwt-application',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      try {
        const app = await credentialService.myApplication(addr)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, application: app }))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),
]
