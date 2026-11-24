/**
 * 用户域路由 · 环境模板自助面（方案③，2026-10-27）
 * （refactor-giant-files P1 迁入，源 user.routes.js）
 *
 * 定格/发布权在管理员（PR1 审核闸），选用与回退在用户自己——"自己的容器自己主"。
 * 全部端点只作用于会话地址本人；applyImageVersion 的 dryRun 停机预览/重建/留痕全链路复用。
 * 资格门（freezeAllowed）与限流保持 handler 内原位——顺序=原样（会话 401 已由
 * guard:'user' 前置，其余判定次序一毫不改）。
 */

import { userService } from '../../services/user.service.js'
import { dockerService } from '../../services/docker.service.js'
import { envBundleService } from '../../services/env-bundle.service.js'
import {
  runEnvCommit,
  normEnvNames,
  autoSlug,
  normEnvWsExcludes,
} from '../../services/env-commit.service.js'
import { dataService } from '../../services/data.service.js'
import { skillService } from '../../services/skill.service.js'
import { credentialService } from '../../services/credential.service.js'
import { getRequestAddress } from '../../middleware/auth.middleware.js'
import { rateLimit } from '../../middleware/rate-limit.middleware.js'
import { swtcContainerName } from '../../utils/address.js'
import { handleError } from '../../utils/errors.js'
import { parseJsonBody } from '../../utils/parse-body.js'
import { defineRoute } from '../registry.js'

const envFreezeDenied = (res, addr) => {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
  res.end(
    JSON.stringify({
      error: `上传环境需要 CWT 或管理员凭证（当前地址 ${addr ? '未持有' : '无会话'}）`,
      code: 'FREEZE_REQUIRES_CWT',
      hint: '容器本身不受影响，照常使用；可在凭证页申请 CWT 后回来上传',
    }),
  )
}

