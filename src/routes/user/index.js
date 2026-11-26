/**
 * 用户域注册表汇总（refactor-giant-files §P1）
 *
 * 聚合序承载语义（与 admin 不同！）：USER_PROFILE_ROUTES 的详情 catch-all
 * 必须最后——原 if 链靠物理先后排除它吞掉精确路径。新增 /api/user/* 精确端点
 * 请加在 catch-all 之前的任一域文件里。
 */

import { validateRoutes } from '../registry.js'
import { USER_AUTH_ROUTES } from './auth.routes.js'
import { USER_CREDENTIAL_ROUTES } from './credential.routes.js'
import { USER_ENV_ROUTES } from './environment.routes.js'
import { USER_CONFIG_ROUTES } from './config.routes.js'
import { USER_PROFILE_ROUTES } from './profile.routes.js'

export const USER_ROUTES = validateRoutes([
  ...USER_AUTH_ROUTES,
  ...USER_CREDENTIAL_ROUTES,
  ...USER_ENV_ROUTES,
  ...USER_CONFIG_ROUTES,
  ...USER_PROFILE_ROUTES,
])
