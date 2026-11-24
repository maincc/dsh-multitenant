/**
 * 技能市场域路由（refactor-giant-files P1 迁入，源 skill.routes.js）
 *
 * 鉴权三谱（注册面如实声明，成因注释在 note）：
 *   - guard:'admin'            —— /admin 列表、:name/hide（hide 另加当场签名）
 *   - guard:'public'+handler 内钱包签名 —— publish/import/install/uninstall/mine POST/DELETE
 *     （挑战-响应，SKILLS 用途池；"public" 仅指免会话，验签在 skillService.authenticate）
 *   - guard:'public'+handler 内归属闸 —— GET /api/skills、GET /mine（S1 修复判例：
 *     此前匿名+任意地址可枚举他人安装记录并触发对受害者卷的探测/销账）
 *
 * 顺序红线：精确端点（challenge/publish/import/mine/admin/列表）必须先于
 * :name 通配注册——原注释"必须先于 :name 匹配"的注册表时代等价物。
 */

import { skillService } from '../../services/skill.service.js'
import { tenantConfigService, SIGN_PURPOSE } from '../../services/tenant-config.service.js'
import {
  requireAdmin,
  getAdminSession,
  getRequestAddress,
} from '../../middleware/auth.middleware.js'
import { validateSwtcAddress } from '../../middleware/validate.middleware.js'
import { normalizeAddress } from '../../utils/address.js'
import { credentialService } from '../../services/credential.service.js'
import { handleError } from '../../utils/errors.js'
import { parseBody, parseJsonBody } from '../../utils/parse-body.js'
import { defineRoute } from '../registry.js'

const PREFIX = '/api/skills'

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

/**
 * 钱包签名鉴权：校验地址格式 + 消费挑战 + 验签。
 * 成功返回规范化地址；失败已发响应，返回 null。
 */
async function authenticate(body, res) {
  if (!body || !validateSwtcAddress(body.address, res)) return null
  try {
    return skillService.authenticate(body.address, {
      nonce: body.nonce,
      signature: body.signature,
      publicKey: body.publicKey,
    })
  } catch (err) {
    handleError(err, res)
    return null
  }
}

/** 从 /api/skills/<name>[/…] 取段并做 kebab 校验（原 catch-all 块首段逐字迁入） */
function parseName(path, res) {
  const segs = path.slice(PREFIX.length + 1).split('/')
  const name = decodeURIComponent(segs[0])
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    send(res, 404, { error: `技能 ${name} 不存在或已下架`, code: 'NOT_FOUND' })
    return null
  }
  return { name, segs }
}

