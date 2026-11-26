/**
 * 管理域路由 · 网关与可达性（refactor-giant-files P1 首批迁入，源 admin.routes.js）
 *
 * tenant-url（管理员代开租户：一次性 gateway_ticket）、gateway-ports（隧道同步面）、
 * docker/status（2026-10 审计收紧为管理员专用的基础设施探活）。
 * gateway-ports 的守卫是"现场信任"而非签名（脚本签不了名），故 guard='custom'
 * ——回环直放 / 远程须 Bearer TUNNEL_SYNC_TOKEN，双不满足 404 不泄网络地图。
 */

import { CONFIG } from '../../config/config.js'
import { userService } from '../../services/user.service.js'
import { dockerService } from '../../services/docker.service.js'
import { tenantGateway } from '../../services/tenant-proxy.service.js'
import { validateSwtcAddress } from '../../middleware/validate.middleware.js'
import { normalizeAddress } from '../../utils/address.js'
import { publicScheme, publicEntryPort } from '../../utils/public-endpoint.js'
import { defineRoute } from '../registry.js'
import { timingSafeEqual } from 'node:crypto'

/** 隧道同步面的现场信任门禁（原分支首段逐字迁入） */
function tunnelGuard(req, res) {
  const remote = String(req.socket?.remoteAddress || '')
  const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
  let tokenOk = false
  const token = String(process.env.TUNNEL_SYNC_TOKEN || CONFIG.server.tunnelSyncToken || '')
  const bearer = String(req.headers.authorization || '')
  if (token && bearer.startsWith('Bearer ')) {
    const a = Buffer.from(bearer.slice(7))
    const b = Buffer.from(token)
    tokenOk = a.length === b.length && timingSafeEqual(a, b)
  }
  if (!isLoopback && !tokenOk) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'not found', code: 'NOT_FOUND' }))
    return false
  }
  return true
}

export const GATEWAY_ROUTES = [
  // GET /api/admin/tenant-url?address= - 管理员代开租户容器（网关门禁凭证）
  // 返回带一次性 gateway_ticket 的 URL：浏览器首次访问该 URL 即换取该租户会话并放行
  defineRoute({
    method: 'GET',
    path: '/api/admin/tenant-url',
    guard: 'admin',
    handler: async (req, res, path, url) => {
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
          url: `${publicScheme(req)}://${PUBLIC_HOST}:${user.port}/?gateway_ticket=${ticket}`,
          address,
          port: user.port,
        }),
      )
      return true
    },
  }),

  // GET /api/admin/gateway-ports - 隧道同步面（2026-11-12）：一次性给出全部已分配
  // 租户网关端口 + 对外形态声明，供隧道侧脚本轮询并调 frpc admin API 自动补口——
  // 新租户上线不再需要人肉改 frpc 配置。门禁走"现场信任"而非签名（脚本签不了名）：
  //   ① 回环来源（隧道客户端与平台同机部署的常态）直接放行；
  //   ② 远程来源须带 Bearer TUNNEL_SYNC_TOKEN（env 或 config.server.tunnelSyncToken）。
  // 两者都不满足 → 404（与不存在同形，不向站外泄露"端口+地址"这张网络地图）。
  defineRoute({
    method: 'GET',
    path: '/api/admin/gateway-ports',
    guard: 'custom',
    customGuard: tunnelGuard,
    note: '非签名门禁是刻意设计（隧道脚本无钱包）；对站外伪装 404 防网络地图泄露',
    handler: async (req, res) => {
      const ports = []
      for (const [address, u] of Object.entries(userService.state.swtcUsers || {})) {
        if (Number.isInteger(u.port) && u.port > 0) {
          ports.push({ address, port: u.port, status: u.containerStatus || 'unknown' })
        }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: true,
          ports,
          // 占用账本（2026-11-14）：发号探针发现的**非本服务**监听占用
          // （混段部署里"谁占了哪号"直接看这里，不必 ss 全表对）
          occupied: Object.values(userService.state.externalOccupations || {}),
          ranges: (() => {
            const { pub, internal } = userService.tenantPortRanges()
            return {
              public: [pub.base, pub.max],
              internal: internal ? [internal.base, internal.max] : null,
            }
          })(),
          entry: {
            host: process.env.PUBLIC_HOST || CONFIG.server.publicHost,
            port: publicEntryPort(),
            scheme: publicScheme(req),
          },
        }),
      )
      return true
    },
  }),

  // GET /api/docker/status - 检查 Docker 状态
  defineRoute({
    method: null, // 原分支不查 method，行为对齐
    path: '/api/docker/status',
    guard: 'admin',
    note: '2026-10 审计：匿名探测 Docker 可用性（基础设施指纹）收紧为管理员专用',
    handler: async (req, res) => {
      try {
        const available = await dockerService.isDockerAvailable()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ available, timestamp: Date.now() }))
      } catch (err) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ available: false, error: err.message, timestamp: Date.now() }))
      }
      return true
    },
  }),
]
