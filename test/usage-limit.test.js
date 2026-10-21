/**
 * 每日使用时限（usageLimit）与用户主动停止容器测试
 *
 * 覆盖：
 *   - settleUsage：把运行段累计进当日 usages，并清零起点
 *   - getUsedMinutes：跨日重置 / 当前运行段计入
 *   - ensureUsageAllowed：超限抛 USAGE_LIMIT_REACHED、开关关闭放行
 *   - checkUsageLimitAndStop：超限优雅停止、未超限不停
 *   - stopContainerForUser：用户主动停止（结算 + 优雅停止 + 状态）
 *
 * 隔离：清空真实 state 用户；mock dockerService 全部破坏性调用与 saveState，
 * 防止测试触碰真实 Docker 容器/写入真实 state.json。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { dataService } from '../src/services/data.service.js'
import { isolateOpsLog } from './ops-log-isolation.js'
isolateOpsLog(dataService) // 留痕 json 轨进临时目录，防写真实 operations.log

const ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const NAME = `dsh-swtc-${ADDR}`

/**
 * 本地历日 YYYY-MM-DD——与 src 的 todayStr() 同口径。
 * 2026-10 审计修复：夹具此前用 `toISOString().slice(0,10)`（UTC 日），而生产按
 * 本地日重置，东八区 00:00–07:59 之间必然对不上、整文件飘红。
 */
function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 把时钟锚定在"今日本地 12:00"。
 * 配套 settle-after-stop / 跨午夜截断的新语义：所有"N 分钟前的运行段"夹具
 * 距离午夜至少 4 小时，任何真实日期/时区下都不受跨日截断影响（既去掉旧
 * UTC-day 飘红，也防新语义在午夜 CI 上引入新的抖动）。
 */
