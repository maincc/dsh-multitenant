/**
 * 用户域路由 · 档案与配额（refactor-giant-files P1 迁入，源 user.routes.js 末两支）
 *
 * ⚠️ 注册序红线：DETAIL 是 /api/user/ 兜底 catch-all（match 函数），必须排在全部
 * 精确路径之后——原 if 链靠物理先后达成同一语义，注册表时代靠 USER_ROUTES 聚合序
 * 达成（credential-status/tenant-config 等若排在它后面会永远被它先吃掉成 400）。
 */

import { CONFIG } from '../../config/config.js'
import { userService } from '../../services/user.service.js'
import { dataService } from '../../services/data.service.js'
import { getAdminSession, getRequestAddress } from '../../middleware/auth.middleware.js'
import { validateSwtcAddress } from '../../middleware/validate.middleware.js'
import { credentialService } from '../../services/credential.service.js'
import { normalizeAddress } from '../../utils/address.js'
import { NotFoundError, handleError } from '../../utils/errors.js'
import { parseBody } from '../../utils/parse-body.js'
import { defineRoute } from '../registry.js'

/** 原 catch-all 的排除语义逐字保留（/restart /reset /remove /stop 归 tenant.routes 域） */
function isUserDetailPath(path) {
  return (
    path.startsWith('/api/user/') &&
    !path.endsWith('/restart') &&
    !path.endsWith('/reset') &&
    !path.endsWith('/remove') &&
    !path.endsWith('/stop')
  )
}

export const USER_PROFILE_ROUTES = [
  // POST /api/upgrade/:address - 调整用户配额（升/降双向；立即 stop→update→start 目标容器）
  defineRoute({
    method: 'POST',
    prefix: '/api/upgrade/',
    guard: 'admin',
    signOp: 'user-upgrade',
    note: '2026-10 审计：会当场重启他人正在用的容器（危害=force-stop 同级），CSRF/误触面最重漏网端点补齐当场签名；本域 attach 自挂（非全局装配面，原 dynamic-import 保留）',
    handler: async (req, res, path) => {
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

        // 签名绑定 address:tier——防"签 1 档执行 3 档"偷换；操作进审计。
        const { requireAdminSignature, attachAdminSignature } =
          await import('../../middleware/admin-signature.middleware.js')
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
    },
  }),

  // GET /api/user/:address - 获取单个用户详情
  // 排除 /restart /reset /remove /stop 路径（由 tenant.routes 处理）
  defineRoute({
    method: null, // 原分支不查 method，行为对齐
    match: isUserDetailPath,
    guard: 'public',
    note: '三态可见性是数据面判权（匿名=脱敏壳；本人/管理员=全量；登录非本人=403），判定在 handler 原位——2026-10 P1-3 收紧判例',
    handler: async (req, res, path) => {
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
          res.end(
            JSON.stringify({ address, exists: false, status: 'none', code: 'USER_NOT_FOUND' }),
          )
        } else {
          handleError(err, res)
        }
      }
      return true
    },
  }),
]
