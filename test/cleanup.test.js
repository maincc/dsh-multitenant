/**
 * 空闲清理的活动检测测试
 *
 * 验证 cleanupIdleContainers 的四层活动检测：
 *   - 会话文件最近有写入（DSH 内部活动）→ 视为活跃，不停止
 *   - docker top 进程数超基线（外部程序）→ 视为活跃，不停止
 *   - 活跃连接 / DSH running 会话 → 视为活跃，不停止
 *   - 全部安静且超时 → 才停止（优雅宽限）
 *
 * 隔离：userService 单例在构造时从 state.json 加载了真实用户，destroy 阶段
 * 会对 status='stopped' 且超时的用户执行 docker rm——必须清掉历史用户并 mock
 * 销毁相关调用，防止测试操作真实 Docker 容器/卷。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { dataService } from '../src/services/data.service.js'

const ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const NAME = `dsh-swtc-${ADDR}`

describe('空闲清理活动检测', () => {
  beforeEach(() => {
    // 隔离：清掉从 state.json 加载的历史用户，避免 destroy 阶段操作真实容器
    Object.keys(userService.state.swtcUsers || {}).forEach((addr) => {
      delete userService.state.swtcUsers[addr]
    })
    // 双保险：即使出现 stopped 用户，销毁调用也打不到真实 Docker
    vi.spyOn(dockerService, 'removeContainer').mockResolvedValue(undefined)
    vi.spyOn(dockerService, 'removeVolume').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // 清理测试注入的用户（saveState 已被 mock，不会落盘）
    if (userService.state.swtcUsers?.[ADDR]) delete userService.state.swtcUsers[ADDR]
  })

  it('会话文件最近有写入 → 活跃（不清理由）', async () => {
    vi.spyOn(dockerService, 'runVolumeScript').mockResolvedValue(
      JSON.stringify({ latestSessionMtime: Date.now() - 1000, sessionCount: 1 }),
    )
    vi.spyOn(dockerService, 'topProcessCount').mockResolvedValue(2)
    expect(await userService.isContainerActive(ADDR, NAME)).toBe(true)
  })

  it('会话安静且进程数低于基线 → 空闲（可清理）', async () => {
    vi.spyOn(dockerService, 'runVolumeScript').mockResolvedValue(
      JSON.stringify({ latestSessionMtime: Date.now() - 3600000, sessionCount: 1 }),
    )
    vi.spyOn(dockerService, 'topProcessCount').mockResolvedValue(2)
    expect(await userService.isContainerActive(ADDR, NAME)).toBe(false)
  })

  it('进程数超过基线 → 活跃（即使会话安静）', async () => {
    vi.spyOn(dockerService, 'runVolumeScript').mockResolvedValue(
      JSON.stringify({ latestSessionMtime: 0, sessionCount: 0 }),
    )
    vi.spyOn(dockerService, 'topProcessCount').mockResolvedValue(12)
    expect(await userService.isContainerActive(ADDR, NAME)).toBe(true)
  })

  it('活跃连接（页面开着）→ 活跃，即使会话文件旧且进程少', async () => {
    // 第一层（session）安静、第二层（进程）低，但第三层（连接）有 ESTABLISHED
    vi.spyOn(dockerService, 'runVolumeScript').mockImplementation(
      (volume, scriptPath, scriptName) => {
        if (scriptName === 'check-connections.mjs') {
          return Promise.resolve(JSON.stringify({ established: 3 }))
        }
        if (scriptName === 'check-rpc.mjs') {
          return Promise.resolve(JSON.stringify({ ok: true, runningSessions: 0, totalSessions: 1 }))
        }
        return Promise.resolve(JSON.stringify({ latestSessionMtime: 0, sessionCount: 0 }))
      },
    )
    vi.spyOn(dockerService, 'topProcessCount').mockResolvedValue(2)
    expect(await userService.isContainerActive(ADDR, NAME)).toBe(true)
  })

  it('DSH 有 running 会话（静默等待任务）→ 活跃，即使无连接/无会话写入', async () => {
    // 前两层安静、第三层无连接，但 RPC 报告有 running 会话
    vi.spyOn(dockerService, 'runVolumeScript').mockImplementation(
      (volume, scriptPath, scriptName) => {
        if (scriptName === 'check-rpc.mjs') {
          return Promise.resolve(JSON.stringify({ ok: true, runningSessions: 2, totalSessions: 2 }))
        }
        if (scriptName === 'check-connections.mjs') {
          return Promise.resolve(JSON.stringify({ established: 0 }))
        }
        return Promise.resolve(JSON.stringify({ latestSessionMtime: 0, sessionCount: 0 }))
      },
    )
    vi.spyOn(dockerService, 'topProcessCount').mockResolvedValue(2)
    expect(await userService.isContainerActive(ADDR, NAME)).toBe(true)
  })

  it('cleanup：活跃容器被跳过并刷新 lastSeenAt（不调用 stop）', async () => {
    vi.spyOn(dockerService, 'runVolumeScript').mockResolvedValue(
      JSON.stringify({ latestSessionMtime: Date.now(), sessionCount: 1 }),
    )
    const stopSpy = vi.spyOn(dockerService, 'stopContainer').mockResolvedValue()
    const saveSpy = vi.spyOn(dataService, 'saveState').mockImplementation(() => {})
    vi.spyOn(dockerService, 'topProcessCount').mockResolvedValue(2)

    const before = Date.now() - 60 * 60 * 1000 // idle 1 小时 > stopTimeoutMs
    userService.state.swtcUsers[ADDR] = {
      port: 31000,
      tier: 1,
      containerStatus: 'running',
      lastSeenAt: before,
      createdAt: Date.now(),
    }
    await userService.cleanupIdleContainers()
    expect(stopSpy).not.toHaveBeenCalled()
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('running')
    expect(userService.state.swtcUsers[ADDR].lastSeenAt).toBeGreaterThan(before)
    expect(saveSpy).toHaveBeenCalled()
  })

  it('cleanup：确认空闲才停止，且使用优雅宽限', async () => {
    vi.spyOn(dockerService, 'runVolumeScript').mockResolvedValue(
      JSON.stringify({ latestSessionMtime: 0, sessionCount: 0 }),
    )
    vi.spyOn(dockerService, 'topProcessCount').mockResolvedValue(2)
    const stopSpy = vi.spyOn(dockerService, 'stopContainer').mockResolvedValue()
    vi.spyOn(dataService, 'saveState').mockImplementation(() => {})

    userService.state.swtcUsers[ADDR] = {
      port: 31000,
      tier: 1,
      containerStatus: 'running',
      lastSeenAt: Date.now() - 60 * 60 * 1000,
      createdAt: Date.now(),
    }
    await userService.cleanupIdleContainers()
    expect(stopSpy).toHaveBeenCalledTimes(1)
    // 优雅宽限：stopContainer(name, graceSeconds)，grace > 默认 10
    const [, grace] = stopSpy.mock.calls[0]
    expect(grace).toBeGreaterThanOrEqual(60)
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('stopped')
  })
})
