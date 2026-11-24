/**
 * 管理路由模块
 */

import { CONFIG, getAdminAddresses } from '../config/config.js'
import { userService } from '../services/user.service.js'
import { dataService } from '../services/data.service.js'
import { dockerService } from '../services/docker.service.js'
import { envBundleService } from '../services/env-bundle.service.js'
import { runEnvCommit, normEnvNames, normEnvWsExcludes } from '../services/env-commit.service.js'
// 镜像归属与可清理性判定的唯一真源（2026-09 从本文件抽出，与 F3 维护定时器共用）
import { collectPrunableImages, matchImageId } from '../services/image-inventory.service.js'
import { dshVersionService } from '../services/dsh-version.service.js'
import { credentialService } from '../services/credential.service.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireAdmin, getAdminSession } from '../middleware/auth.middleware.js'
import {
  attachAdminSignature,
  requireAdminSignature,
} from '../middleware/admin-signature.middleware.js'
import { validateSwtcAddress } from '../middleware/validate.middleware.js'
import { normalizeAddress } from '../utils/address.js'
import { BadRequestError, handleError } from '../utils/errors.js'
import { parseBody, parseJsonBody } from '../utils/parse-body.js'
// ★ P1 注册表（refactor-giant-files）：已迁域走 dispatch（守卫声明必填），未迁域暂留本文件遗留 if 链
import { dispatchRoutes } from './registry.js'
import { ADMIN_ROUTES } from './admin/index.js'

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 镜像构建任务状态（进程内存）。
 *
 * 构建要编译 node-pty、可能拉 72 个 npm 依赖，耗时以分钟计——绝不能占着
 * HTTP 请求等它。因此 POST /api/admin/dsh/image 立即返回 { started:true }，
 * 前端轮询 GET /api/admin/dsh/image 读这里的进度。
 * 先不做持久化：进程重启即丢失，重新触发一次即可（构建是幂等的）。
 */
const imageBuildTask = {
  running: false,
  version: null,
  startedAt: null,
  finishedAt: null,
  ok: null,
  error: null,
  result: null,
}

/**
 * 「应用镜像到租户容器」任务状态（进程内存）。
 *
 * 每个租户要重建容器（停→删→建→等就绪），单个就要十几秒到 2 分钟，
 * 批量更久——因此同样立即返回、后台执行、前端轮询。
 * 逐租户结果都记下来：批量时不能因为一个失败就丢掉其余结果。
 */
const imageApplyTask = {
  running: false,
  targets: [],
  total: 0,
  completed: 0,
  results: [],
  startedAt: null,
  finishedAt: null,
}

/**
 * 处理管理路由
 */
