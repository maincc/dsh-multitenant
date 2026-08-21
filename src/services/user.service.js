/**
 * 用户服务模块
 * 管理用户状态、容器生命周期
 */

import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG, getTierLimits, isAdmin } from '../config/config.js'
import { dockerService } from './docker.service.js'
import { dataService } from './data.service.js'
import { swtcContainerName, swtcVolumeName, normalizeAddress } from '../utils/address.js'
import { NotFoundError, BadRequestError, ConflictError } from '../utils/errors.js'

const execFileAsync = promisify(execFile)
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PATCHES_DIR = join(ROOT, 'patches')
// 确保 patches 目录存在（旧版入口在启动时创建，模块化版需自行保证）
mkdirSync(PATCHES_DIR, { recursive: true })

export class UserService {
  constructor() {
    this.state = dataService.loadState()
    this.waitQueue = [] // 等待队列
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

    // 1. 检查端口
    const availablePorts = this.state.availablePorts?.length ?? 0
    const nextPort = this.state.nextPort ?? CONFIG.docker.basePort
    checks.ports = availablePorts > 0 || nextPort < CONFIG.docker.maxPort

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
   * 添加到等待队列
   */
  addToWaitQueue(address, tier = 1) {
    // 检查是否已在队列中
    const existing = this.waitQueue.find((item) => item.address === address)
    if (existing) {
      return {
        position: this.waitQueue.indexOf(existing) + 1,
        alreadyInQueue: true,
      }
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

    // 重启容器
    await dockerService.restartContainer(name)

    // 等待容器就绪
    const port = await dockerService.publishedPort(name)
    if (port === null) {
      throw new Error(`Container ${name} has no port mapping after restart`)
    }

    // 更新状态
    if (!this.state.swtcUsers) this.state.swtcUsers = {}
    this.state.swtcUsers[address] = {
      ...(this.state.swtcUsers[address] ?? {}),
      port,
      lastSeenAt: Date.now(),
      containerStatus: 'running',
    }
    dataService.saveState(this.state)

    // 等待容器完全就绪
    const ready = await dockerService.waitReady(port)
    if (!ready) {
      throw new Error(`Container ${name} did not become ready after restart`)
    }

    console.log(`[restart] ${address} container restarted successfully`)
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

    if (this.state.swtcUsers?.[address]) {
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

    console.log(`[reset] ${address} container and volume deleted, port ${port} recycled`)
    return { ok: true, address, portRecycled: port, volumeDeleted: volume }
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

    // 更新状态
    if (this.state.swtcUsers?.[address]) {
      this.state.swtcUsers[address].containerStatus = 'destroyed'
      dataService.saveState(this.state)
    }

    return { ok: true, address, volumeDeleted: volume }
  }

  /**
   * 获取用户信息
   */
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
    const name = swtcContainerName(address)
    const volume = swtcVolumeName(address)

    // 1) 容器已存在：启动（若停止）→ 读取实际端口 → 等待就绪
    const info = await dockerService.containerInfo(name)
    if (info.exists) {
      if (info.status !== 'running') {
        await dockerService.startContainer(name)
        // 等待容器完全启动
        await new Promise((r) => setTimeout(r, 3000))
      }

      // 获取端口映射（可能需要重试）
      let port = await dockerService.publishedPort(name)

      // 如果端口映射丢失，尝试重启容器
      if (port === null) {
        console.warn(`[user] Container ${name} has no port mapping, restarting...`)
        await dockerService.restartContainer(name)
        await new Promise((r) => setTimeout(r, 5000))
        port = await dockerService.publishedPort(name)
      }

      if (port === null) {
        throw new Error(`SWTC container ${name} has no readable port mapping`)
      }
      return await this.finalizeTenant(address, name, port)
    }

    // 2) 资源预检（队列处理时跳过）
    if (!skipQueueCheck) {
      const check = await this.preflightCheck()
      if (!check.ok) {
        // 资源不足，添加到等待队列
        const tier = this.state.swtcUsers?.[address]?.tier ?? 1
        const queueResult = this.addToWaitQueue(address, tier)
        const error = new Error('资源不足，已进入等待队列')
        error.code = 'RESOURCE_EXHAUSTED'
        error.queuePosition = queueResult.position
        error.failedResources = check.failed
        throw error
      }
    }

    // 3) 容器不存在：创建新容器
    // 优先使用回收的端口，其次使用 nextPort
    let port
    if (this.state.availablePorts && this.state.availablePorts.length > 0) {
      port = this.state.availablePorts.shift() // 取出最小的可用端口
      console.log(`[port] using recycled port ${port} for ${address}`)
    } else {
      port = this.state.swtcUsers?.[address]?.port ?? this.state.nextPort ?? CONFIG.docker.basePort
    }
    const tier = this.state.swtcUsers?.[address]?.tier ?? 1
    const limits = getTierLimits(tier)

    for (let attempt = 0; attempt < 64; attempt++) {
      if (attempt > 0) port = port + 1
      if (port > CONFIG.docker.maxPort) {
        throw new Error(`exhausted host port range for SWTC tenant ${address}`)
      }

      const patchFile = join(PATCHES_DIR, `swtc-${address}.yml`)
      writeFileSync(patchFile, this.tenantPatch(port))

      try {
        await dockerService.createContainer(name, port, volume, patchFile, limits)
        this.state.nextPort = Math.max(this.state.nextPort ?? CONFIG.docker.basePort, port + 1)
        return await this.finalizeTenant(address, name, port)
      } catch (err) {
        const msg = String(err.stderr)
        if (msg.includes('already in use')) {
          const info2 = await dockerService.containerInfo(name)
          if (info2.exists) {
            if (info2.status !== 'running') {
              await dockerService.startContainer(name)
            }
            const p2 = await dockerService.publishedPort(name)
            if (p2 !== null) return await this.finalizeTenant(address, name, p2)
          }
          continue
        }
        if (msg.includes('port is already allocated')) continue
        throw err
      }
    }
    throw new Error(`could not allocate a host port for SWTC tenant ${address}`)
  }

  /**
   * 租户收尾：写入 state 并等待容器就绪
   */
  async finalizeTenant(address, name, port) {
    if (!this.state.swtcUsers) this.state.swtcUsers = {}
    const tier = this.state.swtcUsers[address]?.tier ?? 1
    this.state.swtcUsers[address] = {
      ...(this.state.swtcUsers[address] ?? {}),
      port,
      tier,
      createdAt: this.state.swtcUsers[address]?.createdAt ?? Date.now(),
      lastSeenAt: Date.now(),
      containerStatus: 'running',
    }
    dataService.saveState(this.state)
    const ready = await dockerService.waitReady(port)
    if (!ready) {
      throw new Error(
        `SWTC container ${name} did not become ready on port ${port} within ${CONFIG.docker.startupTimeoutMs}ms`,
      )
    }
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

    // 先停止容器
    if (info.status === 'running') {
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
    }
    dataService.saveState(this.state)

    console.log(
      `[upgrade] ${address} upgraded to tier ${tier} (${limits.label}), container restarted`,
    )
    return { tier, limits }
  }

  /**
   * 合并重复地址（基于前缀匹配）
   * 保留运行中的记录，删除其他重复记录
   */
  async mergeDuplicateAddresses() {
    const users = this.state.swtcUsers || {}
    const addresses = Object.keys(users)
    const merged = []

    // 按前 10 个字符分组
    const groups = {}
    for (const addr of addresses) {
      const prefix = addr.slice(0, 10)
      if (!groups[prefix]) groups[prefix] = []
      groups[prefix].push(addr)
    }

    // 合并每组中的重复地址
    for (const [prefix, addrs] of Object.entries(groups)) {
      if (addrs.length <= 1) continue

      console.log(`[merge] Found ${addrs.length} addresses with prefix ${prefix}:`, addrs)

      // 找到运行中的记录（优先保留）
      let keepAddr = addrs.find((a) => users[a].containerStatus === 'running')
      if (!keepAddr) {
        // 如果没有运行中的，保留最后看到的
        keepAddr = addrs.reduce((a, b) =>
          (users[a].lastSeenAt || 0) > (users[b].lastSeenAt || 0) ? a : b,
        )
      }

      // 删除其他记录，回收端口
      for (const addr of addrs) {
        if (addr !== keepAddr) {
          const port = users[addr].port
          if (port) {
            if (!this.state.availablePorts) this.state.availablePorts = []
            if (!this.state.availablePorts.includes(port)) {
              this.state.availablePorts.push(port)
              this.state.availablePorts.sort((a, b) => a - b)
            }
          }
          delete users[addr]
          merged.push({ removed: addr, kept: keepAddr, portRecycled: port })
          console.log(`[merge] Removed ${addr}, kept ${keepAddr}, recycled port ${port}`)
        }
      }
    }

    if (merged.length > 0) {
      this.state.swtcUsers = users
      dataService.saveState(this.state)
    }

    return merged
  }

  /**
   * 停止并销毁容器（保留数据卷）
   * @param {boolean} removeRecord - 是否彻底删除用户记录并释放端口
   */
  async destroyContainer(address, removeRecord = false) {
    const user = this.state.swtcUsers?.[address]
    if (!user) throw new NotFoundError('User not found')

    const name = swtcContainerName(address)
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

    if (removeRecord) {
      // 彻底删除：移除记录，释放端口
      const port = user.port
      delete this.state.swtcUsers[address]

      // 将端口回收到可用端口池
      if (!this.state.availablePorts) this.state.availablePorts = []
      if (!this.state.availablePorts.includes(port)) {
        this.state.availablePorts.push(port)
        this.state.availablePorts.sort((a, b) => a - b)
      }

      dataService.saveState(this.state)
      console.log(`[destroy] ${address} completely removed, port ${port} recycled`)
      return { ok: true, address, status: 'removed', portRecycled: port }
    } else {
      // 仅销毁容器，保留记录
      user.containerStatus = 'destroyed'
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
    const trusted = [`127.0.0.1:${port}`, `localhost:${port}`, ...PUBLIC_TRUST]
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
    for (const name of names) {
      const address = name.replace(/^dsh-swtc-/, '').toLowerCase()
      const port = await dockerService.publishedPort(name)
      if (port === null) continue

      // 从 Docker 容器检查实际配额
      let actualTier = 1
      try {
        const info = await dockerService.inspectContainer(name)
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
        ...(this.state.swtcUsers[address] ?? {}),
        port,
        tier: targetTier,
        createdAt: this.state.swtcUsers[address]?.createdAt ?? Date.now(),
        lastSeenAt: this.state.swtcUsers[address]?.lastSeenAt ?? Date.now(),
        containerStatus: 'running',
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

      this.state.nextPort = Math.max(this.state.nextPort ?? CONFIG.docker.basePort, port + 1)
    }
    dataService.saveState(this.state)
  }

  /**
   * 清理空闲容器
   */
  async cleanupIdleContainers() {
    const now = Date.now()
    let changed = false

    for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
      const idle = now - user.lastSeenAt
      const name = swtcContainerName(address)
      const status = user.containerStatus ?? 'running'

      // 阶段 1：运行中的容器空闲超过阈值 → 停止
      if (status === 'running' && idle > this.state.cleanupPolicy.stopTimeoutMs) {
        try {
          await dockerService.stopContainer(name)
          user.containerStatus = 'stopped'
          user.stoppedAt = now
          // 清理不相关字段
          delete user.lastUpgradeAt
          const idleMin = (idle / 60000).toFixed(0)
          console.log(`[cleanup] stopped idle container: ${address} (idle ${idleMin}min)`)
          changed = true
        } catch (err) {
          if (String(err.stderr).includes('No such container')) {
            user.containerStatus = 'destroyed'
            delete user.stoppedAt
            delete user.lastUpgradeAt
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
    return {
      totalUsers,
      runningUsers,
      tierCounts,
      tiers: CONFIG.tiers,
    }
  }
}

export const userService = new UserService()