export const SKILL_ROUTES = [
  // POST /api/skills/challenge - 领取钱包签名挑战（与 config-challenge 同模式）
  defineRoute({
    method: 'POST',
    path: `${PREFIX}/challenge`,
    guard: 'public',
    note: 'SKILLS 用途池挑战发放（免会话是挑战前门）',
    handler: async (req, res) => {
      const body = await parseJsonBody(req, res)
      if (!body) return true
      if (!validateSwtcAddress(body.address, res)) return true
      const challenge = tenantConfigService.issueChallenge(body.address, SIGN_PURPOSE.SKILLS)
      if (!challenge) {
        send(res, 503, { error: '挑战发放过载，请稍后重试', code: 'OVERLOAD' })
        return true
      }
      // message 是交给钱包签的用途绑定内容（hex）；要签的是它，不是 nonce
      send(res, 200, { ok: true, nonce: challenge.nonce, message: challenge.message })
      return true
    },
  }),

  // POST /api/skills/publish - 从签名地址的卷提取技能并发布到市场
  defineRoute({
    method: 'POST',
    path: `${PREFIX}/publish`,
    guard: 'public',
    note: '钱包签名在 handler 内 authenticate（SKILLS 用途）',
    handler: async (req, res) => {
      const body = await parseJsonBody(req, res)
      const address = await authenticate(body, res)
      if (!address) return true
      try {
        const entry = await skillService.publish(address, body.skillName, {
          renameTo: body.renameTo,
        })
        send(res, 200, { ok: true, skill: entry })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/skills/import - 把用户提供的技能写入自己的卷（不入市场）
  defineRoute({
    method: 'POST',
    path: `${PREFIX}/import`,
    guard: 'public',
    note: '钱包签名在 handler 内 authenticate',
    handler: async (req, res) => {
      const body = await parseJsonBody(req, res)
      const address = await authenticate(body, res)
      if (!address) return true
      try {
        const result = await skillService.importSkill(
          address,
          body.skillName,
          typeof body.content === 'string' ? body.content : '',
        )
        send(res, 200, { ok: true, ...result })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // ---- 我的 ----
  // POST /api/skills/mine - 我的发布 + 我的安装（注意：必须先于 :name 匹配）
  defineRoute({
    method: 'POST',
    path: `${PREFIX}/mine`,
    guard: 'public',
    note: '钱包签名在 handler 内 authenticate',
    handler: async (req, res) => {
      const body = await parseJsonBody(req, res)
      const address = await authenticate(body, res)
      if (!address) return true
      try {
        const mine = await skillService.mine(address)
        send(res, 200, { ok: true, ...mine })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // ---- 我的（视图，本人会话即可，无需签名）----
  // GET /api/skills/mine?address= - 我的发布 + 我的安装（个人视图；须先于 :name 匹配）
  // S1 修复（2026-11-12 审计）：此面此前匿名+任意地址可读——不止泄他人安装/发布
  // 记录，mineView 还会【挂目标容器卷做实物探测】并【就地销账 removeInstallRecord】：
  // 攻击者拿任意地址即可枚举谁装了什么 + 反复触发对受害者卷的 docker 执行 +
  // 写侧篡改他人安装账。个人数据面按 tenant-config GET 同判例：仅本人（会话地址
  // ===目标）或管理员可读；地址格式校验保留。
  defineRoute({
    method: 'GET',
    path: `${PREFIX}/mine`,
    guard: 'public',
    note: '归属闸在 handler 原位（本人或管理员，S1 判例）',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`)
        const address = url.searchParams.get('address')
        if (!address || !/^j[1-9A-HJ-NP-Za-km-zl]{29,34}$/.test(address)) {
          send(res, 400, { error: 'address 参数非法', code: 'BAD_REQUEST' })
          return true
        }
        const target = normalizeAddress(address)
        const session = getRequestAddress(req)
        if (session !== target && !(session && credentialService.isAdmSync(session))) {
          send(res, 403, { error: '只能查看自己的技能视图', code: 'FORBIDDEN' })
          return true
        }
        const mine = await skillService.mineView(target)
        send(res, 200, { ok: true, ...mine })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // ---- 管理列表 ----
  // GET /api/skills/admin - 全量管理视图（含 removed 与安装数）
  defineRoute({
    method: 'GET',
    path: `${PREFIX}/admin`,
    guard: 'admin',
    handler: async (_req, res) => {
      try {
        const skills = await skillService.adminList()
        send(res, 200, { ok: true, skills })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // ---- 公开列表 ----
  // GET /api/skills?address= - 市场列表（可选标记已安装）
  // S1 修复（同上判例）：列表本体公开，但 address 标记位会【探目标容器卷】读他人
  // 安装名单——非本人/管理员的 address 一律忽略（不探卷、不泄标记）。
  defineRoute({
    method: 'GET',
    path: PREFIX,
    guard: 'public',
    note: '市场列表公开；address 标记位的归属闸在 handler 原位（S1 判例）',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`)
        const rawAddr = url.searchParams.get('address') || undefined
        let address
        if (rawAddr) {
          const session = getRequestAddress(req)
          if (
            session === normalizeAddress(rawAddr) ||
            (session && credentialService.isAdmSync(session))
          ) {
            address = rawAddr
          }
        }
        const skills = await skillService.list({ address })
        send(res, 200, { ok: true, skills })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // ---- /api/skills/:name[/action]（catch-all 族，注册在精确端点之后=原"先于 :name"序） ----
  // GET /api/skills/:name - 详情（全文预览）
  defineRoute({
    method: 'GET',
    pattern: /^\/api\/skills\/[^/]+$/,
    guard: 'public',
    handler: async (_req, res, path) => {
      const parsed = parseName(path, res)
      if (!parsed) return true
      try {
        const detail = await skillService.detail(parsed.name)
        send(res, 200, { ok: true, skill: detail })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // DELETE /api/skills/:name - 取消共享（作者签名 或 管理员 cookie）
  defineRoute({
    method: 'DELETE',
    pattern: /^\/api\/skills\/[^/]+$/,
    guard: 'public',
    note: '双通道判权在 handler 原位：管理员走会话，作者走钱包签名',
    handler: async (req, res, path) => {
      const parsed = parseName(path, res)
      if (!parsed) return true
      const { name } = parsed
      const session = getAdminSession(req)
      const adm = Boolean(session) && credentialService.isAdmSync(session)
      let operator = null
      if (adm) {
        operator = session
      } else {
        const body = await parseJsonBody(req, res)
        operator = await authenticate(body, res)
      }
      if (!operator) return true
      try {
        const entry = await skillService.unpublish(operator, name, { admin: adm })
        send(res, 200, { ok: true, skill: entry })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // GET /api/skills/:name/download - 导出为 Markdown 文件
  defineRoute({
    method: 'GET',
    pattern: /^\/api\/skills\/[^/]+\/download$/,
    guard: 'public',
    handler: async (_req, res, path) => {
      const parsed = parseName(path, res)
      if (!parsed) return true
      try {
        const dl = await skillService.download(parsed.name)
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${dl.fileName}"`,
        })
        res.end(dl.body)
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/skills/:name/install - 安装到签名地址自己的卷
  defineRoute({
    method: 'POST',
    pattern: /^\/api\/skills\/[^/]+\/install$/,
    guard: 'public',
    note: '钱包签名在 handler 内 authenticate',
    handler: async (req, res, path) => {
      const parsed = parseName(path, res)
      if (!parsed) return true
      const body = await parseJsonBody(req, res)
      const address = await authenticate(body, res)
      if (!address) return true
      try {
        const entry = await skillService.install(address, parsed.name)
        send(res, 200, { ok: true, skill: entry })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/skills/:name/uninstall - 从签名地址自己的卷卸载
  defineRoute({
    method: 'POST',
    pattern: /^\/api\/skills\/[^/]+\/uninstall$/,
    guard: 'public',
    note: '钱包签名在 handler 内 authenticate',
    handler: async (req, res, path) => {
      const parsed = parseName(path, res)
      if (!parsed) return true
      const body = await parseJsonBody(req, res)
      const address = await authenticate(body, res)
      if (!address) return true
      try {
        const result = await skillService.uninstall(address, parsed.name)
        send(res, 200, { ok: true, ...result })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/skills/:name/hide - 管理员下架
  // 审查 H3（2026-11-06）：下架会把作者正文移出共享仓，此前只凭会话 cookie——
  // 同站 CSRF 即毁他人技能。补会话+当场钱包签名双门禁（binding 锁技能名，防
  // "签 A 执行 B"）；attach 本域自挂（profile.routes 同款先例，非全局装配面）。
  defineRoute({
    method: 'POST',
    pattern: /^\/api\/skills\/[^/]+\/hide$/,
    guard: 'admin',
    signOp: 'skill-hide',
    handler: async (req, res, path) => {
      const parsed = parseName(path, res)
      if (!parsed) return true
      const { requireAdminSignature, attachAdminSignature } =
        await import('../../middleware/admin-signature.middleware.js')
      attachAdminSignature(req)
      if (
        !requireAdminSignature(req, res, 'skill-hide', { name: parsed.name }, getAdminSession(req))
      )
        return true
      try {
        const entry = await skillService.unpublish(
          req.headers.cookie ? getAdminSession(req) : '',
          parsed.name,
          {
            admin: true,
          },
        )
        send(res, 200, { ok: true, skill: entry })
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // :name 族未匹配的形态（段数>2 / 未知 action / 合法名段但方法不合，如 PUT /api/skills/foo）
  // → 原 catch-all 尾部的 404。用 match 覆盖整个 /api/skills/ 前缀并注册最后：
  // 原代码里凡 /api/skills/* 必进 startsWith 块、必 send 404（恒"已处理"），
  // 若这里用具体 pattern 会漏接怪方法单段路径造成 fallthrough——语义红线，逐字对齐。
  defineRoute({
    method: null,
    match: (p) => p.startsWith(PREFIX + '/'),
    guard: 'public',
    note: '前缀兜底 404：原块尾 send(res,404)。必须注册于全部具体路由之后（first-match-wins）',
    handler: async (_req, res, path) => {
      const parsed = parseName(path, res)
      if (!parsed) return true
      send(res, 404, { error: 'Not found', code: 'NOT_FOUND' })
      return true
    },
  }),
]
