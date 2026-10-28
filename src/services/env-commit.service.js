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
  const { address, slug, displayName, intro, include, dryRun, operator } = p
  const opKind = p.opKind || 'env_commit'
  const name = swtcContainerName(address)
  const info = await dockerService.containerInfo(name)
  if (!info.exists || info.status !== 'running') {
    return {
      status: 409,
      body: {
        error: '源容器未在运行——定格需要活容器（执行时定格会停机数十秒并自动起回）',
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
  const repo = String(CONFIG.docker?.image || 'dsh-multitenant').split(':')[0]
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const tag = `${repo}:env-${address.slice(0, 8)}-${slug}-${ts}`
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
          '执行定格时你的容器会暂停约 15~60 秒：正在用的会话会断，恢复后照常',
          '密码、登录状态、聊天记录不会被带走（它们本来就与复制品隔离）；工作目录 /root/workspace 里的文件**默认清空、勾了才保留**（本次勾选: ' +
            (include.folders.join(', ') || '未勾选→全清') +
            '）',
          '清理是"尽力而为"，不是保证——复制品里有什么，以管理员逐条核对的清单为准，请如实勾选',
        ],
      },
    }
  }
  const parentImage = await dockerService.containerImageId(name)
  const out = await dockerService.commitEnvironment(name, tag, {
    maxBytes: Number(CONFIG.docker?.envMaxBytes) || 2 * 1024 * 1024 * 1024,
    scrubKeep: include.folders,
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
      return { status: 500, body: { error: `随行包导出失败，本次定格整体作废：${err.message}` } }
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
    bundle,
    scan,
    status: 'draft',
    pinnedBy: [],
    createdBy: operator,
    createdAt: new Date().toISOString(),
  }
  await dataService.putEnvironment(doc)
  dataService.logOperation(opKind, {
    address,
    tag: out.tag,
    includeSnapshot: include,
    imageId: out.imageId,
    sizeBytes: out.sizeBytes,
    scrubbed: out.scrubbed,
    operator,
  })
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

export { JSON_HDR }
