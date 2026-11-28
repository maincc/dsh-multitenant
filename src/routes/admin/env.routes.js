/**
 * 管理域路由 · 环境模板（environment-templates PR1，2026-10-27）
 * （refactor-giant-files P1 迁入，源 admin.routes.js）
 *
 * 定格→draft→人审 publish→apply→revoke；digest 不可变钉；下架不驱逐。
 * docker 面只有管理员碰（形态 B 会审定案）；用户侧自助口子在 PR3 另议。
 * 六个写面 op 全部注册即校验白名单；两个只读盘点面（inventory/browse）免签——
 * 判例 H2（2026-11-06）：纯算即 return 的预览不该被自断，正式落库照旧签。
 */

import { userService } from '../../services/user.service.js'
import { dataService } from '../../services/data.service.js'
import { dockerService } from '../../services/docker.service.js'
import { envBundleService } from '../../services/env-bundle.service.js'
import { runEnvCommit, normEnvNames, normEnvWsExcludes } from '../../services/env-commit.service.js'
import { getAdminSession } from '../../middleware/auth.middleware.js'
import { requireAdminSignature } from '../../middleware/admin-signature.middleware.js'
import { validateSwtcAddress } from '../../middleware/validate.middleware.js'
import { normalizeAddress } from '../../utils/address.js'
import { parseJsonBody } from '../../utils/parse-body.js'
import { defineRoute } from '../registry.js'

export const ENV_ROUTES = [
  // POST /api/admin/env-commit {address, slug, dryRun} —— 定格用户容器为模板草稿
  defineRoute({
    method: 'POST',
    path: '/api/admin/env-commit',
    guard: 'admin',
    signOp: 'env-commit',
    note: 'dryRun 免签（审查 H2 判例）、正式落库签——条件在 handler 内，注册面如实声明',
    handler: async (req, res) => {
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
    },
  }),

  // GET /api/admin/environments —— 模板账本列表（manifest 折叠，详情按需单查）
  defineRoute({
    method: 'GET',
    path: '/api/admin/environments',
    guard: 'admin',
    handler: async (_req, res) => {
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
    },
  }),

  // GET /api/admin/environments/<id> —— 单模板全量（含 manifest 审核面）
  defineRoute({
    method: 'GET',
    prefix: '/api/admin/environments/',
    guard: 'admin',
    handler: async (_req, res, path) => {
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
    },
  }),

  // POST /api/admin/env-publish {id} —— 审完 manifest 放行（draft→published）
  defineRoute({
    method: 'POST',
    path: '/api/admin/env-publish',
    guard: 'admin',
    signOp: 'env-publish',
    handler: async (req, res) => {
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
    },
  }),

  // POST /api/admin/env-revoke {id} —— 撤 listing：禁新 pin，不驱逐在用者（只减不增）
  defineRoute({
    method: 'POST',
    path: '/api/admin/env-revoke',
    guard: 'admin',
    signOp: 'env-revoke',
    handler: async (req, res) => {
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
    },
  }),

  // POST /api/admin/env-apply {id, address, dryRun} —— 分发：digest 逐字校验后
  // 走既有 applyImageVersion（停机/重建/留痕/重建保持全是现成的）
  defineRoute({
    method: 'POST',
    path: '/api/admin/env-apply',
    guard: 'admin',
    signOp: 'env-apply',
    handler: async (req, res) => {
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
    },
  }),

  // POST /api/admin/env-inventory {address} —— 代格前内容盘点（只读；免签）
  defineRoute({
    method: 'POST',
    path: '/api/admin/env-inventory',
    guard: 'admin',
    note: '只读盘点免签（对齐 env-browse；写面全在册）',
    handler: async (req, res) => {
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
    },
  }),

  // POST /api/admin/env-browse {address, dir} —— 选择器的分层列表（只读；免签）
  defineRoute({
    method: 'POST',
    path: '/api/admin/env-browse',
    guard: 'admin',
    note: '只读浏览免签（同上）',
    handler: async (req, res) => {
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
    },
  }),

  // POST /api/admin/env-scan {id} —— 重跑随行包检测（规则库升级后全量再扫；
  // 结果写账本=审核底稿的版本化。写账本故签名，同 publish 形态）
  defineRoute({
    method: 'POST',
    path: '/api/admin/env-scan',
    guard: 'admin',
    signOp: 'env-scan',
    handler: async (req, res) => {
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
    },
  }),

  // POST /api/admin/env-reject {id, reason} —— 驳回即弃（方案 §9-3 拍板）：
  // 只作用于 draft；镜像与包当场删除，理由回传作者面；留账本摘要可追责。
  defineRoute({
    method: 'POST',
    path: '/api/admin/env-reject',
    guard: 'admin',
    signOp: 'env-reject',
    handler: async (req, res) => {
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
          JSON.stringify({
            error: `状态 ${doc.status}：驳回只作用于 draft（published 走 revoke）`,
          }),
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
    },
  }),
]
