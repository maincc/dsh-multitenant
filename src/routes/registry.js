/**
 * 路由守卫注册表（docs/refactor-giant-files.md §P1）
 *
 * ## 为什么存在
 *
 * admin/user/skill 三组路由原本是巨型 if-path 链（admin 41 个分支），守卫靠逐分支
 * 手挂——2026-11-10 审计 S1 的成因正是"大加固逐条补守卫，补了 user 漏了 skill"。
 * 本注册表把守卫变成**声明必填项**：
 *
 *   - 每条路由必须显式声明 guard：'public'（免鉴权，必须写出，review 一眼可见）
 *     | 'user'（user_session 会话门，判例 2026-10-30 单源身份）
 *     | 'admin'（requireAdmin）| 'custom'（自带 customGuard 函数，须写理由注释）
 *     ——'user'/'admin' 的拒绝响应文案在此单点定义（原 user.routes 里逐字重复 13
 *     次的 401 块是判例 58 型孪生，收敛掉）
 *   - 需要当场签名的操作声明 signOp，注册时即校验它在 ADMIN_SIGNED_OPERATIONS
 *     白名单内（运行时才知 → 注册时即知）
 *   - dispatch 统一"处理过必返 true"，消灭 return / return true 混风格
 *     （混风格今天无害——守卫失败前必已写响应；但它依赖隐式约定，换守卫就是
 *     fallthrough，见 fixlog 判例 58"半拉子不对称"母题）
 *
 * ## 语义红线（纯搬运的对齐基准）
 *
 *   - 匹配顺序 = 注册顺序，first-match-wins（与原 if 链一致；跨域无重叠匹配，
 *     域间顺序无关，域内保持原相对顺序）
 *   - 无 handler 抛错兜底：异常照常向 server.js 顶层 try/catch 传播——与原 if 链
 *     内抛出的路径逐字一致，dispatch 不加 catch（各 handler 保留自己的 try/catch）
 *   - rateLimit 先于 guard：仅 /api/admin/check 用到（原代码即首句限流），
 *     其余注册无此字段
 */

import { requireAdmin, getRequestAddress } from '../middleware/auth.middleware.js'
import { rateLimit } from '../middleware/rate-limit.middleware.js'
import { ADMIN_SIGNED_OPERATIONS } from '../middleware/admin-signature.middleware.js'

const GUARD_KINDS = new Set(['public', 'user', 'admin', 'custom'])

/**
 * 定义一条路由（纯函数式：不做全局副作用，域文件各自导出数组、index 汇总）。
 *
 * @param {object} def
 * @param {('GET'|'POST'|null)=} def.method   省略/null = 任意方法（原链部分分支不查 method，行为对齐）
 * @param {string=} def.path                   精确路径
 * @param {string=} def.prefix                 前缀匹配（原 path.startsWith 分支）
 * @param {RegExp=} def.pattern                正则匹配（原 regex 分支）
 * @param {(path:string, req)=>boolean=} def.match 函数匹配（兜底 catch-all 专用，如
 *        原 GET /api/user/:address 的 startsWith+排除后缀语义；必须注册在域表末尾）
 * @param {('public'|'admin'|'custom')} def.guard  守卫种类，必填
 * @param {(req,res,path,url)=>boolean|Promise<boolean>=} def.customGuard  guard='custom' 必填：
 *        返回 false = 已写拒绝响应，按已处理收敛
 * @param {{max?:number,windowMs?:number,keyPrefix?:string}=} def.rateLimit
 * @param {string=} def.signOp                 当场签名操作名（须在 ADMIN_SIGNED_OPERATIONS）
 * @param {(req,res,path,url)=>Promise<void>} def.handler
 * @param {string=} def.note                   设计成因备注（如"免签=隧道脚本签不了名"）
 */
