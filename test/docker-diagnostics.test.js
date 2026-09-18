/**
 * 容器"起不来"时的现场采集与快速失败
 *
 * 背景（线上实测）：容器创建/重启成功，但里面的 DSH 没能就绪，用户只看到
 *   "Container dsh-swtc-… did not become ready after restart"
 * —— 既看不出是崩了还是没监听，也没有日志，远程排查只能上机器翻。
 * 更糟的是 finalizeTenant 失败会**回滚删容器**，日志随之永久消失。
 *
 * 覆盖：
 *   - containerDiagnostics 采集状态/退出码/OOM 并**合并 stdout+stderr**
 *     （docker logs 把容器 stderr 写到进程 stderr，只用 sh() 会丢关键行）
 *   - waitReady 在容器已退出时**立即失败**（不白等满 120s 超时）
 *
 * 隔离：mock node:child_process 与 global.fetch，不触碰真实 docker/网络。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { execFile } from 'node:child_process'
import { dockerService } from '../src/services/docker.service.js'

beforeEach(() => {
  execFile.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('containerDiagnostics：启动失败现场', () => {
  it('合并 stdout 与 stderr —— docker logs 的容器 stderr 不能丢', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === 'inspect') return cb(null, 'status=exited exit=1 oom=false\n', '')
      // docker logs：容器 stdout 走 stdout，容器 stderr 走进程 stderr
      return cb(null, 'listening on 3080\n', 'FATAL: cannot read /patches/tenant.patch.yml\n')
    })

    const out = await dockerService.containerDiagnostics('c1')

    expect(out).toContain('status=exited exit=1 oom=false')
    expect(out).toContain('listening on 3080')
    // 关键行在 stderr 里：丢掉它就等于没诊断
    expect(out).toContain('FATAL: cannot read /patches/tenant.patch.yml')
  })

  it('采集本身绝不抛错：docker 命令失败也要返回可读文本', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      const e = Object.assign(new Error('Command failed: docker inspect'), {
        stderr: 'Error: No such container: c1',
      })
      return cb(e, '', e.stderr)
    })

    const out = await dockerService.containerDiagnostics('c1')

    expect(out).toMatch(/inspect 失败|No such container/)
  })
})

describe('waitReady：容器早退时快速失败', () => {
  it('容器已 exited → 立即返回 false，不再轮询满超时', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchSpy)
    // containerInfo 走 docker inspect --format {{.State.Status}}
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, 'exited\n', ''))

    const t0 = Date.now()
    const ready = await dockerService.waitReady(40001, 120000, { containerName: 'c1' })
    const elapsed = Date.now() - t0

    expect(ready).toBe(false)
    // 早退：不该等到 120s；也不该反复探测（首次探测即发现已退出）
    expect(elapsed).toBeLessThan(3000)
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('未传 containerName 时保持原行为（不额外查存活）', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchSpy)
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, 'exited\n', ''))

    const ready = await dockerService.waitReady(40001, 1200) // 短超时，避免测试变慢

    expect(ready).toBe(false)
    expect(execFile).not.toHaveBeenCalled() // 没有注入存活检查
  })
})
