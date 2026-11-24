/**
 * 用户路由模块（refactor-giant-files §P1 完成态：薄壳）
 *
 * 原 1101 行 if 链已迁入守卫注册表（src/routes/user/*.routes.js 五域，25 端点）。
 * 13 处逐字重复的"无会话 401"块收敛为 registry 的 guard:'user' 单源（判例 58 清偿）。
 * 对外导出 handleUserRoutes(req, res, path) 签名不变——server.js 与测试 import 面零改动。
 */

import { dispatchRoutes } from './registry.js'
import { USER_ROUTES } from './user/index.js'

export async function handleUserRoutes(req, res, path) {
  // 原签名不吃 url；个别 handler 需要 query——由 req.url 现算（原代码同款做法）
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`)
  return dispatchRoutes(USER_ROUTES, req, res, path, url)
}
