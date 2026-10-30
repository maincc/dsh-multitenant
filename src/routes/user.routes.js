/**
 * 用户路由模块
 */

import { CONFIG } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { dockerService } from '../services/docker.service.js'
import { envBundleService } from '../services/env-bundle.service.js'
import {
  runEnvCommit,
  normEnvNames,
  autoSlug,
  normEnvWsExcludes,
} from '../services/env-commit.service.js'
import { dataService } from '../services/data.service.js'
import { skillService } from '../services/skill.service.js'
import { resourceExhaustedPayload } from '../utils/resource-exhausted.js'
import {
  tenantConfigService,
  SIGN_PURPOSE,
  buildSignedMessage,
} from '../services/tenant-config.service.js'
import { userSessionStore } from '../middleware/user-auth.middleware.js'
import { normalizeAddress, swtcContainerName } from '../utils/address.js'
import { rateLimit } from '../middleware/rate-limit.middleware.js'
import { getAdminSession, getRequestAddress } from '../middleware/auth.middleware.js'
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
    const sessionToken = userSessionStore.create(addrLower)
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
  // 凭证端点身份 = user_session 专属（钱包签名登录建立的会话）。全部端点要求登录态。
  // ⚠️ 事故复盘一（2026-10 审计）：曾误用 admin_session 专用会话，导致真实普通用户
  // （只有 user_session）六个凭证端点整体 401，而管理员浏览器双会话自测全通过，
  // service 层测试零 HTTP 用例把断链掩盖成绿灯。
  // ⚠️ 事故复盘二（2026-10-23 "会话主人不一致"循环根因）：当时改用 getRequestAddress
  // （admin 优先）矫枉过正——管理员浏览器遗留的 admin_session 会**抢占**凭证身份：
  // 插件切到账户 B、自动重签换的是 user_session=B，但端点恒返回旧管理员 A，前端守卫
  // 反复判"会话主人≠当前账户"且重签不掉 admin_session，F9 陷入循环。
  // 终局（判例 2026-10-30）：admin_session **整体废止**，双票抢占的根子拔除——
  // 身份 = user_session 唯一。两段事故复盘的病理（抢占/循环）随单源化成为历史；
  // 凭证端点与 restart/logout 同构复用 getRequestAddress。
  const credSession = () => getRequestAddress(req)

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

  // ---------------------------------------------------------------------------
  // 环境模板自助面（方案③，2026-10-27）：定格/发布权在管理员（PR1 审核闸），
  // 选用与回退在用户自己——"自己的容器自己主"。三端点全部只作用于会话地址本人，
  // applyImageVersion 的 dryRun 停机预览/重建/留痕全链路复用。
  // ---------------------------------------------------------------------------

  // —— 定格自助面（PR3）：cwt/admin 本人可格自己的容器（freezeAllowed 前置）。
  // 流程与管理员代格一字不差（runEnvCommit 共用）；权限差异=会话本人+资格门。
  const envFreezeDenied = (res, addr) => {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        error: `上传环境需要 CWT 或管理员凭证（当前地址 ${addr ? '未持有' : '无会话'}）`,
        code: 'FREEZE_REQUIRES_CWT',
        hint: '容器本身不受影响，照常使用；可在凭证页申请 CWT 后回来上传',
      }),
    )
  }

  // POST /api/user/environment-inventory —— 我可带的东西清单（只读）
  if (path === '/api/user/environment-inventory' && req.method === 'POST') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    if (!(await credentialService.freezeAllowed(addr))) return (envFreezeDenied(res, addr), true)
    if (!rateLimit(req, res, { max: 10, windowMs: 60000, keyPrefix: 'envinv' })) return true
    try {
      // 卷侧（helper：技能/插件/目录）与可写层侧（exec：workspace 顶层）并行，
      // 向导第 2 步两档各有真实数据源
      const [inventory, workspace, info, envsAll, curImage] = await Promise.all([
        envBundleService.inventory(addr),
        dockerService.listWorkspaceTop(swtcContainerName(addr)),
        dockerService.containerInfo(swtcContainerName(addr)),
        dataService.listEnvironments(),
        dockerService.containerImageId(swtcContainerName(addr)),
      ])
      // 正在跑某模板的镜像（按实物 ID 认，不按 pin）——前端据此亮"先回退"卡
      const runningTpl = curImage
        ? envsAll.find(
            (e) =>
              e.imageId === curImage &&
              (e.status === 'published' ||
                e.sourceAddr === addr ||
                (e.pinnedBy || []).includes(addr)),
          ) || null
        : null
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          inventory,
          workspace,
          canFreeze: true,
          containerRunning: !!(info.exists && info.status === 'running'),
          onTemplate: runningTpl
            ? {
                name: runningTpl.displayName || runningTpl.slug,
                byMe: runningTpl.sourceAddr === addr,
              }
            : null,
        }),
      )
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `随行内容盘点失败：${err.message}` }))
    }
    return true
  }

  // POST /api/user/environment-browse {dir} —— 选择器的分层浏览（只读）
  if (path === '/api/user/environment-browse' && req.method === 'POST') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    if (!(await credentialService.freezeAllowed(addr))) return (envFreezeDenied(res, addr), true)
    if (!rateLimit(req, res, { max: 30, windowMs: 60000, keyPrefix: 'envbrowse' })) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    try {
      const listing = await envBundleService.browse(addr, String(body.dir || ''))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(listing))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `浏览失败：${err.message}` }))
    }
    return true
  }

  // POST /api/user/environment-commit {displayName, intro, include, dryRun}
  // —— 自助定格：slug 平台自动生成（autoSlug），用户只管起名与勾选内容
  if (path === '/api/user/environment-commit' && req.method === 'POST') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    // 定格是重动作（停机几十秒+占盘）：两道防刷——资格门+低频 rateLimit
    if (!(await credentialService.freezeAllowed(addr))) return (envFreezeDenied(res, addr), true)
    if (!rateLimit(req, res, { max: 2, windowMs: 600000, keyPrefix: 'envfreeze' })) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    const displayName = String(body.displayName || '')
      .trim()
      .slice(0, 60)
    if (!displayName) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '上传需要给环境起名（displayName，≤60 字）' }))
      return true
    }
    const intro = String(body.intro || '')
      .trim()
      .slice(0, 300)
    const include = {
      skills: normEnvNames(body.include && body.include.skills),
      plugins: normEnvNames(body.include && body.include.plugins),
      folders: normEnvNames(body.include && body.include.folders),
    }
    const wsEx = normEnvWsExcludes(body.include && body.include.wsExcludes)
    if (wsEx === null) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          error:
            '子项摘除清单格式不正：须为"目录/子项"两段路径且不含 ..——隐私摘除宁可拒绝也不静默失效',
          code: 'BAD_WS_EXCLUDE',
        }),
      )
      return true
    }
    include.wsExcludes = wsEx
    try {
      const { status, body: respBody } = await runEnvCommit({
        address: addr,
        slug: autoSlug(displayName),
        displayName,
        intro,
        include,
        dryRun: !!body.dryRun,
        operator: addr, // 本人自助：审计操作人=会话地址（代格面记管理员）
        opKind: 'env_commit_self',
      })
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(respBody))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `上传失败：${err.message}（源容器已确认起回）` }))
    }
    return true
  }

  // GET /api/user/environments - published 模板列表 + 我当前的环境来源
  if (path === '/api/user/environments' && req.method === 'GET') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    const envs = await dataService.listEnvironments()
    const published = envs.filter((e) => e.status === 'published')
    const pinned = userService.state.swtcUsers?.[addr]?.pinnedImage ?? null
    // 认领兜底要认**全部状态**（判例 2026-10-30：作者下架后，正用着的人容器被
    // 闲置销毁、实物探测扑空，published-only 兜底把来源条谎成"默认环境"——
    // pin 是本人同意用的账，模板此刻上没上架都改不了"我用的就是它"的事实；
    // 暴露面仍只有 name/slug/author，不借道泄 intro/manifest）
    const mine = (pinned && envs.find((e) => e._id === pinned)) || null
    // 画面与真相收敛（第八案连带修正）：容器实物命中模板就算"套来的"，
    // 账本 pin 只在容器不在线时兜底——否则半途中止的回退会让来源条说谎，
    // 用户连"再点一次回退"的按钮都摸不到
    let runningTpl = null
    try {
      const curImage = await dockerService.containerImageId(swtcContainerName(addr))
      runningTpl = curImage
        ? published.find((e) => e.imageId === curImage) ||
          envs.find(
            (e) =>
              e.imageId === curImage &&
              (e.sourceAddr === addr || (e.pinnedBy || []).includes(addr)),
          ) ||
          null
        : null
    } catch {
      // 实物探测失败不拦列表：退回按账本认领
    }
    const shownTpl = runningTpl || mine
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        ok: true,
        // 只展示审核放行的；manifest 不外露（用户选用面=作者+版本+大小，
        // 审核证据留在管理端）
        // 我的作品**全状态**（判例 2026-10-29：曾滤掉 published，作者已上架的
        // 东西在市场卡与自留地两头都不见，"下架"入口只剩市场卡一张——切换账号
        // 后找不到自己的环境。名也改 myWorks：账目如实，键名不再撒谎）
        myWorks: envs
          .filter((e) => e.sourceAddr === addr)
          .map((e) => ({
            id: e._id,
            name: e.displayName || e.slug,
            slug: e.slug,
            status: e.status,
            rejectReason: e.rejectReason || null, // 驳回理由回传作者（改起来才有方向）
            pinnedByCount: (e.pinnedBy || []).length,
            sizeBytes: e.sizeBytes,
            createdAt: e.createdAt,
          }))
          .sort((a2, b2) => String(b2.createdAt).localeCompare(String(a2.createdAt))),
        environments: published
          .map((e) => ({
            id: e._id,
            slug: e.slug,
            name: e.displayName || e.slug, // 人读处一律展示名（老数据回退 slug）
            intro: e.intro || null,
            author: e.sourceAddr,
            isMine: e.sourceAddr === addr, // 作者标记：我的模板卡上给「下架」入口
            dshVersion: e.dshVersion,
            sizeBytes: e.sizeBytes,
            scrubbed: e.scrubbed,
            createdAt: e.createdAt,
            // 详情页要料（用户验收：市场里的环境模板要有详情）——随行清单
            // 本来就是分发事实，展示不算泄密；manifest 全文仍留管理端
            include: {
              skills: (e.include?.skills || []).slice(0, 50),
              plugins: (e.include?.plugins || []).slice(0, 50),
              folders: (e.include?.folders || []).slice(0, 200),
            },
            bundleFiles: (e.bundle?.files || []).length,
            bundleBytes: e.bundle?.bytes || 0,
            pinnedByCount: (e.pinnedBy || []).length,
          }))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
        yourCurrent: {
          image: pinned,
          // pin 的是版本镜像（平台钉版）而非模板——如实标 null，UI 归"其他"
          fromTemplate: shownTpl
            ? {
                name: shownTpl.displayName || shownTpl.slug,
                slug: shownTpl.slug,
                author: shownTpl.sourceAddr,
              }
            : null,
        },
      }),
    )
    return true
  }

  // POST /api/user/environment/apply {id, dryRun} - 自助换到自己的容器。
  // 命名避坑：不叫 -reset/-apply 后缀——/reset 后缀被 tenant.routes 卷删除端点
  // 劫持，/restart|/reset|/remove|/stop 后缀都在签名强制名单里（:541-544）。
  // 校验与 admin env-apply 同口径（published + digest 逐字），差别只在目标
  // 地址恒等于会话本人——不存在"用别人的会话换别人的容器"面。
  if (path === '/api/user/environment/apply' && req.method === 'POST') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    if (!rateLimit(req, res, { max: 5, windowMs: 600000, keyPrefix: 'envapply' })) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    const id = String(body.id || '')
    const doc = await dataService.getEnvironment(id)
    if (!doc) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '模板不存在' }))
      return true
    }
    if (doc.status !== 'published') {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '该模板未上架或已下架' }))
      return true
    }
    // digest 不可变钉（与 admin 面同一道供应链闸）
    const nowId = await dockerService.imageId(doc._id)
    if (!nowId) {
      res.writeHead(410, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '模板镜像已不在本机，不可选用' }))
      return true
    }
    if (nowId !== doc.imageId) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '模板与账本 digest 不符（同名被覆盖），拒用' }))
      return true
    }
    try {
      const result = await userService.applyImageVersion(addr, {
        image: doc._id,
        dryRun: !!body.dryRun,
      })
      let bundleOut = {}
      try {
        bundleOut = await envBundleService.applyBundleTo(addr, doc, { dryRun: !!body.dryRun })
      } catch (err) {
        bundleOut = { bundleError: `随行包装入失败（镜像切换本身已完成）：${err.message}` }
      }
      if (!body.dryRun) {
        const cur = await dataService.getEnvironment(id)
        const pinnedBy = new Set(cur?.pinnedBy || [])
        pinnedBy.add(addr)
        await dataService.patchEnvironment(id, { pinnedBy: [...pinnedBy] })
        // 换钉即迁账：A→B 后 A 的 pinnedBy 还挂着本人 = 幽灵引用（下架回执
        // usingCount 虚高、GC"被引用"护栏被撑大、hadTpl 兜底清错清单）
        for (const other of await dataService.listEnvironments()) {
          if (other._id !== id && (other.pinnedBy || []).includes(addr)) {
            await dataService.patchEnvironment(other._id, {
              pinnedBy: other.pinnedBy.filter((a) => a !== addr),
            })
          }
        }
        dataService.logOperation('env_apply_self', {
          id,
          address: addr,
          operator: addr, // 本人自助：操作人=会话地址（与管理员代发区分审计）
        })
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ...result, ...bundleOut }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // POST /api/user/environment-reset {dryRun} - 一键回平台默认环境
  // （applyImageVersion(image=null)=摘 pin 回 latest 语义；引用账本同步清）
  // POST /api/user/environment/unpublish {id} - 作者自助下架：published → unlisted
  // （已下架·自己摘的）。判例 2026-10-30：下架**不是**回到待审核（draft）——
  // 摘了就该安静待着，作者想回来才重新排队；也绝不复用 'draft' 字面，否则
  // 管理队列里凭空长出没人提交的"待审核"。下架≠删除：被引用之物不可物理删，
  // 正在用的人（含作者自己）不受影响，只是市场不再展示、不再接受新的选用。
  // POST /api/user/environment/submit {id} - 作者重新提交审核（unlisted → draft）。
  // 出口律：下架有去路。'draft' 就是定格入队本体的字面（env-commit 造它，
  // 管理端过审/驳回只认它）——重提必须回到这个真队列，不能回 'pending' 那种
  // 管理端不认的幽灵态（判例：曾写 pending，重提=从队列消失）。
  if (path === '/api/user/environment/submit' && req.method === 'POST') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    if (!rateLimit(req, res, { max: 10, windowMs: 60000, keyPrefix: 'envmeta' })) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    try {
      const doc = await dataService.getEnvironment(String(body.id || ''))
      if (!doc) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '模板不存在' }))
        return true
      }
      if (doc.sourceAddr !== addr) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '只能提交自己上传的模板' }))
        return true
      }
      if (doc.status !== 'unlisted') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '只有已下架的作品可以重新提交审核' }))
        return true
      }
      await dataService.patchEnvironment(doc._id, { status: 'draft' })
      dataService.logOperation('env_submit_self', { address: addr, id: doc._id })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, status: 'draft' }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  if (path === '/api/user/environment/unpublish' && req.method === 'POST') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    if (!rateLimit(req, res, { max: 10, windowMs: 60000, keyPrefix: 'envmeta' })) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    try {
      const doc = await dataService.getEnvironment(String(body.id || ''))
      if (!doc) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '模板不存在' }))
        return true
      }
      if (doc.sourceAddr !== addr) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '只能下架自己上传的模板' }))
        return true
      }
      if (doc.status !== 'published') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '只有已上架的模板需要下架（其他状态本就不在市场里）' }))
        return true
      }
      await dataService.patchEnvironment(doc._id, { status: 'unlisted' })
      // 裁定 2026-10-30：下架者不再住进下架物——作者本人的钉回落默认环境（在用的
      // 别人一律不动）；从此重连不回滚到定格点，攒好的改动下次定格就是现在。
      const off =
        typeof userService.unpinAuthorOnOffshelf === 'function'
          ? await userService.unpinAuthorOnOffshelf(addr, doc._id, 'unpublish')
          : { skipped: true }
      // 账实一致：回读账本再计数（doc 是解钉前的陈旧引用）；作者既已回落默认，
      // 任何记账时序下都不该被算进"仍在用"——filter 对已摘/未摘幂等
      const postPin = (await dataService.getEnvironment(doc._id))?.pinnedBy || []
      const usingLeft = off.unpinned ? postPin.filter((a) => a !== addr).length : postPin.length
      dataService.logOperation('env_unpublish_self', { address: addr, id: doc._id })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: true,
          status: 'unlisted',
          usingCount: usingLeft,
          selfUnpinned: Boolean(off.unpinned),
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  if (path === '/api/user/environment/revert' && req.method === 'POST') {
    const addr = credSession()
    if (!addr) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
      return true
    }
    if (!rateLimit(req, res, { max: 5, windowMs: 600000, keyPrefix: 'envrevert' })) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    try {
      // 先读账本：我现在钉在谁身上（hadTpl 必须在解绑与换容器之前拿到）
      const envs = body.dryRun ? [] : await dataService.listEnvironments()
      const recNow = userService.state?.swtcUsers?.[addr]
      // 清除清单的源头必须是**现在钉着的镜像**所属模板（判例：先后套过 A/B 的
      // 人，pinnedBy 双挂时按旧账 A 的清单清除 = 清错世界）；pinnedBy 只兜底。
      const hadTpl =
        (recNow?.pinnedImage && envs.find((e) => e._id === recNow.pinnedImage)) ||
        envs.find((e) => (e.pinnedBy || []).includes(addr)) ||
        null
      let cleanedCount = 0
      // 「一并清除」必须在**换容器之前**做（判例 2026-10-29 雷达竞态：代际在
      // 容器重建那刻翻转、雷达随即刷新页面——清除若排在换容器之后，页面刷
      // 出来看到的是"半干净"世界，插件明明删了还显示）。在旧容器里先清干净，
      // 页面刷新那一眼就是终态。
      let cleanNote = null
      if (hadTpl && body.alsoClean) {
        // 技能必须走 skillService.uninstall 正路（判例：只 rm 文件不销安装账，
        // 「我的技能」读账本显示装了个空气）；插件无账本，按名单 rm 目录。
        const NAME_OK = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/
        const removed = []
        const failed = []
        for (const n of hadTpl.include?.skills || []) {
          if (!NAME_OK.test(n)) continue
          try {
            await skillService.uninstall(addr, n)
            removed.push(n)
          } catch {
            failed.push(n)
          }
        }
        const plugins = (hadTpl.include?.plugins || []).filter((n) => NAME_OK.test(n))
        if (plugins.length) {
          try {
            await dockerService.execSh(
              swtcContainerName(addr),
              plugins.map((n) => `rm -rf /dsh-home/plugins/${n}`).join(' && '),
            )
            removed.push(...plugins)
          } catch {
            failed.push(...plugins)
          }
        }
        cleanNote =
          removed.length || failed.length
            ? failed.length
              ? `已清除 ${removed.length} 项，${failed.length} 项未成（${failed.join('、')}），可重试。`
              : `已按清单清除 ${removed.length} 项随行技能/插件（账本同步销记）。`
            : '该模板清单里没有登记在册的随行技能/插件，无需清除。'
        cleanedCount = removed.length
      } else if (body.alsoClean && !hadTpl) {
        cleanNote = '查无套用模板的记录，无需清除。'
      }
      const result = await userService.applyImageVersion(addr, {
        image: null,
        dryRun: !!body.dryRun,
        // 回退=干净默认（判例语义定规）：工作目录只存档不进新容器
        workspaceSnapshot: 'archive-only',
      })
      if (!body.dryRun) {
        for (const e of envs) {
          if (!(e.pinnedBy || []).includes(addr)) continue
          // 新鲜读再摘（判例：apply 侧已改新鲜读，这里用陈旧数组覆写会在
          // 重建窗口内吞掉别人刚挂上去的引用账）
          const fresh = await dataService.getEnvironment(e._id)
          if (fresh && (fresh.pinnedBy || []).includes(addr)) {
            await dataService.patchEnvironment(e._id, {
              pinnedBy: fresh.pinnedBy.filter((a) => a !== addr),
            })
          }
        }
        dataService.logOperation('env_reset_self', { address: addr, operator: addr })
        result.revertNote = cleanedCount
          ? `已回退到默认环境，随行技能/插件同步清除（${cleanedCount} 项）。DSH 页面会自动刷新。`
          : '已回退到默认环境（随行技能/插件保留，可在列表卸载）。DSH 页面会自动刷新。'
        if (cleanNote) result.cleanNote = cleanNote
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    } catch (err) {
      if (cleanNote) {
        // 随行物已经清了、容器却没换成——只报 500 会丢知情权（判例④）：
        // 已删的东西必须如实上报（remove-skill 幂等，重试安全）
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: `清除已生效但回退未完成：${String(err?.message || err)}。可重试。`,
            cleanNote,
            code: 'REBUILD_FAILED_AFTER_CLEAN',
          }),
        )
      } else {
        handleError(err, res)
      }
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
    // 2026-10 全面审计：此前匿名+任意地址可读——任何人可枚举任意租户的
    // baseURL/模型清单/Provider 拓扑（侦察面 + 用户私有配置）。模型配置是
    // 本人数据：仅本人（会话地址===目标）或管理员可读；另加 IP 限流兜底。
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
    const isAdm = session && credentialService.isAdmSync(session)
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
        // 未建档=新用户正常初始态（v1.5 登录/建档分离）：回 200+exists:false 同形载荷
        // （与前端空态合成一致），不再用 404——浏览器把非 2xx 记成红色网络日志，
        // 每个新用户进中心都"报错"一回，纯噪音还诱发误判。code 留作机器可读标记。
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ address, exists: false, status: 'none', code: 'USER_NOT_FOUND' }))
      } else {
        handleError(err, res)
      }
    }
    return true
  }

  // POST /api/upgrade/:address - 调整用户配额（升/降双向；立即 stop→update→start 目标容器）
  if (path.startsWith('/api/upgrade/') && req.method === 'POST') {
    const { requireAdmin, getAdminSession } = await import('../middleware/auth.middleware.js')
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

      // 2026-10 全面审计修复：本端点会**当场重启他人正在用的容器**（危害=force-stop
      // 同级），此前既无确认弹窗也无当场签名，是 CSRF/误触面上最重的漏网端点。
      // 签名绑定 address:tier——防"签 1 档执行 3 档"偷换；操作进审计。
      const { requireAdminSignature, attachAdminSignature } =
        await import('../middleware/admin-signature.middleware.js')
      attachAdminSignature(req)
      if (
        !requireAdminSignature(req, res, 'user-upgrade', { address, tier }, getAdminSession(req))
      ) {
        return true
      }

      const result = await userService.upgradeContainer(address, tier)
      dataService.logOperation('admin_tier_change', {
        address,
        operator: getAdminSession(req),
        tier: String(tier),
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  return false
}
