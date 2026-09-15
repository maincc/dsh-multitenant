/**
 * 磁盘监控（磁盘采集 + /api/stats 返回 + 精确扫描）测试
 *
 * 覆盖：
 *   - collectDiskUsage：宿主 / Docker 总体 / 租户卷三段采集并缓存到 this.diskUsage
 *   - 采集失败：单段失败该项为 null，不影响其他段；全部失败也有缓存结构
 *   - 防重入：_diskCollectRunning 期间重复调用跳过
 *   - getStats：resource.disk 返回缓存数据（含 diskCheckIntervalMs）
 *   - scanVolumeUsage：du 实测逐卷写入 sizeActual；无卷/超限/防重入跳过
 *
 * 隔离：mock dockerService 全部采集方法，不触碰真实 docker/df。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { dataService } from '../src/services/data.service.js'

beforeEach(() => {
  userService._diskCollectRunning = false
  userService._volumeScanRunning = false
  userService.diskUsage = null
  vi.spyOn(dataService, 'saveState').mockImplementation(() => {})
  vi.spyOn(dockerService, 'hostDiskUsage').mockResolvedValue({
    totalKB: 244810132,
    usedKB: 10995192,
    availableKB: 54779312,
    usePercent: '17%',
  })
  vi.spyOn(dockerService, 'dockerDiskSummary').mockResolvedValue({
    items: [
      { name: 'Images', total: '28', active: '16', size: '19.92GB', reclaimable: '16GB (80%)' },
      {
        name: 'Local Volumes',
        total: '14',
        active: '1',
        size: '169.3MB',
        reclaimable: '169.2MB (99%)',
      },
    ],
  })
  vi.spyOn(dockerService, 'tenantVolumeUsage').mockResolvedValue([
    { volume: 'dsh-data-swtc-abc123', size: '101.3kB' },
  ])
  vi.spyOn(dockerService, 'duVolumeSize').mockResolvedValue(2 * 1024 * 1024) // 2MB
})

afterEach(() => {
  vi.restoreAllMocks()
  userService.diskUsage = null
})

describe('磁盘监控：collectDiskUsage', () => {
  it('三段采集成功并缓存', async () => {
    await userService.collectDiskUsage()

    expect(userService.diskUsage).not.toBeNull()
    expect(userService.diskUsage.host.usePercent).toBe('17%')
    expect(userService.diskUsage.docker.items.length).toBe(2)
    expect(userService.diskUsage.volumes[0].volume).toBe('dsh-data-swtc-abc123')
    expect(userService.diskUsage.collectedAt).toBeGreaterThan(0)
  })

  it('宿主采集失败 → host 为 null，其余段不受影响', async () => {
    vi.spyOn(dockerService, 'hostDiskUsage').mockResolvedValue(null)

    await userService.collectDiskUsage()

    expect(userService.diskUsage.host).toBeNull()
    expect(userService.diskUsage.docker.items.length).toBe(2)
    expect(userService.diskUsage.volumes.length).toBe(1)
  })

  it('全部失败 → 仍缓存结构（各段 null），不抛错', async () => {
    vi.spyOn(dockerService, 'hostDiskUsage').mockResolvedValue(null)
    vi.spyOn(dockerService, 'dockerDiskSummary').mockResolvedValue(null)
    vi.spyOn(dockerService, 'tenantVolumeUsage').mockResolvedValue(null)

    await expect(userService.collectDiskUsage()).resolves.toBeUndefined()
    expect(userService.diskUsage.host).toBeNull()
    expect(userService.diskUsage.docker).toBeNull()
    expect(userService.diskUsage.volumes).toBeNull()
  })

  it('dockerService 抛异常 → 捕获并缓存失败结构，不抛出', async () => {
    vi.spyOn(dockerService, 'hostDiskUsage').mockRejectedValue(new Error('docker down'))

    await expect(userService.collectDiskUsage()).resolves.toBeUndefined()
    expect(userService.diskUsage.host).toBeNull()
  })

  it('防重入：_diskCollectRunning 期间重复调用直接跳过', async () => {
    userService._diskCollectRunning = true
    await userService.collectDiskUsage()
    expect(dockerService.hostDiskUsage).not.toHaveBeenCalled()
  })
})

describe('磁盘监控：getStats', () => {
  it('无缓存时 resource.disk 为 null', () => {
    const stats = userService.getStats()
    expect(stats.resource.disk).toBeNull()
    expect(stats.resource.diskCheckIntervalMs).toBeGreaterThan(0)
  })

  it('有缓存时返回采集数据', async () => {
    await userService.collectDiskUsage()
    const stats = userService.getStats()
    expect(stats.resource.disk.host.usePercent).toBe('17%')
    expect(stats.resource.disk.volumes.length).toBe(1)
  })
})

describe('磁盘监控：scanVolumeUsage（du 精确扫描）', () => {
  it('逐卷写入 sizeActual 并记录 preciseScannedAt', async () => {
    await userService.collectDiskUsage()
    const scanned = await userService.scanVolumeUsage()

    expect(scanned).toBe(true)
    expect(dockerService.duVolumeSize).toHaveBeenCalledWith('dsh-data-swtc-abc123')
    expect(userService.diskUsage.volumes[0].sizeActual).toBe(2 * 1024 * 1024)
    expect(userService.diskUsage.volumes[0].sizeActualAt).toBeGreaterThan(0)
    expect(userService.diskUsage.preciseScannedAt).toBeGreaterThan(0)
  })

  it('无磁盘缓存（volumes 缺失）→ 返回 false 不执行', async () => {
    const scanned = await userService.scanVolumeUsage()
    expect(scanned).toBe(false)
    expect(dockerService.duVolumeSize).not.toHaveBeenCalled()
  })

  it('卷数超过上限 → 跳过并返回 false', async () => {
    await userService.collectDiskUsage()
    const scanned = await userService.scanVolumeUsage(0) // 上限 0
    expect(scanned).toBe(false)
    expect(dockerService.duVolumeSize).not.toHaveBeenCalled()
  })

  it('防重入：扫描进行中重复调用跳过', async () => {
    await userService.collectDiskUsage()
    userService._volumeScanRunning = true
    const scanned = await userService.scanVolumeUsage()
    expect(scanned).toBe(false)
    expect(dockerService.duVolumeSize).not.toHaveBeenCalled()
  })

  it('单卷 du 失败（null）→ 跳过该卷不中断整轮', async () => {
    await userService.collectDiskUsage()
    vi.spyOn(dockerService, 'duVolumeSize').mockResolvedValue(null)

    const scanned = await userService.scanVolumeUsage()
    expect(scanned).toBe(true)
    expect(userService.diskUsage.volumes[0].sizeActual).toBeUndefined()
    expect(userService.diskUsage.preciseScannedAt).toBeGreaterThan(0)
  })

  it('du 全部抛异常 → 捕获返回 false，不抛出', async () => {
    await userService.collectDiskUsage()
    vi.spyOn(dockerService, 'duVolumeSize').mockRejectedValue(new Error('docker down'))

    await expect(userService.scanVolumeUsage()).resolves.toBe(false)
  })
})
