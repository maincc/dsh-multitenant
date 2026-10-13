/**
 * 管理路由模块
 */

import { CONFIG, isAdmin } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { dataService } from '../services/data.service.js'
import { dockerService } from '../services/docker.service.js'
// 镜像归属与可清理性判定的唯一真源（2026-09 从本文件抽出，与 F3 维护定时器共用）
import { collectPrunableImages, matchImageId } from '../services/image-inventory.service.js'
import { cwtAdminService } from '../services/cwt-admin.service.js'
import {
  tenantConfigService,
  SIGN_PURPOSE,
  buildSignedMessage,
} from '../services/tenant-config.service.js'
import { tenantGateway } from '../services/tenant-proxy.service.js'
import { dshVersionService } from '../services/dsh-version.service.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireAdmin, getAdminSession, adminSessionStore } from '../middleware/auth.middleware.js'
import {
  attachAdminSignature,
  issueAdminSignatureChallenge,
  requireAdminSignature,
} from '../middleware/admin-signature.middleware.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { normalizeAddress } from '../utils/address.js'
import { BadRequestError, NotFoundError, handleError } from '../utils/errors.js'
import { parseBody } from '../utils/parse-body.js'

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 镜像构建任务状态（进程内存）。
 *
 * 构建要编译 node-pty、可能拉 72 个 npm 依赖，耗时以分钟计——绝不能占着
 * HTTP 请求等它。因此 POST /api/admin/dsh/image 立即返回 { started:true }，
 * 前端轮询 GET /api/admin/dsh/image 读这里的进度。
 * 先不做持久化：进程重启即丢失，重新触发一次即可（构建是幂等的）。
 */
const imageBuildTask = {
  running: false,
  version: null,
  startedAt: null,
  finishedAt: null,
  ok: null,
  error: null,
  result: null,
}

/**
 * 「应用镜像到租户容器」任务状态（进程内存）。
 *
 * 每个租户要重建容器（停→删→建→等就绪），单个就要十几秒到 2 分钟，
 * 批量更久——因此同样立即返回、后台执行、前端轮询。
 * 逐租户结果都记下来：批量时不能因为一个失败就丢掉其余结果。
 */
const imageApplyTask = {
  running: false,
  targets: [],
  total: 0,
  completed: 0,
  results: [],
  startedAt: null,
  finishedAt: null,
}

/**
 * 收集孤儿数据卷：dsh-data-swtc-* 前缀 + 不属于任何 state 用户 + 无任何容器挂载引用。
 * 删除前务必用本函数实时重算（而非信任前端提交的列表），避免误删在用/在案卷。
 */
async function collectOrphanVolumes() {
  const prefix = 'dsh-data-swtc-'
  const volumes = await dockerService.listVolumes()
  const stateVolumes = new Set(
    Object.keys(userService.state.swtcUsers || {}).map((a) =>
      (prefix + normalizeAddress(a)).toLowerCase(),
    ),
  )
  const referenced = await dockerService.listReferencedVolumes()
  return volumes.filter(
    (v) =>
      v.startsWith(prefix) &&
      !stateVolumes.has(v.toLowerCase()) &&
      !referenced.has(v.toLowerCase()),
  )
}
/**
 * 处理管理路由
 */
