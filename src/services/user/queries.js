/**
 * 用户域模块 · 查询面（refactor-giant-files §P2 第五刀，源 user.service.js 逐字节切片搬运）
 *
 * 组成：getUserInfo / getAllUsers(缓存) / invalidateUsersCache / _computeAllUsers /
 * getStats。`_usersCache` 类字段留守主文件（mixin 不承载字段初始化器，class field
 * 与 prototype 装配时序无关）——方法经 this 读写同一实例槽，语义不变。
 * 能力探针二法（resolveTenantCapability/getTenantDshVersion）留守主文件：被网关/
 * 供应热路径按调用现场消费且与 gateway 编排深纠缠，属『探针』而非『用户查询』
 * ——§3.1 表格两处归属就此钉正（P2 收尾文档同步更新）。
 * getStats 里 this.diskUsage 由 resourcesMixin 写入——跨域 this 互读为过渡丑线（§3.2）。
 */

import { CONFIG, getTierLimits } from '../../config/config.js'
import { dockerService } from '../docker.service.js'
import { credentialService } from '../credential.service.js'
import { swtcContainerName } from '../../utils/address.js'
import { NotFoundError } from '../../utils/errors.js'

export const queriesMixin = {
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
      isAdmin: credentialService.isAdmSync(address),
      stats: stats
        ? {
            cpu: stats.cpu,
            memory: stats.mem,
            memoryPercent: stats.memPercent,
          }
        : null,
    }
  },

  /**
   * 获取所有用户列表
   */
  /**
   * 管理端列表（带短 TTL 缓存）。
   *
   * 为什么加缓存：管理端每轮刷新都要为每个 running 租户跑一次 docker 采样，
   * 而多个管理员/多个标签页会**各自**触发一遍 → docker CLI 被打爆。
   * 缓存只活几秒（默认 3s），且任何状态写入都会立即失效（见 _saveState），
   * 所以「管理员点完按钮看到旧状态」不会发生。
   *
   * @param {{force?: boolean}} [opts] force=true 跳过缓存
   */
  async getAllUsers({ force = false } = {}) {
    const ttl = Number(CONFIG.admin?.usersCacheTtlMs ?? 3000)
    const cached = this._usersCache
    if (!force && cached?.data && Date.now() - cached.at < ttl) {
      return cached.data
    }
    const data = await this._computeAllUsers()
    this._usersCache = { at: Date.now(), data }
    return data
  },

  /** 让列表缓存立即失效 */
  invalidateUsersCache() {
    this._usersCache = { at: 0, data: null }
  },

  async _computeAllUsers() {
    const users = this.state.swtcUsers || {}

    // 检查 Docker 是否可用
    const dockerAvailable = await dockerService.isDockerAvailable()

    // 只对 running 的租户批量取一次 stats（一次 docker 进程拿全部，替 N 次）
    const runningNames = Object.entries(users)
      .filter(([, u]) => dockerAvailable && u.containerStatus === 'running')
      .map(([address]) => swtcContainerName(address))
    const statsMap = await dockerService.getContainerStatsMany(runningNames)

    return Promise.all(
      Object.entries(users).map(async ([address, user]) => {
        let stats = null
        let actualStatus = user.containerStatus ?? 'unknown'

        // 只有 Docker 可用时才查询实时状态
        if (dockerAvailable && user.containerStatus === 'running') {
          stats = statsMap.get(swtcContainerName(address)) ?? null
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
          // 管理员要看到"这个租户到底在跑哪个 DSH 版本"。
          // 优先问容器本身（真实值）；容器不在/exec 失败时退回创建时记录值。
          // 走 dockerService 的镜像 ID 缓存，同一镜像只 exec 一次。
          dshVersion:
            (await dockerService.containerDshVersion(swtcContainerName(address))) ??
            user.baseImageVersion ??
            null,
          createdAt: user.createdAt,
          lastSeenAt: user.lastSeenAt,
          lastAutoUpgradeAt: user.lastAutoUpgradeAt ?? null,
          idle: Date.now() - user.lastSeenAt,
          isAdmin: credentialService.isAdmSync(address),
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
  },

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
  },
}
