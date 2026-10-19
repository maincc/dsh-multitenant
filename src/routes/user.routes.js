/**
 * 用户路由模块
 */

import { CONFIG, isAdmin } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { dataService } from '../services/data.service.js'
import { resourceExhaustedPayload } from '../utils/resource-exhausted.js'
import {
  tenantConfigService,
  SIGN_PURPOSE,
  buildSignedMessage,
} from '../services/tenant-config.service.js'
import { userSessionStore } from '../middleware/user-auth.middleware.js'
import { normalizeAddress } from '../utils/address.js'
import { rateLimit } from '../middleware/rate-limit.middleware.js'
import {
  getAdminSession,
  getRequestAddress,
  getSessionAddress,
} from '../middleware/auth.middleware.js'
import { credentialService } from '../services/credential.service.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { NotFoundError, ForbiddenError, handleError } from '../utils/errors.js'
import { parseBody, parseJsonBody } from '../utils/parse-body.js'
import { tenantGateway } from '../services/tenant-proxy.service.js'

/**
 * 处理用户路由
 */
export async function handleUserRoutes(req, res, path) {
  // ---- 租户密钥配置（钱包签名验证身份）----

  // ── 用户中心钱包签名登录（2026-10 补门）：user_session 此前只在"进入工作区
  // 网关"(/connect)时签发，普通用户不点进容器就永远没有会话——数字身份 tab 的
  // connect-status 全走非本人隐私分支（"暂无凭证"假象）。此端点给用户中心一扇
  // 正门：与 admin 登录同构（LOGIN 用途挑战→验签→一次性→发会话 cookie），
  // 只证明钱包地址归属，不创建/触碰容器。
  if (path === '/api/user/wallet-login-challenge' && req.method === 'POST') {
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
  }

  // POST /api/user/wallet-login - 完成登录：{address, nonce, signature, publicKey}
  if (path === '/api/user/wallet-login' && req.method === 'POST') {
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
    const sessionToken = userSessionStore.create(addrLower, 2 * 60 * 60 * 1000)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `user_session=${sessionToken}; path=/; max-age=43200; httponly; samesite=strict`,
    })
    res.end(JSON.stringify({ ok: true, address: addrLower }))
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
    const who = getRequestAddress(req) // 先取操作人：吊销之后就查不到了
    if (m) {
      await userSessionStore.revoke(decodeURIComponent(m[1]))
      // 会话吊销留痕（换钱包场景高频、单行成本可忽略）
      dataService.logOperation('user_logout', { address: who })
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': 'user_session=; path=/; max-age=0; httponly; samesite=strict',
    })
    res.end(JSON.stringify({ ok: true }))
    return true
  }

  // ════════════ v1.4 凭证体系（DID 普通凭证 / CWT 解限凭证，互斥单记录）════════════
  // 会话地址即用户身份（钱包签名登录建立的 user_session），全部端点要求登录态。

  const credSession = () => getSessionAddress(req)

  // GET /api/user/credential-status - 进入用户中心的判定钩子：
  // 有凭证→原样；无→自动分配（legacy CWT 名单命中=直接发 CWT 解限凭证，否则 DID 普通待领取）。
  // popup=true → 前端弹窗提醒领取；profileHit=false → 领取会撞"无 DID"指引（顺带回给前端做提示条）
  if (path === '/api/user/credential-status' && req.method === 'GET') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    try {
      const st = await credentialService.enter(addr)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, address: addr, ...st }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/user/credential-vc - 凭证本体（从用户档案读回平台签发的那张卡，JSON 可复制）
  if (path === '/api/user/credential-vc' && req.method === 'GET') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    try {
      const r = await credentialService.getClaimedCredential(addr)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, credential: r.credential, consistent: r.consistent }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // POST /api/user/credential-scaffold - 领取第一步：平台签 VC 组装目标档案文档
  // body {canonicalAddress}：插件 requestAccounts 的原始大小写地址（DID 文件名承载它）
  if (path === '/api/user/credential-scaffold' && req.method === 'POST') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
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
  }

  // POST /api/user/credential-upload - 领取第二步：用户插件文件签 → 验签 → relay 写 → 台账 claimed
  // body {document, fileName, publicKey, signature}（signature=插件对 document 字节的文件签 DER hex）
  if (path === '/api/user/credential-upload' && req.method === 'POST') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
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
  }

  // POST /api/user/cwt-apply - 申请解除限制（必须已领取 DID 普通凭证）
  if (path === '/api/user/cwt-apply' && req.method === 'POST') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    const body = (await parseJsonBody(req, res)) || {}
    try {
      const out = await credentialService.applyCwt(addr, body)
      dataService.logOperation('cwt_apply', { address: addr, id: out.id })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/user/cwt-application - 本人最近一次 CWT 申请状态（账户详情展示）
  if (path === '/api/user/cwt-application' && req.method === 'GET') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    try {
      const app = await credentialService.myApplication(addr)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, application: app }))
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
