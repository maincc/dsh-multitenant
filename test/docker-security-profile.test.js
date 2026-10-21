/**
 * 安全参数组（P1-6 strict/compat）测试
 *
 * 覆盖 docker.service.js 的"安全参数组"块：
 *   - 两档参数组的形状（strict 白名单 / compat 现状）
 *   - auto 探测：触发时机、探测 argv 逐字、结果缓存、并发合并
 *   - 探测失败 → compat + 告警
 *   - daemon 拒绝 seccomp 文件 → auto 降级重试一次；显式 strict 不回退
 *   - 其它 docker 错误必须原样上抛
 *
 * 隔离：mock node:child_process 的 execFile，不执行真实 docker。
 * 真实 docker 的端到端验证在实现当日已本机跑过（矩阵脚本
 * .dshArchive/…/test-p16-privilege-drop.sh），这里只锁行为契约。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { execFile } from 'node:child_process'
import {
  dockerService,
  BWRAP_PROBE_ARGS,
  securityArgsFor,
  setSecurityModeForTest,
  setStorageOptSupportedForTest,
  setTenantNetworkForTest,
} from '../src/services/docker.service.js'

const calls = () => execFile.mock.calls.map((c) => c[1])
const isProbe = (args) => args.includes('--rm')
const isRun = (args) => args[0] === 'run' && args.includes('-d')
const base = { memory: '512m', cpus: '1.0', pids: 256, disk: '1g' }

/**
 * 通用 mock：probe 结果与 run 结果可编程。
 * @param {object} o
 * @param {boolean} [o.probeOk=true]     bwrap 探测是否通过
 * @param {Error|null} [o.runErr=null]   供应容器 run 的固定错误（null=成功）
 */
function mockDocker({ probeOk = true, runErr = null } = {}) {
  execFile.mockImplementation((cmd, args, opts, cb) => {
    if (isProbe(args)) {
      return probeOk
        ? cb(null, '', '')
        : cb(
            Object.assign(new Error('Command failed: docker run'), {
              stderr: 'bwrap: Creating new namespace failed: Operation not permitted',
            }),
            '',
            'bwrap: Creating new namespace failed: Operation not permitted',
          )
    }
    if (runErr) return cb(runErr, '', runErr.stderr || '')
    return cb(null, 'container-id\n', '')
  })
}

beforeEach(() => {
  execFile.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // 模块级缓存逐条重置：安全档位回到"未探测"，配额支持状态清空
  setSecurityModeForTest(null)
  setStorageOptSupportedForTest(null)
  setTenantNetworkForTest()
  delete process.env.DSH_PRIVILEGE_PROFILE
})

afterEach(() => {
  delete process.env.DSH_PRIVILEGE_PROFILE
  vi.restoreAllMocks()
})

describe('参数组形状', () => {
  it('strict：SYS_ADMIN 保留 + no-new-privileges + 白名单文件，绝不含 unconfined', () => {
    const a = securityArgsFor('strict')
    expect(a).toEqual(
      expect.arrayContaining(['--cap-add', 'SYS_ADMIN', '--security-opt', 'no-new-privileges']),
    )
    expect(a.some((x) => String(x).startsWith('seccomp=') && String(x).endsWith('.json'))).toBe(
      true,
    )
    expect(a).not.toContain('seccomp=unconfined')
    expect(a).toContain('apparmor=unconfined')
  })

  it('compat：与 2026-09-22 之前的线上行为逐字一致', () => {
    const a = securityArgsFor('compat')
    expect(a).toEqual([
      '--cap-add',
      'SYS_ADMIN',
      '--security-opt',
      'seccomp=unconfined',
      '--security-opt',
      'apparmor=unconfined',
    ])
  })

  it('BWRAP_PROBE_ARGS 与 DSH sandbox-local 的探测形态一致（契约锁定）', () => {
    // packages/sandbox/sandbox-local: bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
    expect(BWRAP_PROBE_ARGS.join(' ')).toBe(
      '--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true',
    )
  })
})

describe('租户隔离网络（2026-10 全面审计 CRITICAL 回归位）', () => {
  // default bridge 事故形态：租户容器自带 shell，可 nc 直连其他租户
  // 172.17.x.x:3080 绕过网关全部会话门禁。修复=所有租户容器落
  // enable_icc=false 的自定义 bridge；helper 容器（--network container:）不受影响。
  it('createContainer 的 run 带 --network dsh-tenant-net', async () => {
    mockDocker({ probeOk: true })
    await dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', base)
    const run = calls().find(isRun)
    const i = run.indexOf('--network')
    expect(i).toBeGreaterThan(-1)
    expect(run[i + 1]).toBe('dsh-tenant-net')
  })

  it('建网幂等：首次供应建一次（带 icc=false 桥选项），后续供应不重发', async () => {
    mockDocker({ probeOk: true })
    await dockerService.createContainer('c1', 40001, 'v1', '/tmp/p.yml', base)
    const netCreates = calls().filter((a) => a[0] === 'network' && a[1] === 'create')
    expect(netCreates).toHaveLength(1)
    expect(netCreates[0]).toContain('com.docker.network.bridge.enable_icc=false')
    expect(netCreates[0]).toContain('dsh-tenant-net')
    await dockerService.createContainer('c2', 40002, 'v2', '/tmp/p.yml', base)
    expect(calls().filter((a) => a[0] === 'network' && a[1] === 'create')).toHaveLength(1)
  })
})

