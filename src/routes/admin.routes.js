/**
 * 管理路由模块（refactor-giant-files §P1 完成态：薄壳）
 *
 * 2007 行的 if-path 大链已全部迁入守卫注册表（src/routes/admin/*.routes.js 七个域，
 * 41 端点）。本文件只剩两件事：
 *   ① attachAdminSignature——所有管理请求统一的签名材料解析（无副作用预处理）；
 *   ② dispatchRoutes——按注册序匹配/挂守卫/执行（default-deny：新端点不注册即 404）。
 *
 * 对外导出 handleAdminRoutes(req, res, path, url) 签名不变——server.js dispatch 与
 * 9 个既有测试文件的 import 面零改动。新增管理端点请写进对应域文件（无对应域就
 * 建一个新域文件并在 index.js 汇总），守卫必填：免鉴权也要显式 guard:'public'。
 */

import { attachAdminSignature } from '../middleware/admin-signature.middleware.js'
import { dispatchRoutes } from './registry.js'
import { ADMIN_ROUTES } from './admin/index.js'

export async function handleAdminRoutes(req, res, path, url) {
  // 解析破坏性操作的签名材料（请求头 → req.__adminSignature）。无副作用，
  // 没带就是没带，由 requireAdminSignature 统一报错。
  attachAdminSignature(req)

  return dispatchRoutes(ADMIN_ROUTES, req, res, path, url)
}