export async function handleAdminRoutes(req, res, path, url) {
  // 解析破坏性操作的签名材料（请求头 → req.__adminSignature）。无副作用，
  // 没带就是没带，由 requireAdminSignature 统一报错。
  attachAdminSignature(req)

  // POST /api/admin/challenge - 领取一次性签名挑战（security-hardening-plan P0-1）
  //   不带 operation  → 登录挑战（对裸 nonce 签名，旧行为）
  //   带 operation    → 破坏性操作挑战：服务端推导 binding，钱包签 `${nonce}|${binding}`
  if (path === '/api/admin/challenge' && req.method === 'POST') {
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
                '签名钱包与管理员登录会话不是同一账户（防会话劫持，与操作对象是谁无关）。' +
                '请在 CCDAO 插件切回登录管理面板时的账户，或退出后重新登录再试。',
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
  }

  // POST /api/admin/login - 管理员钱包签名登录（P0-1：nonce 挑战 + 验签 + 地址归属）
  if (path === '/api/admin/login' && req.method === 'POST') {
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
      // ③ 必须是管理员地址
      if (!isAdmin(addrLower)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '不是管理员地址', code: 'FORBIDDEN' }))
        return true
      }

      // ④ 签发服务端随机会话（Cookie 值 = token，非地址）
      const token = adminSessionStore.create(addrLower)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `admin_session=${token}; path=/; max-age=43200; httponly; samesite=strict`,
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
  }

  // POST /api/admin/logout - 吊销当前会话（P0-1）
  if (path === '/api/admin/logout' && req.method === 'POST') {
    const cookie = req.headers.cookie || ''
    const match = cookie.match(/admin_session=([^;]+)/)
    const who = getAdminSession(req) // 先取操作人：吊销之后就查不到了
    if (match) {
      try {
        await adminSessionStore.revoke(decodeURIComponent(match[1]))
        // 会话吊销也是"改变世界的动作"——进录像
        dataService.logOperation('admin_logout', { address: who })
      } catch {
        // 忽略损坏的 token
      }
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
    return true
  }

  // GET /api/admin/check - 检查管理员权限
  if (path === '/api/admin/check') {
    const session = getAdminSession(req)
    const queryAddress = url.searchParams.get('address')

    // 如果传入了 address 参数，检查该地址是否是管理员
    if (queryAddress) {
      const addrLower = normalizeAddress(queryAddress)
      const isAdm = isAdmin(addrLower)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ isAdmin: isAdm, address: addrLower, checkedAddress: addrLower }))
      return true
    }

    // 否则检查 cookie 中的 session
    const isAdm = session && isAdmin(session)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ isAdmin: isAdm, address: session || null }))
    return true
  }

  // GET /api/admin/tenant-url?address= - 管理员代开租户容器（网关门禁凭证）
  // 返回带一次性 gateway_ticket 的 URL：浏览器首次访问该 URL 即换取该租户会话并放行
  if (path === '/api/admin/tenant-url' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return true
    let address = url.searchParams.get('address')
    if (!validateSwtcAddress(address, res)) return true
    address = normalizeAddress(address)

    const user = userService.state.swtcUsers?.[address]
    if (!user || user.containerStatus !== 'running') {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '租户容器未在运行', code: 'NOT_FOUND' }))
      return true
    }

    const ticket = tenantGateway.issueTicket(address)
    if (!ticket) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '网关未接管该租户端口，请稍后重试', code: 'CONFLICT' }))
      return true
    }
    const PUBLIC_HOST = process.env.PUBLIC_HOST || CONFIG.server.publicHost
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        url: `http://${PUBLIC_HOST}:${user.port}/?gateway_ticket=${ticket}`,
        address,
        port: user.port,
      }),
    )
    return true
  }

  // GET /api/docker/status - 检查 Docker 状态
  if (path === '/api/docker/status') {
    try {
      const available = await dockerService.isDockerAvailable()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ available, timestamp: Date.now() }))
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ available: false, error: err.message, timestamp: Date.now() }))
    }
    return true
  }

  // ---- 孤儿数据卷管理（管理端"清理孤儿卷"） ----

  // GET /api/admin/orphan-volumes - 列出孤儿数据卷
  // 判定：dsh-data-swtc-* 前缀 + 不属于任何 state 用户 + 无任何容器（含已停止）挂载引用
  if (path === '/api/admin/orphan-volumes' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return true
    try {
      const orphans = await collectOrphanVolumes()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, orphanVolumes: orphans, total: orphans.length }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // POST /api/admin/cleanup-orphan-volumes - 删除孤儿数据卷
  // 批量删数据是不可逆操作 → 与 delete-volume 同规格：除会话外还要求**当场签名**，
  // 且签的内容绑定"删哪几个卷"（规范化去重+排序）。执行时只删
  // 【签名清单 ∩ 当前仍是孤儿的卷】——清单里已被认领/回收的进 skipped，绝不扩大。
  if (path === '/api/admin/cleanup-orphan-volumes' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true

    let signed
    try {
      const body = JSON.parse((await parseBody(req)) || '{}')
      signed = Array.isArray(body.volumes) ? body.volumes : null
    } catch {
      signed = null
    }
    if (!signed) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          error: '缺少 volumes 列表：清理必须显式携带要删除的卷名（并为其签名）',
          code: 'BAD_REQUEST',
        }),
      )
      return true
    }

    if (
      !requireAdminSignature(
        req,
        res,
        'cleanup-orphan-volumes',
        { volumes: signed },
        getAdminSession(req),
      )
    ) {
      return true
    }

    try {
      const orphans = await collectOrphanVolumes()
      const norm = [...new Set(signed.map((s) => String(s).trim()).filter(Boolean))]
      const targets = orphans.filter((v) => norm.includes(v))
      const skipped = norm.filter((v) => !orphans.includes(v))
      const removed = []
      const failed = []
      for (const volume of targets) {
        try {
          await dockerService.removeVolume(volume)
          removed.push(volume)
        } catch (err) {
          failed.push({ name: volume, error: err.message })
        }
      }
      // 批量不可逆删除必须留痕（真删了或有失败才记——全空说明没动世界）
      if (removed.length || failed.length) {
        dataService.logOperation('admin_cleanup_orphan_volumes', {
          operator: getAdminSession(req),
          removed,
          failedNames: failed.map((f) => f.name),
          skipped,
        })
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: true,
          removed,
          failed,
          skipped,
          total: targets.length,
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // POST /api/admin/promote/:address - 提权用户为管理员
  // 破坏性（持久化后门级别的操作）→ 除会话外还要求**当场钱包签名**
  if (path.startsWith('/api/admin/promote/') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true

    let address = path.slice('/api/admin/promote/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    if (!requireAdminSignature(req, res, 'promote', { address }, getAdminSession(req))) {
      return true
    }

    // 添加到管理员列表（运行时 + 持久化）
    const added = await dataService.addAdmin(address, getAdminSession(req) || 'system')

    if (added) {
      console.log(`[admin] promoted ${address} to admin`)
      dataService.logOperation('admin_promote', { address, operator: getAdminSession(req) })
    }

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, address, promoted: added }))
    return true
  }

  // GET /api/users - 获取所有用户列表 + 只读 tier 配置
  if (path === '/api/users') {
    if (!requireAdmin(req, res)) return
    try {
      // force=1：跳过服务端短缓存 —— 手动刷新与写操作后必须拿到最新
      const force = url.searchParams.get('force') === '1'
      const users = await userService.getAllUsers({ force })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ users, tiers: CONFIG.tiers }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/stats - 系统统计
  if (path === '/api/stats') {
    if (!requireAdmin(req, res)) return
    const stats = userService.getStats()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    // uiConfig 随 stats 一起下发：前端用它设定轮询间隔，改 config.json 只需重启服务，
    // 不必重新构建前端。（refreshIntervalMs 默认 15000，可填 300000 = 5 分钟）
    res.end(
      JSON.stringify({
        ...stats,
        uiConfig: {
          refreshIntervalMs: Number(CONFIG.admin?.refreshIntervalMs ?? 15000),
        },
      }),
    )
    return true
  }

  // POST /api/admin/force-stop/:address - 强制下线容器
  if (path.startsWith('/api/admin/force-stop/') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return

    let address = path.slice('/api/admin/force-stop/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    // 会打断在用租户的会话 → 要求当场签名
    if (!requireAdminSignature(req, res, 'force-stop', { address }, getAdminSession(req))) {
      return
    }

    try {
      const result = await userService.forceStopContainer(address)
      dataService.logOperation('admin_force_stop', { address, operator: getAdminSession(req) })
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

  // GET /api/admin/cwt/applications - CWT 申请列表（分页 + 状态筛选）
  // 查询参数：limit（默认 50，上限 200）、offset（默认 0）、status（pending|approved|rejected|all）
  if (path === '/api/admin/cwt/applications' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10)
      const rawOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
      const statusParam = url.searchParams.get('status')
      const VALID_STATUS = ['pending', 'approved', 'rejected', 'all']
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 10
      const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0
      const status = statusParam && VALID_STATUS.includes(statusParam) ? statusParam : 'all'

      const { items, total } = cwtAdminService.queryApplications({ limit, offset, status })
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            ok: true,
            applications: items,
            total,
            limit,
            offset,
            status,
            hasMore: offset + items.length < total,
          }),
        )
      }
    } catch (err) {
      if (!res.headersSent) handleError(err, res)
    }
    return true
  }

  // POST /api/admin/cwt/applications/:id/approve - 批准（复核验签后入库）
  if (
    path.startsWith('/api/admin/cwt/applications/') &&
    path.endsWith('/approve') &&
    req.method === 'POST'
  ) {
    if (!requireAdmin(req, res)) return
    const id = path.slice('/api/admin/cwt/applications/'.length, -'/approve'.length)
    // 批准＝发放"无限时长豁免"，与被签名的 promote 同级 → 当场签名，绑申请 id
    const adminAddr = getAdminSession(req)
    if (!requireAdminSignature(req, res, 'cwt/approve', { id }, adminAddr)) {
      return true
    }
    try {
      const result = await cwtAdminService.approveApplication(id, adminAddr)
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      }
    } catch (err) {
      if (!res.headersSent) {
        const status = err.statusCode || (err.code ? 400 : 500)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL_ERROR' }))
      }
    }
    return true
  }

  // POST /api/admin/cwt/applications/:id/reject - 拒绝
  if (
    path.startsWith('/api/admin/cwt/applications/') &&
    path.endsWith('/reject') &&
    req.method === 'POST'
  ) {
    if (!requireAdmin(req, res)) return
    const id = path.slice('/api/admin/cwt/applications/'.length, -'/reject'.length)
    // 拒绝同样改变审批状态机 → 当场签名，绑申请 id（防"签这张拒那张"）
    const adminAddr = getAdminSession(req)
    if (!requireAdminSignature(req, res, 'cwt/reject', { id }, adminAddr)) {
      return true
    }
    try {
      const result = await cwtAdminService.rejectApplication(id, adminAddr)
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      }
    } catch (err) {
      if (!res.headersSent) {
        const status = err.statusCode || (err.code ? 400 : 500)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL_ERROR' }))
      }
    }
    return true
  }

  // GET /api/admin/cwt/registry - 已批准注册表（分页）
  // 查询参数：limit（默认 50，上限 200）、offset（默认 0）
  if (path === '/api/admin/cwt/registry' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10)
      const rawOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 10
      const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0

      const { items, total } = cwtAdminService.queryRegistry({ limit, offset })
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            ok: true,
            registry: items,
            total,
            limit,
            offset,
            hasMore: offset + items.length < total,
          }),
        )
      }
    } catch (err) {
      if (!res.headersSent) handleError(err, res)
    }
    return true
  }

  // POST /api/admin/cwt/registry/:address/revoke - 撤销授权
  if (
    path.startsWith('/api/admin/cwt/registry/') &&
    path.endsWith('/revoke') &&
    req.method === 'POST'
  ) {
    if (!requireAdmin(req, res)) return
    let address = path.slice('/api/admin/cwt/registry/'.length, -'/revoke'.length)
    if (!validateSwtcAddress(address, res)) return
    address = normalizeAddress(address)
    // 撤销授权会让用户从"CWT 豁免"跌回每日时限，是权限状态改变 → 当场签名，绑地址
    const adminAddr = getAdminSession(req)
    if (!requireAdminSignature(req, res, 'cwt/revoke', { address }, adminAddr)) {
      return true
    }
    try {
      const result = await cwtAdminService.revokeRegistry(address, adminAddr)
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      }
    } catch (err) {
      if (!res.headersSent) {
        const status = err.statusCode || (err.code ? 400 : 500)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL_ERROR' }))
      }
    }
    return true
  }

  // GET /api/admin/cwt/records - 审计记录（分页；token 原文可查可重验）
  // 查询参数：limit（默认 10，上限 200）、offset（默认 0）。
  // 不返回 total：审计日志为 append-only，统计总行数需读全文件，会破坏尾部读取优化；
  // 前端据 hasMore 判断是否还有更早记录。
  if (path === '/api/admin/cwt/records' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10)
      const rawOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 10
      const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0

      const { records, hasMore } = await cwtAdminService.listRecords(limit, offset) // mongodb 形态为异步读
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, records, limit, offset, hasMore }))
      }
    } catch (err) {
      if (!res.headersSent) handleError(err, res)
    }
    return true
  }

  // POST /api/admin/delete-volume/:address - 删除数据卷
  if (path.startsWith('/api/admin/delete-volume/') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return

    let address = path.slice('/api/admin/delete-volume/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    // 删除数据卷不可逆 → 要求当场签名
    if (!requireAdminSignature(req, res, 'delete-volume', { address }, getAdminSession(req))) {
      return
    }

    try {
      const result = await userService.deleteUserVolume(address)
      // 不可逆删除必须留痕（volumeDeleted=真实删除的卷名；status:stopped=仅停容器）
      dataService.logOperation('admin_delete_volume', {
        address,
        operator: getAdminSession(req),
        volume: result?.volumeDeleted ?? null,
        resultStatus: result?.status ?? null,
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

  // POST /api/admin/disk-scan - 精确扫描租户卷真实占用（du 实测）
  if (path === '/api/admin/disk-scan' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      const scanned = await userService.scanVolumeUsage()
      const disk = userService.diskUsage
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          scanned,
          preciseScannedAt: disk?.preciseScannedAt ?? null,
          volumes: disk?.volumes ?? [],
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // ---------------------------------------------------------------------------
  // DSH 版本 / 镜像升级
  // ---------------------------------------------------------------------------

  // GET /api/admin/dsh/versions - npm 上可用版本（按 dist-tag 分组）
  if (path === '/api/admin/dsh/versions' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const url = new URL(req.url, 'http://x')
      // 默认折叠预发布；includePrerelease=1 才展开
      const includePrerelease = url.searchParams.get('includePrerelease') === '1'
      const data = await dshVersionService.getVersions()
      if (!data.ok) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: `无法获取 DSH 版本列表：${data.error}`,
            code: 'REGISTRY_UNAVAILABLE',
          }),
        )
        return true
      }

      // 本地已构建的版本 —— 管理页需要它来回答
      // "哪些版本我手上有、可以直接拿去构建/回滚"，而不只是"远端有哪些版本"。
      //
      // 不能只看 `docker image ls` 的 tag：构建新版本会把旧 tag 挪走，
      // 旧镜像变成无 tag 的悬空镜像但**仍占 1.2GB 且仍可回滚**（这正是历史里
      // 那些"在本地"的记录）。所以"本地有没有"要同时看 tag 与平台历史，
      // 再统一按"该镜像在不在本地"判定（复用 collectPrunableImages 的实时结果）。
      const localTags = (await dockerService.listLocalVersionTags()) || []
      const record = dataService.getDshImage()
      const present = await collectPrunableImages(record)
      const presentIds = present.items.map((im) => im.id)

      /** 该版本是否在本地留有镜像（带 tag 或悬空） */
      const versionLocal = (v) => {
        if (!v) return false
        if (localTags.some((t) => t.version === v)) return true
        const h = (record.history || []).find((x) => x.version === v)
        return Boolean(h) && presentIds.some((pid) => matchImageId(pid, h.imageId))
      }

      const localVersionSet = new Set(
        (record.history || [])
          .map((h) => h.version)
          .concat(localTags.map((t) => t.version))
          .filter((v) => v && v !== 'latest' && versionLocal(v)),
      )
      const { current } = record
      const markLocal = (v) => localVersionSet.has(v)

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          latest: data.latest,
          tags: data.tags,
          stable: data.stable,
          prerelease: includePrerelease ? data.prerelease : [],
          prereleaseCount: data.prerelease.length,
          includePrerelease,
          stale: Boolean(data.stale),
          fetchedAt: data.fetchedAt,
          // 每个远端版本是否已在本地构建（前端用来标"已构建"）
          stableLocal: data.stable.map((v) => ({ version: v, local: markLocal(v) })),
          prereleaseLocal: includePrerelease
            ? data.prerelease.map((v) => ({ version: v, local: markLocal(v) }))
            : [],
          // 本地已有 tag 的版本（含 latest 的指向），按版本去重
          localVersions: [...localVersionSet].sort(),
          localTags: localTags.map((t) => ({
            version: t.version,
            imageId: t.imageId,
            createdAt: t.createdAt,
            // 必须用 matchImageId：docker 给短 ID、平台存完整 sha256，
            // 直接 === 比较永远为 false（"当前"标记会一直不亮）
            isCurrent: Boolean(current?.imageId) && matchImageId(t.imageId, current.imageId),
          })),
          currentVersion: current?.version ?? null,
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/admin/dsh/status - 当前镜像版本 + 各租户版本 + 哪些租户需要重建
  if (path === '/api/admin/dsh/status' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const record = dataService.getDshImage()
      const currentImageId = await dockerService.imageId()
      const currentImageVersion = await dockerService.imageDshVersion()

      // 与 registry 最新版对比（**只用缓存**，不联网）：
      // /status 要快，不能在管理面板每次刷新时都去等 npm view（数秒）。
      // 缓存为空返回 null → 界面显示"未知"，而不是把请求拖慢。
      let upgrade = null
      if (currentImageVersion) {
        const versions = await dshVersionService.getVersions({ compareOnly: true })
        if (versions.ok && versions.latest) {
          upgrade = {
            latest: versions.latest,
            // 字符串不等即判定需升级：DSH 版本号非严格 semver，不做大小比较
            // （只依赖"是否等于当前版本"这一个事实，避免误判 0.1.10 < 0.1.9）
            behind: currentImageVersion !== versions.latest,
            checkedAt: versions.fetchedAt ?? null,
          }
        } else {
          upgrade = {
            latest: null,
            behind: null,
            notLoaded: Boolean(versions.notLoaded),
            reason: versions.notLoaded
              ? '版本列表尚未加载（打开「本地版本列表」后会自动拉取）'
              : '版本列表不可用（registry 错误见版本列表提示）',
          }
        }
      }

      // 逐租户：容器实际引用的镜像 ID vs 当前镜像 ID
      // （容器记录的是创建时的镜像 ID，不受之后 latest 被重指影响）
      const tenants = []
      for (const [address, user] of Object.entries(userService.state.swtcUsers || {})) {
        if (user.containerStatus !== 'running' && user.containerStatus !== 'stopped') continue
        const name = `dsh-swtc-${normalizeAddress(address)}`
        const containerImageId = await dockerService.containerImageId(name)
        tenants.push({
          address,
          containerStatus: user.containerStatus,
          containerImageId,
          // 容器里实际装的 DSH 版本（可能 != currentImageVersion：容器一旦创建就
          // 钉在旧镜像上）。管理员需要它才能判断"这个租户要不要更新"。
          dshVersion:
            (await dockerService.containerDshVersion(name)) ?? user.baseImageVersion ?? null,
          // 该租户是否被钉在指定镜像上（租户镜像选择）。null = 跟随平台默认
          pinnedImage: user.pinnedImage ?? null,
          // containerImageId 为 null = 容器不存在
          stale: Boolean(currentImageId) && containerImageId !== currentImageId,
        })
      }

      // 版本历史增强：标出每条记录对应的镜像**是否仍在本地**。
      //
      // 为什么必须标：同一个版本可以被构建多次（每次都是新镜像 ID，tag 只有一个
      // → 后来的覆盖先前的），历史却把所有构建都留着。不标出来，管理员会以为
      // 4 条 "0.1.5-rc.1" 都能回滚，其实只有 tag 指向的那一个还在。
      // 同时给出体积与"是否可安全清理"，供管理页做多选清理。
      //
      // 安全约束（宁可漏删不可误删）：
      //   · current 指向的镜像绝不能删
      //   · 仍被任何容器（含已停止）引用的镜像不能删 —— 删了那容器就再也起不来
      // 可删性一律取自 collectPrunableImages（与 /images 清理面板同一判定），
      // 否则会出现"历史说带 tag 不能清、清理面板说能清"的自相矛盾。
      const prunable = await collectPrunableImages(record)

      const history = record.history.slice(-20).map((h) => {
        // docker images 给的是短 ID（通常 12 位，冲突时会更长），inspect 给的是
        // 完整 sha256 → 用 matchImageId 双向前缀匹配
        const local = prunable.items.find((im) => matchImageId(im.id, h.imageId)) ?? null
        const isCurrent = Boolean(currentImageId) && matchImageId(h.imageId, currentImageId)
        return {
          ...h,
          present: Boolean(local),
          sizeBytes: local?.sizeBytes ?? 0,
          removable: Boolean(local?.removable),
          reason: !local ? 'not_local' : isCurrent ? 'current' : local.used ? 'in_use' : null,
        }
      })

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          image: CONFIG.docker.image,
          currentImageId,
          currentImageVersion,
          upgrade,
          recorded: record.current,
          history,
          // 可清理镜像清单（含不在历史里的，如更早遗留的 tag）——
          // 让管理页清理面板**始终**有内容可展示，而不是没得清时整个入口消失
          // 可指定给租户运行的本地镜像（租户镜像选择的下拉项）
          availableImages: await dockerService
            .listAvailableImages(CONFIG.docker?.image)
            .catch(() => []),
          prunable: {
            image: prunable.image,
            items: prunable.items,
            removableCount: prunable.removableCount,
            removableBytes: prunable.removableBytes,
            danglingCount: prunable.danglingCount,
            taggedCount: prunable.taggedCount,
            infoIncomplete: prunable.infoIncomplete,
          },
          staleTenants: tenants.filter((t) => t.stale).length,
          tenants,
          // 镜像升级对已有容器无效（它们仍引用旧镜像 ID），必须重建容器才生效
          note: '已有容器仍引用旧镜像，需重建容器才会应用新版本',
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/admin/dsh/image - 构建任务进度（前端轮询）
  // GET /api/admin/dsh/images - 本地镜像清单 + 每个镜像的可清理性
  //
  // 前端需要它来回答两个问题："有哪些镜像在占盘" 和 "为什么这个不能删"。
  // 判定由服务端实时重算，绝不信任前端提交的列表。
  //
  // 可删条件（同时满足）：
  //   · 属于本项目（带本项目 tag，或无 tag 但出现在平台构建历史里）
  //   · 不是 current 镜像
  //   · 没有任何容器（含已停止）引用
  // 带 tag 的镜像也允许删（旧版本 tag 同样占 1.2GB），但前端要显式勾选
  // "包含带 tag 的版本"，避免误删回滚退路。
  if (path === '/api/admin/dsh/images' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const prunable = await collectPrunableImages(dataService.getDshImage())
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ...prunable,
          note: '只删除本项目镜像；current 与仍被容器（含已停止）引用的镜像一律不可删',
        }),
      )
      return true
    } catch (err) {
      // 用统一的 handleError：BadRequestError 才有正确的 400，
      // 手工 writeHead(500) 会把客户端错误误报成服务端故障
      handleError(err, res)
      return true
    }
  }

  // POST /api/admin/dsh/images/prune - 清理多余镜像（破坏性操作，需签名）
  // body: { ids: string[] }  必须显式列出要删的镜像 ID
  //
  // 为什么强制显式列表：签名 binding 是"删哪几个镜像"，若允许省略（= 删全部）
  // 就会出现"签的时候是这一批、执行时又多了几个"的解释空间。显式列出后，
  // 签名内容与执行内容严格一致。
  //
  // 每一项都在服务端**重新校验**后才删。这台机器上同时跑着其它项目的镜像，
  // 所以绝不使用 docker image prune，只按 ID 精确删除。
  if (path === '/api/admin/dsh/images/prune' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      // 顺序很重要：必须**先读 body**才能把"删哪几个镜像"并入签名 binding。
      // 且 parseBody 无缓存（每调用一次都新挂监听），所以全流程只读一次。
      const raw = await parseBody(req)
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        throw new BadRequestError('请求体不是合法 JSON')
      }

      const requested = Array.isArray(body.ids) ? body.ids.map((s) => String(s)) : []
      if (!requested.length) throw new BadRequestError('缺少 ids（必须是镜像 ID 数组）')

      // 验签：binding 里包含这份镜像 ID 列表，签名内容与执行内容严格一致
      if (
        !requireAdminSignature(
          req,
          res,
          'dsh/prune-images',
          { ids: requested },
          getAdminSession(req),
        )
      ) {
        return true
      }

      // 复用与 GET /images 完全相同的判定，杜绝"列表说可清理、删除说不行"的矛盾
      const prunable = await collectPrunableImages(dataService.getDshImage())
      const byId = (id) => prunable.items.find((im) => matchImageId(im.id, id))

      const eligible = []
      const skipped = []
      for (const id of requested) {
        const img = byId(id)
        if (!img) {
          skipped.push({ id, reason: 'not_found_or_not_ours' })
          continue
        }
        if (img.removable) {
          eligible.push(img)
          continue
        }
        // 给出精确原因 + 谁在用，管理员才知道下一步怎么办。
        // "信息不全"必须与"真的在用"区分：前者是平台拿不到容器列表（可重试），
        // 后者是真的被占用（要先去处理那个容器）。
        skipped.push({
          id,
          reason: img.isCurrent
            ? 'current'
            : prunable.infoIncomplete
              ? 'info_incomplete'
              : img.used
                ? 'in_use_by_container'
                : 'not_removable',
          usedBy: (img.usedBy || []).map((c) => `${c.name}(${c.state})`),
        })
      }

      const { removed, failed } = eligible.length
        ? await dockerService.removeImages(eligible.map((i) => i.id))
        : { removed: [], failed: [] }
      const freedBytes = eligible
        .filter((i) => removed.includes(i.id))
        .reduce((s, i) => s + i.sizeBytes, 0)

      // 破坏性删除留痕（真删了或有失败才记；全 skipped=没动世界）
      if (removed.length || failed.length) {
        dataService.logOperation('admin_image_prune', {
          operator: getAdminSession(req),
          removed,
          failed,
          skippedIds: skipped.map((s) => s.id),
          freedBytes,
        })
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          removed,
          failed,
          skipped,
          freedBytes,
          // 共享层导致该数值可能高估实际释放量，如实说明
          note: 'freedBytes 为镜像独占层之和，存在共享层时实际释放可能更少',
        }),
      )
      return true
    } catch (err) {
      // 用统一的 handleError：BadRequestError 才有正确的 400，
      // 手工 writeHead(500) 会把"缺 ids"这类客户端错误误报成服务端故障
      handleError(err, res)
      return true
    }
  }

  if (path === '/api/admin/dsh/image' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(imageBuildTask))
    return true
  }

  // POST /api/admin/dsh/image - 升级租户镜像到指定 DSH 版本
  // body: { version: string, refreshVersions?: boolean }
  // 立即返回（构建耗时为分钟级），进度看 GET /api/admin/dsh/image
  if (path === '/api/admin/dsh/image' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      if (imageBuildTask.running) {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '已有镜像构建在进行中', code: 'CONFLICT' }))
        return true
      }

      // parseBody 返回的是原始字符串，必须自己解析（与其它路由一致）
      const raw = await parseBody(req)
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        throw new BadRequestError('请求体不是合法 JSON')
      }
      const version = String(body.version ?? '').trim()
      if (!version) throw new BadRequestError('缺少 version')
      if (body.refreshVersions) dshVersionService.clearCache()

      const check = await dshVersionService.isInstallable(version)
      if (!check.ok) throw new BadRequestError(check.error)

      const localBuild = CONFIG.dsh?.allowLocalBuild !== false
      const context = join(PROJECT_ROOT, CONFIG.dsh?.buildContext || '.')
      if (localBuild && !existsSync(join(context, 'Dockerfile'))) {
        throw new BadRequestError(
          `构建上下文里没有 Dockerfile：${context}（平台服务器需要完整源码树，或改用 docker pull 现成镜像）`,
        )
      }

      // 交给后台执行：构建以分钟计，不能占着 HTTP 请求
      imageBuildTask.running = true
      imageBuildTask.version = version
      imageBuildTask.startedAt = Date.now()
      imageBuildTask.finishedAt = null
      imageBuildTask.ok = null
      imageBuildTask.error = null
      imageBuildTask.result = null

      const by = getAdminSession(req) || 'admin'
      dockerService
        .buildImage(version, { context })
        .then(async (result) => {
          await dataService.saveDshImage({ ...result, by })
          // P2 留痕：构建完成（新镜像进历史+默认）记一条
          dataService.logOperation('dsh_image_build', {
            address: by,
            version: result.version,
            imageId: result.imageId,
          })
          // 镜像换了 → 能力缓存必须立即失效。
          // 否则最长 CAPABILITY_CACHE_TTL_MS 内，网关仍按旧镜像的
          // requiresToken 判定：比如刚从"需要认证的新版"退回"可直通的
          // 0.1.1-rc.2"，租户重建后仍会被拒 503，看起来像升级没生效。
          dockerService.clearCapabilityCache()
          imageBuildTask.ok = true
          imageBuildTask.result = result
          console.log(`[dsh] image built for version ${version}: ${result.imageId}`)
        })
        .catch((err) => {
          imageBuildTask.ok = false
          imageBuildTask.error = err.message
          console.error(`[dsh] image build failed for ${version}:`, err.message)
        })
        .finally(() => {
          imageBuildTask.running = false
          imageBuildTask.finishedAt = Date.now()
        })

      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          started: true,
          version,
          message: '镜像构建已开始，请轮询 GET /api/admin/dsh/image 查看进度',
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/admin/dsh/local-images - 本机所有可用镜像 + 当前平台默认是哪一张
  // （"从当前镜像中选一个当平台镜像"功能的数据源；含不在构建历史里的，
  // 比如从别的机器 docker load 进来的）。
  // 命名注意：`/dsh/images` 已被镜像清理面板占用（可删清单），此端点是可选清单。
  if (path === '/api/admin/dsh/local-images' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const [images, defaultId, defaultVersion] = await Promise.all([
        dockerService.listAvailableImages(),
        dockerService.imageId(),
        dockerService.imageDshVersion(),
      ])
      // 必须后端归一化比对：docker 清单给的是短 ID（12 位），inspect 给
      // sha256 全量——前端直接 === 永远不相等，"当前默认"标记会整体消失
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: true,
          images: (images || []).map((im) => ({
            ...im,
            isDefault: matchImageId(im.imageId, defaultId),
          })),
          defaultId,
          // "现在的总体镜像到底是谁"的答案随清单一起下发：
          // defaultRef = 平台配置引用的名字（如 dsh-multitenant:latest）；
          // defaultId 为 null = 该 tag 根本不存在（"不知道"态），前端据此
          // 明示"无平台默认镜像"，而不是让人猜；defaultVersion 为 null =
          // tag 在但读不出内嵌版本（外来/损坏镜像），同样明示"未知"。
          defaultRef: CONFIG.docker.image,
          defaultVersion: defaultVersion || null,
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // POST /api/admin/dsh/select - 把一个本地镜像钦定为平台默认镜像
  // body: { ref: string }  （形如 dsh-multitenant:0.1.5-rc.3 或镜像 ID）
  //
  // 与"构建"的区别：构建 = 从 registry 现拉现装并自动夺 latest；钦定 = 直接
  // 拿机器上已有的镜像当默认（load 来的、历史遗留的都行），**不重建任何容器**。
  // 与"应用"的区别：应用 = 把默认镜像推到租户容器上；钦定只改"以后用谁"。
  //
  // 防护：当场签名绑 ref（签 A 指 B 是越权通道）+ 存在性 + 内嵌版本可读
  // （读不到 /usr/local/share/dsh-version 也不是旧 package.json = 不是本项目
  // 镜像，拒）+ 启动自检做不起（构建侧探活兜住健康产物，这里不重复付费）。
  if (path === '/api/admin/dsh/select' && req.method === 'POST') {
    const adminAddr = getAdminSession(req)
    if (!requireAdmin(req, res)) return true
    try {
      const raw = await parseBody(req)
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        throw new BadRequestError('请求体不是合法 JSON')
      }
      const ref = String(body.ref ?? '').trim()
      if (!ref) throw new BadRequestError('缺少 ref：要钦定为平台默认的镜像引用')
      if (!requireAdminSignature(req, res, 'dsh/select', { ref }, adminAddr)) return true

      const imageId = await dockerService.imageId(ref)
      if (!imageId) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: `本机不存在镜像 ${ref}`, code: 'IMAGE_NOT_FOUND' }))
        return true
      }
      const version = await dockerService.imageDshVersion(ref)
      if (!version) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: `${ref} 读不出 DSH 内嵌版本——不是本项目的租户镜像，拒绝钦定`,
            code: 'NOT_A_TENANT_IMAGE',
          }),
        )
        return true
      }

      const applied = await dockerService.setDefaultImage(ref)
      const record = await dataService.saveDshImage({
        version,
        imageId: applied.imageId,
        tag: ref,
        by: adminAddr,
      })
      // 与构建同款的收尾：默认镜像变了 → 能力缓存必须立即失效，否则网关
      // 在 TTL 内仍按旧镜像的 requiresToken 判定（见 dsh/image 构建处注释）
      dockerService.clearCapabilityCache()

      // P2 留痕：钦定平台默认镜像（影响所有新建租户）记一条
      dataService.logOperation('dsh_image_select', {
        address: getAdminSession(req),
        version,
        imageId: applied.imageId,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, version, imageId: applied.imageId, current: record }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/admin/dsh/apply - 应用任务进度（前端轮询）
  if (path === '/api/admin/dsh/apply' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(imageApplyTask))
    return true
  }

  // POST /api/admin/dsh/apply - 把当前镜像应用到租户容器（重建容器，保留数据卷）
  // body: { address?: string, all?: boolean, staleOnly?: boolean, dryRun?: boolean }
  // 不传 address 且 all=true → 批量。立即返回，进度看 GET /api/admin/dsh/apply
  if (path === '/api/admin/dsh/apply' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      if (imageApplyTask.running) {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '已有应用任务在进行中', code: 'CONFLICT' }))
        return true
      }

      const raw = await parseBody(req)
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        throw new BadRequestError('请求体不是合法 JSON')
      }

      const dryRun = Boolean(body.dryRun)

      // 目标镜像（租户镜像选择）。空 = 平台默认 latest（保持原行为）。
      // 只接受"本平台仓库名 + 版本 tag"形式，避免把租户指向任意镜像；
      // 进一步的存在性与"是不是 DSH 镜像"由 applyImageVersion 在动容器前校验。
      let targetImage = null
      if (body.image != null && String(body.image).trim() !== '') {
        targetImage = String(body.image).trim()
        const repo = String(CONFIG.docker?.image || 'dsh-multitenant').split(':')[0]
        if (!targetImage.startsWith(`${repo}:`)) {
          throw new BadRequestError(`目标镜像必须属于 ${repo}（收到：${targetImage}）`)
        }
      }

      // ---- 选定目标租户 ----
      // 参数校验先于签名检查：请求本身就不合法时报明确的 400，
      // 而不是先抛"需要签名"（否则调用方会去签一个注定失败的操作）。
      let targets = []
      if (body.address) {
        let address = String(body.address)
        if (!validateSwtcAddress(address, res)) return true
        address = normalizeAddress(address)
        targets = [address]
      } else if (body.all) {
        targets = Object.entries(userService.state.swtcUsers || {})
          // 只处理"有容器"的租户：destroyed 的下次连接会自动用新镜像
          .filter(([, u]) => u.containerStatus === 'running' || u.containerStatus === 'stopped')
          .map(([addr]) => addr)
      } else {
        throw new BadRequestError('需要 address，或传 all:true 批量')
      }

      // 破坏性：重建租户容器（可能附带备份/停机）→ 要求当场签名。
      // 绑定的是"执行意图"：单租户绑地址、批量绑 all=1。dryRun 只是预演，
      // 不改变签名内容（否则管理员得签两次）。
      if (
        !requireAdminSignature(
          req,
          res,
          'dsh/apply',
          { address: body.address, all: body.all, image: targetImage },
          getAdminSession(req),
        )
      ) {
        return true
      }

      if (targets.length === 0) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({ applied: 0, skipped: 0, message: '没有需要处理的租户', results: [] }),
        )
        return true
      }

      // dryRun 或单租户：同步执行并直接返回结果（快，且调用方要立即看到明细）
      if (dryRun || targets.length === 1) {
        const results = []
        for (const address of targets) {
          try {
            const result = await userService.applyImageVersion(address, {
              dryRun,
              image: targetImage,
            })
            results.push({ address, ok: true, ...result })
          } catch (err) {
            results.push({ address, ok: false, error: err.message, backupPath: err.backupPath })
          }
        }
        const failed = results.filter((r) => !r.ok).length
        const skipped = results.filter((r) => r.skipped).length
        res.writeHead(failed > 0 && !dryRun ? 207 : 200, {
          'content-type': 'application/json; charset=utf-8',
        })
        res.end(
          JSON.stringify({
            applied: results.filter((r) => r.applied).length,
            skipped,
            failed,
            results,
          }),
        )
        return true
      }

      // ---- 批量：后台执行 ----
      imageApplyTask.running = true
      imageApplyTask.targets = [...targets]
      imageApplyTask.total = targets.length
      imageApplyTask.completed = 0
      imageApplyTask.results = []
      imageApplyTask.startedAt = Date.now()
      imageApplyTask.finishedAt = null

      ;(async () => {
        for (const address of targets) {
          try {
            const result = await userService.applyImageVersion(address, { image: targetImage })
            imageApplyTask.results.push({ address, ok: true, ...result })
          } catch (err) {
            // 单个失败不中断整轮：批量场景必须把其余租户处理完
            imageApplyTask.results.push({
              address,
              ok: false,
              error: err.message,
              backupPath: err.backupPath,
            })
          }
          imageApplyTask.completed += 1
        }
        imageApplyTask.running = false
        imageApplyTask.finishedAt = Date.now()
        const failed = imageApplyTask.results.filter((r) => !r.ok).length
        console.log(`[dsh] apply finished: ${targets.length - failed}/${targets.length} ok`)
      })()

      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          started: true,
          total: targets.length,
          message: '应用任务已开始，请轮询 GET /api/admin/dsh/apply 查看进度',
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  return false
}