describe('auto：探测与选档', () => {
  it('首次供应先探测；探测命令 = run --rm + strict 参数 + entrypoint bwrap', async () => {
    mockDocker({ probeOk: true })
    await dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', base)

    // 用 filter 取（不再按下标解构）：createContainer 前置还有幂等
    // network create（2026-10 icc=false 隔离网），调用序列会增长
    const probe = calls().find(isProbe)
    const run = calls().find(isRun)
    expect(isProbe(probe)).toBe(true)
    expect(probe).toEqual(expect.arrayContaining(['--entrypoint', 'bwrap']))
    expect(probe.slice(-BWRAP_PROBE_ARGS.length)).toEqual(BWRAP_PROBE_ARGS)
    // 探测必须用 strict 参数——拿 compat 探等于没探
    expect(probe).toContain('no-new-privileges')
    expect(probe.some((x) => String(x).startsWith('seccomp=') && String(x).endsWith('.json'))).toBe(
      true,
    )
    // 容器本体也用 strict 档
    expect(run).toContain('no-new-privileges')
    expect(run).not.toContain('seccomp=unconfined')
  })

  it('探测只跑一次：后续供应直接复用缓存档位', async () => {
    mockDocker({ probeOk: true })
    await dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', base)
    await dockerService.createContainer('c2', 40002, 'vol2', '/tmp/p.yml', base)

    expect(calls().filter(isProbe)).toHaveLength(1)
    expect(calls().filter(isRun)).toHaveLength(2)
  })

  it('并发供应合并为一次探测（同一时刻只跑一个 run --rm）', async () => {
    mockDocker({ probeOk: true })
    await Promise.all([
      dockerService.createContainer('a1', 40001, 'v1', '/tmp/p.yml', base),
      dockerService.createContainer('a2', 40002, 'v2', '/tmp/p.yml', base),
      dockerService.createContainer('a3', 40003, 'v3', '/tmp/p.yml', base),
    ])
    expect(calls().filter(isProbe)).toHaveLength(1)
  })

  it('探测不过 → 回落 compat + 告警（容器照常起）', async () => {
    mockDocker({ probeOk: false })
    await dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', base)

    const run = calls().find(isRun)
    expect(run).toContain('seccomp=unconfined')
    expect(run).not.toContain('no-new-privileges')
    const warned =
      console.warn.mock.calls.flat().join(' ') + console.log.mock.calls.flat().join(' ')
    expect(warned).toContain('compat')
  })

  it('探测失败也被缓存：第二条容器不再探测', async () => {
    mockDocker({ probeOk: false })
    await dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', base)
    await dockerService.createContainer('c2', 40002, 'vol2', '/tmp/p.yml', base)
    expect(calls().filter(isProbe)).toHaveLength(1)
  })
})

describe('降级与不回退', () => {
  it('auto 探到 strict 后 daemon 拒绝 profile 文件 → 降 compat 重试一次', async () => {
    const reject = Object.assign(new Error('Command failed: docker run'), {
      stderr:
        'docker: Error response from daemon: opening seccomp profile (/no/such.json) ' +
        'failed: open /no/such.json: no such file or directory',
    })
    mockDocker({ probeOk: true, runErr: reject })

    await expect(
      dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', base),
    ).rejects.toBe(reject) // mock 让 run 永远失败 → 降级重试一次后上抛

    const runs = calls().filter(isRun)
    expect(runs).toHaveLength(2) // 第一次 strict 被拒，第二次 compat
    expect(runs[0].some((x) => String(x).endsWith('.json'))).toBe(true)
    expect(runs[1]).toContain('seccomp=unconfined')
    expect(console.warn.mock.calls.flat().join(' ')).toContain('seccomp')
  })

  it('降级重试仍受配额降级保护：其它错误绝不吞', async () => {
    const conflict = Object.assign(new Error('Command failed: docker run'), {
      stderr:
        'docker: Error response from daemon: Conflict. The container name "/c1" is already in use',
    })
    mockDocker({ probeOk: true, runErr: conflict })
    await expect(
      dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', base),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/already in use/) })
    expect(calls().filter(isRun)).toHaveLength(1) // 没有盲目重试
  })

  it('显式 strict：不探测，profile 被拒必须上抛（不静默回退）', async () => {
    process.env.DSH_PRIVILEGE_PROFILE = 'strict'
    const reject = Object.assign(new Error('Command failed: docker run'), {
      stderr:
        'docker: Error response from daemon: error loading seccomp profile into seccomp argument filter',
    })
    mockDocker({ runErr: reject })
    await expect(
      dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', base),
    ).rejects.toBe(reject)
    expect(calls().filter(isProbe)).toHaveLength(0)
    expect(calls().filter(isRun)).toHaveLength(1)
  })

  it('显式 compat：不探测，直接旧参数', async () => {
    process.env.DSH_PRIVILEGE_PROFILE = 'compat'
    mockDocker({ probeOk: true })
    await dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', base)
    expect(calls().filter(isProbe)).toHaveLength(0)
    expect(calls().find(isRun)).toContain('seccomp=unconfined')
  })
})
