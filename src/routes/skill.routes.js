/**
 * 技能市场路由模块（挂载点：/api/skills/*，见 server.js）
 *
 * 鉴权分层：
 *   - 公开（无需鉴权）：GET 列表 / 详情 / 下载
 *   - 钱包签名（挑战-响应，同 tenant-config 模式）：publish / import / install /
 *     uninstall / mine / DELETE（作者取消共享）
 *   - 管理员 cookie：/admin（列表）、/:name/hide（下架）、DELETE（代下架）
 */

import { skillService } from '../services/skill.service.js'
import { tenantConfigService } from '../services/tenant-config.service.js'
import { requireAdmin, getAdminSession } from '../middleware/auth.middleware.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { isAdmin } from '../config/config.js'
import { handleError } from '../utils/errors.js'

const PREFIX = '/api/skills'

/**
 * 解析请求体
 */
function parseBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

/**
 * 安全解析 JSON 请求体（非法 JSON 返回 400）
 */
async function parseJsonBody(req, res) {
  try {
    return JSON.parse((await parseBody(req)) || '{}')
  } catch {
    send(res, 400, { error: 'Invalid JSON body', code: 'BAD_REQUEST' })
    return null
  }
}

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

/**
 * 处理技能市场路由
 */
export async function handleSkillRoutes(req, res, path) {
  // ---- 挑战 ----
  // POST /api/skills/challenge - 领取钱包签名挑战（与 config-challenge 同模式）
  if (path === `${PREFIX}/challenge` && req.method === 'POST') {
    const body = await parseJsonBody(req, res)
    if (!body) return true
    if (!validateSwtcAddress(body.address, res)) return true
    send(res, 200, { ok: true, nonce: tenantConfigService.issueChallenge(body.address) })
    return true
  }

  // ---- 发布 ----
  // POST /api/skills/publish - 从签名地址的卷提取技能并发布到市场
  if (path === `${PREFIX}/publish` && req.method === 'POST') {
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
  }

  // ---- 本地导入 ----
  // POST /api/skills/import - 把用户提供的技能写入自己的卷（不入市场）
  if (path === `${PREFIX}/import` && req.method === 'POST') {
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
  }

  // ---- 我的 ----
  // POST /api/skills/mine - 我的发布 + 我的安装（注意：必须先于 :name 匹配）
  if (path === `${PREFIX}/mine` && req.method === 'POST') {
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
  }

  // ---- 我的（视图，无需签名）----
  // GET /api/skills/mine?address= - 我的发布 + 我的安装（个人视图；须先于 :name 匹配）
  if (path === `${PREFIX}/mine` && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`)
      const address = url.searchParams.get('address')
      if (!address || !/^j[1-9A-HJ-NP-Za-km-zl]{29,34}$/.test(address)) {
        send(res, 400, { error: 'address 参数非法', code: 'BAD_REQUEST' })
        return true
      }
      const mine = await skillService.mineView(address)
      send(res, 200, { ok: true, ...mine })
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // ---- 管理列表 ----
  // GET /api/skills/admin - 全量管理视图（含 removed 与安装数）
  if (path === `${PREFIX}/admin` && req.method === 'GET') {
    if (!requireAdmin(req, res)) return true
    try {
      const skills = await skillService.adminList()
      send(res, 200, { ok: true, skills })
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // ---- 公开列表 ----
  // GET /api/skills?address= - 市场列表（可选标记已安装）
  if (path === PREFIX && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`)
      const address = url.searchParams.get('address') || undefined
      const skills = await skillService.list({ address })
      send(res, 200, { ok: true, skills })
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // ---- /api/skills/:name[/action] ----
  if (path.startsWith(`${PREFIX}/`)) {
    const segs = path.slice(PREFIX.length + 1).split('/')
    const name = decodeURIComponent(segs[0])
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      send(res, 404, { error: `技能 ${name} 不存在或已下架`, code: 'NOT_FOUND' })
      return true
    }

    // GET /api/skills/:name - 详情（全文预览）
    if (segs.length === 1 && req.method === 'GET') {
      try {
        const detail = await skillService.detail(name)
        send(res, 200, { ok: true, skill: detail })
      } catch (err) {
        handleError(err, res)
      }
      return true
    }

    // DELETE /api/skills/:name - 取消共享（作者签名 或 管理员 cookie）
    if (segs.length === 1 && req.method === 'DELETE') {
      const session = getAdminSession(req)
      const adm = Boolean(session) && isAdmin(session)
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
    }

    // GET /api/skills/:name/download - 导出为 Markdown 文件
    if (segs.length === 2 && segs[1] === 'download' && req.method === 'GET') {
      try {
        const dl = await skillService.download(name)
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${dl.fileName}"`,
        })
        res.end(dl.body)
      } catch (err) {
        handleError(err, res)
      }
      return true
    }

    // POST /api/skills/:name/install - 安装到签名地址自己的卷
    if (segs.length === 2 && segs[1] === 'install' && req.method === 'POST') {
      const body = await parseJsonBody(req, res)
      const address = await authenticate(body, res)
      if (!address) return true
      try {
        const entry = await skillService.install(address, name)
        send(res, 200, { ok: true, skill: entry })
      } catch (err) {
        handleError(err, res)
      }
      return true
    }

    // POST /api/skills/:name/uninstall - 从签名地址自己的卷卸载
    if (segs.length === 2 && segs[1] === 'uninstall' && req.method === 'POST') {
      const body = await parseJsonBody(req, res)
      const address = await authenticate(body, res)
      if (!address) return true
      try {
        const result = await skillService.uninstall(address, name)
        send(res, 200, { ok: true, ...result })
      } catch (err) {
        handleError(err, res)
      }
      return true
    }

    // POST /api/skills/:name/hide - 管理员下架
    if (segs.length === 2 && segs[1] === 'hide' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return true
      try {
        const entry = await skillService.unpublish(
          req.headers.cookie ? getAdminSession(req) : '',
          name,
          {
            admin: true,
          },
        )
        send(res, 200, { ok: true, skill: entry })
      } catch (err) {
        handleError(err, res)
      }
      return true
    }

    send(res, 404, { error: 'Not found', code: 'NOT_FOUND' })
    return true
  }

  return false
}
