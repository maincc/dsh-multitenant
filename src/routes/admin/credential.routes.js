/**
 * 管理域路由 · v1.4 凭证体系与 CWT 审批（refactor-giant-files P1 迁入，源 admin.routes.js）
 *
 * 台账浏览/申请单列表为纯读取（admin 守卫，免签）；批准/拒绝是签发解除凭证的
 * 改变世界动作 → 当场签名。approve/reject 的绑定序（判例区）：先按 id 查申请单，
 * **申请人地址由服务端从库里取出并入 binding**——前端传了也只当展示，绑定的以库为准。
 */

import { credentialService } from '../../services/credential.service.js'
import { dataService } from '../../services/data.service.js'
import { getAdminSession } from '../../middleware/auth.middleware.js'
import { requireAdminSignature } from '../../middleware/admin-signature.middleware.js'
import { handleError } from '../../utils/errors.js'
import { parseBody } from '../../utils/parse-body.js'
import { defineRoute } from '../registry.js'

export const CREDENTIAL_ROUTES = [
  // GET /api/admin/credentials?kind=did|cwt|admin|all&q=<地址片段>&limit&offset - 凭证台账浏览
  // 三类卡制式（2026-10-23 用户拍板）：admin=cwt∧roles∋admin 独立档；cwt 档=纯解限剔除 admin
  defineRoute({
    method: 'GET',
    path: '/api/admin/credentials',
    guard: 'admin',
    handler: async (_req, res, path, url) => {
      const kind = url.searchParams.get('kind') || 'all'
      const q = (url.searchParams.get('q') || '').slice(0, 64)
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20))
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
      try {
        const r = await credentialService.listCredentials({ kind, q, limit, offset })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            credentials: r.items,
            total: r.total,
            limit,
            offset,
            hasMore: offset + r.items.length < r.total,
          }),
        )
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // GET /api/admin/cwt-applications?status=pending|approved|rejected|all&limit&offset
  defineRoute({
    method: 'GET',
    path: '/api/admin/cwt-applications',
    guard: 'admin',
    handler: async (_req, res, path, url) => {
      const status = url.searchParams.get('status') || 'pending'
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10))
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
      try {
        const r = await credentialService.listApplications({ status, limit, offset })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            applications: r.items,
            total: r.total,
            limit,
            offset,
            hasMore: offset + r.items.length < r.total,
          }),
        )
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/admin/cwt-applications/:id/approve - 批准=签发 CWT 解限凭证
  // 签名绑定 {id, address}：address 由服务端按申请单查出（前端传了也只当展示，绑定的以库为准）
  defineRoute({
    method: 'POST',
    pattern: /^\/api\/admin\/cwt-applications\/[^/]+\/approve$/,
    guard: 'admin',
    signOp: 'cwt/approve',
    handler: async (req, res, path) => {
      const id = decodeURIComponent(path.split('/')[4])
      const app = await credentialService._findApp(id)
      if (!app) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '申请不存在', code: 'NOT_FOUND' }))
        return true
      }
      if (
        !requireAdminSignature(
          req,
          res,
          'cwt/approve',
          { id, address: app.address },
          getAdminSession(req),
        )
      ) {
        return true
      }
      try {
        const out = await credentialService.approveApplication(id, getAdminSession(req))
        dataService.logOperation('admin_cwt_approve', {
          operator: getAdminSession(req),
          id,
          address: app.address,
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/admin/cwt-applications/:id/reject - 拒绝（同样当场签名绑定单号+申请人）
  defineRoute({
    method: 'POST',
    pattern: /^\/api\/admin\/cwt-applications\/[^/]+\/reject$/,
    guard: 'admin',
    signOp: 'cwt/reject',
    handler: async (req, res, path) => {
      const id = decodeURIComponent(path.split('/')[4])
      const app = await credentialService._findApp(id)
      if (!app) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '申请不存在', code: 'NOT_FOUND' }))
        return true
      }
      if (
        !requireAdminSignature(
          req,
          res,
          'cwt/reject',
          { id, address: app.address },
          getAdminSession(req),
        )
      ) {
        return true
      }
      let reason = ''
      try {
        reason = (JSON.parse((await parseBody(req)) || '{}').reason || '').slice(0, 300)
      } catch {
        reason = ''
      }
      try {
        const out = await credentialService.rejectApplication(id, getAdminSession(req), reason)
        dataService.logOperation('admin_cwt_reject', {
          operator: getAdminSession(req),
          id,
          address: app.address,
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),
]
