/**
 * env-commit.service — 定格流程单一实现（admin 代格 / user 自助共用）
 *
 * 为什么抽出来：两条入口的**世界动作必须一字不差**（同样的停机/清洗/导出/
 * 配额/账本形状），复制两份必然漂移——漂移出来的差异最后都由用户买单。
 * 权限差异（requireAdminSignature vs session+freezeAllowed）留在各自路由层，
 * 这里只管"从 containerInfo 开始到入账本为止"的流程，返回 {status, body}
 * 由路由层落响应。
 *
 * 模块图纪律：只静态引已有服务单例（它们构造期不碰半 mock 数据），
 * 本模块自身零顶层副作用。
 */
import { CONFIG } from '../config/config.js'
import { dockerService } from './docker.service.js'
import { dataService } from './data.service.js'
import { envBundleService } from './env-bundle.service.js'
import { swtcContainerName } from '../utils/address.js'

const JSON_HDR = { 'content-type': 'application/json; charset=utf-8' }

// 勾选名单归一：只收单层名（无 / 无控制符），200 条封顶——后端硬闸，
// 前端灰显不是防线（export/install 两侧还要各自再验根）

// 子项摘除清单校验（判例 2026-10-30：隐私摘除必须响亮失败——格式不正宁可不
// 定格，绝不静默放行让密钥跟着上云）。合法形如 "目录/子项" 恰好两段，段内无
// \0、不是 . / ..、单段 ≤255。null=有非法项，调用方必须拒绝。
function normEnvWsExcludes(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > 200) return null
  const out = []
  for (const x of raw) {
    const segStr = String(x === null || x === undefined ? '' : x).trim()
    const segs = segStr.split('/')
    if (segs.length !== 2 || !segStr) return null
    for (const seg of segs) {
      if (!seg || seg.length > 255 || seg === '.' || seg === '..' || seg.includes('\0')) return null
    }
    out.push(segStr)
  }
  return [...new Set(out)]
}

export function normEnvNames(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => String(x || '').trim())
    .filter((x) => x && !x.includes('/') && x !== '.' && x !== '..' && x.length <= 200)
    .slice(0, 200)
}

/**
 * 展示名 → slug（镜像 tag 治理段，用户不再被要求手填技术名）：
 * ascii 归一，失败退化 'env'；产物必须过 /^[a-z0-9][a-z0-9-]{1,40}$/。
 */
export function autoSlug(displayName) {
  let base = String(displayName || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+/g, '-')
    .replace(/-+$/, '')
    .slice(0, 20)
    .replace(/-+$/, '')
  if (!/^[a-z0-9]/.test(base)) base = base ? `e-${base}` : 'env'
  if (base.length < 2) base = `${base}-x`
  return base.slice(0, 41)
}

/**
 * @param {{address:string, slug:string, displayName?:string, intro?:string,
 *   include:{skills:string[],plugins:string[],folders:string[]},
 *   dryRun:boolean, operator:string, opKind?:string}} p
 * @returns {Promise<{status:number, body:object}>}
 */
