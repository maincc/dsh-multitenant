/**
 * 用户域模块 · 等待队列与资源预检（refactor-giant-files §P2 第三刀，源 user.service.js 逐字节搬运）
 *
 * WAIT_QUEUE_MAX/WAIT_QUEUE_STALE_MS 常量与 execFileAsync（macOS 分支专用）随域迁入——
 * 搬前 grep 证明其在主文件零其他消费点（死线已从 user.service.js 移除，非语义改动，
 * 纯搬运的"搬运物"含其独占依赖）。F1 三缺口修复长注与 warn/enforce 语义原文照录。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG, getTierLimits } from '../../config/config.js'
import { dockerService } from '../docker.service.js'
import {
  readMemAvailableKB,
  parseMemorySpecToBytes,
  MEM_HEADROOM_BYTES,
} from '../../utils/host-resources.js'

const execFileAsync = promisify(execFile)

/** 等待队列上限与过期时间（security-hardening-plan P0-3） */
const WAIT_QUEUE_MAX = 500
const WAIT_QUEUE_STALE_MS = 60 * 60 * 1000

export const queueMixin = {
  /**
   * 资源预检（F1 改造，2026-09 磁盘防复发方案）
   * 检查是否有足够资源创建新容器。
   *
   * 改造前这里是"形同虚设"的重灾区（三个缺口各自修掉）：
   * - 缺口 C 磁盘：旧版查 `df -k /`，Linux 上 /var/lib/docker 独立挂载时
   *   查错分区（盘真满了预检全绿）。现查 docker info 的 DockerRootDir
   *   所在分区（docker.service.hostFreeBytes 内实现；macOS 上该路径是
   *   VM 内地址、宿主不可达，自动回落 `/`，语义不变）。阈值走
   *   CONFIG.docker.minFreeBytes（默认 4GiB，旧值写死 2GiB 偏紧）。
   * - 缺口 D 内存：旧版 `sysctl hw.memsize` 是 macOS 专有命令，Linux 上
   *   抛错被 catch 成 true —— 生产（Linux）内存保护恒真（roadmap P1-4）。
   *   现 Linux 读 /proc/meminfo 的 MemAvailable 实测真检，水位 =
   *   即将供应 tier 的 memory 限额 + 512MB 余量；读不到按 fail-closed
   *   记不足（warn 模式下只记日志不拦，见 preflightMode）。
   *   macOS 保留旧行为（开发机形态不变，避免制造新误杀）。
   * - 拦截强度：preflightMode=warn（上线默认）时"不足"只记日志、照常
   *   放行——行为=历史；观察无误后运维改 enforce，才真正入等待队列。
   *   ports/containers 两项是本来就可靠的硬检查，不受 mode 影响。
   *
   * @param {number} [tier] 即将供应的资源档（内存水位按它的限额算），缺省 1
   */
  async preflightCheck(tier = 1) {
    const checks = {
      ports: false,
      memory: false,
      disk: false,
      containers: false,
    }

    // 1. 检查端口（含可按需征用的 destroyed 闲置端口，避免僵尸占用导致误报耗尽）
    const availablePorts = this.state.availablePorts?.length ?? 0
    const pubRange = this.tenantPortRanges().pub
    const nextPort = this.state.nextPort ?? pubRange.base
    checks.ports = availablePorts > 0 || nextPort < pubRange.max || this.hasReclaimablePorts()

    // 2. 主机内存：Linux 实测 MemAvailable 真检；非 Linux（macOS 开发机）保留旧逻辑
    if (process.platform === 'linux') {
      const availKB = await readMemAvailableKB()
      if (availKB === null) {
        // fail-closed：读不到按"不足"计（warn 模式兜底放行，enforce 由运维确认环境后才开）
        checks.memory = false
        console.warn('[preflight] 无法读取 /proc/meminfo 的 MemAvailable：按内存不足处理')
      } else {
        const limit = parseMemorySpecToBytes(getTierLimits(tier).memory) ?? 512 * 1024 * 1024
        checks.memory = availKB * 1024 >= limit + MEM_HEADROOM_BYTES
      }
    } else {
      try {
        const { stdout } = await execFileAsync('sysctl', ['-n', 'hw.memsize'])
        const totalMemory = parseInt(stdout.trim(), 10)
        // 简化检查：如果总内存 > 8GB，认为足够
        checks.memory = totalMemory > 8 * 1024 * 1024 * 1024
      } catch {
        checks.memory = true // 无法检查时假设足够
      }
    }

    // 3. 磁盘：查 Docker 数据分区（缺口 C 修复），阈值可配置（默认 4GiB）
    try {
      const free = await dockerService.hostFreeBytes()
      if (!free) {
        checks.disk = false
        console.warn('[preflight] df 读取失败：按磁盘不足处理（fail-closed）')
      } else {
        const minFreeBytes = CONFIG.docker?.minFreeBytes ?? 4 * 1024 * 1024 * 1024
        checks.disk = free.freeBytes >= minFreeBytes
      }
    } catch {
      checks.disk = false
    }

    // 4. 检查容器数量（最多 50 个）
    try {
      const containers = await dockerService.listSwtcContainers()
      checks.containers = containers.length < 50
    } catch {
      checks.containers = true
    }

    const failed = Object.entries(checks)
      .filter(([_, v]) => !v)
      .map(([k]) => k)

    return {
      ok: failed.length === 0,
      checks,
      failed,
    }
  },

  /**
   * 预检拦截强度：warn（默认）=不足只记日志不拦，enforce=拒绝供应入队。
   * 环境变量 DSH_PREFLIGHT_MODE 可临时覆盖（应急/验证用）。
   */
  preflightMode() {
    const v = String(process.env.DSH_PREFLIGHT_MODE || CONFIG.docker?.preflightMode || 'warn')
      .trim()
      .toLowerCase()
    return v === 'enforce' ? 'enforce' : 'warn'
  },

  /**
   * 添加到等待队列（security-hardening-plan P0-3：上限 + 过期淘汰，防无界内存增长）
   */
  addToWaitQueue(address, tier = 1) {
    this.pruneWaitQueue()
    // 检查是否已在队列中
    const existing = this.waitQueue.find((item) => item.address === address)
    if (existing) {
      return {
        position: this.waitQueue.indexOf(existing) + 1,
        alreadyInQueue: true,
      }
    }

    if (this.waitQueue.length >= WAIT_QUEUE_MAX) {
      return { position: -1, full: true, alreadyInQueue: false }
    }

    const item = {
      address,
      tier,
      timestamp: Date.now(),
      status: 'waiting',
    }
    this.waitQueue.push(item)
    return {
      position: this.waitQueue.length,
      alreadyInQueue: false,
    }
  },

  /**
   * 淘汰过期等待项（超过 1 小时仍未创建则移出队列）
   */
  pruneWaitQueue() {
    const now = Date.now()
    this.waitQueue = this.waitQueue.filter((item) => now - item.timestamp < WAIT_QUEUE_STALE_MS)
  },

  /**
   * 从等待队列移除
   */
  removeFromWaitQueue(address) {
    const index = this.waitQueue.findIndex((item) => item.address === address)
    if (index !== -1) {
      this.waitQueue.splice(index, 1)
      return true
    }
    return false
  },

  /**
   * 获取队列中的位置
   */
  getQueuePosition(address) {
    const index = this.waitQueue.findIndex((item) => item.address === address)
    if (index === -1) return null
    return {
      position: index + 1,
      total: this.waitQueue.length,
      timestamp: this.waitQueue[index].timestamp,
    }
  },

  /**
   * 处理等待队列
   * 尝试为队列中的用户创建容器
   */
  async processWaitQueue() {
    if (this.waitQueue.length === 0) return []

    const processed = []
    const check = await this.preflightCheck(this.waitQueue[0]?.tier ?? 1)

    if (!check.ok && this.preflightMode() === 'enforce') {
      console.log(`[queue] Resources still insufficient: ${check.failed.join(', ')}`)
      return processed
    }
    if (!check.ok) {
      // warn 模式：预检报不足也照常处理队列头（行为=历史放行，只是多一条日志）
      console.log(
        `[queue] Resources insufficient (${check.failed.join(', ')}) — warn mode, still processing`,
      )
    }

    // 处理队列中的第一个用户
    const next = this.waitQueue.shift()
    if (next) {
      try {
        console.log(`[queue] Processing ${next.address} (tier ${next.tier})`)
        await this.ensureContainer(next.address)
        next.status = 'completed'
        processed.push(next)
        console.log(`[queue] Successfully created container for ${next.address}`)
      } catch (err) {
        console.error(`[queue] Failed to create container for ${next.address}:`, err.message)
        next.status = 'failed'
        next.error = err.message
        processed.push(next)
      }
    }

    return processed
  },
}
