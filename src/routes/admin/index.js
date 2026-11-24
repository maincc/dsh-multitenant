/**
 * 管理域注册表汇总（refactor-giant-files §P1）
 *
 * 域文件按"用户可理解的地图"分组（session/gateway/users/volumes/credential/env/dsh），
 * 汇总序不承载语义——跨域无重叠匹配（exact 各异、prefix 域内自洽），但域内顺序
 * 必须保持原 if 链相对次序（如 environments exact 先于 environments/ prefix）。
 *
 * admin.routes.js 迁移完成后只余薄壳：attachAdminSignature + dispatchRoutes。
 */

import { validateRoutes } from '../registry.js'
import { SESSION_ROUTES } from './session.routes.js'
import { GATEWAY_ROUTES } from './gateway.routes.js'
import { USERS_ROUTES } from './users.routes.js'
import { VOLUMES_ROUTES } from './volumes.routes.js'

export const ADMIN_ROUTES = validateRoutes([
  ...SESSION_ROUTES,
  ...GATEWAY_ROUTES,
  ...USERS_ROUTES,
  ...VOLUMES_ROUTES,
])
