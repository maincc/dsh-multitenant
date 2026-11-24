/**
 * 管理域路由 · 数据卷与磁盘（refactor-giant-files P1 二批迁入，源 admin.routes.js）
 *
 * 孤儿卷"实时重算、绝不信任前端列表"的判定真源（collectOrphanVolumes）随两个
 * 孤儿卷端点一起迁入。批量删卷/删单卷都是不可逆 → ADMIN_SIGNED_OPERATIONS 在册，
 * 现注册时即校验 op 拼写。
 */

import { userService } from '../../services/user.service.js'
import { dockerService } from '../../services/docker.service.js'
import { dataService } from '../../services/data.service.js'
import { getAdminSession } from '../../middleware/auth.middleware.js'
import { requireAdminSignature } from '../../middleware/admin-signature.middleware.js'
import { validateSwtcAddress } from '../../middleware/validate.middleware.js'
import { normalizeAddress } from '../../utils/address.js'
import { handleError } from '../../utils/errors.js'
import { parseBody } from '../../utils/parse-body.js'
import { defineRoute } from '../registry.js'

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

export const VOLUMES_ROUTES = [
  // GET /api/admin/orphan-volumes - 列出孤儿数据卷
  // 判定：dsh-data-swtc-* 前缀 + 不属于任何 state 用户 + 无任何容器（含已停止）挂载引用
  defineRoute({
    method: 'GET',
    path: '/api/admin/orphan-volumes',
    guard: 'admin',
    handler: async (_req, res) => {
      try {
        const orphans = await collectOrphanVolumes()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, orphanVolumes: orphans, total: orphans.length }))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/admin/cleanup-orphan-volumes - 删除孤儿数据卷
  // 批量删数据是不可逆操作 → 与 delete-volume 同规格：除会话外还要求**当场签名**，
  // 且签的内容绑定"删哪几个卷"（规范化去重+排序）。执行时只删
  // 【签名清单 ∩ 当前仍是孤儿的卷】——清单里已被认领/回收的进 skipped，绝不扩大。
  defineRoute({
    method: 'POST',
    path: '/api/admin/cleanup-orphan-volumes',
    guard: 'admin',
    signOp: 'cleanup-orphan-volumes',
    handler: async (req, res) => {
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
    },
  }),

  // POST /api/admin/delete-volume/:address - 删除数据卷
  defineRoute({
    method: 'POST',
    prefix: '/api/admin/delete-volume/',
    guard: 'admin',
    signOp: 'delete-volume',
    note: '删除数据卷不可逆 → 要求当场签名',
    handler: async (req, res, path) => {
      let address = path.slice('/api/admin/delete-volume/'.length)
      if (!validateSwtcAddress(address, res)) return

      address = normalizeAddress(address)

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
    },
  }),

  // POST /api/admin/disk-scan - 精确扫描租户卷真实占用（du 实测）
  defineRoute({
    method: 'POST',
    path: '/api/admin/disk-scan',
    guard: 'admin',
    handler: async (_req, res) => {
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
    },
  }),
]
