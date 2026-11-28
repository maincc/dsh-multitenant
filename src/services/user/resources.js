/**
 * 用户域模块 · 资源与磁盘观测（refactor-giant-files §P2 第四刀，源 user.service.js 逐字节搬运）
 *
 * monitorResources（超阈自动升级，调留守的 this.upgradeContainer）/
 * collectDiskUsage（结果挂 this.diskUsage 实例字段）/scanVolumeUsage（du 精扫）。
 * F3#4 低盘告警"只标记不处置"与判例十一双契约宽容注释原文照录。
 * 防重入三标志（_monitorRunning/_diskCollectRunning/_volumeScanRunning）继续
 * 挂在实例上——与 cleanup/usage-limit 同风格是刻意的（原注释）。
 */

import { CONFIG } from '../../config/config.js'
import { dockerService } from '../docker.service.js'
import { swtcContainerName } from '../../utils/address.js'

export const resourcesMixin = {
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
      if (changed) await this._saveState()
    } finally {
      this._monitorRunning = false
    }
  },

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
      // F3#4 低盘告警：宿主可用 < docker.maintenance.lowFreeBytes →
      // host.lowFree=true（面板红条）+ 日志列可回收 top-N（人工判断依据）。
      // 只加标记，不拦截、不删除——判断与处置留给人。
      let lowFree = false
      if (host) {
        const threshold = CONFIG.docker?.maintenance?.lowFreeBytes ?? 4 * 1024 * 1024 * 1024
        lowFree = host.availableKB * 1024 < threshold
        // dockerDiskSummary 实物返 {items}；历史上有的调用方按裸数组消费
        // （判例十一：mock 数组绿、真机 {items} 崩——低盘告警形同虚设，
        // 可回收 21GB 报成"无回收项"）。宽容双契约，再不让形状分歧说谎。
        const dockerList = Array.isArray(docker) ? docker : (docker?.items ?? [])
        if (lowFree) {
          const reclaim = dockerList
            .filter((d) => d.reclaimable && !/^0B$/i.test(String(d.reclaimable)))
            .slice(0, 3)
            .map((d) => `${d.name}:${d.reclaimable}`)
            .join(' ')
          console.warn(
            `[disk] 低盘告警：可用 ${(host.availableKB / 1048576).toFixed(1)}GB < ${(threshold / 1073741824).toFixed(0)}GB（分区 ${host.path ?? '?'}）。可回收 ${reclaim || '（docker system df 无回收项——检查非 Docker 占用）'}`,
          )
        }
      }
      this.diskUsage = {
        collectedAt: Date.now(),
        host: host ? { ...host, lowFree } : null,
        docker,
        volumes,
      }
    } catch (err) {
      console.error('[disk] collect failed:', err.message)
      this.diskUsage = { collectedAt: Date.now(), host: null, docker: null, volumes: null }
    } finally {
      this._diskCollectRunning = false
    }
  },

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
  },
}