function anchorNoonClock() {
  vi.useFakeTimers()
  const anchor = new Date()
  anchor.setHours(12, 0, 0, 0)
  vi.setSystemTime(anchor)
}

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
    anchorNoonClock()
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
    vi.useRealTimers()
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
    userService.state.usages[ADDR] = { date: localToday(), minutes: 12 }
    injectUser({ usageStartedAt: Date.now() - 8 * 60000 })
    expect(userService.getUsedMinutes(ADDR)).toBe(20)
  })

  it('ensureUsageAllowed：未超限放行', () => {
    userService.state.usages[ADDR] = { date: localToday(), minutes: 5 }
    injectUser()
    expect(() => userService.ensureUsageAllowed(ADDR)).not.toThrow()
  })

  it('ensureUsageAllowed：超限抛 USAGE_LIMIT_REACHED', () => {
    userService.state.usages[ADDR] = { date: localToday(), minutes: 30 }
    injectUser()
    try {
      userService.ensureUsageAllowed(ADDR)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.code).toBe('USAGE_LIMIT_REACHED')
      expect(err.dailyLimit).toBe(30)
    }
  })

  it('ensureUsageAllowed：开关关闭放行', () => {
    userService.state.usageLimit = { enabled: false, dailyMinutes: 30 }
    userService.state.usages[ADDR] = { date: localToday(), minutes: 999 }
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

  it('stopContainerForUser：容器已不存在（漂移/被销毁）→ 结算并成功，不抛 404', async () => {
    // 旧断言"抛 NotFoundError"被线上故障证伪：容器被清理定时器销毁后点
    // "停止"报 404，用户既停不下，运行段也没结算（白扣/白丢额度两头都亏）。
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: false })
    injectUser({ usageStartedAt: Date.now() - 5 * 60000 })
    const result = await userService.stopContainerForUser(ADDR)

    expect(result).toMatchObject({ ok: true, status: 'already_stopped' })
    expect(userService.state.usages[ADDR].minutes).toBeGreaterThanOrEqual(5)
    expect(userService.state.swtcUsers[ADDR].usageStartedAt).toBeUndefined()
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('stopped')
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

  // 必须是**函数**：常量形态在模块加载时求值（真钟），与下面锚定的假钟错位
  function idleUser() {
    return {
      port: 31009,
      tier: 1,
      createdAt: Date.now(),
      lastSeenAt: Date.now() - 60 * 60 * 1000, // 空闲 1 小时 > stopTimeoutMs
      containerStatus: 'running',
    }
  }

  beforeEach(() => {
    anchorNoonClock()
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
    vi.useRealTimers()
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
      ...idleUser(),
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
      ...idleUser(),
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
      ...idleUser(),
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

describe('额度精度（2026-10 全面审计回归位）', () => {
  // 原实现每段 floor 到分钟：<60s 的段记 0——"起 59s 停一次"反复操作当日额度
  // 不掉，限时被结构性绕过；跨午夜的段整段记进"今天"，新一天的额度被昨天吃掉；
  // "先结算后停止"在 stop 失败时留下"容器在跑却无表针"的永久免计费窗口。
  beforeEach(() => {
    anchorNoonClock()
    Object.keys(userService.state.swtcUsers || {}).forEach((addr) => {
      delete userService.state.swtcUsers[addr]
    })
    delete userService.state.usages?.[ADDR]
    userService.state.usageLimit = { enabled: true, dailyMinutes: 30, checkIntervalMs: 60000 }
    vi.spyOn(dataService, 'saveState').mockImplementation(() => {})
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: true, status: 'running' })
    vi.spyOn(dockerService, 'stopContainer').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (userService.state.swtcUsers?.[ADDR]) delete userService.state.swtcUsers[ADDR]
    delete userService.state.usages?.[ADDR]
    delete userService.state.usageLimit
  })

  it('亚分钟尾差按毫秒累计：3 段 × 59 秒 = 177 秒记 2 分钟（旧实现每段落 0）', () => {
    for (let i = 0; i < 3; i++) {
      injectUser({ usageStartedAt: Date.now() - 59 * 1000 })
      userService.settleUsage(ADDR)
    }
    const rec = userService.state.usages[ADDR]
    expect(rec.ms).toBe(3 * 59 * 1000)
    expect(rec.minutes).toBe(2)
    // 限时判定同口径：不再是 0
    expect(userService.getUsedMinutes(ADDR)).toBe(2)
  })

  it('跨午夜截断：昨夜 23:50 开的段、今日 00:10 结算，只计今日的 10 分钟', () => {
    const yesterdayLate = new Date()
    yesterdayLate.setDate(yesterdayLate.getDate() - 1)
    yesterdayLate.setHours(23, 50, 0, 0)
    const justAfterMidnight = new Date()
    justAfterMidnight.setHours(0, 10, 0, 0)
    vi.setSystemTime(justAfterMidnight)

    injectUser({ usageStartedAt: yesterdayLate.getTime() })
    const settled = userService.settleUsage(ADDR)
    expect(settled).toBe(10) // 旧实现会把 20 分钟全记进新一天
    expect(userService.state.usages[ADDR].minutes).toBe(10)
  })

  it('跨午夜的运行段读数同口径：00:10 时 getUsedMinutes 只含今日部分', () => {
    const yesterdayLate = new Date()
    yesterdayLate.setDate(yesterdayLate.getDate() - 1)
    yesterdayLate.setHours(23, 50, 0, 0)
    const justAfterMidnight = new Date()
    justAfterMidnight.setHours(0, 10, 0, 0)
    vi.setSystemTime(justAfterMidnight)

    injectUser({ usageStartedAt: yesterdayLate.getTime() })
    expect(userService.getUsedMinutes(ADDR)).toBe(10)
  })

  it('限时检查 stop 失败 → 表针保留、状态不动（旧顺序会留下永久免计费窗口）', async () => {
    vi.spyOn(dockerService, 'stopContainer').mockRejectedValue(new Error('daemon busy'))
    injectUser({ usageStartedAt: Date.now() - 40 * 60000 })
    await userService.checkUsageLimitAndStop()

    const user = userService.state.swtcUsers[ADDR]
    expect(user.usageStartedAt).toBeTypeOf('number') // 表针没被清
    expect(user.containerStatus).toBe('running')
    expect(userService.getUsedMinutes(ADDR)).toBeGreaterThanOrEqual(40) // 计费没断档
    expect(userService.state.usages[ADDR]).toBeUndefined()
  })

  it('用户停止 stop 失败 → 向上抛且表针保留', async () => {
    vi.spyOn(dockerService, 'stopContainer').mockRejectedValue(new Error('daemon busy'))
    injectUser({ usageStartedAt: Date.now() - 12 * 60000 })
    await expect(userService.stopContainerForUser(ADDR)).rejects.toThrow('daemon busy')
    expect(userService.state.swtcUsers[ADDR].usageStartedAt).toBeTypeOf('number')
    expect(userService.state.usages[ADDR]).toBeUndefined()
  })

  it('旧格式 {date, minutes} 可读、settle 后以 ms 写回（懒迁移）', () => {
    userService.state.usages[ADDR] = { date: localToday(), minutes: 7 }
    injectUser({ usageStartedAt: Date.now() - 60 * 1000 })
    userService.settleUsage(ADDR)
    const rec = userService.state.usages[ADDR]
    expect(rec.ms).toBe(7 * 60000 + 60000)
    expect(rec.minutes).toBe(8)
  })
})
