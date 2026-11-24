/**
 * 技能市场路由模块（挂载点：/api/skills/*，见 server.js）
 * （refactor-giant-files §P1 完成态：薄壳——原 303 行 if 链迁入 skill/skills.routes.js 注册表）
 *
 * 鉴权谱系（原注释的翻译，判例细节在域文件各路由 note）：
 *   - 公开（无需鉴权）：GET 列表 / 详情 / 下载
 *   - 钱包签名（挑战-响应，同 tenant-config 模式）：publish / import / install /
 *     uninstall / mine POST / DELETE（作者取消共享）
 *   - 管理员：/admin（列表）、:name/hide（下架，会话+当场签名双门禁）；
 *     DELETE 为"管理员或作者签名"双通道
 *   - 会话归属闸（S1 修复判例）：GET 列表的 address 标记位、GET mine 视图
 *
 * 对外导出 handleSkillRoutes(req, res, path) 签名不变。
 */

import { dispatchRoutes } from './registry.js'
import { SKILL_ROUTES } from './skill/skills.routes.js'

export async function handleSkillRoutes(req, res, path) {
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`)
  return dispatchRoutes(SKILL_ROUTES, req, res, path, url)
}
