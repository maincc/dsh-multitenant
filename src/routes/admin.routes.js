/**
 * 管理路由模块
 */

import { CONFIG, isAdmin } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { dataService } from '../services/data.service.js'
import { dockerService } from '../services/docker.service.js'
import { cwtAdminService } from '../services/cwt-admin.service.js'
import { tenantConfigService } from '../services/tenant-config.service.js'
import { tenantGateway } from '../services/tenant-proxy.service.js'
import { requireAdmin, getAdminSession, adminSessionStore } from '../middleware/auth.middleware.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { normalizeAddress } from '../utils/address.js'
import { BadRequestError, NotFoundError, handleError } from '../utils/errors.js'
import { parseBody } from '../utils/parse-body.js'

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
  // POST /api/admin/challenge - 领取一次性签名挑战（security-hardening-plan P0-1）
  if (path === '/api/admin/challenge' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      const { address } = JSON.parse(body || '{}')
      if (!validateSwtcAddress(address, res)) return true
      const nonce = tenantConfigService.issueChallenge(normalizeAddress(address))
      if (!nonce) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '挑战发放过载，请稍后重试', code: 'OVERLOAD' }))
        return true
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, nonce }))
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

      // ① 验签：nonce 签名有效且公钥推导地址 === 声称地址
      if (!tenantConfigService.verifySignature(addrLower, nonce, signature, publicKey)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '签名验证失败', code: 'FORBIDDEN' }))
        return true
      }
      // ② 挑战一次性（不可重放）
      if (!tenantConfigService.consumeChallenge(addrLower, nonce)) {
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
    if (match) {
      try {
        adminSessionStore.revoke(decodeURIComponent(match[1]))
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
  if (path === '/api/admin/cleanup-orphan-volumes' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    try {
      const orphans = await collectOrphanVolumes()
      const removed = []
      const failed = []
      for (const volume of orphans) {
        try {
          await dockerService.removeVolume(volume)
          removed.push(volume)
        } catch (err) {
          failed.push({ name: volume, error: err.message })
        }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, removed, failed, total: orphans.length }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // POST /api/admin/promote/:address - 提权用户为管理员
  if (path.startsWith('/api/admin/promote/') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true

    let address = path.slice('/api/admin/promote/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    // 添加到管理员列表（运行时 + 持久化）
    const added = dataService.addAdmin(address, getAdminSession(req) || 'system')

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
      const users = await userService.getAllUsers()
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
    res.end(JSON.stringify(stats))
    return true
  }

  // POST /api/admin/force-stop/:address - 强制下线容器
  if (path.startsWith('/api/admin/force-stop/') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return

    let address = path.slice('/api/admin/force-stop/'.length)
    if (!validateSwtcAddress(address, res)) return

    address = normalizeAddress(address)

    try {
      const result = await userService.forceStopContainer(address)
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
    try {
      const adminAddr = getAdminSession(req)
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
    try {
      const adminAddr = getAdminSession(req)
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
    try {
      const adminAddr = getAdminSession(req)
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

      const { records, hasMore } = cwtAdminService.listRecords(limit, offset)
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

    try {
      const result = await userService.deleteUserVolume(address)
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

  return false
}