export async function handleAdminRoutes(req, res, path, url) {
  // 解析破坏性操作的签名材料（请求头 → req.__adminSignature）。无副作用，
  // 没带就是没带，由 requireAdminSignature 统一报错。
  attachAdminSignature(req)

  // ★ 已迁入注册表的域（refactor-giant-files §P1）：守卫声明必填、dispatch 统一收敛。
  // 迁移期间先查注册表再落遗留 if 链（跨域无重叠匹配，顺序无关）。
  if (await dispatchRoutes(ADMIN_ROUTES, req, res, path, url)) return true

  // ════════════ v1.4 凭证体系 · CWT 解限申请审批（管理员当场签名）════════════

  // GET /api/admin/credentials?kind=did|cwt|admin|all&q=<地址片段>&limit&offset - 凭证台账浏览
  // 三类卡制式（2026-10-23 用户拍板）：admin=cwt∧roles∋admin 独立档；cwt 档=纯解限剔除 admin
  if (path === '/api/admin/credentials' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return true
    const kind = url.searchParams.get('kind') || 'all'
    const q = (url.searchParams.get('q') || '').slice(0, 64)
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20))
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    try {
      const r = await credentialService.listCredentials({ kind, q, limit, offset })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          credentials: r.items,
          total: r.total,
          limit,
          offset,
          hasMore: offset + r.items.length < r.total,
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/admin/cwt-applications?status=pending|approved|rejected|all&limit&offset
  if (path === '/api/admin/cwt-applications' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return true
    const status = url.searchParams.get('status') || 'pending'
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10))
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    try {
      const r = await credentialService.listApplications({ status, limit, offset })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          applications: r.items,
          total: r.total,
          limit,
          offset,
          hasMore: offset + r.items.length < r.total,
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // POST /api/admin/cwt-applications/:id/approve - 批准=签发 CWT 解限凭证
  // 签名绑定 {id, address}：address 由服务端按申请单查出（前端传了也只当展示，绑定的以库为准）
  if (/^\/api\/admin\/cwt-applications\/[^/]+\/approve$/.test(path) && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    const id = decodeURIComponent(path.split('/')[4])
    const app = await credentialService._findApp(id)
    if (!app) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '申请不存在', code: 'NOT_FOUND' }))
      return true
    }
    if (
      !requireAdminSignature(
        req,
        res,
        'cwt/approve',
        { id, address: app.address },
        getAdminSession(req),
      )
    ) {
      return true
    }
    try {
      const out = await credentialService.approveApplication(id, getAdminSession(req))
      dataService.logOperation('admin_cwt_approve', {
        operator: getAdminSession(req),
        id,
        address: app.address,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // POST /api/admin/cwt-applications/:id/reject - 拒绝（同样当场签名绑定单号+申请人）
  if (/^\/api\/admin\/cwt-applications\/[^/]+\/reject$/.test(path) && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    const id = decodeURIComponent(path.split('/')[4])
    const app = await credentialService._findApp(id)
    if (!app) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '申请不存在', code: 'NOT_FOUND' }))
      return true
    }
    if (
      !requireAdminSignature(
        req,
        res,
        'cwt/reject',
        { id, address: app.address },
        getAdminSession(req),
      )
    ) {
      return true
    }
    let reason = ''
    try {
      reason = (JSON.parse((await parseBody(req)) || '{}').reason || '').slice(0, 300)
    } catch {
      reason = ''
    }
    try {
      const out = await credentialService.rejectApplication(id, getAdminSession(req), reason)
      dataService.logOperation('admin_cwt_reject', {
        operator: getAdminSession(req),
        id,
        address: app.address,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // ---------------------------------------------------------------------------
  // 环境模板（environment-templates PR1，2026-10-27）
  // 定格→draft→人审 publish→apply→revoke；digest 不可变钉；下架不驱逐。
  // docker 面只有管理员碰（形态 B 会审定案）；用户侧自助口子在 PR3 另议。
  // ---------------------------------------------------------------------------

  // POST /api/admin/env-commit {address, slug, dryRun} —— 定格用户容器为模板草稿
  if (path === '/api/admin/env-commit' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    let address = String(body.address || '')
    if (!validateSwtcAddress(address, res)) return true
    address = normalizeAddress(address)
    const slug = String(body.slug || '').trim()
    // 展示名（2026-10-27 用户定式："起名"该是自由的事）：自由文本≤60，人读的
    // 界面全用它；slug 回归纯技术位（镜像 tag 治理段，用户端 PR3 起平台自动
    // 生成、不再要求手填）。不进签名绑定：纯展示字段，换不动 id/image/address
    // 任何权力语义——偷换只伤作者自己，不值得占签名面。缺省回退 slug，永不为空。
    const displayName = String(body.displayName || '')
      .trim()
      .slice(0, 60)
    // 一句话介绍（向导第 1 步的展示文案；同 displayName：纯展示不进签名）
    const intro = String(body.intro || '')
      .trim()
      .slice(0, 300)
    // 勾选三档（向导第 2 步）：skills=按名随行走官方管线；plugins=文件进包；
    // folders=/root/workspace 顶层保留（进清洗层 scrubKeep——没勾=默认清空）
    const include = {
      skills: normEnvNames(body.include && body.include.skills),
      plugins: normEnvNames(body.include && body.include.plugins),
      folders: normEnvNames(body.include && body.include.folders),
    }
    const wsEx = normEnvWsExcludes(body.include && body.include.wsExcludes)
    if (wsEx === null) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          error: '子项摘除清单格式不正：须为"目录/子项"两段路径且不含 ..',
          code: 'BAD_WS_EXCLUDE',
        }),
      )
      return true
    }
    include.wsExcludes = wsEx
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({ error: 'slug 需为小写字母/数字/连字符，2~41 字符（入镜像名，从严）' }),
      )
      return true
    }
    // 参数合法先于签名检查（promote 同款次序：不让人去签一个注定失败的操作）
    // 审查 H2（2026-11-06）：dryRun 预览免签——该分支在服务侧纯算字符串即 return
    // （不触容器/不落账/不落图，零世界改动），原闸把预览一并 403、代格功能自断。
    // 正式落库照旧签名，且 binding 扩勾选面（H4）：签"不随行"执行"全随行"封死。
    if (
      !body.dryRun &&
      !requireAdminSignature(
        req,
        res,
        'env-commit',
        { address, slug, include: body.include },
        getAdminSession(req),
      )
    )
      return true
    // 定格全流程在 env-commit.service（admin/user 两面共用同一条链——权限差异
    // 留在路由层：这里 requireAdmin+签名，user 面是 session+freezeAllowed）
    try {
      const { status, body: respBody } = await runEnvCommit({
        address,
        slug,
        displayName,
        intro,
        include,
        dryRun: !!body.dryRun,
        operator: getAdminSession(req) || 'system',
        opKind: 'env_commit',
      })
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(respBody))
    } catch (err) {
      // commitEnvironment 的 finally 已负责把源容器起回；此处只诚实报断点
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `上传失败：${err.message}（源容器已确认起回）` }))
    }
    return true
  }

  // GET /api/admin/environments —— 模板账本列表（manifest 折叠，详情按需单查）
  if (path === '/api/admin/environments' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return true
    const envs = await dataService.listEnvironments()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        environments: envs
          .map((e) => ({
            _id: e._id,
            sourceAddr: e.sourceAddr,
            slug: e.slug,
            name: e.displayName || e.slug,
            imageId: e.imageId,
            dshVersion: e.dshVersion,
            sizeBytes: e.sizeBytes,
            scrubbed: e.scrubbed,
            status: e.status,
            pinnedBy: e.pinnedBy || [],
            manifestCount: (e.manifest || []).length,
            hasBundle: !!e.bundle,
            hasScan: !!e.scan,
            // 检测计数上列表（审核队列徽标）；命中细节只在详情面，不外露全量
            secretCount: (e.scan?.secrets || []).length,
            hitCount: (e.scan?.hits || []).length,
            rejectReason: e.rejectReason || null,
            createdBy: e.createdBy,
            createdAt: e.createdAt,
          }))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      }),
    )
    return true
  }

  // GET /api/admin/environments/<id> —— 单模板全量（含 manifest 审核面）
  if (path.startsWith('/api/admin/environments/') && req.method === 'GET') {
    if (!requireAdmin(req, res)) return true
    const id = decodeURIComponent(path.slice('/api/admin/environments/'.length))
    const doc = await dataService.getEnvironment(id)
    if (!doc) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '模板不存在' }))
      return true
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ template: doc }))
    return true
  }

  // POST /api/admin/env-publish {id} —— 审完 manifest 放行（draft→published）
  if (path === '/api/admin/env-publish' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    const id = String(body.id || '')
    if (!requireAdminSignature(req, res, 'env-publish', { id }, getAdminSession(req))) return true
    const doc = await dataService.getEnvironment(id)
    if (!doc) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '模板不存在' }))
      return true
    }
    if (doc.status !== 'draft') {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          error: `状态 ${doc.status} 不可上架（revoked 不可复活——需重新上传重审）`,
        }),
      )
      return true
    }
    const next = await dataService.patchEnvironment(id, {
      status: 'published',
      publishedAt: new Date().toISOString(),
      publishedBy: getAdminSession(req) || 'system',
    })
    dataService.logOperation('env_publish', { id, operator: getAdminSession(req) || 'system' })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, template: next }))
    return true
  }

  // POST /api/admin/env-revoke {id} —— 撤 listing：禁新 pin，不驱逐在用者（只减不增）
  if (path === '/api/admin/env-revoke' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    const id = String(body.id || '')
    if (!requireAdminSignature(req, res, 'env-revoke', { id }, getAdminSession(req))) return true
    const doc = await dataService.getEnvironment(id)
    if (!doc) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '模板不存在' }))
      return true
    }
    if (doc.status === 'revoked') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, already: true }))
      return true
    }
    const next = await dataService.patchEnvironment(id, {
      status: 'revoked',
      revokedAt: new Date().toISOString(),
      revokedBy: getAdminSession(req) || 'system',
    })
    // 裁定 2026-10-30：撤板不驱逐"在用的人"判例不变，但**作者本人**不再住进
    // 被撤的模板——他的钉回落默认环境（文件零风险，快照三件套与 pin 无关）。
    const off =
      typeof userService.unpinAuthorOnOffshelf === 'function' && doc.sourceAddr
        ? await userService.unpinAuthorOnOffshelf(doc.sourceAddr, id, 'revoke')
        : { skipped: true }
    // 账实一致：回读账本计数；作者既已回落默认，任何时序下都不算"仍在用"（幂等 filter）
    const postPin = (await dataService.getEnvironment(id))?.pinnedBy || []
    const usingLeft = off.unpinned
      ? postPin.filter((a) => a !== doc.sourceAddr).length
      : postPin.length
    dataService.logOperation('env_revoke', {
      id,
      pinnedCount: (doc.pinnedBy || []).length,
      authorUnpinned: Boolean(off.unpinned),
      operator: getAdminSession(req) || 'system',
    })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        ok: true,
        template: next,
        selfUnpinned: Boolean(off.unpinned),
        note:
          `已撤 listing；${usingLeft} 个在用租户不受影响（重钉该模板将被拒）` +
          (off.unpinned ? '；作者已回落默认环境（文件原封不动）' : ''),
      }),
    )
    return true
  }

  // POST /api/admin/env-apply {id, address, dryRun} —— 分发：digest 逐字校验后
  // 走既有 applyImageVersion（停机/重建/留痕/重建保持全是现成的）
  if (path === '/api/admin/env-apply' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    const id = String(body.id || '')
    let address = String(body.address || '')
    if (!validateSwtcAddress(address, res)) return true
    address = normalizeAddress(address)
    if (!requireAdminSignature(req, res, 'env-apply', { id, address }, getAdminSession(req)))
      return true
    const doc = await dataService.getEnvironment(id)
    if (!doc) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '模板不存在' }))
      return true
    }
    if (doc.status !== 'published') {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          error: `模板状态 ${doc.status}：仅 published 可分发（draft 未审、revoked 已撤）`,
        }),
      )
      return true
    }
    // digest 不可变钉：tag 可能被后续定格/外力覆盖，ID 不符=货不证
    const nowId = await dockerService.imageId(doc._id)
    if (!nowId) {
      res.writeHead(410, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '模板镜像已不在本机（被清理？）——不可分发' }))
      return true
    }
    if (nowId !== doc.imageId) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          error: '模板 tag 指向的镜像与账本 digest 不符（同名被覆盖），拒发',
          expected: doc.imageId,
          actual: nowId,
        }),
      )
      return true
    }
    try {
      const result = await userService.applyImageVersion(address, {
        image: doc._id,
        dryRun: !!body.dryRun,
      })
      // 随行进卷+技能随行（镜像先行包后行；失败如实标注不谎报整单）
      let bundleOut = {}
      try {
        bundleOut = await envBundleService.applyBundleTo(address, doc, { dryRun: !!body.dryRun })
      } catch (err) {
        bundleOut = { bundleError: `随行包装入失败（镜像切换本身已完成）：${err.message}` }
      }
      if (!body.dryRun) {
        const cur = await dataService.getEnvironment(id)
        const pinnedBy = new Set(cur?.pinnedBy || [])
        pinnedBy.add(address)
        await dataService.patchEnvironment(id, { pinnedBy: [...pinnedBy] })
        dataService.logOperation('env_apply', {
          id,
          address,
          operator: getAdminSession(req) || 'system',
        })
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ...result,
          ...bundleOut,
          userNotices: ['管理员已切换你的容器环境（见容器 tab）'],
        }),
      )
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `分发失败：${err.message}` }))
    }
    return true
  }

  // POST /api/admin/env-inventory {address} —— 代格前内容盘点（只读；免签）
  if (path === '/api/admin/env-inventory' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    let address = String(body.address || '')
    if (!validateSwtcAddress(address, res)) return true
    address = normalizeAddress(address)
    try {
      const inventory = await envBundleService.inventory(address)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ inventory }))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `随行内容盘点失败：${err.message}` }))
    }
    return true
  }

  // POST /api/admin/env-browse {address, dir} —— 选择器的分层列表（只读；免签）
  if (path === '/api/admin/env-browse' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    let address = String(body.address || '')
    if (!validateSwtcAddress(address, res)) return true
    address = normalizeAddress(address)
    try {
      const listing = await envBundleService.browse(address, String(body.dir || ''))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(listing))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `浏览失败：${err.message}` }))
    }
    return true
  }

  // POST /api/admin/env-scan {id} —— 重跑随行包检测（规则库升级后全量再扫；
  // 结果写账本=审核底稿的版本化。写账本故签名，同 publish 形态）
  if (path === '/api/admin/env-scan' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    const id = String(body.id || '')
    if (!requireAdminSignature(req, res, 'env-scan', { id }, getAdminSession(req))) return true
    const doc = await dataService.getEnvironment(id)
    if (!doc) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '模板不存在' }))
      return true
    }
    if (!doc.bundle || !doc.bundle.files || !doc.bundle.files.length) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '该模板无随行包（纯镜像上传）——无扫描对象' }))
      return true
    }
    try {
      await envBundleService.verifyBundle(id, doc.bundle.files) // 账本↔tar 实体核验，不符拒扫
      // 判例 56：装配实物现场再扫——拿包目录当平铺目录扫，恒 scanned:0 的假绿收案
      const scan = envBundleService.scanOnStage(id, doc.bundle.files)
      await dataService.patchEnvironment(id, { scan })
      dataService.logOperation('env_scan', { id, operator: getAdminSession(req) || 'system' })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ scan }))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `检测失败：${err.message}` }))
    }
    return true
  }

  // POST /api/admin/env-reject {id, reason} —— 驳回即弃（方案 §9-3 拍板）：
  // 只作用于 draft；镜像与包当场删除，理由回传作者面；留账本摘要可追责。
  if (path === '/api/admin/env-reject' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return true
    const body = await parseJsonBody(req, res)
    if (!body) return true
    const id = String(body.id || '')
    const reason = String(body.reason || '')
      .trim()
      .slice(0, 500)
    if (!reason) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '驳回必须附理由（作者可见的反馈，不许沉默毙掉）' }))
      return true
    }
    if (!requireAdminSignature(req, res, 'env-reject', { id }, getAdminSession(req))) return true
    const doc = await dataService.getEnvironment(id)
    if (!doc) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '模板不存在' }))
      return true
    }
    if (doc.status === 'rejected') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, already: true, id }))
      return true
    }
    if (doc.status !== 'draft') {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({ error: `状态 ${doc.status}：驳回只作用于 draft（published 走 revoke）` }),
      )
      return true
    }
    // 拆账先行（判例 57 M3，"置账于前、再动物理"）：先摘 bundle.files——否则
    // rejected doc 的 sha 恒驻引用账，CAS 字节块永不清扫，"当场即弃"变永久驻盘。
    // 摘要留账可审（片数/字节/discarded 标记），实物引用归零交给 removeBundle 的 sweep。
    await dataService.patchEnvironment(id, {
      status: 'rejected',
      rejectedAt: new Date().toISOString(),
      rejectedBy: getAdminSession(req) || 'system',
      rejectReason: reason,
      pinnedBy: [], // 钉册随像作废（解绑名数已录 env_unpin_on_reject 审计）
      bundle: doc.bundle
        ? {
            bytes: doc.bundle.bytes || 0,
            fileCount: (doc.bundle.files || []).length,
            files: [],
            discarded: true,
          }
        : null,
    })
    await dockerService.removeImage(doc.imageTag) // 即弃：删像
    await Promise.resolve(envBundleService.removeBundle(id)) // 删包+sweep（此刻才真销得动）
    // 判例 2026-10-30：像没了钉必须卸——否则被钉者下次重建容器吊空炸。
    // 驳回不是撤板（撤板对象还在、不驱逐在用者；驳回是物理消失）。
    const holders =
      typeof userService.unpinHolders === 'function' ? await userService.unpinHolders(id) : []
    dataService.logOperation('env_reject', {
      id,
      address: doc.sourceAddr,
      reason,
      operator: getAdminSession(req) || 'system',
    })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        ok: true,
        id,
        discarded: true,
        notice:
          '镜像与随行包已当场删除' +
          (holders.length ? `；${holders.length} 人的钉选已随之解绑（下次回默认环境）` : ''),
      }),
    )
    return true
  }

  // ---------------------------------------------------------------------------
  // DSH 版本 / 镜像升级
  // ---------------------------------------------------------------------------

  // GET /api/admin/dsh/versions - npm 上可用版本（按 dist-tag 分组）
  if (path === '/api/admin/dsh/versions' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const url = new URL(req.url, 'http://x')
      // 默认折叠预发布；includePrerelease=1 才展开
      const includePrerelease = url.searchParams.get('includePrerelease') === '1'
      const data = await dshVersionService.getVersions()
      if (!data.ok) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: `无法获取 DSH 版本列表：${data.error}`,
            code: 'REGISTRY_UNAVAILABLE',
          }),
        )
        return true
      }

      // 本地已构建的版本 —— 管理页需要它来回答
      // "哪些版本我手上有、可以直接拿去构建/回滚"，而不只是"远端有哪些版本"。
      //
      // 不能只看 `docker image ls` 的 tag：构建新版本会把旧 tag 挪走，
      // 旧镜像变成无 tag 的悬空镜像但**仍占 1.2GB 且仍可回滚**（这正是历史里
      // 那些"在本地"的记录）。所以"本地有没有"要同时看 tag 与平台历史，
      // 再统一按"该镜像在不在本地"判定（复用 collectPrunableImages 的实时结果）。
      const localTags = (await dockerService.listLocalVersionTags()) || []
      const record = dataService.getDshImage()
      const present = await collectPrunableImages(record)
      const presentIds = present.items.map((im) => im.id)

      /** 该版本是否在本地留有镜像（带 tag 或悬空） */
      const versionLocal = (v) => {
        if (!v) return false
        if (localTags.some((t) => t.version === v)) return true
        const h = (record.history || []).find((x) => x.version === v)
        return Boolean(h) && presentIds.some((pid) => matchImageId(pid, h.imageId))
      }

      const localVersionSet = new Set(
        (record.history || [])
          .map((h) => h.version)
          .concat(localTags.map((t) => t.version))
          .filter((v) => v && v !== 'latest' && versionLocal(v)),
      )
      const { current } = record
      const markLocal = (v) => localVersionSet.has(v)

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          latest: data.latest,
          tags: data.tags,
          stable: data.stable,
          prerelease: includePrerelease ? data.prerelease : [],
          prereleaseCount: data.prerelease.length,
          includePrerelease,
          stale: Boolean(data.stale),
          fetchedAt: data.fetchedAt,
          // 每个远端版本是否已在本地构建（前端用来标"已构建"）
          stableLocal: data.stable.map((v) => ({ version: v, local: markLocal(v) })),
          prereleaseLocal: includePrerelease
            ? data.prerelease.map((v) => ({ version: v, local: markLocal(v) }))
            : [],
          // 本地已有 tag 的版本（含 latest 的指向），按版本去重
          localVersions: [...localVersionSet].sort(),
          localTags: localTags.map((t) => ({
            version: t.version,
            imageId: t.imageId,
            createdAt: t.createdAt,
            // 必须用 matchImageId：docker 给短 ID、平台存完整 sha256，
            // 直接 === 比较永远为 false（"当前"标记会一直不亮）
            isCurrent: Boolean(current?.imageId) && matchImageId(t.imageId, current.imageId),
          })),
          currentVersion: current?.version ?? null,
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/admin/dsh/status - 当前镜像版本 + 各租户版本 + 哪些租户需要重建
  if (path === '/api/admin/dsh/status' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const record = dataService.getDshImage()
      const currentImageId = await dockerService.imageId()
      const currentImageVersion = await dockerService.imageDshVersion()

      // 与 registry 最新版对比（**只用缓存**，不联网）：
      // /status 要快，不能在管理面板每次刷新时都去等 npm view（数秒）。
      // 缓存为空返回 null → 界面显示"未知"，而不是把请求拖慢。
      let upgrade = null
      if (currentImageVersion) {
        const versions = await dshVersionService.getVersions({ compareOnly: true })
        if (versions.ok && versions.latest) {
          upgrade = {
            latest: versions.latest,
            // 字符串不等即判定需升级：DSH 版本号非严格 semver，不做大小比较
            // （只依赖"是否等于当前版本"这一个事实，避免误判 0.1.10 < 0.1.9）
            behind: currentImageVersion !== versions.latest,
            checkedAt: versions.fetchedAt ?? null,
          }
        } else {
          upgrade = {
            latest: null,
            behind: null,
            notLoaded: Boolean(versions.notLoaded),
            reason: versions.notLoaded
              ? '版本列表尚未加载（打开「本地版本列表」后会自动拉取）'
              : '版本列表不可用（registry 错误见版本列表提示）',
          }
        }
      }

      // 逐租户：容器实际引用的镜像 ID vs 当前镜像 ID
      // （容器记录的是创建时的镜像 ID，不受之后 latest 被重指影响）
      const tenants = []
      for (const [address, user] of Object.entries(userService.state.swtcUsers || {})) {
        if (user.containerStatus !== 'running' && user.containerStatus !== 'stopped') continue
        const name = `dsh-swtc-${normalizeAddress(address)}`
        const containerImageId = await dockerService.containerImageId(name)
        tenants.push({
          address,
          containerStatus: user.containerStatus,
          containerImageId,
          // 容器里实际装的 DSH 版本（可能 != currentImageVersion：容器一旦创建就
          // 钉在旧镜像上）。管理员需要它才能判断"这个租户要不要更新"。
          dshVersion:
            (await dockerService.containerDshVersion(name)) ?? user.baseImageVersion ?? null,
          // 该租户是否被钉在指定镜像上（租户镜像选择）。null = 跟随平台默认
          pinnedImage: user.pinnedImage ?? null,
          // containerImageId 为 null = 容器不存在
          stale: Boolean(currentImageId) && containerImageId !== currentImageId,
        })
      }

      // 版本历史增强：标出每条记录对应的镜像**是否仍在本地**。
      //
      // 为什么必须标：同一个版本可以被构建多次（每次都是新镜像 ID，tag 只有一个
      // → 后来的覆盖先前的），历史却把所有构建都留着。不标出来，管理员会以为
      // 4 条 "0.1.5-rc.1" 都能回滚，其实只有 tag 指向的那一个还在。
      // 同时给出体积与"是否可安全清理"，供管理页做多选清理。
      //
      // 安全约束（宁可漏删不可误删）：
      //   · current 指向的镜像绝不能删
      //   · 仍被任何容器（含已停止）引用的镜像不能删 —— 删了那容器就再也起不来
      // 可删性一律取自 collectPrunableImages（与 /images 清理面板同一判定），
      // 否则会出现"历史说带 tag 不能清、清理面板说能清"的自相矛盾。
      const prunable = await collectPrunableImages(record)

      const history = record.history.slice(-20).map((h) => {
        // docker images 给的是短 ID（通常 12 位，冲突时会更长），inspect 给的是
        // 完整 sha256 → 用 matchImageId 双向前缀匹配
        const local = prunable.items.find((im) => matchImageId(im.id, h.imageId)) ?? null
        const isCurrent = Boolean(currentImageId) && matchImageId(h.imageId, currentImageId)
        return {
          ...h,
          present: Boolean(local),
          sizeBytes: local?.sizeBytes ?? 0,
          removable: Boolean(local?.removable),
          reason: !local ? 'not_local' : isCurrent ? 'current' : local.used ? 'in_use' : null,
        }
      })

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          image: CONFIG.docker.image,
          currentImageId,
          currentImageVersion,
          upgrade,
          recorded: record.current,
          history,
          // 可清理镜像清单（含不在历史里的，如更早遗留的 tag）——
          // 让管理页清理面板**始终**有内容可展示，而不是没得清时整个入口消失
          // 可指定给租户运行的本地镜像（租户镜像选择的下拉项）
          availableImages: await dockerService
            .listAvailableImages(CONFIG.docker?.image)
            .catch(() => []),
          prunable: {
            image: prunable.image,
            items: prunable.items,
            removableCount: prunable.removableCount,
            removableBytes: prunable.removableBytes,
            danglingCount: prunable.danglingCount,
            taggedCount: prunable.taggedCount,
            infoIncomplete: prunable.infoIncomplete,
          },
          staleTenants: tenants.filter((t) => t.stale).length,
          tenants,
          // 镜像升级对已有容器无效（它们仍引用旧镜像 ID），必须重建容器才生效
          note: '已有容器仍引用旧镜像，需重建容器才会应用新版本',
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/admin/dsh/image - 构建任务进度（前端轮询）
  // GET /api/admin/dsh/images - 本地镜像清单 + 每个镜像的可清理性
  //
  // 前端需要它来回答两个问题："有哪些镜像在占盘" 和 "为什么这个不能删"。
  // 判定由服务端实时重算，绝不信任前端提交的列表。
  //
  // 可删条件（同时满足）：
  //   · 属于本项目（带本项目 tag，或无 tag 但出现在平台构建历史里）
  //   · 不是 current 镜像
  //   · 没有任何容器（含已停止）引用
  // 带 tag 的镜像也允许删（旧版本 tag 同样占 1.2GB），但前端要显式勾选
  // "包含带 tag 的版本"，避免误删回滚退路。
  if (path === '/api/admin/dsh/images' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const prunable = await collectPrunableImages(dataService.getDshImage())
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ...prunable,
          note: '只删除本项目镜像；current 与仍被容器（含已停止）引用的镜像一律不可删',
        }),
      )
      return true
    } catch (err) {
      // 用统一的 handleError：BadRequestError 才有正确的 400，
      // 手工 writeHead(500) 会把客户端错误误报成服务端故障
      handleError(err, res)
      return true
    }
  }

  // POST /api/admin/dsh/images/prune - 清理多余镜像（破坏性操作，需签名）
  // body: { ids: string[] }  必须显式列出要删的镜像 ID
  //
  // 为什么强制显式列表：签名 binding 是"删哪几个镜像"，若允许省略（= 删全部）
  // 就会出现"签的时候是这一批、执行时又多了几个"的解释空间。显式列出后，
  // 签名内容与执行内容严格一致。
  //
  // 每一项都在服务端**重新校验**后才删。这台机器上同时跑着其它项目的镜像，
  // 所以绝不使用 docker image prune，只按 ID 精确删除。
  if (path === '/api/admin/dsh/images/prune' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      // 顺序很重要：必须**先读 body**才能把"删哪几个镜像"并入签名 binding。
      // 且 parseBody 无缓存（每调用一次都新挂监听），所以全流程只读一次。
      const raw = await parseBody(req)
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        throw new BadRequestError('请求体不是合法 JSON')
      }

      const requested = Array.isArray(body.ids) ? body.ids.map((s) => String(s)) : []
      if (!requested.length) throw new BadRequestError('缺少 ids（必须是镜像 ID 数组）')

      // 验签：binding 里包含这份镜像 ID 列表，签名内容与执行内容严格一致
      if (
        !requireAdminSignature(
          req,
          res,
          'dsh/prune-images',
          { ids: requested },
          getAdminSession(req),
        )
      ) {
        return true
      }

      // 复用与 GET /images 完全相同的判定，杜绝"列表说可清理、删除说不行"的矛盾
      const prunable = await collectPrunableImages(dataService.getDshImage())
      const byId = (id) => prunable.items.find((im) => matchImageId(im.id, id))

      const eligible = []
      const skipped = []
      for (const id of requested) {
        const img = byId(id)
        if (!img) {
          skipped.push({ id, reason: 'not_found_or_not_ours' })
          continue
        }
        if (img.removable) {
          eligible.push(img)
          continue
        }
        // 给出精确原因 + 谁在用，管理员才知道下一步怎么办。
        // "信息不全"必须与"真的在用"区分：前者是平台拿不到容器列表（可重试），
        // 后者是真的被占用（要先去处理那个容器）。
        skipped.push({
          id,
          reason: img.isCurrent
            ? 'current'
            : prunable.infoIncomplete
              ? 'info_incomplete'
              : img.used
                ? 'in_use_by_container'
                : 'not_removable',
          usedBy: (img.usedBy || []).map((c) => `${c.name}(${c.state})`),
        })
      }

      const { removed, failed } = eligible.length
        ? await dockerService.removeImages(eligible.map((i) => i.id))
        : { removed: [], failed: [] }
      const freedBytes = eligible
        .filter((i) => removed.includes(i.id))
        .reduce((s, i) => s + i.sizeBytes, 0)

      // 破坏性删除留痕（真删了或有失败才记；全 skipped=没动世界）
      if (removed.length || failed.length) {
        dataService.logOperation('admin_image_prune', {
          operator: getAdminSession(req),
          removed,
          failed,
          skippedIds: skipped.map((s) => s.id),
          freedBytes,
        })
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          removed,
          failed,
          skipped,
          freedBytes,
          // 共享层导致该数值可能高估实际释放量，如实说明
          note: 'freedBytes 为镜像独占层之和，存在共享层时实际释放可能更少',
        }),
      )
      return true
    } catch (err) {
      // 用统一的 handleError：BadRequestError 才有正确的 400，
      // 手工 writeHead(500) 会把"缺 ids"这类客户端错误误报成服务端故障
      handleError(err, res)
      return true
    }
  }

  if (path === '/api/admin/dsh/image' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(imageBuildTask))
    return true
  }

  // POST /api/admin/dsh/image - 升级租户镜像到指定 DSH 版本
  // body: { version: string, refreshVersions?: boolean }
  // 立即返回（构建耗时为分钟级），进度看 GET /api/admin/dsh/image
  if (path === '/api/admin/dsh/image' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      if (imageBuildTask.running) {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '已有镜像构建在进行中', code: 'CONFLICT' }))
        return true
      }

      // parseBody 返回的是原始字符串，必须自己解析（与其它路由一致）
      const raw = await parseBody(req)
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        throw new BadRequestError('请求体不是合法 JSON')
      }
      const version = String(body.version ?? '').trim()
      if (!version) throw new BadRequestError('缺少 version')
      if (body.refreshVersions) dshVersionService.clearCache()

      // 2026-10 审计修复：构建产物直接夺平台默认镜像 tag（buildImage -t IMAGE），
      // 决定之后所有新租户用什么镜像——比已签名的 dsh/select 更重的权限此前免签。
      // 现在当场签名，version 进绑定（"签 0.1.5 执行 0.9.9"的偷换面关掉）。
      if (!requireAdminSignature(req, res, 'dsh/build-image', { version }, getAdminSession(req))) {
        return true
      }

      const check = await dshVersionService.isInstallable(version)
      if (!check.ok) throw new BadRequestError(check.error)

      const localBuild = CONFIG.dsh?.allowLocalBuild !== false
      const context = join(PROJECT_ROOT, CONFIG.dsh?.buildContext || '.')
      if (localBuild && !existsSync(join(context, 'Dockerfile'))) {
        throw new BadRequestError(
          `构建上下文里没有 Dockerfile：${context}（平台服务器需要完整源码树，或改用 docker pull 现成镜像）`,
        )
      }

      // 交给后台执行：构建以分钟计，不能占着 HTTP 请求
      imageBuildTask.running = true
      imageBuildTask.version = version
      imageBuildTask.startedAt = Date.now()
      imageBuildTask.finishedAt = null
      imageBuildTask.ok = null
      imageBuildTask.error = null
      imageBuildTask.result = null

      const by = getAdminSession(req) || 'admin'
      dockerService
        .buildImage(version, { context })
        .then(async (result) => {
          await dataService.saveDshImage({ ...result, by })
          // P2 留痕：构建完成（新镜像进历史+默认）记一条
          dataService.logOperation('dsh_image_build', {
            address: by,
            version: result.version,
            imageId: result.imageId,
          })
          // 镜像换了 → 能力缓存必须立即失效。
          // 否则最长 CAPABILITY_CACHE_TTL_MS 内，网关仍按旧镜像的
          // requiresToken 判定：比如刚从"需要认证的新版"退回"可直通的
          // 0.1.1-rc.2"，租户重建后仍会被拒 503，看起来像升级没生效。
          dockerService.clearCapabilityCache()
          imageBuildTask.ok = true
          imageBuildTask.result = result
          console.log(`[dsh] image built for version ${version}: ${result.imageId}`)
        })
        .catch((err) => {
          imageBuildTask.ok = false
          imageBuildTask.error = err.message
          console.error(`[dsh] image build failed for ${version}:`, err.message)
        })
        .finally(() => {
          imageBuildTask.running = false
          imageBuildTask.finishedAt = Date.now()
        })

      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          started: true,
          version,
          message: '镜像构建已开始，请轮询 GET /api/admin/dsh/image 查看进度',
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/admin/dsh/local-images - 本机所有可用镜像 + 当前平台默认是哪一张
  // （"从当前镜像中选一个当平台镜像"功能的数据源；含不在构建历史里的，
  // 比如从别的机器 docker load 进来的）。
  // 命名注意：`/dsh/images` 已被镜像清理面板占用（可删清单），此端点是可选清单。
  if (path === '/api/admin/dsh/local-images' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    try {
      const [images, defaultId, defaultVersion] = await Promise.all([
        dockerService.listAvailableImages(),
        dockerService.imageId(),
        dockerService.imageDshVersion(),
      ])
      // 必须后端归一化比对：docker 清单给的是短 ID（12 位），inspect 给
      // sha256 全量——前端直接 === 永远不相等，"当前默认"标记会整体消失
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: true,
          images: (images || []).map((im) => ({
            ...im,
            isDefault: matchImageId(im.imageId, defaultId),
          })),
          defaultId,
          // "现在的总体镜像到底是谁"的答案随清单一起下发：
          // defaultRef = 平台配置引用的名字（如 dsh-multitenant:latest）；
          // defaultId 为 null = 该 tag 根本不存在（"不知道"态），前端据此
          // 明示"无平台默认镜像"，而不是让人猜；defaultVersion 为 null =
          // tag 在但读不出内嵌版本（外来/损坏镜像），同样明示"未知"。
          defaultRef: CONFIG.docker.image,
          defaultVersion: defaultVersion || null,
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // POST /api/admin/dsh/select - 把一个本地镜像钦定为平台默认镜像
  // body: { ref: string }  （形如 dsh-multitenant:0.1.5-rc.3 或镜像 ID）
  //
  // 与"构建"的区别：构建 = 从 registry 现拉现装并自动夺 latest；钦定 = 直接
  // 拿机器上已有的镜像当默认（load 来的、历史遗留的都行），**不重建任何容器**。
  // 与"应用"的区别：应用 = 把默认镜像推到租户容器上；钦定只改"以后用谁"。
  //
  // 防护：当场签名绑 ref（签 A 指 B 是越权通道）+ 存在性 + 内嵌版本可读
  // （读不到 /usr/local/share/dsh-version 也不是旧 package.json = 不是本项目
  // 镜像，拒）+ 启动自检做不起（构建侧探活兜住健康产物，这里不重复付费）。
  if (path === '/api/admin/dsh/select' && req.method === 'POST') {
    const adminAddr = getAdminSession(req)
    if (!requireAdmin(req, res)) return true
    try {
      const raw = await parseBody(req)
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        throw new BadRequestError('请求体不是合法 JSON')
      }
      const ref = String(body.ref ?? '').trim()
      if (!ref) throw new BadRequestError('缺少 ref：要钦定为平台默认的镜像引用')
      if (!requireAdminSignature(req, res, 'dsh/select', { ref }, adminAddr)) return true

      const imageId = await dockerService.imageId(ref)
      if (!imageId) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: `本机不存在镜像 ${ref}`, code: 'IMAGE_NOT_FOUND' }))
        return true
      }
      const version = await dockerService.imageDshVersion(ref)
      if (!version) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: `${ref} 读不出 DSH 内嵌版本——不是本项目的租户镜像，拒绝钦定`,
            code: 'NOT_A_TENANT_IMAGE',
          }),
        )
        return true
      }

      const applied = await dockerService.setDefaultImage(ref)
      const record = await dataService.saveDshImage({
        version,
        imageId: applied.imageId,
        tag: ref,
        by: adminAddr,
      })
      // 与构建同款的收尾：默认镜像变了 → 能力缓存必须立即失效，否则网关
      // 在 TTL 内仍按旧镜像的 requiresToken 判定（见 dsh/image 构建处注释）
      dockerService.clearCapabilityCache()

      // P2 留痕：钦定平台默认镜像（影响所有新建租户）记一条
      dataService.logOperation('dsh_image_select', {
        address: getAdminSession(req),
        version,
        imageId: applied.imageId,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, version, imageId: applied.imageId, current: record }))
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  // GET /api/admin/dsh/apply - 应用任务进度（前端轮询）
  if (path === '/api/admin/dsh/apply' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(imageApplyTask))
    return true
  }

  // POST /api/admin/dsh/apply - 把当前镜像应用到租户容器（重建容器，保留数据卷）
  // body: { address?: string, all?: boolean, staleOnly?: boolean, dryRun?: boolean }
  // 不传 address 且 all=true → 批量。立即返回，进度看 GET /api/admin/dsh/apply
  if (path === '/api/admin/dsh/apply' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    try {
      if (imageApplyTask.running) {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '已有应用任务在进行中', code: 'CONFLICT' }))
        return true
      }

      const raw = await parseBody(req)
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        throw new BadRequestError('请求体不是合法 JSON')
      }

      const dryRun = Boolean(body.dryRun)

      // 目标镜像（租户镜像选择）。空 = 平台默认 latest（保持原行为）。
      // 只接受"本平台仓库名 + 版本 tag"形式，避免把租户指向任意镜像；
      // 进一步的存在性与"是不是 DSH 镜像"由 applyImageVersion 在动容器前校验。
      let targetImage = null
      if (body.image != null && String(body.image).trim() !== '') {
        targetImage = String(body.image).trim()
        const repo = String(CONFIG.docker?.image || 'dsh-multitenant').split(':')[0]
        if (!targetImage.startsWith(`${repo}:`)) {
          throw new BadRequestError(`目标镜像必须属于 ${repo}（收到：${targetImage}）`)
        }
      }

      // ---- 选定目标租户 ----
      // 参数校验先于签名检查：请求本身就不合法时报明确的 400，
      // 而不是先抛"需要签名"（否则调用方会去签一个注定失败的操作）。
      let targets = []
      if (body.address) {
        let address = String(body.address)
        if (!validateSwtcAddress(address, res)) return true
        address = normalizeAddress(address)
        targets = [address]
      } else if (body.all) {
        targets = Object.entries(userService.state.swtcUsers || {})
          // 只处理"有容器"的租户：destroyed 的下次连接会自动用新镜像
          .filter(([, u]) => u.containerStatus === 'running' || u.containerStatus === 'stopped')
          .map(([addr]) => addr)
      } else {
        throw new BadRequestError('需要 address，或传 all:true 批量')
      }

      // 破坏性：重建租户容器（可能附带备份/停机）→ 要求当场签名。
      // 绑定的是"执行意图"：单租户绑地址、批量绑 all=1。dryRun 只是预演，
      // 不改变签名内容（否则管理员得签两次）。
      if (
        !requireAdminSignature(
          req,
          res,
          'dsh/apply',
          { address: body.address, all: body.all, image: targetImage },
          getAdminSession(req),
        )
      ) {
        return true
      }

      if (targets.length === 0) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({ applied: 0, skipped: 0, message: '没有需要处理的租户', results: [] }),
        )
        return true
      }

      // dryRun 或单租户：同步执行并直接返回结果（快，且调用方要立即看到明细）
      if (dryRun || targets.length === 1) {
        const results = []
        for (const address of targets) {
          try {
            const result = await userService.applyImageVersion(address, {
              dryRun,
              image: targetImage,
              // 审查 F9：管理员把租户打回默认 = 同一"回退"语义，工作目录同样
              // 只存档不塞回（判例 b：回退=干净默认，不分入口）
              ...(targetImage ? {} : { workspaceSnapshot: 'archive-only' }),
            })
            results.push({ address, ok: true, ...result })
          } catch (err) {
            results.push({ address, ok: false, error: err.message, backupPath: err.backupPath })
          }
        }
        const failed = results.filter((r) => !r.ok).length
        const skipped = results.filter((r) => r.skipped).length
        res.writeHead(failed > 0 && !dryRun ? 207 : 200, {
          'content-type': 'application/json; charset=utf-8',
        })
        res.end(
          JSON.stringify({
            applied: results.filter((r) => r.applied).length,
            skipped,
            failed,
            results,
          }),
        )
        return true
      }

      // ---- 批量：后台执行 ----
      imageApplyTask.running = true
      imageApplyTask.targets = [...targets]
      imageApplyTask.total = targets.length
      imageApplyTask.completed = 0
      imageApplyTask.results = []
      imageApplyTask.startedAt = Date.now()
      imageApplyTask.finishedAt = null

      ;(async () => {
        for (const address of targets) {
          try {
            const result = await userService.applyImageVersion(address, {
              image: targetImage,
              ...(targetImage ? {} : { workspaceSnapshot: 'archive-only' }),
            })
            imageApplyTask.results.push({ address, ok: true, ...result })
          } catch (err) {
            // 单个失败不中断整轮：批量场景必须把其余租户处理完
            imageApplyTask.results.push({
              address,
              ok: false,
              error: err.message,
              backupPath: err.backupPath,
            })
          }
          imageApplyTask.completed += 1
        }
        imageApplyTask.running = false
        imageApplyTask.finishedAt = Date.now()
        const failed = imageApplyTask.results.filter((r) => !r.ok).length
        console.log(`[dsh] apply finished: ${targets.length - failed}/${targets.length} ok`)
      })()

      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          started: true,
          total: targets.length,
          message: '应用任务已开始，请轮询 GET /api/admin/dsh/apply 查看进度',
        }),
      )
    } catch (err) {
      handleError(err, res)
    }
    return true
  }

  return false
}
