/**
 * F1 资源预检改造测试（disk-fix 方案，2026-09）
 *
 * 覆盖：
 *   - 磁盘：查 hostFreeBytes（Docker 数据分区），阈值 CONFIG.docker.minFreeBytes
 *     （缺省 4GiB）；读不到 → fail-closed 记不足
 *   - 内存：Linux 走 MemAvailable 真检 + tier 水位 + fail-closed；
 *     非 Linux（macOS 开发机）保留 sysctl 旧行为
 *   - preflightMode：默认 warn（行为=历史，不拦截）；enforce 才拒绝供应；
 *     环境变量 DSH_PREFLIGHT_MODE 可覆盖
 *   - 202 错误对象带 failedResources（"缺什么"透到路由层）
 *
 * 隔离：mock node:child_process + spy dockerService 探针；不触碰真实 docker。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { execFile } from 'node:child_process'
import { dockerService } from '../src/services/docker.service.js'
import { userService } from '../src/services/user.service.js'

const GIB = 1024 * 1024 * 1024
const ADDR = 'jhfamgqipxtakkdnamduoppim4shcdztea'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

let savedState
let savedQueue

beforeEach(() => {
  execFile.mockReset()
  // sysctl hw.memsize → 16GB（macOS 分支全绿）；其余命令空输出
  execFile.mockImplementation((...a) => {
    const cb = a.at(-1)
    const args = a[1] ?? []
    if (args[1] === 'hw.memsize') return cb(null, String(16 * GIB) + '\n', '')
    cb(null, '', '')
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})

  savedState = userService.state
  userService.state = {
    swtcUsers: {},
    availablePorts: [31999],
    nextPort: 31000,
    usages: {},
    usageLimit: { enabled: false },
  }
  savedQueue = userService.waitQueue
  userService.waitQueue = []

  vi.spyOn(dockerService, 'listSwtcContainers').mockResolvedValue([])
  vi.spyOn(dockerService, 'hostFreeBytes').mockResolvedValue({
    freeBytes: 10 * GIB,
    totalBytes: 100 * GIB,
    checkedPath: '/var/lib/docker',
  })
  delete process.env.DSH_PREFLIGHT_MODE
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  userService.state = savedState
  userService.waitQueue = savedQueue
  delete process.env.DSH_PREFLIGHT_MODE
  vi.restoreAllMocks()
})

describe('preflightCheck：磁盘（缺口 C 修复处）', () => {
  it('10GiB 可用 → 全绿', async () => {
    const r = await userService.preflightCheck(1)
    expect(r.ok).toBe(true)
    expect(r.checks.disk).toBe(true)
  })

  it('3.5GiB < 阈值 4GiB → disk 不足（旧阈值 2GiB 时代这是放行区间）', async () => {
    dockerService.hostFreeBytes.mockResolvedValue({ freeBytes: 3.5 * GIB, checkedPath: '/' })
    const r = await userService.preflightCheck(1)
    expect(r.checks.disk).toBe(false)
    expect(r.failed).toContain('disk')
  })

  it('恰好等于阈值 → 放行（>= 语义）', async () => {
    dockerService.hostFreeBytes.mockResolvedValue({ freeBytes: 4 * GIB, checkedPath: '/data' })
    const r = await userService.preflightCheck(1)
    expect(r.checks.disk).toBe(true)
  })

  it('探针读不到（null）→ fail-closed 记不足 + 告警', async () => {
    dockerService.hostFreeBytes.mockResolvedValue(null)
    const r = await userService.preflightCheck(1)
    expect(r.checks.disk).toBe(false)
    expect(console.warn).toHaveBeenCalled()
  })
})

describe('preflightCheck：内存（缺口 D / roadmap P1-4）', () => {
  it('Linux + MemAvailable 读不到（本机无 /proc）→ fail-closed，不再是旧的恒真', async () => {
    setPlatform('linux')
    const r = await userService.preflightCheck(1)
    expect(r.checks.memory).toBe(false)
    expect(console.warn).toHaveBeenCalled()
  })

  it('macOS 保留旧 sysctl 行为（总内存 16GB → 放行）', async () => {
    setPlatform('darwin')
    const r = await userService.preflightCheck(1)
    expect(r.checks.memory).toBe(true)
  })

  it('tier 参与水位：调用签名接受 tier 且非法档位不炸（getTierLimits 兜底 tier1）', async () => {
    const r = await userService.preflightCheck(99)
    expect(r.ok).toBe(true) // 非 linux 分支，磁盘充足 → 全绿
  })
})

describe('preflightMode（warn/enforce 门）', () => {
  it('默认 warn（本机 config.json 的 docker 块无此键 → 代码兜底）', () => {
    expect(userService.preflightMode()).toBe('warn')
  })

  it('环境变量可临时覆盖为 enforce', () => {
    process.env.DSH_PREFLIGHT_MODE = 'enforce'
    expect(userService.preflightMode()).toBe('enforce')
  })

  it('乱值按 warn 处理（安全侧：不认识的模式不拦人）', () => {
    process.env.DSH_PREFLIGHT_MODE = 'whatever'
    expect(userService.preflightMode()).toBe('warn')
  })
})

describe('warn 不拦截 / enforce 才入队（供应路径）', () => {
  const insufficient = { ok: false, checks: {}, failed: ['disk'] }

  it('warn：预检报不足 → 照常走供应（行为=历史），只记一条 warn 日志', async () => {
    vi.spyOn(userService, 'preflightCheck').mockResolvedValue(insufficient)
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: false })
    // 哨兵：门放行后必然到达 createContainer；在那里抛断，避免走完整创建链
    const create = vi.spyOn(dockerService, 'createContainer').mockImplementation(async () => {
      throw new Error('SENTINEL_PASSED_GATE')
    })
    await expect(userService.ensureContainer(ADDR)).rejects.toThrow('SENTINEL_PASSED_GATE')
    expect(create).toHaveBeenCalled()
    expect(userService.waitQueue).toHaveLength(0) // 没入队
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('warn'))
  })

  it('warn：processWaitQueue 在不足时也继续处理（队列不死锁）', async () => {
    userService.waitQueue.push({ address: ADDR, tier: 1, timestamp: Date.now(), status: 'waiting' })
    vi.spyOn(userService, 'preflightCheck').mockResolvedValue(insufficient)
    const ensure = vi.spyOn(userService, 'ensureContainer').mockResolvedValue(31001)
    const done = await userService.processWaitQueue()
    expect(ensure).toHaveBeenCalledWith(ADDR)
    expect(done).toHaveLength(1)
  })

  it('enforce：不足 → RESOURCE_EXHAUSTED + queuePosition + failedResources 上抛', async () => {
    process.env.DSH_PREFLIGHT_MODE = 'enforce'
    vi.spyOn(userService, 'preflightCheck').mockResolvedValue(insufficient)
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: false })
    await expect(userService.ensureContainer(ADDR)).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
      queuePosition: 1,
      failedResources: ['disk'],
    })
    expect(userService.waitQueue).toHaveLength(1)
  })

  it('enforce：processWaitQueue 不足 → 留在队列里，30s 后重试', async () => {
    process.env.DSH_PREFLIGHT_MODE = 'enforce'
    userService.waitQueue.push({ address: ADDR, tier: 1, timestamp: Date.now(), status: 'waiting' })
    vi.spyOn(userService, 'preflightCheck').mockResolvedValue(insufficient)
    const ensure = vi.spyOn(userService, 'ensureContainer').mockResolvedValue(31001)
    const done = await userService.processWaitQueue()
    expect(ensure).not.toHaveBeenCalled()
    expect(done).toHaveLength(0)
    expect(userService.waitQueue).toHaveLength(1)
  })
})
