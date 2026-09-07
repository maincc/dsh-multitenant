/**
 * 每日使用时限（usageLimit）与用户主动停止容器测试
 *
 * 覆盖：
 *   - settleUsage：把运行段累计进当日 usages，并清零起点
 *   - getUsedMinutes：跨日重置 / 当前运行段计入
 *   - isUsageExempt：CWT 授权/验证用户豁免
 *   - ensureUsageAllowed：超限抛 USAGE_LIMIT_REACHED、豁免放行、开关关闭放行
 *   - checkUsageLimitAndStop：超限优雅停止、豁免不停、未超限不停
 *   - stopContainerForUser：用户主动停止（结算 + 优雅停止 + 状态）
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

describe('每日使用时限', () => {
  beforeEach(() => {
    Object.keys(userService.state.swtcUsers || {}).forEach((addr) => {
      delete userService.state.swtcUsers[addr]
    })
    delete userService.state.usages?.[ADDR]
    delete userService.state.usageLimit
    // 默认测试配置：30 分钟上限
    userService.state.usageLimit = { enabled: true, dailyMinutes: 30, checkIntervalMs: 60000 }
    // 防真实落盘与真实 Docker 操作
    vi.spyOn(dataService, 'saveState').mockImplementation(() => {})
    vi.spyOn(dockerService, 'stopContainer').mockResolvedValue(undefined)
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: true, status: 'running' })
    vi.spyOn(dockerService, 'removeContainer').mockResolvedValue(undefined)
    vi.spyOn(dockerService, 'removeVolume').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (userService.state.swtcUsers?.[ADDR]) delete userService.state.swtcUsers[ADDR]
    delete userService.state.usages?.[ADDR]
    delete userService.state.usageLimit
  })

  it('settleUsage：把运行段累计进当日 usages，并清零 usageStartedAt', () => {
    injectUser({ usageStartedAt: Date.now() - 35 * 60000 })
    const settled = userService.settleUsage(ADDR)
    expect(settled).toBe(35)
    expect(userService.state.usages[ADDR].minutes).toBe(35)
    expect(userService.state.usages[ADDR].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(userService.state.swtcUsers[ADDR].usageStartedAt).toBeUndefined()
  })

  it('settleUsage：多次结算累加', () => {
    injectUser({ usageStartedAt: Date.now() - 10 * 60000 })
    userService.settleUsage(ADDR)
    userService.state.swtcUsers[ADDR].usageStartedAt = Date.now() - 5 * 60000
    userService.settleUsage(ADDR)
    expect(userService.state.usages[ADDR].minutes).toBe(15)
  })

  it('getUsedMinutes：跨日记录归零', () => {
    userService.state.usages[ADDR] = { date: '2000-01-01', minutes: 999 }
    injectUser()
    expect(userService.getUsedMinutes(ADDR)).toBe(0)
  })

  it('getUsedMinutes：当日累计 + 当前运行段', () => {
    userService.state.usages[ADDR] = { date: new Date().toISOString().slice(0, 10), minutes: 12 }
    injectUser({ usageStartedAt: Date.now() - 8 * 60000 })
    expect(userService.getUsedMinutes(ADDR)).toBe(20)
  })

  it('isUsageExempt：cwtAuthorizedAt / cwtVerifiedAt 任一存在即豁免', () => {
    injectUser({ cwtAuthorizedAt: Date.now() })
    expect(userService.isUsageExempt(ADDR)).toBe(true)
    injectUser({ cwtAuthorizedAt: undefined, cwtVerifiedAt: Date.now() })
    expect(userService.isUsageExempt(ADDR)).toBe(true)
    injectUser({})
    expect(userService.isUsageExempt(ADDR)).toBe(false)
  })

  it('ensureUsageAllowed：未超限放行', () => {
    userService.state.usages[ADDR] = { date: new Date().toISOString().slice(0, 10), minutes: 5 }
    injectUser()
    expect(() => userService.ensureUsageAllowed(ADDR)).not.toThrow()
  })

  it('ensureUsageAllowed：超限抛 USAGE_LIMIT_REACHED', () => {
    userService.state.usages[ADDR] = { date: new Date().toISOString().slice(0, 10), minutes: 30 }
    injectUser()
    try {
      userService.ensureUsageAllowed(ADDR)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.code).toBe('USAGE_LIMIT_REACHED')
      expect(err.dailyLimit).toBe(30)
    }
  })

  it('ensureUsageAllowed：豁免用户超限也放行', () => {
    userService.state.usages[ADDR] = { date: new Date().toISOString().slice(0, 10), minutes: 999 }
    injectUser({ cwtAuthorizedAt: Date.now() })
    expect(() => userService.ensureUsageAllowed(ADDR)).not.toThrow()
  })

  it('ensureUsageAllowed：开关关闭放行', () => {
    userService.state.usageLimit = { enabled: false, dailyMinutes: 30 }
    userService.state.usages[ADDR] = { date: new Date().toISOString().slice(0, 10), minutes: 999 }
    injectUser()
    expect(() => userService.ensureUsageAllowed(ADDR)).not.toThrow()
  })

  it('checkUsageLimitAndStop：超限优雅停止并结算', async () => {
    injectUser({ usageStartedAt: Date.now() - 40 * 60000 })
    await userService.checkUsageLimitAndStop()
    expect(dockerService.stopContainer).toHaveBeenCalledWith(NAME, expect.any(Number))
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('stopped')
    expect(userService.state.swtcUsers[ADDR].usageStartedAt).toBeUndefined()
    expect(userService.state.usages[ADDR].minutes).toBeGreaterThanOrEqual(40)
  })

  it('checkUsageLimitAndStop：豁免用户不停', async () => {
    injectUser({ cwtVerifiedAt: Date.now(), usageStartedAt: Date.now() - 40 * 60000 })
    await userService.checkUsageLimitAndStop()
    expect(dockerService.stopContainer).not.toHaveBeenCalled()
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('running')
  })

  it('checkUsageLimitAndStop：未超限不停（含当前运行段）', async () => {
    injectUser({ usageStartedAt: Date.now() - 5 * 60000 })
    await userService.checkUsageLimitAndStop()
    expect(dockerService.stopContainer).not.toHaveBeenCalled()
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('running')
  })

  it('stopContainerForUser：结算运行段 + 优雅停止 + 状态 stopped', async () => {
    injectUser({ usageStartedAt: Date.now() - 12 * 60000 })
    const result = await userService.stopContainerForUser(ADDR)
    expect(result.status).toBe('stopped')
    expect(dockerService.stopContainer).toHaveBeenCalledWith(NAME, expect.any(Number))
    expect(userService.state.usages[ADDR].minutes).toBeGreaterThanOrEqual(12)
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('stopped')
    expect(userService.state.swtcUsers[ADDR].usageStartedAt).toBeUndefined()
  })

  it('stopContainerForUser：容器不存在时抛 NotFoundError', async () => {
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: false })
    await expect(userService.stopContainerForUser(ADDR)).rejects.toThrow(/not found/i)
  })

  it('stopContainerForUser：已在停止状态不重复 stop，但仍结算', async () => {
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: true, status: 'stopped' })
    injectUser({ usageStartedAt: Date.now() - 7 * 60000 })
    await userService.stopContainerForUser(ADDR)
    // containerInfo 返回 stopped → 不应调用 docker stop
    expect(dockerService.stopContainer).not.toHaveBeenCalledWith(NAME, expect.any(Number))
    expect(userService.state.usages[ADDR].minutes).toBeGreaterThanOrEqual(7)
  })
})

describe('并发安全：限时检查 × 空闲清理 / 用户停止同时命中同一容器', () => {
  /**
   * 制造交错：第一次 stopContainer 挂起，第二次立即返回。
   * 两个异步流程都会推进到"await stop"处交错在同一容器上。
   *
   * 注意：release 是闭包内 let 变量，只有在 stopContainer 被调用后才被赋值，
   * 因此通过 () => release 读取最新值，不能解构拷贝（会拿到 undefined）。
   */
  function injectStaggeredStop() {
    let release
    const calls = []
    vi.spyOn(dockerService, 'stopContainer').mockImplementation((name, grace) => {
      calls.push({ name, grace })
      if (calls.length === 1) {
        return new Promise((resolve) => {
          release = resolve
        })
      }
      return Promise.resolve()
    })
    return { release: () => release, calls }
  }

  // 让 cleanup 判定"空闲"（会话文件旧、进程数低于基线）
  function mockCleanupIdleDetection() {
    vi.spyOn(dockerService, 'runVolumeScript').mockResolvedValue(
      JSON.stringify({ latestSessionMtime: 0, sessionCount: 0 }),
    )
    vi.spyOn(dockerService, 'topProcessCount').mockResolvedValue(2)
  }

  const IDLE_USER = {
    port: 31009,
    tier: 1,
    createdAt: Date.now(),
    lastSeenAt: Date.now() - 60 * 60 * 1000, // 空闲 1 小时 > stopTimeoutMs
    containerStatus: 'running',
  }

  beforeEach(() => {
    Object.keys(userService.state.swtcUsers || {}).forEach((addr) => {
      delete userService.state.swtcUsers[addr]
    })
    delete userService.state.usages?.[ADDR]
    delete userService.state.usageLimit
    // 前序测试若异常，防重入锁可能残留，这里显式复位
    userService._usageCheckRunning = false
    userService._cleanupRunning = false
    userService.state.usageLimit = { enabled: true, dailyMinutes: 30, checkIntervalMs: 60000 }
    vi.spyOn(dataService, 'saveState').mockImplementation(() => {})
    vi.spyOn(dockerService, 'removeContainer').mockResolvedValue(undefined)
    vi.spyOn(dockerService, 'removeVolume').mockResolvedValue(undefined)
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: true, status: 'running' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (userService.state.swtcUsers?.[ADDR]) delete userService.state.swtcUsers[ADDR]
    delete userService.state.usages?.[ADDR]
    delete userService.state.usageLimit
  })

  it('限时检查与空闲清理并发停同一超限空闲容器：状态一致、结算不翻倍', async () => {
    const { release, calls } = injectStaggeredStop()
    mockCleanupIdleDetection()
    // 超限（40 分钟前的运行段）且空闲（1 小时没动）：限时和空闲清理都会命中它
    userService.state.swtcUsers[ADDR] = {
      ...IDLE_USER,
      usageStartedAt: Date.now() - 40 * 60000,
    }

    // 先启动两个流程（p1 挂起在第一次 stop），再放行挂起，让两者交错后各自完成
    const p1 = userService.checkUsageLimitAndStop()
    const p2 = userService.cleanupIdleContainers()
    release()()
    await Promise.all([p1, p2])

    const final = userService.state.swtcUsers[ADDR]
    expect(final.containerStatus).toBe('stopped')
    expect(final.usageStartedAt).toBeUndefined()

    // 两者都会尝试 stop：至少一次（stopContainer 幂等，重复无害）
    expect(calls.length).toBeGreaterThanOrEqual(1)

    // 结算幂等：两次 settle 只有第一次有效，minutes 是 40 分钟段（不翻倍）
    const minutes = userService.state.usages[ADDR].minutes
    expect(minutes).toBeGreaterThanOrEqual(39)
    expect(minutes).toBeLessThan(45) // 若重复结算会是 ~78-80
  })

  it('限时检查与用户主动停止并发停同一容器：状态一致、结算不翻倍', async () => {
    const { release, calls } = injectStaggeredStop()
    // 用户超限（40 分钟 > 30 上限）：限时检查和主动停止都会尝试停它
    userService.state.swtcUsers[ADDR] = {
      ...IDLE_USER,
      usageStartedAt: Date.now() - 40 * 60000,
    }

    const p1 = userService.checkUsageLimitAndStop()
    const p2 = userService.stopContainerForUser(ADDR)
    release()()
    await Promise.all([p1, p2])

    const final = userService.state.swtcUsers[ADDR]
    expect(final.containerStatus).toBe('stopped')
    expect(final.usageStartedAt).toBeUndefined()
    expect(calls.length).toBeGreaterThanOrEqual(1)

    const minutes = userService.state.usages[ADDR].minutes
    expect(minutes).toBeGreaterThanOrEqual(39)
    expect(minutes).toBeLessThan(45) // 若重复结算会是 ~78-80
  })

  it('两个机制接力：限时停完（stoppedAt 刚写）→ cleanup 阶段 2 不销毁', async () => {
    vi.spyOn(dockerService, 'stopContainer').mockResolvedValue(undefined)
    mockCleanupIdleDetection()
    userService.state.swtcUsers[ADDR] = {
      ...IDLE_USER,
      usageStartedAt: Date.now() - 40 * 60000,
    }

    // 先由限时停止（写 stoppedAt=now），再跑 cleanup：不应被阶段 2 销毁
    await userService.checkUsageLimitAndStop()
    const stoppedAt = userService.state.swtcUsers[ADDR].stoppedAt
    expect(stoppedAt).toBeGreaterThan(0)
    await userService.cleanupIdleContainers()

    // 容器仍在（未被 destroy），数据卷保留
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('stopped')
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
    expect(dockerService.removeVolume).not.toHaveBeenCalled()
  })
})
