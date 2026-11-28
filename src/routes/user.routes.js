/**
 * 用户路由模块（refactor-giant-files §P1 完成态：薄壳）
 *
 * 原 1101 行 if 链已迁入守卫注册表（src/routes/user/*.routes.js 五域，25 端点）。
 * 14 处逐字重复的"无会话 401"块收敛为 registry 的 guard:'user' 单源（判例 58 清偿；
 * P1 审查 L1 订正计数）。
 * 对外导出 handleUserRoutes(req, res, path) 签名不变——server.js 与测试 import 面零改动。
 */

import { dispatchRoutes } from './registry.js'
import { USER_ROUTES } from './user/index.js'

export async function handleUserRoutes(req, res, path) {
  // P1 审查 L4：原每请求预构 URL 但 25 个 handler 无一消费第 4 参（各自内建 req.url，
  // 与旧版基底逐字相同）——死计算移除；url 传 undefined 由 dispatch 原样透传。
  return dispatchRoutes(USER_ROUTES, req, res, path)
}