export const USER_ENV_ROUTES = [
  // POST /api/user/environment-inventory —— 我可带的东西清单（只读）
  // —— 定格自助面（PR3）：cwt/admin 本人可格自己的容器（freezeAllowed 前置）。
  // 流程与管理员代格一字不差（runEnvCommit 共用）；权限差异=会话本人+资格门。
  defineRoute({
    method: 'POST',
    path: '/api/user/environment-inventory',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      if (!(await credentialService.freezeAllowed(addr))) return (envFreezeDenied(res, addr), true)
      if (!rateLimit(req, res, { max: 10, windowMs: 60000, keyPrefix: 'envinv' })) return true
      try {
        // 卷侧（helper：技能/插件/目录）与可写层侧（exec：workspace 顶层）并行，
        // 向导第 2 步两档各有真实数据源
        const [inventory, workspace, info, envsAll, curImage] = await Promise.all([
          envBundleService.inventory(addr),
          dockerService.listWorkspaceTop(swtcContainerName(addr)),
          dockerService.containerInfo(swtcContainerName(addr)),
          dataService.listEnvironments(),
          dockerService.containerImageId(swtcContainerName(addr)),
        ])
        // 正在跑某模板的镜像（按实物 ID 认，不按 pin）——前端据此亮"先回退"卡
        const runningTpl = curImage
          ? envsAll.find(
              (e) =>
                e.imageId === curImage &&
                (e.status === 'published' ||
                  e.sourceAddr === addr ||
                  (e.pinnedBy || []).includes(addr)),
            ) || null
          : null
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            inventory,
            workspace,
            canFreeze: true,
            containerRunning: !!(info.exists && info.status === 'running'),
            onTemplate: runningTpl
              ? {
                  name: runningTpl.displayName || runningTpl.slug,
                  byMe: runningTpl.sourceAddr === addr,
                }
              : null,
          }),
        )
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: `随行内容盘点失败：${err.message}` }))
      }
      return true
    },
  }),

  // POST /api/user/environment-browse {dir} —— 选择器的分层浏览（只读）
  defineRoute({
    method: 'POST',
    path: '/api/user/environment-browse',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      if (!(await credentialService.freezeAllowed(addr))) return (envFreezeDenied(res, addr), true)
      if (!rateLimit(req, res, { max: 30, windowMs: 60000, keyPrefix: 'envbrowse' })) return true
      const body = await parseJsonBody(req, res)
      if (!body) return true
      try {
        const listing = await envBundleService.browse(addr, String(body.dir || ''))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(listing))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: `浏览失败：${err.message}` }))
      }
      return true
    },
  }),

  // POST /api/user/environment-commit {displayName, intro, include, dryRun}
  // —— 自助定格：slug 平台自动生成（autoSlug），用户只管起名与勾选内容
  defineRoute({
    method: 'POST',
    path: '/api/user/environment-commit',
    guard: 'user',
    note: '定格是重动作（停机几十秒+占盘）：资格门+低频 rateLimit 双防刷，原位保留',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      if (!(await credentialService.freezeAllowed(addr))) return (envFreezeDenied(res, addr), true)
      if (!rateLimit(req, res, { max: 2, windowMs: 600000, keyPrefix: 'envfreeze' })) return true
      const body = await parseJsonBody(req, res)
      if (!body) return true
      const displayName = String(body.displayName || '')
        .trim()
        .slice(0, 60)
      if (!displayName) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '上传需要给环境起名（displayName，≤60 字）' }))
        return true
      }
      const intro = String(body.intro || '')
        .trim()
        .slice(0, 300)
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
            error:
              '子项摘除清单格式不正：须为"目录/子项"两段路径且不含 ..——隐私摘除宁可拒绝也不静默失效',
            code: 'BAD_WS_EXCLUDE',
          }),
        )
        return true
      }
      include.wsExcludes = wsEx
      try {
        const { status, body: respBody } = await runEnvCommit({
          address: addr,
          slug: autoSlug(displayName),
          displayName,
          intro,
          include,
          provenance: body.provenance,
          dryRun: !!body.dryRun,
          operator: addr, // 本人自助：审计操作人=会话地址（代格面记管理员）
          opKind: 'env_commit_self',
        })
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(respBody))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: `上传失败：${err.message}（源容器已确认起回）` }))
      }
      return true
    },
  }),

  // GET /api/user/environments - published 模板列表 + 我当前的环境来源
  defineRoute({
    method: 'GET',
    path: '/api/user/environments',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      const envs = await dataService.listEnvironments()
      const published = envs.filter((e) => e.status === 'published')
      const pinned = userService.state.swtcUsers?.[addr]?.pinnedImage ?? null
      // 认领兜底要认**全部状态**（判例 2026-10-30：作者下架后，正用着的人容器被
      // 闲置销毁、实物探测扑空，published-only 兜底把来源条谎成"默认环境"——
      // pin 是本人同意用的账，模板此刻上没上架都改不了"我用的就是它"的事实；
      // 暴露面仍只有 name/slug/author，不借道泄 intro/manifest）
      const mine = (pinned && envs.find((e) => e._id === pinned)) || null
      // 画面与真相收敛（第八案连带修正）：容器实物命中模板就算"套来的"，
      // 账本 pin 只在容器不在线时兜底——否则半途中止的回退会让来源条说谎，
      // 用户连"再点一次回退"的按钮都摸不到
      let runningTpl = null
      try {
        const curImage = await dockerService.containerImageId(swtcContainerName(addr))
        runningTpl = curImage
          ? published.find((e) => e.imageId === curImage) ||
            envs.find(
              (e) =>
                e.imageId === curImage &&
                (e.sourceAddr === addr || (e.pinnedBy || []).includes(addr)),
            ) ||
            null
          : null
      } catch {
        // 实物探测失败不拦列表：退回按账本认领
      }
      const shownTpl = runningTpl || mine
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: true,
          // 只展示审核放行的；manifest 不外露（用户选用面=作者+版本+大小，
          // 审核证据留在管理端）
          // 我的作品**全状态**（判例 2026-10-29：曾滤掉 published，作者已上架的
          // 东西在市场卡与自留地两头都不见，"下架"入口只剩市场卡一张——切换账号
          // 后找不到自己的环境。名也改 myWorks：账目如实，键名不再撒谎）
          myWorks: envs
            .filter((e) => e.sourceAddr === addr)
            .map((e) => ({
              id: e._id,
              name: e.displayName || e.slug,
              slug: e.slug,
              status: e.status,
              rejectReason: e.rejectReason || null, // 驳回理由回传作者（改起来才有方向）
              pinnedByCount: (e.pinnedBy || []).length,
              sizeBytes: e.sizeBytes,
              createdAt: e.createdAt,
            }))
            .sort((a2, b2) => String(b2.createdAt).localeCompare(String(a2.createdAt))),
          environments: published
            .map((e) => ({
              id: e._id,
              slug: e.slug,
              name: e.displayName || e.slug, // 人读处一律展示名（老数据回退 slug）
              intro: e.intro || null,
              author: e.sourceAddr,
              isMine: e.sourceAddr === addr, // 作者标记：我的模板卡上给「下架」入口
              dshVersion: e.dshVersion,
              sizeBytes: e.sizeBytes,
              scrubbed: e.scrubbed,
              createdAt: e.createdAt,
              // 详情页要料（用户验收：市场里的环境模板要有详情）——随行清单
              // 本来就是分发事实，展示不算泄密；manifest 全文仍留管理端
              include: {
                skills: (e.include?.skills || []).slice(0, 50),
                plugins: (e.include?.plugins || []).slice(0, 50),
                folders: (e.include?.folders || []).slice(0, 200),
              },
              bundleFiles: (e.bundle?.files || []).length,
              provenance: e.provenance || null, // 出身自述：记了就得看得见（列表白名单曾漏此字段成哑功能）
              bundleBytes: e.bundle?.bytes || 0,
              pinnedByCount: (e.pinnedBy || []).length,
            }))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
          yourCurrent: {
            image: pinned,
            // pin 的是版本镜像（平台钉版）而非模板——如实标 null，UI 归"其他"
            fromTemplate: shownTpl
              ? {
                  name: shownTpl.displayName || shownTpl.slug,
                  slug: shownTpl.slug,
                  author: shownTpl.sourceAddr,
                }
              : null,
          },
        }),
      )
      return true
    },
  }),

  // POST /api/user/environment/apply {id, dryRun} - 自助换到自己的容器。
  // 命名避坑：不叫 -reset/-apply 后缀——/reset 后缀被 tenant.routes 卷删除端点
  // 劫持，/restart|/reset|/remove|/stop 后缀都在签名强制名单里。
  // 校验与 admin env-apply 同口径（published + digest 逐字），差别只在目标
  // 地址恒等于会话本人——不存在"用别人的会话换别人的容器"面。
  defineRoute({
    method: 'POST',
    path: '/api/user/environment/apply',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      if (!rateLimit(req, res, { max: 5, windowMs: 600000, keyPrefix: 'envapply' })) return true
      const body = await parseJsonBody(req, res)
      if (!body) return true
      const id = String(body.id || '')
      const doc = await dataService.getEnvironment(id)
      if (!doc) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '模板不存在' }))
        return true
      }
      if (doc.status !== 'published') {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '该模板未上架或已下架' }))
        return true
      }
      // digest 不可变钉（与 admin 面同一道供应链闸）
      const nowId = await dockerService.imageId(doc._id)
      if (!nowId) {
        res.writeHead(410, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '模板镜像已不在本机，不可选用' }))
        return true
      }
      if (nowId !== doc.imageId) {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '模板与账本 digest 不符（同名被覆盖），拒用' }))
        return true
      }
      try {
        const result = await userService.applyImageVersion(addr, {
          image: doc._id,
          dryRun: !!body.dryRun,
        })
        let bundleOut = {}
        try {
          bundleOut = await envBundleService.applyBundleTo(addr, doc, { dryRun: !!body.dryRun })
        } catch (err) {
          bundleOut = { bundleError: `随行包装入失败（镜像切换本身已完成）：${err.message}` }
        }
        if (!body.dryRun) {
          const cur = await dataService.getEnvironment(id)
          const pinnedBy = new Set(cur?.pinnedBy || [])
          pinnedBy.add(addr)
          await dataService.patchEnvironment(id, { pinnedBy: [...pinnedBy] })
          // 换钉即迁账：A→B 后 A 的 pinnedBy 还挂着本人 = 幽灵引用（下架回执
          // usingCount 虚高、GC"被引用"护栏被撑大、hadTpl 兜底清错清单）
          for (const other of await dataService.listEnvironments()) {
            if (other._id !== id && (other.pinnedBy || []).includes(addr)) {
              await dataService.patchEnvironment(other._id, {
                pinnedBy: other.pinnedBy.filter((a) => a !== addr),
              })
            }
          }
          dataService.logOperation('env_apply_self', {
            id,
            address: addr,
            operator: addr, // 本人自助：操作人=会话地址（与管理员代发区分审计）
          })
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ...result, ...bundleOut }))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/user/environment/submit {id} - 作者重新提交审核（unlisted → draft）。
  // 出口律：下架有去路。'draft' 就是定格入队本体的字面（env-commit 造它，
  // 管理端过审/驳回只认它）——重提必须回到这个真队列，不能回 'pending' 那种
  // 管理端不认的幽灵态（判例：曾写 pending，重提=从队列消失）。
  defineRoute({
    method: 'POST',
    path: '/api/user/environment/submit',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      if (!rateLimit(req, res, { max: 10, windowMs: 60000, keyPrefix: 'envmeta' })) return true
      const body = await parseJsonBody(req, res)
      if (!body) return true
      try {
        const doc = await dataService.getEnvironment(String(body.id || ''))
        if (!doc) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '模板不存在' }))
          return true
        }
        if (doc.sourceAddr !== addr) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '只能提交自己上传的模板' }))
          return true
        }
        if (doc.status !== 'unlisted') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '只有已下架的作品可以重新提交审核' }))
          return true
        }
        await dataService.patchEnvironment(doc._id, { status: 'draft' })
        dataService.logOperation('env_submit_self', { address: addr, id: doc._id })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, status: 'draft' }))
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/user/environment/unpublish {id} - 作者自助下架：published → unlisted
  // （已下架·自己摘的）。判例 2026-10-30：下架**不是**回到待审核（draft）——
  // 摘了就该安静待着，作者想回来才重新排队；也绝不复用 'draft' 字面，否则
  // 管理队列里凭空长出没人提交的"待审核"。下架≠删除：被引用之物不可物理删，
  // 正在用的人（含作者自己）不受影响，只是市场不再展示、不再接受新的选用。
  defineRoute({
    method: 'POST',
    path: '/api/user/environment/unpublish',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      if (!rateLimit(req, res, { max: 10, windowMs: 60000, keyPrefix: 'envmeta' })) return true
      const body = await parseJsonBody(req, res)
      if (!body) return true
      try {
        const doc = await dataService.getEnvironment(String(body.id || ''))
        if (!doc) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '模板不存在' }))
          return true
        }
        if (doc.sourceAddr !== addr) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '只能下架自己上传的模板' }))
          return true
        }
        if (doc.status !== 'published') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '只有已上架的模板需要下架（其他状态本就不在市场里）' }))
          return true
        }
        await dataService.patchEnvironment(doc._id, { status: 'unlisted' })
        // 裁定 2026-10-30：下架者不再住进下架物——作者本人的钉回落默认环境（在用的
        // 别人一律不动）；从此重连不回滚到定格点，攒好的改动下次定格就是现在。
        const off =
          typeof userService.unpinAuthorOnOffshelf === 'function'
            ? await userService.unpinAuthorOnOffshelf(addr, doc._id, 'unpublish')
            : { skipped: true }
        // 账实一致：回读账本再计数（doc 是解钉前的陈旧引用）；作者既已回落默认，
        // 任何记账时序下都不该被算进"仍在用"——filter 对已摘/未摘幂等
        const postPin = (await dataService.getEnvironment(doc._id))?.pinnedBy || []
        const usingLeft = off.unpinned ? postPin.filter((a) => a !== addr).length : postPin.length
        dataService.logOperation('env_unpublish_self', { address: addr, id: doc._id })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            ok: true,
            status: 'unlisted',
            usingCount: usingLeft,
            selfUnpinned: Boolean(off.unpinned),
          }),
        )
      } catch (err) {
        handleError(err, res)
      }
      return true
    },
  }),

  // POST /api/user/environment-reset {dryRun} - 一键回平台默认环境
  // （applyImageVersion(image=null)=摘 pin 回 latest 语义；引用账本同步清）
  defineRoute({
    method: 'POST',
    path: '/api/user/environment/revert',
    guard: 'user',
    handler: async (req, res) => {
      const addr = getRequestAddress(req)
      if (!rateLimit(req, res, { max: 5, windowMs: 600000, keyPrefix: 'envrevert' })) return true
      const body = await parseJsonBody(req, res)
      if (!body) return true
      try {
        // 先读账本：我现在钉在谁身上（hadTpl 必须在解绑与换容器之前拿到）
        const envs = body.dryRun ? [] : await dataService.listEnvironments()
        const recNow = userService.state?.swtcUsers?.[addr]
        // 清除清单的源头必须是**现在钉着的镜像**所属模板（判例：先后套过 A/B 的
        // 人，pinnedBy 双挂时按旧账 A 的清单清除 = 清错世界）；pinnedBy 只兜底。
        const hadTpl =
          (recNow?.pinnedImage && envs.find((e) => e._id === recNow.pinnedImage)) ||
          envs.find((e) => (e.pinnedBy || []).includes(addr)) ||
          null
        let cleanedCount = 0
        // 「一并清除」必须在**换容器之前**做（判例 2026-10-29 雷达竞态：代际在
        // 容器重建那刻翻转、雷达随即刷新页面——清除若排在换容器之后，页面刷
        // 出来看到的是"半干净"世界，插件明明删了还显示）。在旧容器里先清干净，
        // 页面刷新那一眼就是终态。
        let cleanNote = null
        if (hadTpl && body.alsoClean) {
          // 技能必须走 skillService.uninstall 正路（判例：只 rm 文件不销安装账，
          // 「我的技能」读账本显示装了个空气）；插件无账本，按名单 rm 目录。
          const NAME_OK = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/
          const removed = []
          const failed = []
          for (const n of hadTpl.include?.skills || []) {
            if (!NAME_OK.test(n)) continue
            try {
              await skillService.uninstall(addr, n)
              removed.push(n)
            } catch {
              failed.push(n)
            }
          }
          // 删护内容（判例 55，裁定"插件可能来自 GitHub/官网/自写"）：manifest 躺着
          // "我当初放的字节指纹"——槽位实物与之全等才删；不等=已被别的来源占据，
          // 留物留话；查不了=不代删（可重试）。包内没记指纹的名字退回旧规点名删并如实注明。
          const plugins = (hadTpl.include?.plugins || []).filter((n) => NAME_OK.test(n))
          const occupied = []
          const skip = new Set()
          let legacyNoHash = 0
          if (plugins.length) {
            // null 原型（判例 57 H2）：插件目录名 '__proto__' 是合法名——普通字面量上
            // `obj[n] ||= {}` 会拿到 Object.prototype 再把键直写全局原型，污染驻进程。
            const expectByPlugin = Object.create(null)
            for (const f of hadTpl.bundle?.files || []) {
              const m = /^plugins\/([^/]+)\/(.+)$/.exec(String(f.p || ''))
              if (m && f.sha256) (expectByPlugin[m[1]] ||= {})[m[2]] = f.sha256
            }
            const checkable = plugins.filter((n) => expectByPlugin[n])
            legacyNoHash = plugins.length - checkable.length
            if (checkable.length) {
              const probe = await envBundleService.probePluginContent(
                addr,
                Object.fromEntries(checkable.map((n) => [n, expectByPlugin[n]])),
              )
              for (const n of checkable) {
                if (probe && probe[n] === true) continue
                if (probe && probe[n] === false) occupied.push(n)
                else failed.push(`${n}（实物查不了）`)
                skip.add(n)
              }
            }
            const deletable = plugins.filter((n) => !skip.has(n))
            if (deletable.length) {
              try {
                await dockerService.execSh(
                  swtcContainerName(addr),
                  deletable.map((n) => `rm -rf /dsh-home/plugins/${n}`).join(' && '),
                )
                removed.push(...deletable)
              } catch {
                failed.push(...deletable)
              }
            }
          }
          cleanNote =
            removed.length || failed.length || occupied.length
              ? (failed.length
                  ? `已清除 ${removed.length} 项，${failed.length} 项未成（${failed.join('、')}），可重试。`
                  : `已按清单清除 ${removed.length} 项随行技能/插件（账本同步销记${
                      legacyNoHash
                        ? `；其中 ${legacyNoHash} 项包内无字节指纹在册，按旧规点名删`
                        : ''
                    }）。`) +
                (occupied.length
                  ? ` ${occupied.join('、')} 槽位现被其他内容占据（自写/另行下载/改过），未删。`
                  : '')
              : '该模板清单里没有登记在册的随行技能/插件，无需清除。'
          cleanedCount = removed.length
        } else if (body.alsoClean && !hadTpl) {
          cleanNote = '查无套用模板的记录，无需清除。'
        }
        const result = await userService.applyImageVersion(addr, {
          image: null,
          dryRun: !!body.dryRun,
          // 回退=干净默认（判例语义定规）：工作目录只存档不进新容器
          workspaceSnapshot: 'archive-only',
        })
        if (!body.dryRun) {
          for (const e of envs) {
            if (!(e.pinnedBy || []).includes(addr)) continue
            // 新鲜读再摘（判例：apply 侧已改新鲜读，这里用陈旧数组覆写会在
            // 重建窗口内吞掉别人刚挂上去的引用账）
            const fresh = await dataService.getEnvironment(e._id)
            if (fresh && (fresh.pinnedBy || []).includes(addr)) {
              await dataService.patchEnvironment(e._id, {
                pinnedBy: fresh.pinnedBy.filter((a) => a !== addr),
              })
            }
          }
          dataService.logOperation('env_reset_self', { address: addr, operator: addr })
          result.revertNote = cleanedCount
            ? `已回退到默认环境，随行技能/插件同步清除（${cleanedCount} 项）。DSH 页面会自动刷新。`
            : '已回退到默认环境（随行技能/插件保留，可在列表卸载）。DSH 页面会自动刷新。'
          if (cleanNote) result.cleanNote = cleanNote
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      } catch (err) {
        if (cleanNote) {
          // 随行物已经清了、容器却没换成——只报 500 会丢知情权（判例④）：
          // 已删的东西必须如实上报（remove-skill 幂等，重试安全）
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(
            JSON.stringify({
              error: `清除已生效但回退未完成：${String(err?.message || err)}。可重试。`,
              cleanNote,
              code: 'REBUILD_FAILED_AFTER_CLEAN',
            }),
          )
        } else {
          handleError(err, res)
        }
      }
      return true
    },
  }),
]
