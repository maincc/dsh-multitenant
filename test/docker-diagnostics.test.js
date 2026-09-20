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

describe('quarantineVolumeFile：隔离卷内损坏文件', () => {
  it('改名成 .broken-<时间戳> 并返回新路径（不删除，内容留档）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) =>
      cb(null, '/dsh-home/.credentials.yaml.broken-2026-09-18T10-00-00-000Z\n', ''),
    )

    const out = await dockerService.quarantineVolumeFile('dsh-data-swtc-x', '.credentials.yaml')

    expect(out).toBe('/dsh-home/.credentials.yaml.broken-2026-09-18T10-00-00-000Z')
    const args = execFile.mock.calls.at(-1)[1]
    // 挂载租户卷 + 用镜像里的 sh（不依赖 alpine）
    expect(args).toEqual(expect.arrayContaining(['-v', 'dsh-data-swtc-x:/dsh-home']))
    expect(args).toEqual(expect.arrayContaining(['--entrypoint', 'sh']))
    // 注入安全：文件名/后缀走位置参数，不拼进脚本
    expect(args[args.indexOf('-c') + 2]).toBe('sh') // $0
    expect(args[args.indexOf('-c') + 3]).toBe('.credentials.yaml')
    expect(args[args.indexOf('-c') + 4]).toMatch(/^broken-/)
  })

  it('文件不存在 → 返回 null（幂等，不报错）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '', ''))
    expect(await dockerService.quarantineVolumeFile('v', '.credentials.yaml')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ensureDshWorkspace：补建 DSH 会话的默认工作目录
//
// 根因（本地实测复现）：DSH 新建会话的 cwd 默认是 $HOME/workspace
// （本镜像 /root/workspace）。该目录不存在时，bash 工具的沙箱以它作为
// spawn 的 cwd —— Node 在 cwd 不存在时也抛 ENOENT，而报错文案是
//     Error: spawn bwrap ENOENT
// 于是被误判成"bwrap 没装"（DSH 自己的提示也是这么说的），实际 bwrap 正常，
// 只是容器内【所有】bash 命令都失败。镜像已内置该目录，平台再兜一层。
// ---------------------------------------------------------------------------
describe('ensureDshWorkspace：补建会话工作目录', () => {
  it('执行 docker exec <name> mkdir -p /root/workspace', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '', ''))
    const ok = await dockerService.ensureDshWorkspace('dsh-swtc-x')
    expect(ok).toBe(true)
    expect(execFile.mock.calls.at(-1)[1]).toEqual([
      'exec',
      'dsh-swtc-x',
      'mkdir',
      '-p',
      '/root/workspace',
    ])
  })

  it('失败只记日志并返回 false（绝不影响容器启动）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) =>
      cb(Object.assign(new Error('No such container'), { stderr: 'No such container' }), '', ''),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = await dockerService.ensureDshWorkspace('dsh-swtc-gone')
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalled()
  })
})
