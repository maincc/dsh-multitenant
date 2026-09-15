/**
 * 资源监控（resourceMonitor）自动升级测试
 *
 * 覆盖：
 *   - 内存超阈（memPercent >= threshold）→ 自动升一级 tier
 *   - 未超阈 → 不升级
 *   - 已达最高 tier → 不升级
 *   - stats 读取失败/返回 null → 跳过不报错
 *   - 冷却期内（lastAutoUpgradeAt 距今 < cooldownMs）→ 不重复升级
 *   - 防重入：_monitorRunning 期间重复调用直接跳过
 *
 * 隔离：清空真实 state 用户；mock dockerService 全部破坏性调用与 saveState，
 * 防止测试触碰真实 Docker 容器/写入真实 state.json。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { dataService } from '../src/services/data.service.js'

const ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const NAME = `dsh-swtc-${ADDR}`

function injectUser(overrides = {}) {
  userService.state.swtcUsers[ADDR] = {
    port: 31009,
    tier: 1,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    containerStatus: 'running',
    ...overrides,
  }
  return userService.state.swtcUsers[ADDR]
}

/** 模拟 docker stats 返回（memPercent 形如 "12.34%"） */
function mockStats(memPercent) {
  vi.spyOn(dockerService, 'getContainerStats').mockResolvedValue({
    cpu: '0.50%',
    mem: '100MiB / 512MiB',
    memPercent: `${memPercent}%`,
    net: '1kB / 2kB',
    block: '0B / 0B',
  })
}

beforeEach(() => {
  Object.keys(userService.state.swtcUsers || {}).forEach((addr) => {
    delete userService.state.swtcUsers[addr]
  })
  userService._monitorRunning = false
  vi.spyOn(dataService, 'saveState').mockImplementation(() => {})
  vi.spyOn(dockerService, 'getContainerStats').mockResolvedValue(null)
  vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: true, status: 'running' })
  vi.spyOn(dockerService, 'updateContainer').mockResolvedValue(undefined)
  vi.spyOn(dockerService, 'stopContainer').mockResolvedValue(undefined)
  vi.spyOn(dockerService, 'startContainer').mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  Object.keys(userService.state.swtcUsers || {}).forEach((addr) => {
    delete userService.state.swtcUsers[addr]
  })
})

describe('资源监控：自动升级', () => {
  it('内存超阈（>=80%）→ 自动升一级 tier 并记录冷却标记', async () => {
    injectUser({ tier: 1 })
    mockStats(87.5)

    await userService.monitorResources()

    expect(dockerService.getContainerStats).toHaveBeenCalledWith(NAME)
    expect(userService.state.swtcUsers[ADDR].tier).toBe(2)
    expect(userService.state.swtcUsers[ADDR].lastAutoUpgradeAt).toBeGreaterThan(0)
    expect(dataService.saveState).toHaveBeenCalled()
  })

  it('内存未超阈 → 不升级', async () => {
    injectUser({ tier: 1 })
    mockStats(42.3)

    await userService.monitorResources()

    expect(userService.state.swtcUsers[ADDR].tier).toBe(1)
    expect(userService.state.swtcUsers[ADDR].lastAutoUpgradeAt).toBeUndefined()
    expect(dataService.saveState).not.toHaveBeenCalled()
  })

  it('已达最高 tier（3）→ 不升级', async () => {
    injectUser({ tier: 3 })
    mockStats(95)

    await userService.monitorResources()

    expect(userService.state.swtcUsers[ADDR].tier).toBe(3)
    expect(dataService.saveState).not.toHaveBeenCalled()
  })

  it('stats 返回 null（容器刚停/不存在）→ 跳过不报错', async () => {
    injectUser({ tier: 1 })
    vi.spyOn(dockerService, 'getContainerStats').mockResolvedValue(null)

    await expect(userService.monitorResources()).resolves.toBeUndefined()
    expect(userService.state.swtcUsers[ADDR].tier).toBe(1)
  })

  it('getContainerStats 抛异常 → 跳过该容器不中断整轮', async () => {
    injectUser({ tier: 1 })
    vi.spyOn(dockerService, 'getContainerStats').mockRejectedValue(new Error('docker down'))

    await expect(userService.monitorResources()).resolves.toBeUndefined()
    expect(userService.state.swtcUsers[ADDR].tier).toBe(1)
  })

  it('非 running 容器（stopped）→ 不检查不升级', async () => {
    injectUser({ tier: 1, containerStatus: 'stopped' })
    mockStats(99)

    await userService.monitorResources()

    expect(dockerService.getContainerStats).not.toHaveBeenCalled()
    expect(userService.state.swtcUsers[ADDR].tier).toBe(1)
  })

  it('冷却期内不重复升级，冷却期过后再次触发', async () => {
    const now = Date.now()
    injectUser({ tier: 1, lastAutoUpgradeAt: now - 60 * 1000 }) // 1 分钟前升过（冷却 10min）
    mockStats(90)

    await userService.monitorResources()
    // 冷却内：不再升级
    expect(userService.state.swtcUsers[ADDR].tier).toBe(1)

    // 冷却期过后：上次升级超过冷却窗口 → 可以再次触发
    userService.state.swtcUsers[ADDR].lastAutoUpgradeAt = now - 11 * 60 * 1000
    await userService.monitorResources()
    expect(userService.state.swtcUsers[ADDR].tier).toBe(2)
  })

  it('防重入：_monitorRunning 为 true 时直接跳过', async () => {
    injectUser({ tier: 1 })
    userService._monitorRunning = true
    mockStats(95)

    await userService.monitorResources()

    expect(dockerService.getContainerStats).not.toHaveBeenCalled()
    expect(userService.state.swtcUsers[ADDR].tier).toBe(1)
  })

  it('upgradeContainer 失败 → 捕获并继续，不中断整轮', async () => {
    injectUser({ tier: 1 })
    mockStats(90)
    vi.spyOn(userService, 'upgradeContainer').mockRejectedValue(new Error('docker update failed'))

    await expect(userService.monitorResources()).resolves.toBeUndefined()
    expect(userService.state.swtcUsers[ADDR].tier).toBe(1)
  })
})
