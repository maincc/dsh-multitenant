/**
 * 用户服务模块
 * 管理用户状态、容器生命周期
 */

import { join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONFIG, getTierLimits, isAdmin } from '../config/config.js'
import { dockerService } from './docker.service.js'
import { dataService } from './data.service.js'
import { swtcContainerName, swtcVolumeName, normalizeAddress } from '../utils/address.js'
import { NotFoundError, BadRequestError, ConflictError } from '../utils/errors.js'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PATCHES_DIR = join(ROOT, 'patches')

export class UserService {
  constructor() {
    this.state = dataService.loadState()
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
   */
  async ensureContainer(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const volume = swtcVolumeName(address)

    // 1) 容器已存在：启动（若停止）→ 读取实际端口 → 等待就绪
    const info = await dockerService.containerInfo(name)
    if (info.exists) {
      if (info.status !== 'running') {
        await dockerService.startContainer(name)
      }
      const port = await dockerService.publishedPort(name)
      if (port === null) {
        throw new Error(`SWTC container ${name} has no readable port mapping`)
      }
      return await this.finalizeTenant(address, name, port)
    }

    // 2) 容器不存在：创建新容器
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
