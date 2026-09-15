/**
 * 用户服务模块
 * 管理用户状态、容器生命周期
 */

import { join, resolve } from 'node:path'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG, getTierLimits, isAdmin } from '../config/config.js'
import { dockerService } from './docker.service.js'
import { dataService } from './data.service.js'
import { cwtStore } from './cwt.store.js'
import { tenantGateway } from './tenant-proxy.service.js'
import { swtcContainerName, swtcVolumeName, normalizeAddress } from '../utils/address.js'
import { NotFoundError, BadRequestError, ConflictError } from '../utils/errors.js'

const execFileAsync = promisify(execFile)
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PATCHES_DIR = join(ROOT, 'patches')
const SCRIPTS_DIR = join(ROOT, 'src', 'services')
/** 等待队列上限与过期时间（security-hardening-plan P0-3） */
const WAIT_QUEUE_MAX = 500
const WAIT_QUEUE_STALE_MS = 60 * 60 * 1000
// 确保 patches 目录存在（旧版入口在启动时创建，模块化版需自行保证）
mkdirSync(PATCHES_DIR, { recursive: true })

/** 本地日期 YYYY-MM-DD（每日限时按此重置） */
function todayStr() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export class UserService {
  constructor() {
    this.state = dataService.loadState()
    this.state.usages = this.state.usages || {} // 每日使用时长记录 { address: { date, minutes } }
    // 注：CWT 数据（cwtRegistry / cwtApplications / cwtRecords）已迁移到 data/cwt/，
    // 由 cwtStore 管理，不再写入 state.json
    this.waitQueue = [] // 等待队列
  }

  /**
   * 分配宿主内部回环端口（40000-49999 随机，避开已占用）。
   * 内部端口只绑 127.0.0.1，对外进路由网关（tenantGateway）代理。
   * @param {Set<number>} [exclude] 本次分配过程要排除的端口（重试时避免拿到同一个）
   */
  allocateInternalPort(exclude = new Set()) {
    const used = new Set(exclude)
    for (const u of Object.values(this.state.swtcUsers || {})) {
      if (u?.internalPort) used.add(u.internalPort)
    }
    for (let i = 0; i < 300; i++) {
      const p = 40000 + Math.floor(Math.random() * 10000)
      if (!used.has(p)) {
        used.add(p)
        return p
      }
    }
    throw new Error('no internal port available')
  }

  /**
   * 资源预检
   * 检查是否有足够资源创建新容器
   */
  async preflightCheck() {
    const checks = {
      ports: false,
      memory: false,
      disk: false,
      containers: false,
    }

    // 1. 检查端口（含可按需征用的 destroyed 闲置端口，避免僵尸占用导致误报耗尽）
    const availablePorts = this.state.availablePorts?.length ?? 0
    const nextPort = this.state.nextPort ?? CONFIG.docker.basePort
    checks.ports =
      availablePorts > 0 || nextPort < CONFIG.docker.maxPort || this.hasReclaimablePorts()

    // 2. 检查主机内存（需要至少 512MB 可用）
    try {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'hw.memsize'])
      const totalMemory = parseInt(stdout.trim(), 10)
      const { stdout: vmStats } = await execFileAsync('sysctl', ['-n', 'vm.vm_stats'])
      // 简化检查：如果总内存 > 8GB，认为足够
      checks.memory = totalMemory > 8 * 1024 * 1024 * 1024
    } catch {
      checks.memory = true // 无法检查时假设足够
    }

    // 3. 检查磁盘空间（需要至少 2GB 可用）
    try {
      const { stdout } = await execFileAsync('df', ['-k', '/'])
      const lines = stdout.trim().split('\n')
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/)
        const availableKB = parseInt(parts[3], 10)
        checks.disk = availableKB > 2 * 1024 * 1024 // 2GB
      } else {
        checks.disk = true
      }
    } catch {
      checks.disk = true
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
  }

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
  }

  /**
   * 淘汰过期等待项（超过 1 小时仍未创建则移出队列）
   */
  pruneWaitQueue() {
    const now = Date.now()
    this.waitQueue = this.waitQueue.filter((item) => now - item.timestamp < WAIT_QUEUE_STALE_MS)
  }

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
  }

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
  }

  /**
   * 处理等待队列
   * 尝试为队列中的用户创建容器
   */
  async processWaitQueue() {
    if (this.waitQueue.length === 0) return []

    const processed = []
    const check = await this.preflightCheck()

    if (!check.ok) {
      console.log(`[queue] Resources still insufficient: ${check.failed.join(', ')}`)
      return processed
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
  }

  /**
   * 重启容器（用于安装插件后重启 DSH 服务）
   */
  async restartContainer(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const info = await dockerService.containerInfo(name)

    if (!info.exists) {
      throw new NotFoundError(`Container ${name} not found`)
    }

    // 绑定挂载源必须是"文件"：若 patch 缺失/被误删，Docker 会把源补建成"目录"，
    // 挂载到镜像内的文件挂载点时报 exit 127（directory onto file，容器起不来）。
    // 这里用重启前的对外端口显式重建 patch 文件（避免再次启动失败）。
    const patchFile = join(PATCHES_DIR, `swtc-${address}.yml`)
    const portForPatch = this.state.swtcUsers?.[address]?.port
    if (portForPatch != null) {
      let patchIsFile = false
      try {
        patchIsFile = statSync(patchFile).isFile()
      } catch {
        patchIsFile = false
      }
      if (!patchIsFile) {
        mkdirSync(PATCHES_DIR, { recursive: true })
        writeFileSync(patchFile, this.tenantPatch(portForPatch))
        console.log(`[restart] ${address} rebuilt missing/typed patch file for :${portForPatch}`)
      }
    }

    // 重启容器
    await dockerService.restartContainer(name)

    // 等待容器就绪（实际宿主映射 = 内部回环端口）
    const internalPort = await dockerService.publishedPort(name)
    if (internalPort === null) {
      throw new Error(`Container ${name} has no port mapping after restart`)
    }

    // 更新状态
    if (!this.state.swtcUsers) this.state.swtcUsers = {}
    const port = this.state.swtcUsers[address]?.port ?? internalPort
    this.state.swtcUsers[address] = {
      ...(this.state.swtcUsers[address] ?? {}),
      port,
      internalPort,
      lastSeenAt: Date.now(),
      containerStatus: 'running',
    }
    dataService.saveState(this.state)

    // 等待容器完全就绪
    const ready = await dockerService.waitReady(internalPort)
    if (!ready) {
      throw new Error(`Container ${name} did not become ready after restart`)
    }

    // 恢复网关监听（进程重启后外部端口需要重新接管）
    tenantGateway.listen(port, internalPort, address)

    console.log(
      `[restart] ${address} container restarted successfully (gateway :${port} -> :${internalPort})`,
    )
    return { ok: true, address, port, status: 'restarted' }
  }

  /**
   * 重置容器（删除数据卷并重建，放弃当前配置重新开始）
   */
  async resetContainer(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const volume = swtcVolumeName(address)
    const info = await dockerService.containerInfo(name)

    // 1. 停止并删除容器
    if (info.exists) {
      try {
        await dockerService.stopContainer(name)
      } catch {
        // ignore
      }
      try {
        await dockerService.removeContainer(name)
      } catch {
        // ignore
      }
    }

    // 2. 删除数据卷
    try {
      await dockerService.removeVolume(volume)
      console.log(`[reset] Volume ${volume} deleted`)
    } catch {
      // 卷可能不存在，忽略
    }

    // 3. 删除用户记录（保留端口分配）
    const user = this.state.swtcUsers?.[address]
    const port = user?.port
    const tier = user?.tier ?? 1

    // 重置 = 全新开始：结算并清除当日时长记录
    this.settleUsage(address)
    delete this.state.usages[address]

    if (this.state.swtcUsers?.[address]) {
      // 关闭旧网关监听（重置后内部端口会重新分配）
      if (this.state.swtcUsers[address].port) {
        tenantGateway.close(this.state.swtcUsers[address].port)
      }
      delete this.state.swtcUsers[address]
    }

    // 4. 回收端口
    if (port) {
      if (!this.state.availablePorts) this.state.availablePorts = []
      if (!this.state.availablePorts.includes(port)) {
        this.state.availablePorts.push(port)
        this.state.availablePorts.sort((a, b) => a - b)
      }
    }

    dataService.saveState(this.state)

    // 5. 立即重建全新容器（重置 = 清空后重新开始，一步到位；返回新端口供前端直接跳转）
    let newPort = null
    try {
      newPort = await this.ensureContainer(address)
      console.log(`[reset] ${address} fresh container rebuilt on port ${newPort}`)
    } catch (err) {
      console.error(`[reset] ${address} rebuild failed after reset:`, err.message)
      throw new Error(`容器已清空但重建失败：${err.message}`)
    }

    console.log(
      `[reset] ${address} container & volume deleted, port ${port} recycled, rebuilt on ${newPort}`,
    )
    return {
      ok: true,
      address,
      portRecycled: port,
      volumeDeleted: volume,
      port: newPort,
      rebuilt: true,
    }
  }

  /**
   * 每日使用时限配置（优先 state，回退 config.json）
   */
  usageLimitConfig() {
    return this.state?.usageLimit ?? CONFIG.usageLimit ?? {}
  }

  /**
   * CWT 授权用户豁免每日限时。
   * 判定：审批注册表（cwtStore，data/cwt/registry.json）status=approved 优先（权威）；
   * 其次兼容 swtcUsers 上的授权/验证时间戳字段。撤销（revoked）后不再豁免，冗余字段同步清除。
   */
  isUsageExempt(address) {
    const registry = cwtStore.getRegistry()[address]
    if (registry?.status === 'approved') return true
    const user = this.state.swtcUsers?.[address]
    return Boolean(user && (user.cwtAuthorizedAt || user.cwtVerifiedAt))
  }

  /**
   * 结算一段运行时长：把 usageStartedAt 累计进当日 usages，然后清零起点。
   * 所有"容器停止"路径都要调用，保证挂机时间也被准确结算。
   * @returns {number} 本次结算的分钟数
   */
  settleUsage(address) {
    const user = this.state.swtcUsers?.[address]
    const startedAt = user?.usageStartedAt
    if (!startedAt) return 0
    const today = todayStr()
    const rec = this.state.usages[address] || {}
    const prev = rec.date === today ? rec.minutes || 0 : 0
    const minutes = Math.floor((Date.now() - startedAt) / 60000)
    this.state.usages[address] = { date: today, minutes: prev + minutes }
    delete user.usageStartedAt
    return minutes
  }

  /**
   * 当日已用分钟（含当前运行段），跨日自动归零
   */
  getUsedMinutes(address) {
    const today = todayStr()
    const rec = this.state.usages[address]
    let minutes = rec && rec.date === today ? rec.minutes || 0 : 0
    const user = this.state.swtcUsers?.[address]
    if (user?.usageStartedAt) {
      minutes += Math.floor((Date.now() - user.usageStartedAt) / 60000)
    }
    return minutes
  }

  /**
   * 是否存在「容器已销毁（destroyed）但记录还占着端口」的闲置端口（可按需征用）
   */
  hasReclaimablePorts() {
    for (const user of Object.values(this.state.swtcUsers || {})) {
      if (user.containerStatus === 'destroyed' && user.port) return true
    }
    return false
  }

  /**
   * 端口耗尽时的按需征用：把 destroyed 租户闲置的端口收进回收池供新用户分配。
   * 被征用者下次连接时会重新分配新端口（端口号对用户透明，内部资产转移）。
   * 前提：destroyed 状态时网关监听已关闭（cleanup/destroy 路径已补 close），端口确实空闲。
   * @param {string} excludeAddress - 本次申请者自身（不征用自己的端口）
   * @returns {number} 征用到的端口数量
   */
  reclaimDestroyedPorts(excludeAddress) {
    if (!this.state.availablePorts) this.state.availablePorts = []
    let reclaimed = 0
    for (const [addr, user] of Object.entries(this.state.swtcUsers || {})) {
      if (!user?.port) continue
      if (addr === excludeAddress) continue
      if (user.containerStatus !== 'destroyed') continue
      if (this.state.availablePorts.includes(user.port)) continue
      this.state.availablePorts.push(user.port)
      reclaimed++
      console.log(
        `[port] reclaiming destroyed tenant ${addr.slice(0, 8)}...: port ${user.port} → pool`,
      )
      // 端口已被征用：该地址下次连接时重新分配新端口（记录里不再保留旧号）
      delete user.port
    }
    if (reclaimed > 0) {
      this.state.availablePorts.sort((a, b) => a - b)
      dataService.saveState(this.state)
    }
    return reclaimed
  }

  /**
   * 启动容器前的每日额度检查；超限抛 USAGE_LIMIT_REACHED（CWT 授权豁免、开关关闭则放行）
   */
  ensureUsageAllowed(address) {
    const cfg = this.usageLimitConfig()
    if (!cfg.enabled) return
    if (this.isUsageExempt(address)) return
    const limit = cfg.dailyMinutes
    if (!Number.isFinite(limit) || limit <= 0) return
    const used = this.getUsedMinutes(address)
    if (used >= limit) {
      const err = new Error(
        `今日使用时长已达上限（${limit} 分钟），请明日再试，或完成 CWT 验证解锁`,
      )
      err.code = 'USAGE_LIMIT_REACHED'
      err.usedMinutes = used
      err.dailyLimit = limit
      throw err
    }
  }

  /**
   * 定时检查：运行中的非豁免容器超限 → 优雅停止（结算后停）
   */
  async checkUsageLimitAndStop() {
    if (this._usageCheckRunning) return
    this._usageCheckRunning = true
    try {
      const cfg = this.usageLimitConfig()
      if (!cfg.enabled) return
      const limit = cfg.dailyMinutes
      if (!Number.isFinite(limit) || limit <= 0) return
      const grace =
        this.state.cleanupPolicy?.stopGraceSeconds ?? CONFIG.cleanup.stopGraceSeconds ?? 60
      let changed = false
      for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
        if (user.containerStatus !== 'running') continue
        if (this.isUsageExempt(address)) continue
        if (this.getUsedMinutes(address) < limit) continue
        // 超限：先结算本次运行段，再优雅停止
        this.settleUsage(address)
        const name = swtcContainerName(address)
        try {
          await dockerService.stopContainer(name, grace)
        } catch (err) {
          console.error(`[usage-limit] failed to stop ${name}:`, err.message)
          continue
        }
        user.containerStatus = 'stopped'
        user.stoppedAt = Date.now()
        changed = true
        console.log(
          `[usage-limit] ${address} reached ${limit}min daily limit, container stopped (grace ${grace}s)`,
        )
      }
      if (changed) dataService.saveState(this.state)
    } finally {
      this._usageCheckRunning = false
    }
  }

  /**
   * 资源监控：内存使用率超阈自动升级配额（升一级）
   *
   * 规则（config.json → resource）：
   *   - 仅检查 containerStatus === 'running' 的容器；
   *   - 读取 docker stats 的 memPercent，超过 autoUpgradeThreshold（默认 80%）→ 自动升一级 tier；
   *   - 已达最高 tier 不再升级；
   *   - 同一容器升级后进入冷却期（autoUpgradeCooldownMs，默认 10min），防止升级重启反复触发；
   *   - stats 读取失败（容器刚停/不存在）→ 跳过该容器，不报错。
   *
   * 防重入：_monitorRunning 标志（与 cleanup/usage-limit 同风格），
   * 本轮未结束的重复触发直接跳过。
   */
  async monitorResources() {
    if (this._monitorRunning) return
    this._monitorRunning = true
    try {
      const cfg = CONFIG.resource || {}
      const threshold = Number(cfg.autoUpgradeThreshold ?? 80)
      const cooldownMs = Number(cfg.autoUpgradeCooldownMs ?? 10 * 60 * 1000)
      if (!Number.isFinite(threshold) || threshold <= 0) return

      // 最高 tier（config.tiers 的最大 key）
      const maxTier = Object.keys(CONFIG.tiers || {})
        .map(Number)
        .filter(Number.isFinite)
        .reduce((m, t) => (t > m ? t : m), 1)

      let changed = false
      const now = Date.now()
      for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
        if (user.containerStatus !== 'running') continue
        const tier = user.tier ?? 1
        if (tier >= maxTier) continue
        // 冷却期内不重复升级
        if (user.lastAutoUpgradeAt && now - user.lastAutoUpgradeAt < cooldownMs) continue

        const name = swtcContainerName(address)
        let stats
        try {
          stats = await dockerService.getContainerStats(name)
        } catch {
          // stats 读取失败（容器刚停等）→ 跳过
          continue
        }
        if (!stats) continue

        // docker stats memPercent 形如 "12.34%"，parseFloat 取数值
        const memPercent = Number.parseFloat(String(stats.memPercent ?? ''))
        if (!Number.isFinite(memPercent) || memPercent < threshold) continue

        // 超阈：自动升一级
        const nextTier = tier + 1
        try {
          await this.upgradeContainer(address, nextTier)
          // 冷却标记（upgradeContainer 内部已 saveState，落盘由它完成）
          this.state.swtcUsers[address].lastAutoUpgradeAt = Date.now()
          changed = true
          console.log(
            `[monitor] ${address} memory ${memPercent.toFixed(1)}% >= ${threshold}%, auto-upgraded to tier ${nextTier}`,
          )
        } catch (err) {
          console.error(`[monitor] auto-upgrade failed for ${address}:`, err.message)
        }
      }
      if (changed) dataService.saveState(this.state)
    } finally {
      this._monitorRunning = false
    }
  }

  /**
   * 采集磁盘使用情况（宿主 + Docker 总体 + 租户数据卷），结果缓存到 this.diskUsage
   * 供 /api/stats 返回给管理面板展示；采集任一失败则该项为 null，不影响其他项。
   * 防重入：_diskCollectRunning 标志。
   */
  async collectDiskUsage() {
    if (this._diskCollectRunning) return
    this._diskCollectRunning = true
    try {
      const [host, docker, volumes] = await Promise.all([
        dockerService.hostDiskUsage(),
        dockerService.dockerDiskSummary(),
        dockerService.tenantVolumeUsage(),
      ])
      this.diskUsage = {
        collectedAt: Date.now(),
        host,
        docker,
        volumes,
      }
    } catch (err) {
      console.error('[disk] collect failed:', err.message)
      this.diskUsage = { collectedAt: Date.now(), host: null, docker: null, volumes: null }
    } finally {
      this._diskCollectRunning = false
    }
  }

  /**
   * 精确扫描：用 du 实测每个租户卷的真实占用（覆盖 docker system df 的
   * overlayfs 口径偏差），结果写入 this.diskUsage.volumes[i].sizeActual（字节数）。
   *
   * 设计取舍：
   *   - 引擎口径（collectDiskUsage）O(1) 可扩展，但 Docker Desktop overlayfs 下数值偏小；
   *   - du 实测准确但 O(n)（每卷起一次临时容器，~1s），卷多时不可进定时器热路径；
   *   - 因此扫描按需/低频执行：管理员手动触发（POST /api/admin/disk-scan）或
   *     每日自动快照（见 server.js startDiskMonitor）。
   *
   * 防重入：_volumeScanRunning 标志；卷数超过 maxVolumes 时跳过（保护宿主资源）。
   * @param {number} [maxVolumes] 单次扫描卷数上限，超出不扫描返回 false
   * @returns {Promise<boolean>} 是否执行了扫描
   */
  async scanVolumeUsage(maxVolumes = 50) {
    if (this._volumeScanRunning) return false
    const volumes = this.diskUsage?.volumes
    if (!Array.isArray(volumes) || volumes.length === 0) return false
    if (volumes.length > maxVolumes) {
      console.warn(
        `[disk] precise scan skipped: ${volumes.length} volumes exceed limit ${maxVolumes}`,
      )
      return false
    }
    this._volumeScanRunning = true
    try {
      console.log(`[disk] precise scan started: ${volumes.length} volumes (du)`)
      // 串行逐卷 du（避免同时起多个临时容器争抢宿主资源）
      for (const v of volumes) {
        const bytes = await dockerService.duVolumeSize(v.volume)
        if (bytes !== null) {
          v.sizeActual = bytes
          v.sizeActualAt = Date.now()
        }
      }
      this.diskUsage.preciseScannedAt = Date.now()
      console.log(`[disk] precise scan finished: ${volumes.length} volumes`)
      return true
    } catch (err) {
      console.error('[disk] precise scan failed:', err.message)
      return false
    } finally {
      this._volumeScanRunning = false
    }
  }

  /**
   * 用户主动停止自己的容器：结算当前运行段（保全每日额度），优雅停止
   */
  async stopContainerForUser(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const info = await dockerService.containerInfo(name)
    if (!info.exists) {
      throw new NotFoundError(`Container ${name} not found`)
    }

    // 结算当前运行段：时间停在停止时刻，剩余额度保全
    this.settleUsage(address)

    if (info.status === 'running') {
      const grace =
        this.state.cleanupPolicy?.stopGraceSeconds ?? CONFIG.cleanup.stopGraceSeconds ?? 60
      await dockerService.stopContainer(name, grace)
    }

    const user = this.state.swtcUsers?.[address]
    if (user) {
      user.containerStatus = 'stopped'
      user.stoppedAt = Date.now()
      dataService.saveState(this.state)
    }
    console.log(`[user-stop] ${address} container stopped by user (data preserved)`)
    return { ok: true, address, status: 'stopped' }
  }

  /**
   * 强制下线容器（停止容器，保留数据卷）
   */
  async forceStopContainer(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const info = await dockerService.containerInfo(name)

    if (!info.exists) {
      throw new NotFoundError(`Container ${name} not found`)
    }

    if (info.status === 'stopped' || info.status === 'exited') {
      // 已经停止了，直接更新状态
      if (this.state.swtcUsers?.[address]) {
        this.state.swtcUsers[address].containerStatus = 'stopped'
        dataService.saveState(this.state)
      }
      return { ok: true, address, status: 'already_stopped' }
    }

    // 停止容器
    await dockerService.stopContainer(name)

    // 结算本次运行段（管理端强停也计入当日时长）
    this.settleUsage(address)

    // 更新状态
    if (this.state.swtcUsers?.[address]) {
      this.state.swtcUsers[address].containerStatus = 'stopped'
      this.state.swtcUsers[address].stoppedAt = Date.now()
      dataService.saveState(this.state)
    }

    console.log(`[force-stop] ${address} container stopped by admin`)
    return { ok: true, address, status: 'stopped' }
  }

  /**
   * 删除用户数据卷（容器必须已停止并删除）
   */
  async deleteUserVolume(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const volume = swtcVolumeName(address)
    const info = await dockerService.containerInfo(name)

    // 如果容器还在运行，先停止
    if (info.exists && info.status === 'running') {
      await dockerService.stopContainer(name)
      console.log(`[delete-volume] ${address} container stopped before volume deletion`)
    }

    // 删除容器（如果存在）
    if (info.exists) {
      try {
        await dockerService.removeContainer(name)
        console.log(`[delete-volume] Container ${name} removed`)
      } catch (err) {
        throw new Error(`Failed to remove container: ${err.message}`)
      }
    }

    // 删除数据卷
    try {
      await dockerService.removeVolume(volume)
      console.log(`[delete-volume] Volume ${volume} deleted for ${address}`)
    } catch (err) {
      throw new Error(`Failed to delete volume: ${err.message}`)
    }

    // 更新状态：关闭网关监听 + 容器销毁
    if (this.state.swtcUsers?.[address]) {
      if (this.state.swtcUsers[address].port) {
        tenantGateway.close(this.state.swtcUsers[address].port)
      }
      this.state.swtcUsers[address].containerStatus = 'destroyed'
      delete this.state.swtcUsers[address].internalPort // 重建时会分配新的内部端口
      dataService.saveState(this.state)
    }

    return { ok: true, address, volumeDeleted: volume }
  }

  /**
   * 获取用户信息
   */
  /**
   * 判断该地址的容器是否已存在（/connect 所有权口径 B 用：
   * 已存在免签名直连，需要创建时才要求钱包签名）
   * @param {string} address
   * @returns {Promise<boolean>}
   */
  async containerExists(address) {
    const info = await dockerService.containerInfo(swtcContainerName(normalizeAddress(address)))
    return info.exists
  }

  async getUserInfo(address) {
    const user = this.state.swtcUsers?.[address]
    if (!user) throw new NotFoundError('User not found')

    const stats =
      user.containerStatus === 'running'
        ? await dockerService.getContainerStats(swtcContainerName(address))
        : null

    return {
      address,
      port: user.port,
      tier: user.tier ?? 1,
      tierLabel: getTierLimits(user.tier ?? 1)?.label ?? '基础',
      tierLimits: getTierLimits(user.tier ?? 1),
      status: user.containerStatus ?? 'running',
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
      idle: Date.now() - user.lastSeenAt,
      isAdmin: isAdmin(address),
      stats: stats
        ? {
            cpu: stats.cpu,
            memory: stats.mem,
            memoryPercent: stats.memPercent,
          }
        : null,
    }
  }

  /**
   * 获取所有用户列表
   */
  async getAllUsers() {
    const users = this.state.swtcUsers || {}

    // 检查 Docker 是否可用
    const dockerAvailable = await dockerService.isDockerAvailable()

    return Promise.all(
      Object.entries(users).map(async ([address, user]) => {
        let stats = null
        let actualStatus = user.containerStatus ?? 'unknown'

        // 只有 Docker 可用时才查询实时状态
        if (dockerAvailable && user.containerStatus === 'running') {
          stats = await dockerService.getContainerStats(swtcContainerName(address))
          // 如果获取 stats 失败，可能容器实际已停止
          if (!stats) {
            actualStatus = 'unknown'
          }
        } else if (!dockerAvailable) {
          // Docker 不可用，显示未知状态
          actualStatus = 'unknown'
        }

        return {
          address,
          port: user.port,
          tier: user.tier ?? 1,
          tierLabel: getTierLimits(user.tier ?? 1)?.label ?? '基础',
          status: actualStatus,
          createdAt: user.createdAt,
          lastSeenAt: user.lastSeenAt,
          lastAutoUpgradeAt: user.lastAutoUpgradeAt ?? null,
          idle: Date.now() - user.lastSeenAt,
          isAdmin: isAdmin(address),
          stats: stats
            ? {
                cpu: stats.cpu,
                memory: stats.mem,
                memoryPercent: stats.memPercent,
              }
            : null,
          dockerAvailable,
        }
      }),
    )
  }

  /**
   * 确保用户容器存在并运行
   * @param {boolean} skipQueueCheck - 跳过队列检查（队列处理时调用）
   */
  async ensureContainer(address, skipQueueCheck = false) {
    address = normalizeAddress(address)

    // 每日使用时限额度检查（CWT 授权用户豁免；超限抛 USAGE_LIMIT_REACHED）
    this.ensureUsageAllowed(address)

    const name = swtcContainerName(address)
    const volume = swtcVolumeName(address)

    // 1) 容器已存在：启动（若停止）→ 读取实际映射端口（内部回环）→ 等待就绪
    const info = await dockerService.containerInfo(name)
    if (info.exists) {
      if (info.status !== 'running') {
        await dockerService.startContainer(name)
        // 等待容器完全启动
        await new Promise((r) => setTimeout(r, 3000))
      }

      // 获取端口映射（可能需要重试）；宿主实际映射的就是内部回环端口
      let internalPort = await dockerService.publishedPort(name)

      // 如果端口映射丢失，尝试重启容器
      if (internalPort === null) {
        console.warn(`[user] Container ${name} has no port mapping, restarting...`)
        await dockerService.restartContainer(name)
        await new Promise((r) => setTimeout(r, 5000))
        internalPort = await dockerService.publishedPort(name)
      }

      if (internalPort === null) {
        throw new Error(`SWTC container ${name} has no readable port mapping`)
      }
      const port = this.state.swtcUsers?.[address]?.port ?? internalPort
      return await this.finalizeTenant(address, name, port, internalPort)
    }

    // 2) 资源预检（队列处理时跳过）
    if (!skipQueueCheck) {
      const check = await this.preflightCheck()
      if (!check.ok) {
        // 资源不足，添加到等待队列
        const tier = this.state.swtcUsers?.[address]?.tier ?? 1
        const queueResult = this.addToWaitQueue(address, tier)
        if (queueResult.full) {
          const error = new Error('等待队列已满，请稍后再试')
          error.code = 'QUEUE_FULL'
          throw error
        }
        const error = new Error('资源不足，已进入等待队列')
        error.code = 'RESOURCE_EXHAUSTED'
        error.queuePosition = queueResult.position
        error.failedResources = check.failed
        throw error
      }
    }

    // 3) 容器不存在：创建新容器
    // 优先使用回收的对外端口，其次使用 nextPort；内部回环端口随机分配
    let port
    if (this.state.availablePorts && this.state.availablePorts.length > 0) {
      port = this.state.availablePorts.shift() // 取出最小的可用端口
      console.log(`[port] using recycled port ${port} for ${address}`)
    } else {
      port = this.state.swtcUsers?.[address]?.port ?? this.state.nextPort ?? CONFIG.docker.basePort
      // 端口即将耗尽：把「容器已销毁（destroyed）、记录还占着端口」的闲置端口
      // 一次性征用进回收池，供新用户使用（被征用者下次连接时重新分配新端口，内部透明）
      if (port > CONFIG.docker.maxPort && this.reclaimDestroyedPorts(address) > 0) {
        port = this.state.availablePorts.shift()
        console.log(`[port] reclaimed destroyed tenants' ports, using ${port} for ${address}`)
      }
    }
    const tier = this.state.swtcUsers?.[address]?.tier ?? 1
    const limits = getTierLimits(tier)
    let internalPort = this.allocateInternalPort()
    const excludedInternal = new Set() // 本次创建已尝试过的内部端口（冲突时换新）

    for (let attempt = 0; attempt < 64; attempt++) {
      if (attempt > 0) port = port + 1
      if (port > CONFIG.docker.maxPort) {
        throw new Error(`exhausted host port range for SWTC tenant ${address}`)
      }

      const patchFile = join(PATCHES_DIR, `swtc-${address}.yml`)
      writeFileSync(patchFile, this.tenantPatch(port)) // patch 里 trustedHosts 用对外端口

      try {
        await dockerService.createContainer(name, internalPort, volume, patchFile, limits)
        this.state.nextPort = Math.max(this.state.nextPort ?? CONFIG.docker.basePort, port + 1)
        return await this.finalizeTenant(address, name, port, internalPort)
      } catch (err) {
        const msg = String(err.stderr)
        // 容器已存在（并发连接）：直接接管
        if (msg.includes('already in use')) {
          const info2 = await dockerService.containerInfo(name)
          if (info2.exists) {
            if (info2.status !== 'running') {
              await dockerService.startContainer(name)
            }
            const p2 = await dockerService.publishedPort(name)
            if (p2 !== null) {
              const p2public = this.state.swtcUsers?.[address]?.port ?? p2
              return await this.finalizeTenant(address, name, p2public, p2)
            }
          }
          continue
        }
        // 内部回环端口冲突（Bind for 127.0.0.1:xxxxx / port is already allocated）：
        // 对外端口现在由网关监听、docker 不再发布，故 docker 层只会因内部端口冲突报错，
        // 换一个新的内部端口重试（对外端口不动）。
        if (msg.includes('port is already allocated') || msg.includes('Bind for 127.0.0.1')) {
          excludedInternal.add(internalPort)
          internalPort = this.allocateInternalPort(excludedInternal)
          continue
        }
        throw err
      }
    }
    throw new Error(`could not allocate a host port for SWTC tenant ${address}`)
  }

  /**
   * 租户收尾：写入 state（含内部回环端口）→ 等待容器就绪 → 开放网关监听
   * @param {string} address
   * @param {string} name 容器名
   * @param {number} port 对外端口（网关监听，用户 URL 用）
   * @param {number} internalPort 内部回环端口（容器实际映射）
   */
  async finalizeTenant(address, name, port, internalPort) {
    if (!this.state.swtcUsers) this.state.swtcUsers = {}
    const tier = this.state.swtcUsers[address]?.tier ?? 1
    const startedAt = this.state.swtcUsers[address]?.usageStartedAt ?? Date.now()
    this.state.swtcUsers[address] = {
      ...(this.state.swtcUsers[address] ?? {}),
      port,
      internalPort,
      tier,
      createdAt: this.state.swtcUsers[address]?.createdAt ?? Date.now(),
      lastSeenAt: Date.now(),
      containerStatus: 'running',
      usageStartedAt: startedAt,
    }
    dataService.saveState(this.state)
    const ready = await dockerService.waitReady(internalPort)
    if (!ready) {
      throw new Error(
        `SWTC container ${name} did not become ready on port ${internalPort} within ${CONFIG.docker.startupTimeoutMs}ms`,
      )
    }
    // 开放网关：外部只能经 0.0.0.0:port 进入，且必须先过会话门禁
    tenantGateway.listen(port, internalPort, address)
    return port
  }

  /**
   * 升级用户配额
   */
  async upgradeContainer(address, tier) {
    const limits = getTierLimits(tier)
    if (!limits) throw new BadRequestError(`Invalid tier: ${tier}`)

    const name = swtcContainerName(address)
    const info = await dockerService.containerInfo(name)
    if (!info.exists) throw new NotFoundError(`Container ${name} not found`)

    // 先结算当前运行段，再停止容器
    if (info.status === 'running') {
      this.settleUsage(address)
      await dockerService.stopContainer(name)
    }

    // 更新容器配置
    await dockerService.updateContainer(name, limits)

    // 重新启动容器
    await dockerService.startContainer(name)

    // 更新状态
    if (!this.state.swtcUsers) this.state.swtcUsers = {}
    this.state.swtcUsers[address] = {
      ...(this.state.swtcUsers[address] ?? {}),
      tier,
      lastUpgradeAt: Date.now(),
      containerStatus: 'running',
      lastSeenAt: Date.now(),
      usageStartedAt: Date.now(), // 升级重启 = 新的运行段
    }
    dataService.saveState(this.state)

    console.log(
      `[upgrade] ${address} upgraded to tier ${tier} (${limits.label}), container restarted`,
    )
    return { tier, limits }
  }

  /**
   * 停止并销毁容器（可选删除数据卷）
   * @param {boolean} removeRecord - 是否彻底删除用户记录并释放端口
   * @param {{keepVolume?: boolean}} options - removeRecord=true 时：keepVolume=true 保留数据卷
   *   （管理员主动留档/审计），默认删除（用户数据与平台记录一并清除，不产生孤儿卷）
   */
  async destroyContainer(address, removeRecord = false, options = {}) {
    const user = this.state.swtcUsers?.[address]
    if (!user) throw new NotFoundError('User not found')

    const name = swtcContainerName(address)
    try {
      // 容器可能还在运行：先结算本次运行段（销毁也计入当日时长）
      this.settleUsage(address)
      await dockerService.stopContainer(name)
    } catch {
      // ignore
    }
    try {
      await dockerService.removeContainer(name)
    } catch {
      // ignore
    }

    if (removeRecord) {
      const keepVolume = Boolean(options?.keepVolume)
      // 彻底删除：关闭网关、移除记录，释放端口
      const port = user.port
      // 网关监听随容器一并关闭（重建时会重新 listen）
      if (port) tenantGateway.close(port)

      // 数据卷：默认一并删除，不留孤儿卷；管理员选择保留则留在磁盘（可后续手动清理）
      let volumeStatus = 'kept'
      if (!keepVolume) {
        try {
          await dockerService.removeVolume(swtcVolumeName(address))
          volumeStatus = 'deleted'
          console.log(`[destroy] volume ${swtcVolumeName(address)} deleted (${address})`)
        } catch {
          // 卷可能不存在，忽略
        }
      }

      delete this.state.swtcUsers[address]

      // 将端口回收到可用端口池
      if (!this.state.availablePorts) this.state.availablePorts = []
      if (!this.state.availablePorts.includes(port)) {
        this.state.availablePorts.push(port)
        this.state.availablePorts.sort((a, b) => a - b)
      }

      dataService.saveState(this.state)
      console.log(
        `[destroy] ${address} completely removed, port ${port} recycled, volume ${volumeStatus}`,
      )
      return {
        ok: true,
        address,
        status: 'removed',
        portRecycled: port,
        volume: volumeStatus,
      }
    } else {
      // 仅销毁容器，保留记录
      // 容器没了 → 网关转发无上游：关闭网关监听，重建时重新开放
      if (user.port) tenantGateway.close(user.port)
      user.containerStatus = 'destroyed'
      delete user.internalPort // 重建时会分配新的内部端口
      dataService.saveState(this.state)
      return { ok: true, address, status: 'destroyed', volume: swtcVolumeName(address) }
    }
  }

  /**
   * 生成租户 cordis patch 内容
   */
  tenantPatch(port) {
    const PUBLIC_TRUST = (process.env.PUBLIC_TRUST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // 对外 authority：用户浏览器经网关访问时的 Host 头（网关透传不改 Host），
    // 显式列入 trustedHosts，保证将来关闭"局域网自动信任"后也能过 DSH 的 fence。
    const PUBLIC_HOST = process.env.PUBLIC_HOST || CONFIG.server.publicHost
    const externalAuthority =
      PUBLIC_HOST && !['127.0.0.1', 'localhost'].includes(PUBLIC_HOST.toLowerCase())
        ? `${PUBLIC_HOST}:${port}`
        : null
    const trusted = [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      ...(externalAuthority ? [externalAuthority] : []),
      ...PUBLIC_TRUST,
    ]
    return (
      `# Generated by dsh-multitenant entry server for tenant ${port}.\n` +
      `- id: webserver\n` +
      `  config:\n` +
      `    host: '0.0.0.0'\n` +
      `    port: 3080\n` +
      `- id: web-runtime\n` +
      `  config:\n` +
      `    printUrl: true\n` +
      `    surfaceContext: true\n` +
      `    trustedHosts: [${trusted.map((t) => JSON.stringify(t)).join(', ')}]\n`
    )
  }

  /**
   * 从 Docker 恢复状态
   */
  async restoreFromDocker() {
    const names = await dockerService.listSwtcContainers()
    const running = new Set(names)
    for (const name of names) {
      const address = name.replace(/^dsh-swtc-/, '').toLowerCase()
      const saved = this.state.swtcUsers?.[address]

      // 只恢复"运行中"的容器：Exited/暂停一律结算残留运行段并标记 stopped
      // （docker ps -a 会列出已停止容器；之前无条件标 running 且恢复网关监听，
      //   导致 state 与 docker 长期不一致、已停止容器的端口仍被网关占用）
      const info = await dockerService.inspectContainer(name)
      if (info?.State?.Status !== 'running') {
        this.settleUsage(address)
        this.state.swtcUsers[address] = {
          ...(saved ?? {}),
          containerStatus: 'stopped',
          stoppedAt: saved?.stoppedAt ?? Date.now(),
        }
        console.log(
          `[restore] ${address.slice(0, 10)}... 容器不在运行（${info?.State?.Status ?? 'inspect 失败'}）→ stopped，不恢复网关`,
        )
        continue
      }

      // 宿主实际映射端口 = 内部回环端口；对外端口从 state 保留（缺省退化为同端口）
      const internalPort = await dockerService.publishedPort(name)
      if (internalPort === null) continue
      const port = saved?.port ?? internalPort

      // 从 Docker 容器检查实际配额（info 已在上面成功获取）
      let actualTier = 1
      try {
        if (info) {
          const memory = info.HostConfig?.Memory || 0
          const nanoCPUs = info.HostConfig?.NanoCPUs || 0
          if (memory >= 2147483648 || nanoCPUs >= 4000000000) {
            actualTier = 3
          } else if (memory >= 1073741824 || nanoCPUs >= 2000000000) {
            actualTier = 2
          } else {
            actualTier = 1
          }
        }
      } catch (err) {
        console.warn(`[restore] failed to inspect ${name}:`, err.message)
      }

      if (!this.state.swtcUsers) this.state.swtcUsers = {}
      const savedTier = this.state.swtcUsers[address]?.tier
      const targetTier = savedTier ?? actualTier

      this.state.swtcUsers[address] = {
        ...(saved ?? {}),
        port,
        internalPort,
        tier: targetTier,
        createdAt: saved?.createdAt ?? Date.now(),
        lastSeenAt: saved?.lastSeenAt ?? Date.now(),
        containerStatus: 'running',
        // 恢复运行中的容器：保留原运行段起点；缺失（新记录）则从恢复时刻开始计时
        usageStartedAt: saved?.usageStartedAt ?? Date.now(),
      }

      // 如果 tier 不匹配，更新 Docker 容器
      if (savedTier && savedTier !== actualTier) {
        console.log(
          `[restore] ${address} tier mismatch: state=${savedTier}, docker=${actualTier}, updating to ${targetTier}`,
        )
        try {
          const limits = getTierLimits(targetTier)
          await dockerService.updateContainer(name, limits)
        } catch (err) {
          console.error(`[restore] failed to update ${name}:`, err.message)
        }
      }

      // 对外端口回收基线只沿用"有对外端口记录"的容器（新恢复的 40000+ 内部端口不推高 nextPort）
      if (saved?.port) {
        this.state.nextPort = Math.max(this.state.nextPort ?? CONFIG.docker.basePort, port + 1)
      }

      // 重新开放网关监听（进程重启后外部端口需要接管）
      tenantGateway.listen(port, internalPort, address)
    }

    // 对齐每日时长：Docker 中已不在运行的记录，结算残留运行段并校正状态
    // （进程重启前崩溃 / 容器被外部停止时，usageStartedAt 可能残留）
    for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
      if (running.has(swtcContainerName(address))) continue
      this.settleUsage(address)
      if (user.containerStatus === 'running') {
        user.containerStatus = 'stopped'
        user.stoppedAt = user.stoppedAt ?? Date.now()
      }
    }
    dataService.saveState(this.state)
  }

  /**
   * 判断租户容器是否真的在活动（三层检测，全部从宿主侧完成）：
   *   1) DSH 内部活动：卷内 sessions/ 会话文件最近有写入
   *      （对话流/工具调用/agent 任务都会 append 事件，文件在动 = 在干活）
   *   2) 外部程序：docker top 进程数超过基线
   *      （shell 命令、代码执行等 fork 出的额外进程）
   *   3) 活跃连接：容器内非回环 ESTABLISHED 连接 > 0
   *      （浏览器开着 DSH 页面 = WebSocket 长连；LLM 出站请求）
   * 全部安静才算空闲。
   * @param {string} address SWTC 地址
   * @param {string} name 容器名
   */
  async isContainerActive(address, name) {
    const policy = this.state.cleanupPolicy || {}
    const windowMs = policy.activityWindowMs ?? CONFIG.cleanup.activityWindowMs ?? 180000
    const baseline = policy.processBaseline ?? CONFIG.cleanup.processBaseline ?? 2
    const diag = {}

    // 1) 会话文件活动
    try {
      const out = await dockerService.runVolumeScript(
        swtcVolumeName(address),
        join(SCRIPTS_DIR, 'check-activity.mjs'),
        'check-activity.mjs',
        ['/dsh-home/sessions'],
      )
      const parsed = JSON.parse(out)
      const ageMs = parsed?.latestSessionMtime ? Date.now() - parsed.latestSessionMtime : null
      diag.session = {
        mtime: parsed?.latestSessionMtime ?? 0,
        ageMs,
        windowMs,
        active: ageMs !== null && ageMs < windowMs,
      }
      if (diag.session.active) return true
    } catch (err) {
      diag.session = { error: err.message }
    }

    // 2) 外部进程
    try {
      const count = await dockerService.topProcessCount(name)
      diag.process = { count, baseline, active: count > baseline }
      if (diag.process.active) return true
    } catch (err) {
      diag.process = { error: err.message }
    }

    // 3) 活跃连接（共享租户容器网络命名空间看连接表）
    try {
      const out = await dockerService.runVolumeScript(
        swtcVolumeName(address),
        join(SCRIPTS_DIR, 'check-connections.mjs'),
        'check-connections.mjs',
        [],
        { networkContainer: name },
      )
      const parsed = JSON.parse(out)
      diag.connection = {
        established: parsed?.established ?? 0,
        active: (parsed?.established ?? 0) > 0,
      }
      if (diag.connection.active) return true
    } catch (err) {
      diag.connection = { error: err.message }
    }

    // 4) DSH 任务状态：session.list 存在 running 会话
    try {
      const out = await dockerService.runVolumeScript(
        swtcVolumeName(address),
        join(SCRIPTS_DIR, 'check-rpc.mjs'),
        'check-rpc.mjs',
        [],
        { networkContainer: name },
      )
      const parsed = JSON.parse(out)
      diag.rpc = {
        ok: parsed?.ok === true,
        runningSessions: parsed?.runningSessions ?? 0,
        active: parsed?.ok === true && parsed.runningSessions > 0,
      }
      if (diag.rpc.active) return true
    } catch (err) {
      diag.rpc = { error: err.message }
    }

    // 全部安静：记录诊断，便于排查"为何判空闲"
    console.log(`[cleanup] ${address} judged idle: ${JSON.stringify(diag)}`)
    return false
  }

  /**
   * 清理空闲容器
   * 运行中的容器空闲超时 → 先做活动检测（会话文件 + 进程数），
   * 确认空闲才优雅停止（SIGTERM 宽限）；停止超时 → 销毁（数据卷保留）。
   * 防重入：docker stop -t 的宽限等待可能超过检查间隔，重复触发会对同一
   * 容器并发 stop，因此正在执行的本轮直接跳过（不做任何事）。
   */
  async cleanupIdleContainers() {
    if (this._cleanupRunning) return
    this._cleanupRunning = true
    try {
      await this._cleanupIdleContainersInner()
    } finally {
      this._cleanupRunning = false
    }
  }

  async _cleanupIdleContainersInner() {
    const now = Date.now()
    let changed = false

    for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
      const idle = now - user.lastSeenAt
      const name = swtcContainerName(address)
      const status = user.containerStatus ?? 'running'

      // 阶段 1：运行中的容器空闲超过阈值 → 先检测真实活动，确认空闲再停止
      if (status === 'running' && idle > this.state.cleanupPolicy.stopTimeoutMs) {
        // 容器内还有真实活动（会话在写 / 有额外进程）→ 刷新 lastSeenAt，跳过本次清理
        let active = false
        try {
          active = await this.isContainerActive(address, name)
        } catch (err) {
          console.error(`[cleanup] activity check failed for ${address}:`, err.message)
        }
        if (active) {
          user.lastSeenAt = now
          changed = true
          console.log(
            `[cleanup] ${address} is still active, skipping (idle ${(idle / 60000).toFixed(0)}min)`,
          )
          continue
        }
        try {
          const grace =
            this.state.cleanupPolicy.stopGraceSeconds ?? CONFIG.cleanup.stopGraceSeconds ?? 60
          this.settleUsage(address) // 结算本次运行段（空闲停止同样累计当日时长）
          await dockerService.stopContainer(name, grace)
          user.containerStatus = 'stopped'
          user.stoppedAt = now
          // 清理不相关字段
          delete user.lastUpgradeAt
          const idleMin = (idle / 60000).toFixed(0)
          console.log(
            `[cleanup] stopped idle container: ${address} (idle ${idleMin}min, grace ${grace}s)`,
          )
          changed = true
        } catch (err) {
          if (String(err.stderr).includes('No such container')) {
            user.containerStatus = 'destroyed'
            delete user.stoppedAt
            delete user.lastUpgradeAt
            if (user.port) tenantGateway.close(user.port)
            changed = true
          } else {
            console.error(`[cleanup] failed to stop ${address}:`, err.message)
          }
        }
      }
      // 阶段 2：停止的容器超过阈值 → 销毁
      else if (status === 'stopped') {
        const stoppedDuration = now - (user.stoppedAt || user.lastSeenAt)
        if (stoppedDuration > this.state.cleanupPolicy.destroyTimeoutMs) {
          try {
            await dockerService.removeContainer(name)
            user.containerStatus = 'destroyed'
            // 清理不相关字段
            delete user.stoppedAt
            delete user.lastUpgradeAt
            // 关闭网关监听：容器已销毁，端口闲置但保留在记录中供重建复用；
            // 不关的话僵尸监听会占用端口并持续转发失败（EADDRINUSE/502）
            if (user.port) tenantGateway.close(user.port)
            const stoppedMin = (stoppedDuration / 60000).toFixed(0)
            console.log(
              `[cleanup] destroyed stopped container: ${address} (stopped ${stoppedMin}min, data preserved)`,
            )
            changed = true
          } catch (err) {
            if (String(err.stderr).includes('No such container')) {
              user.containerStatus = 'destroyed'
              delete user.stoppedAt
              delete user.lastUpgradeAt
              if (user.port) tenantGateway.close(user.port)
              changed = true
            } else {
              console.error(`[cleanup] failed to destroy ${address}:`, err.message)
            }
          }
        }
      }
      // 修复：running 状态不应有 stoppedAt
      else if (status === 'running' && user.stoppedAt) {
        delete user.stoppedAt
        changed = true
      }
    }

    if (changed) {
      dataService.saveState(this.state)
    }
  }

  /**
   * 获取系统统计
   */
  getStats() {
    const users = this.state.swtcUsers || {}
    const totalUsers = Object.keys(users).length
    const runningUsers = Object.values(users).filter((u) => u.containerStatus === 'running').length
    const tierCounts = { 1: 0, 2: 0, 3: 0 }
    Object.values(users).forEach((u) => {
      const tier = u.tier ?? 1
      tierCounts[tier] = (tierCounts[tier] || 0) + 1
    })
    // 资源监控相关（供管理面板展示）
    const resource = CONFIG.resource || {}
    const autoUpgradeCount = Object.values(users).filter((u) => u.lastAutoUpgradeAt).length
    return {
      totalUsers,
      runningUsers,
      tierCounts,
      tiers: CONFIG.tiers,
      resource: {
        enabled: true,
        monitorIntervalMs: resource.monitorIntervalMs ?? 30000,
        autoUpgradeThreshold: resource.autoUpgradeThreshold ?? 80,
        autoUpgradeCooldownMs: resource.autoUpgradeCooldownMs ?? 600000,
        diskCheckIntervalMs: resource.diskCheckIntervalMs ?? 300000,
        autoUpgradeCount,
        disk: this.diskUsage ?? null,
      },
    }
  }
}

export const userService = new UserService()