export async function runEnvCommit(p) {
  const { address, slug, displayName, intro, include, provenance, dryRun, operator } = p
  const opKind = p.opKind || 'env_commit'
  const name = swtcContainerName(address)
  const info = await dockerService.containerInfo(name)
  if (!info.exists || info.status !== 'running') {
    return {
      status: 409,
      body: {
        error: '源容器未在运行——上传需要活容器（执行时会停机数十秒并自动起回）',
      },
    }
  }
  const envs = await dataService.listEnvironments()
  const mine = envs.filter(
    (e) => e.sourceAddr === address && !['revoked', 'rejected'].includes(e.status),
  )
  if (mine.length >= 5) {
    return {
      status: 409,
      body: {
        error: '该来源未下架模板已达 5 个上限（镜像存储不在 tier 配额内，从严治理）',
        remaining: 0,
      },
    }
  }
  // 判例（2026-10 用户："已经套用了环境还能点定格，这不合理"）：定格复制的是
  // "容器现在的样子"——现在这个样子若来自某个模板，格出来就是它的翻版（插件
  // 还会按文件原样进包、作者栏却写你的名），对原作者和你都不公平。硬闸按
  // **实物镜像 ID** 判定（真相优先——pin 指针可能过期），出路只有一条：回退。
  const curImage = await dockerService.containerImageId(name)
  const usedTpl = curImage ? envs.find((e) => e.imageId === curImage) : null
  if (usedTpl) {
    const nm = usedTpl.displayName || '套来的环境'
    return {
      status: 409,
      body: {
        code: 'TEMPLATE_IN_USE',
        error:
          opKind === 'env_commit_self'
            ? `你的容器正在跑「${nm}」这个套来的环境——在它上面上传只会传出它的翻版。想上传自己搭的环境：先点「回退到默认」，重新装好你的东西，再上传。`
            : `该租户的容器正在跑「${nm}」——替他上传只会传出这个模板的翻版。如需换代：让他（或你在管理端）先回退到默认，装好新东西再传。`,
      },
    }
  }
  const repo = String(CONFIG.docker?.image || 'dsh-multitenant').split(':')[0]
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const tag = `${repo}:env-${address.slice(0, 8)}-${slug}-${ts}`
  // 定格是"新建"不是"修改"：同名旧模板与它的使用者不受任何影响。但货架
  // 上出现两个同名模板会让接收者犯迷糊——预览时如实提醒一句（不禁止：
  // 禁止作者再定格=禁止他更新环境，方向反了）。
  const sameName = mine.filter((e) => e.displayName === displayName)
  if (dryRun) {
    return {
      status: 200,
      body: {
        dryRun: true,
        tag,
        quota: { used: mine.length, limit: 5 },
        steps: [
          '先把你的容器暂停几十秒',
          '把容器里装好的软件环境整体复制一份',
          '清理一遍残留痕迹（命令历史、临时密钥等——只清复制出来的那份，不动你的容器）',
          '检查复制品体积与来源，然后立刻把你的容器恢复运行',
          '存为"待审核"：管理员逐条核过之后，才会摆上平台货架',
        ],
        notices: [
          '执行上传时你的容器会暂停约 15~60 秒：正在用的会话会断，恢复后照常',
          '密码、登录状态、聊天记录不会被带走（它们本来就与复制品隔离）；工作目录 /root/workspace 里的文件**默认清空、勾了才保留**（本次勾选: ' +
            (include.folders.join(', ') || '未勾选→全清') +
            (include.wsExcludes && include.wsExcludes.length
              ? `；摘除子项 ${include.wsExcludes.join('、')}（它们只留容器，不入镜像）`
              : '') +
            '）',
          '清理是"尽力而为"，不是保证——复制品里有什么，以管理员逐条核对的清单为准，请如实勾选',
          ...(sameName.length
            ? [
                `注意：你已经有一个叫「${displayName}」的在架/待审模板——上传会生成全新的一个，旧模板和正在用它的人完全不受影响；新模板上架后建议撤销旧的，免得货架上出现两个同名`,
              ]
            : []),
        ],
      },
    }
  }
  const parentImage = await dockerService.containerImageId(name)
  const out = await dockerService.commitEnvironment(name, tag, {
    maxBytes: Number(CONFIG.docker?.envMaxBytes) || 2 * 1024 * 1024 * 1024,
    scrubKeep: include.folders,
    scrubExclude: include.wsExcludes || [],
    labels: {
      'dsh.env.author': address,
      'dsh.env.slug': slug,
      'dsh.env.parent': parentImage || 'unknown',
    },
  })
  // 随行包导出（plugins 文件进包；skills 不进 tar=按名随行走官方管线）：
  // 失败=定格整体作废——"勾了却没带上"是最坏的半成功；源容器已在
  // commitEnvironment 内起回，这里删像删包还世界原位
  let bundle = null
  let scan = null
  const exportItems = include.plugins.map((n) => ({ root: 'plugins', name: n }))
  if (exportItems.length) {
    try {
      const b = await envBundleService.exportBundle(address, out.tag, exportItems)
      bundle = {
        path: `env-bundles/${String(out.tag).replace(/[^A-Za-z0-9._-]/g, '_')}`,
        bytes: b.bytes,
        files: b.files,
      }
      scan = b.scan
    } catch (err) {
      await dockerService.removeImage(out.tag)
      await envBundleService.removeBundle(out.tag)
      return { status: 500, body: { error: `随行包导出失败，本次上传整体作废：${err.message}` } }
    }
  }
  const doc = {
    _id: out.tag,
    sourceAddr: address,
    slug,
    displayName: displayName || slug,
    intro: intro || null,
    imageTag: out.tag,
    imageId: out.imageId,
    parentImage: parentImage || null,
    dshVersion: out.dshVersion,
    sizeBytes: out.sizeBytes,
    scrubbed: out.scrubbed,
    manifest: out.manifest,
    include: { ...include },
    // 插件出身自述（判例 55）：作者声明、非防线——只随行清单内点名过的插件才有资格记
    provenance: normEnvProvenance(provenance, include.plugins || []),
    bundle,
    scan,
    status: 'draft',
    // 作者即首位使用者：格的正是他此刻的容器，内容一字不差（判例 2026-10-30）
    pinnedBy: [address],
    createdBy: operator,
    createdAt: new Date().toISOString(),
  }
  await dataService.putEnvironment(doc)
  // 判例 2026-10-30：定格=自采纳闭环。自己格容器，自己的"当前环境"立刻就是
  // 这套定格物——来源条按 pin 认账（pin 存 tag=文档 id，本就是同一串）。
  // 过去只入账本不采纳：作者格完仍见"默认环境"，像白格了一趟。
  // 换钉即迁账（与 apply 面同款纪律）：从旧钉模板的引用账里摘掉自己。
  const { userService } = await import('./user.service.js')
  const rec = userService.state?.swtcUsers?.[address] ?? null
  const prevPin = rec?.pinnedImage ?? null
  if (rec && prevPin !== doc._id) {
    if (prevPin) {
      const oldDoc = (await dataService.listEnvironments()).find(
        (e) => String(e._id) === String(prevPin),
      )
      if (oldDoc && (oldDoc.pinnedBy || []).includes(address)) {
        oldDoc.pinnedBy = oldDoc.pinnedBy.filter((x) => x !== address)
        await dataService.putEnvironment(oldDoc)
      }
    }
    userService.state.swtcUsers[address] = { ...rec, pinnedImage: doc._id }
    if (typeof userService._saveState === 'function') {
      try {
        await userService._saveState()
      } catch {}
    }
    dataService.logOperation('env_autopin_on_commit', {
      address,
      from: prevPin,
      to: doc._id,
      operator,
    })
  }
  dataService.logOperation(opKind, {
    address,
    tag: out.tag,
    includeSnapshot: include,
    imageId: out.imageId,
    sizeBytes: out.sizeBytes,
    scrubbed: out.scrubbed,
    operator,
  })

  // 定格完结账（判例 2026-10-30）：作者格完，其"当前环境"即刻就是这套定格物。
  // 尽力轨——模板已安全入账本，采纳环节炸了不反杀定格结果，只记审计偏差。
  try {
    const { userService } = await import('./user.service.js')
    if (typeof userService.adoptCommitAsOwn === 'function') {
      await userService.adoptCommitAsOwn(address, doc._id)
    }
  } catch (err) {
    dataService.logOperation('env_adopt_failed', {
      address,
      to: doc._id,
      error: err.message,
    })
  }
  return {
    status: 200,
    body: {
      template: { ...doc, manifest: undefined, manifestCount: out.manifest.length },
      notice: out.scrubbed
        ? '已按尽力清单清洗；请审 manifest 后 publish'
        : '⚠ 清洗容器未执行成功，产物为未清洗层——请重点审 manifest 后再决定是否 publish',
      quota: { used: mine.length + 1, limit: 5 },
    },
  }
}

export { JSON_HDR, normEnvWsExcludes }

/**
 * 出身自述规整（判例 55）：raw = {plugins: {name: 'github' | {kind,url}}}。
 * kind 枚举 ['self','github','official','other']；未点名（不在随行插件清单）丢弃；
 * url ≤200（self 不带 url）；全空 → null（不制造空账）。
 */
export function normEnvProvenance(raw, allowedNames) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const src = raw.plugins && typeof raw.plugins === 'object' ? raw.plugins : null
  if (!src) return null
  const allowed = new Set((allowedNames || []).map(String))
  const out = {}
  for (const [name, v] of Object.entries(src)) {
    if (!allowed.has(String(name))) continue
    const kind = v && typeof v === 'object' ? String(v.kind || '') : String(v || '')
    if (!['self', 'github', 'official', 'other'].includes(kind)) continue
    const url =
      v && typeof v === 'object' && v.url
        ? String(v.url)
            .trim()
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .slice(0, 200)
        : ''
    out[String(name)] = kind !== 'self' && url ? { kind, url } : { kind }
  }
  return Object.keys(out).length ? out : null
}
