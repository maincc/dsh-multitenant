/**
 * 磁盘维护定时器（disk-fix 方案 F3，2026-09）
 *
 * 目标：F1（预检查对盘）/ F2（日志轮转）把"增长"管住了，本模块把"累积"
 * 管住——悬空镜像与构建缓存的周期回收，防 disk 再走到 0.5GB 那种事故。
 *
 * ⚠️ 红线（本文件的立身之本，单测锁定，任何人不得"顺手加个 prune"）：
 *   - 永不 `docker volume prune` / 永不动任何卷——租户卷是唯一真数据，
 *     删了没法恢复（与 admin.routes 的"只按 ID 精确删除"红线同源）。
 *   - 永不 `docker image prune`（-f 也不行）——prune 是**全机作用域**，这台
 *     机器上同时跑着别的项目（faucet 等），它们 untag 掉的旧构建会被连坐。
 *     悬空回收必须走 image-inventory 的"本项目认领"判定后**按 ID 逐个 rmi**
 *     （2026-09 查重修正：F3 初版误用 prune -f，与清理面板的作用域原则冲突）。
 *   - 只删 dangling（无 tag）且非 current 且无容器（含停止态）引用的；
 *     **带 tag 的一律不碰**——那是版本回退弹药，只归管理员手动处置。
 *   - builder 缓存必须带 --keep-storage（全清会让下次构建从 0 编译，
 *     node-pty 一类依赖白烧几十分钟 CPU）。
 *   - 构建窗口互斥：镜像构建进行中绝不跑任何回收（防删掉 build 中间态）。
 *
 * 配置（CONFIG.docker.maintenance，全部有点值兜底——浅合并防御）：
 *   enabled      false 时本服务整体不执行（只留 F1 的告警面）
 *   keepCache    builder prune 的 --keep-storage 值，默认 '4GB'
 *   lowFreeBytes 低盘告警阈值（采集在 user.service.collectDiskUsage 侧）
 *   fstrim       仅 Docker Desktop 生效的 TRIM 回吐开关（默认 true）
 * 可用 env DSH_MAINTENANCE_ENABLED=0/1 应急覆盖 enabled（服务器排障免改文件）。
 */

import { execFile } from 'node:child_process'
import { CONFIG } from '../config/config.js'
import { isImageBuilding } from './docker.service.js'
import { collectPrunableImages } from './image-inventory.service.js'
import { dataService } from './data.service.js'

/** 周期：悬空镜像每天一次；构建缓存每周一次；fstrim 跟每日回收同轮 */
const IMAGE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
const BUILDER_PRUNE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export function maintenanceConfig() {
  const m = CONFIG.docker?.maintenance ?? {}
  const envEnabled =
    process.env.DSH_MAINTENANCE_ENABLED === '0'
      ? false
      : process.env.DSH_MAINTENANCE_ENABLED === '1'
        ? true
        : undefined
  return {
    enabled: envEnabled ?? m.enabled !== false,
    keepCache: m.keepCache || '4GB',
    lowFreeBytes: m.lowFreeBytes ?? 4 * 1024 * 1024 * 1024,
    fstrim: m.fstrim !== false,
  }
}

/** 运行状态（模块内存即可：重启后最多提前做一轮幂等的 prune，无害） */
const state = {
  lastImagePruneAt: 0,
  lastBuilderPruneAt: 0,
  lastResult: null,
}

/**
 * docker CLI（callback 风格，与 docker.service.sh 同款——不用 promisify：
 * 测试 mock child_process 后 promisify 会丢掉 execFile 的 custom 约定，
 * stdout/stderr 被拆成数组，真实与测试语义会分叉）。
 */
function docker(args, timeout = 60000) {
  return new Promise((resolvePromise, reject) => {
    execFile('docker', args, { maxBuffer: 8 * 1024 * 1024, timeout }, (err, stdout) => {
      if (err) return reject(err)
      resolvePromise(String(stdout ?? '').trim())
    })
  })
}

/**
 * 是否 Docker Desktop 宿主（🍎）。
 * 只有 Desktop 的 VM 磁盘是稀疏 Docker.raw，prune 后需要 fstrim 才把空间
 * 还给 macOS 宿主；Linux 生产删即释放，这一步不存在也不该存在。
 */
async function detectDockerDesktop() {
  try {
    const os = await docker(['info', '--format', '{{.OperatingSystem}}'], 10000)
    return /docker\s*desktop/i.test(os)
  } catch {
    return false
  }
}

/** 跑一次 fstrim（今日验证过的姿势固化：privileged + nsenter 进 VM mount ns） */
async function runFstrim() {
  const image = CONFIG.docker?.image || 'dsh-multitenant:latest'
  const out = await docker(
    [
      'run',
      '--rm',
      '--privileged',
      '--pid=host',
      '--entrypoint',
      'nsenter',
      image,
      '-t',
      '1',
      '-m',
      'fstrim',
      '-av',
    ],
    120000,
  )
  return out
}

/**
 * 悬空镜像回收：作用域 = **本项目**的、非 current、无容器（含停止态）引用的悬空镜像。
 * 判定与管理面板共用同一真源（collectPrunableImages），随后按 ID 逐个 `docker rmi`。
 * 绝不用 `docker image prune`——那是全机作用域，会把别的项目（faucet 等）
 * untag 掉的旧构建连坐删掉（本文件红线，与面板"只按 ID 精确删除"同源）。
 * 拿不到容器信息（infoIncomplete）时本轮跳过：判定依据不足宁可不删，明天再来。
 */
