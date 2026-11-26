/**
 * 管理域路由 · 用户与配额操作（refactor-giant-files P1 二批迁入，源 admin.routes.js）
 *
 * 名册任免（promote/demote/admins，v1.5 凭证联动）、全量列表与统计（带短缓存面）、
 * 强制下线。promote/demote/force-stop 是 ADMIN_SIGNED_OPERATIONS 在册破坏性操作——
 * 现由 signOp 字段在**注册时**校验白名单（原先要到运行时才发现 op 拼错）。
 * 签名检查仍在 handler 内：binding 依赖 body/path 解析结果（参数合法先于签名检查，
 * 不让人去签一个注定失败的操作——env-commit 处判例同款次序）。
 */

import { CONFIG, getAdminAddresses } from '../../config/config.js'
import { userService } from '../../services/user.service.js'
import { dataService } from '../../services/data.service.js'
import { credentialService } from '../../services/credential.service.js'
import { getAdminSession } from '../../middleware/auth.middleware.js'
import { requireAdminSignature } from '../../middleware/admin-signature.middleware.js'
import { validateSwtcAddress } from '../../middleware/validate.middleware.js'
import { normalizeAddress } from '../../utils/address.js'
import { handleError } from '../../utils/errors.js'
import { defineRoute } from '../registry.js'

export const USERS_ROUTES = [
  // POST /api/admin/promote/:address - 提权用户为管理员
  // 破坏性（持久化后门级别的操作）→ 除会话外还要求**当场钱包签名**
  defineRoute({
    method: 'POST',
    prefix: '/api/admin/promote/',
    guard: 'admin',
    signOp: 'promote',
    handler: async (req, res, path) => {
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

      // v1.5 任命联动凭证：admin-auto 升签 cwt+roles:['admin']（免申请免自审，
      // 对方下次登录 popup 引导领新卡；免时限随 cwt 链天然生效）。幂等——重复任命不重签。
      let credential = null
      try {
        credential = (
          await credentialService.provisionAdmin(address, getAdminSession(req) || 'system')
        ).credential
      } catch (err) {
        // 台账写失败不回滚名册（下次登录/对账自愈），但如实告知
        console.warn(
          `[admin] promote 凭证配发失败（名册已生效，对账自愈）: ${String(err?.message || err).slice(0, 140)}`,
        )
      }

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, address, promoted: added, credential }))
      return true
    },
  }),

  // POST /api/admin/demote/:address - 撤销管理员（没收管理凭证并重签降格，v1.5）
  // 破坏性 + 持久化 → 会话之外当场钱包签名（同 promote 双门禁）
  defineRoute({
    method: 'POST',
    prefix: '/api/admin/demote/',
    guard: 'admin',
    signOp: 'demote',
    handler: async (req, res, path) => {
      let address = path.slice('/api/admin/demote/'.length)
      if (!validateSwtcAddress(address, res)) return

      address = normalizeAddress(address)

      if (!requireAdminSignature(req, res, 'demote', { address }, getAdminSession(req))) {
        return true
      }

      // 防锁死：名册（config ∪ 运行时）里不能只剩这一个人
      const remaining = [...getAdminAddresses()].filter((a) => a !== address)
      if (remaining.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({ error: '这是最后一个管理员地址，撤销会把平台锁死', code: 'LAST_ADMIN' }),
        )
        return true
      }

      const removed = await dataService.removeAdmin(address, getAdminSession(req) || 'system')
      const demote = await credentialService.demoteAdmin(address, getAdminSession(req) || 'system')
      if (removed) {
        console.log(`[admin] demoted ${address} (credential → ${demote.to || 'noop'})`)
        dataService.logOperation('admin_demote', {
          address,
          operator: getAdminSession(req),
          to: demote.to || null,
        })
      }

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: true,
          address,
          removed,
          demotedTo: demote.to || null,
          credential: demote.credential || null,
        }),
      )
      return true
    },
  }),

  // GET /api/admin/admins - 管理名册与任免录像（v1.5，前端"系统管理→管理员任免"数据面）
  defineRoute({
    method: 'GET',
    path: '/api/admin/admins',
    guard: 'admin',
    handler: async (_req, res) => {
      const cfg = dataService.getAdminConfig()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          addresses: [...getAdminAddresses()],
          history: (cfg.history || []).slice(-50).reverse(),
        }),
      )
      return true
    },
  }),

  // GET /api/users - 获取所有用户列表 + 只读 tier 配置
  defineRoute({
    method: null, // 原分支不查 method，行为对齐
    path: '/api/users',
    guard: 'admin',
    handler: async (_req, res, path, url) => {
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
    },
  }),

  // GET /api/stats - 系统统计
  defineRoute({
    method: null, // 原分支不查 method，行为对齐
    path: '/api/stats',
    guard: 'admin',
    handler: async (_req, res) => {
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
    },
  }),

  // POST /api/admin/force-stop/:address - 强制下线容器
  defineRoute({
    method: 'POST',
    prefix: '/api/admin/force-stop/',
    guard: 'admin',
    signOp: 'force-stop',
    note: '会打断在用租户的会话 → 要求当场签名',
    handler: async (req, res, path) => {
      let address = path.slice('/api/admin/force-stop/'.length)
      if (!validateSwtcAddress(address, res)) return

      address = normalizeAddress(address)

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
    },
  }),
]
