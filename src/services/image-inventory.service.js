/**
 * 本项目镜像的"归属与可清理性"判定 —— 唯一真源。
 *
 * 从 admin.routes.js 抽出（2026-09 查重合并）：原先只有清理面板用它；
 * F3 维护定时器的悬空回收改为**按 ID 删本项目悬空**后也走这里，两处判定
 * 同源，杜绝"面板说可删、后台半夜删了别人的"这类作用域漂移。
 *
 * 为什么需要精确归属：这台机器上同时跑着其它项目的镜像（faucet 等）。
 * 悬空（`<none>`）不等于"我们的垃圾"——`docker image prune` 是全机作用域，
 * 会连别的项目 untag 掉的旧构建一起删。所以本项目从清理面板起就定死：
 * **绝不使用 docker image prune，只按 ID 精确删除**（见 admin.routes 同注释）。
 *
 * 归属判定不能只看仓库名：镜像一旦被 untag，`docker images` 里的 Repository
 * 就变成 `<none>` —— 而那恰恰就是我们要清理的悬空构建。只按仓库名过滤会
 * 一个都筛不出来。用平台自己的构建历史（data/dsh-image.json）来认领，既能
 * 认出自己人，也绝不会把别的项目的悬空镜像纳进来；历史没记上的（构建中途
 * 失败/手工 build）再靠 Dockerfile 特征补认。
 */

import { CONFIG } from '../config/config.js'
import { dockerService } from './docker.service.js'

/**
 * 镜像 ID 的双向前缀匹配。
 *
 * `docker images` 给的是短 ID（通常 12 位，冲突时更长），inspect 给的是完整
 * sha256。只认"恰好 12 位"会漏判，所以两个方向都比。
 * @param {string} a
 * @param {string} b
 */
export function matchImageId(a, b) {
  const x = String(a || '')
    .replace(/^sha256:/, '')
    .toLowerCase()
  const y = String(b || '')
    .replace(/^sha256:/, '')
    .toLowerCase()
  if (!x || !y) return false
  return x === y || x.startsWith(y) || y.startsWith(x)
}

/**
 * 平台构建过的镜像 ID 集合（完整与短 ID 都在内，便于前缀匹配）。
 */
function collectOurImageIds(record) {
  const ids = new Set()
  const add = (raw) => {
    const s = String(raw || '')
      .replace(/^sha256:/, '')
      .toLowerCase()
    if (!s) return
    ids.add(s)
    ids.add(s.slice(0, 12))
  }
  add(record?.current?.imageId)
  for (const h of record?.history || []) add(h?.imageId)
  return ids
}

/**
 * 镜像是否属于本项目。
 * 带本项目 tag 的按仓库名认；无 tag 的按"是否为历史构建过的镜像"认。
 */
function isOurImage(im, repo, ourIds) {
  return im?.repository === repo || ourIds.has(String(im?.id || '').toLowerCase())
}

/**
 * 计算机器人本项目每个本地镜像的可清理性。
 *
 * **唯一判定来源**：/status（版本历史标记）、/images（清理面板）与
 * maintenance 定时器（每日悬空回收）都用它，否则入口之间会出现
 * "历史说可清理、清理面板说不行"这类自相矛盾。
 *
 * 可删条件（同时满足）：属于本项目、非 current、无任何容器（含已停止）引用。
 * 带 tag 的镜像同样可删（旧版本 tag 一样占 1.2GB），但前端默认不勾选，
 * 后台定时器则**永不碰带 tag 的**（回退弹药只归人管）。
 *
 * @returns {Promise<{
 *   image: string, currentImageId: string|null,
 *   items: Array<object>, removableCount: number, removableBytes: number,
 *   infoIncomplete: boolean, danglingCount: number, taggedCount: number
 * }>}
 */
export async function collectPrunableImages(record) {
  const current = record?.current ?? null
  const image = String(CONFIG.docker?.image || 'dsh-multitenant')
  const repo = image.split(':')[0]
  const local = await dockerService.listImages()

  // 归属判定不能只看仓库名：untag 后 Repository 会变成 <none>，
  // 那正是要清理的悬空构建 → 用平台历史 ID 一起认领（见 isOurImage）
  const ourIds = collectOurImageIds({ current, history: record?.history || [] })
  // 历史只覆盖"平台成功记录过"的构建；无 tag 且不在历史里的自家悬空构建
  // （构建中途失败/手工 build 的产物）要靠 Dockerfile 特征补认，否则永远清不掉
  try {
    for (const id of await dockerService.listUntaggedBySignature(local)) ourIds.add(id)
  } catch {
    // 认领失败不影响主流程：少认几个只是少几个可清理项，绝不误删
  }
  const mine = local.filter((im) => isOurImage(im, repo, ourIds))

  // 容器 → 镜像 对应（要能说清"谁在用"，只给布尔量不够）
  let containers = null
  try {
    containers = await dockerService.listContainerImages()
  } catch {
    containers = null // 拿不到 → 保守：一律当作在用
  }

  const items = mine.map((im) => {
    const dangling = !im.tag || im.tag === '<none>'
    const isCurrent = Boolean(current?.imageId) && matchImageId(im.id, current.imageId)
    const usedBy =
      containers === null
        ? []
        : containers.filter((c) => c.imageId && matchImageId(c.imageId, im.id))
    const used = containers === null || usedBy.length > 0
    // 悬空镜像没有 tag，但平台历史里有它对应的版本 —— 标出来，
    // 管理员才知道"这 843MB 是哪个版本留下的"，而不是面对一个裸 ID
    const fromHistory = dangling
      ? ((record?.history || []).find((h) => matchImageId(h.imageId, im.id))?.version ?? null)
      : null
    return {
      ...im,
      dangling,
      isCurrent,
      used,
      historyVersion: fromHistory,
      running: usedBy.some((c) => c.state === 'running'),
      usedBy: usedBy.map((c) => ({ name: c.name, state: c.state })),
      removable: !isCurrent && !used,
    }
  })

  return {
    image,
    currentImageId: current?.imageId ?? null,
    items,
    removableCount: items.filter((i) => i.removable).length,
    removableBytes: items.filter((i) => i.removable).reduce((s, i) => s + i.sizeBytes, 0),
    // 悬空构建（无 tag）是"纯垃圾"，删了没有任何回滚损失
    danglingCount: items.filter((i) => i.removable && i.dangling).length,
    taggedCount: items.filter((i) => i.removable && !i.dangling).length,
    // 拿不到容器信息时为 true —— 前端应提示"暂时无法判断可清理项"
    infoIncomplete: containers === null,
  }
}