async function reclaimOurDangling() {
  const inv = await collectPrunableImages(dataService.getDshImage())
  if (inv.infoIncomplete) {
    return { ok: true, skipped: 'container-info-unavailable', deleted: 0, reclaimed: '0B' }
  }
  const targets = inv.items.filter((im) => im.dangling && im.removable)
  let deleted = 0
  let freedBytes = 0
  const failed = []
  for (const im of targets) {
    try {
      await docker(['rmi', im.id], 120000)
      deleted += 1
      freedBytes += im.sizeBytes || 0
    } catch (err) {
      // 单个失败（如刚被容器引用、或有依赖子镜像）不拖垮整轮；明晚自愈重试
      failed.push({ id: im.id, error: String(err?.message || err).slice(0, 160) })
    }
  }
  if (failed.length) {
    console.warn(`[maintenance] 悬空回收 ${failed.length} 个失败: ${JSON.stringify(failed)}`)
  }
  return {
    ok: true,
    deleted,
    reclaimed: formatBytes(freedBytes),
    candidates: targets.length,
    failedCount: failed.length,
  }
}

/** 字节 → 可读（仅日志/摘要用，无精度要求） */
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`
}

/**
 * 维护主入口。定时器与手动触发共用；force 跳过"周期未到"判断。
 * 每个动作独立 try——一项失败不影响其余（维护路径永不抛到调用方）。
 *
 * @param {{force?: boolean}} opts
 * @returns {Promise<object>} 本轮结果摘要（含 skip 原因）
 */
export async function runMaintenance({ force = false } = {}) {
  const cfg = maintenanceConfig()
  const result = { at: Date.now(), enabled: cfg.enabled, actions: {}, skipped: null }
  if (!cfg.enabled) {
    result.skipped = 'maintenance.disabled'
    return result
  }
  if (isImageBuilding()) {
    // 构建互斥：build 中途的临时层/缓存正被引用，prune 可能拆梯子
    result.skipped = 'image-build-in-progress'
    console.log('[maintenance] skipped: 镜像构建进行中，本轮不 prune')
    return result
  }

  const now = Date.now()
  if (force || now - state.lastImagePruneAt >= IMAGE_PRUNE_INTERVAL_MS) {
    result.actions.imagePrune = await guarded('悬空镜像回收（按 ID·仅本项目）', async () => {
      const r = await reclaimOurDangling()
      state.lastImagePruneAt = Date.now()
      return r
    })
  } else {
    result.actions.imagePrune = { skipped: 'interval' }
  }

  if (force || now - state.lastBuilderPruneAt >= BUILDER_PRUNE_INTERVAL_MS) {
    result.actions.builderPrune = await guarded('builder prune', async () => {
      const out = await docker(['builder', 'prune', '-f', '--keep-storage', cfg.keepCache], 300000)
      state.lastBuilderPruneAt = Date.now()
      return summarizeReclaim(out)
    })
  } else {
    result.actions.builderPrune = { skipped: 'interval' }
  }

  if (cfg.fstrim && (force || (result.actions.imagePrune?.deleted ?? 0) > 0)) {
    // 只有真删掉了东西（或手动 force）才值得走一次 TRIM；且仅 🍎
    if (await detectDockerDesktop()) {
      result.actions.fstrim = await guarded('fstrim（Docker Desktop 回吐）', runFstrim)
    } else {
      result.actions.fstrim = { skipped: 'non-desktop-host' }
    }
  }

  state.lastResult = result
  console.log(`[maintenance] ${JSON.stringify(result)}`)
  return result
}

/** 单动作护栏：吞错误、记 message，永不外抛 */
async function guarded(label, fn) {
  try {
    const value = await fn()
    return typeof value === 'object' && value !== null ? value : { ok: true, output: value }
  } catch (err) {
    const message = String(err?.message || err)
    console.error(`[maintenance] ${label} failed: ${message}`)
    return { ok: false, error: message.slice(0, 300) }
  }
}

/** prune 输出里抠"回收量"（Total reclaimed space: 1.23GB），有就带上 */
function summarizeReclaim(out) {
  const m = /Total reclaimed space:\s*([0-9.]+\s*[KMGT]?i?B)/i.exec(out || '')
  return { ok: true, reclaimed: m ? m[1] : null }
}

/** 供面板/诊断查看最近一轮结果（可后续接进 /api/stats） */
export function getMaintenanceState() {
  return { ...state, config: maintenanceConfig() }
}

/** 仅供测试：清周期记忆 */
export function resetMaintenanceForTest() {
  state.lastImagePruneAt = 0
  state.lastBuilderPruneAt = 0
  state.lastResult = null
}

/**
 * 定时器接线（server.js 调用）：启动后延迟 2 分钟跑第一轮
 * （避开供应/恢复风暴），之后每 24h 一轮；builder 的 7 天周期在内部门控。
 */
export function startMaintenanceTimer() {
  const cfg = maintenanceConfig()
  if (!cfg.enabled) {
    console.log('[maintenance] disabled by config — timer not started')
    return
  }
  const kickoff = setTimeout(() => {
    runMaintenance().catch(() => {})
  }, 120000)
  kickoff.unref()
  const timer = setInterval(() => {
    runMaintenance().catch(() => {})
  }, IMAGE_PRUNE_INTERVAL_MS)
  timer.unref()
  console.log(
    `[maintenance] started: image prune daily, builder prune weekly (--keep-storage ${cfg.keepCache}), fstrim ${cfg.fstrim ? 'on (Docker Desktop only)' : 'off'}`,
  )
}