export function defineRoute(def) {
  const tag = `${def?.method || '*'} ${def?.path || def?.prefix || String(def?.pattern || def?.match || '?')}`
  if (typeof def?.handler !== 'function') throw new Error(`[registry] ${tag}: handler 必填`)
  const matchers = ['path', 'prefix', 'pattern', 'match'].filter((k) => def[k] != null)
  if (matchers.length !== 1) {
    throw new Error(`[registry] ${tag}: path/prefix/pattern/match 必须恰好给一个`)
  }
  if (def.match != null && typeof def.match !== 'function') {
    throw new Error(`[registry] ${tag}: match 必须是 (path, req) => boolean 函数`)
  }
  if (def.pattern && !def.pattern.global) {
    // 注册正则一律锚定成 ^…$ 全串匹配由定义方负责；这里只挡明显忘锚的
    if (!def.pattern.source.startsWith('^') || !def.pattern.source.endsWith('$')) {
      throw new Error(`[registry] ${tag}: pattern 必须是 ^…$ 锚定的全串匹配`)
    }
  }
  if (!GUARD_KINDS.has(def.guard)) {
    throw new Error(`[registry] ${tag}: guard 必填且 ∈ public|admin|custom（给了 "${def.guard}"）`)
  }
  if (def.guard === 'custom' && typeof def.customGuard !== 'function') {
    throw new Error(`[registry] ${tag}: guard='custom' 必须附 customGuard 函数`)
  }
  if (def.signOp && !ADMIN_SIGNED_OPERATIONS.includes(def.signOp)) {
    throw new Error(`[registry] ${tag}: signOp "${def.signOp}" 不在 ADMIN_SIGNED_OPERATIONS 白名单`)
  }
  return Object.freeze(def)
}

/** 校验一组注册（index 汇总后调用；重复/交叠匹配在此抛） */
export function validateRoutes(routes) {
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i]
      const b = routes[j]
      const sameMatcher =
        (a.path != null && a.path === b.path) ||
        (a.prefix != null && a.prefix === b.prefix) ||
        (a.pattern != null && b.pattern != null && String(a.pattern) === String(b.pattern)) ||
        (a.match != null && a.match === b.match)
      // 方法交叠即重复注册：任一侧不限方法（null）都算覆盖另一侧的具体方法——
      // 原 if 链里"先写先吃"的静默遮蔽，在注册表时代必须显式报错
      const sameOrOverlapMethod = a.method == null || b.method == null || a.method === b.method
      if (sameMatcher && sameOrOverlapMethod) {
        throw new Error(
          `[registry] 重复/交叠注册：${a.method || '*'} ${a.path || a.prefix || a.pattern} ⟂ ` +
            `${b.method || '*'} ${b.path || b.prefix || b.pattern}`,
        )
      }
    }
  }
  return routes
}

function matches(def, method, path, req) {
  if (def.match != null) return !!def.match(path, req)
  if (def.path != null && path !== def.path) return false
  if (def.prefix != null && !path.startsWith(def.prefix)) return false
  if (def.pattern != null) {
    def.pattern.lastIndex = 0 // 防 /g 残留（约定上不写 /g，双保险）
    if (!def.pattern.test(path)) return false
  }
  if (def.method != null && def.method !== method) return false
  return true
}

/**
 * 按注册序 dispatch。命中即执行并返回 true（**已处理**——含"守卫拒绝并已写响应"）；
 * 全部未命中返回 false，由调用方（或 server.js 的 /api 兜底 404）收尾。
 */
export async function dispatchRoutes(routes, req, res, path, url) {
  for (const r of routes) {
    if (!matches(r, req.method, path, req)) continue

    if (r.rateLimit && !rateLimit(req, res, r.rateLimit)) return true

    if (r.guard === 'user') {
      // 单源会话判例（2026-10-30）：凭证/自助端点身份 = getRequestAddress；
      // 无会话的 401 载荷逐字沿用原 user.routes 面（前端据此走登录引导，勿改文案）
      if (!getRequestAddress(req)) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }))
        return true
      }
    }

    if (r.guard === 'admin' && !requireAdmin(req, res)) return true

    if (r.guard === 'custom' && !(await r.customGuard(req, res, path, url))) return true

    await r.handler(req, res, path, url)
    return true
  }
  return false
}
