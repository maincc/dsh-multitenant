/**
 * F1/F2 磁盘与供应参数测试（disk-fix 方案，2026-09）
 *
 * 覆盖：
 *   - dockerService.hostFreeBytes：查 DockerRootDir 分区（Linux 错分区修复）、
 *     不可达时回落 `/`、全失败 null、DockerRootDir 查询记忆化
 *   - hostDiskUsage 保持旧字段 + path（管理面板/磁盘监控兼容）
 *   - createContainer 的供应参数固定带 json-file 轮转（缺口 E）
 *
 * 隔离：mock node:child_process，不执行真实 docker/df。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { execFile } from 'node:child_process'
import { dockerService, setSecurityModeForTest } from '../src/services/docker.service.js'

/** @type {Array<string[]>} 记录每次 execFile 的 [cmd, ...args] */
let calls = []

/**
 * 脚本化执行器：按 cmd+args 匹配假输出。
 * script 为 (key, args) => {out?, err?} | undefined 的函数。
 */
function scripted(script) {
  execFile.mockImplementation((cmd, args, opts, cb) => {
    calls.push([cmd, ...args])
    const hit = script(cmd, args)
    if (!hit) return cb(null, '', '')
    if (hit.err) return cb(new Error(hit.err), hit.out || '', '')
    cb(null, hit.out ?? '', '')
  })
}

const dfLine = (fs, availKB, usePct = '50%') =>
  `Filesystem     1024-blocks      Used Available Capacity Mounted on\n${fs} 100000000 60000000 ${availKB} ${usePct} /`

beforeEach(() => {
  calls = []
  execFile.mockReset()
  // 记忆化字段直清（实例属性，无构造声明）——避免跨用例串数据
  dockerService._dockerRootMemo = undefined
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hostFreeBytes：查 Docker 数据分区', () => {
  it('Linux 场景：df 查的是 DockerRootDir，不是 /', async () => {
    scripted((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'info') return { out: '/var/lib/docker\n' }
      if (cmd === 'df' && args.at(-1) === '/var/lib/docker')
        return { out: dfLine('/dev/sda1', 9000000) }
      return undefined
    })
    const free = await dockerService.hostFreeBytes()
    expect(free.checkedPath).toBe('/var/lib/docker')
    expect(free.freeBytes).toBe(9000000 * 1024)
    // POSIX 单行输出（长设备名不换行）
    expect(calls.some((c) => c[0] === 'df' && c.includes('-P'))).toBe(true)
    // 绝不能再查 /（Linux 上那是错分区）
    expect(calls.some((c) => c[0] === 'df' && c.at(-1) === '/')).toBe(false)
  })

  it('macOS 场景：DockerRootDir 是 VM 内路径、宿主 df 失败 → 回落 /', async () => {
    scripted((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'info') return { out: '/var/lib/docker\n' }
      if (cmd === 'df' && args.at(-1) === '/var/lib/docker')
        return { err: 'df: /var/lib/docker: No such file or directory' }
      if (cmd === 'df' && args.at(-1) === '/') return { out: dfLine('/dev/disk3s1', 5000000) }
      return undefined
    })
    const free = await dockerService.hostFreeBytes()
    expect(free.checkedPath).toBe('/')
    expect(free.freeBytes).toBe(5000000 * 1024)
  })

  it('docker info 查不到 → 行为=改造前（df /）', async () => {
    scripted((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'info') return { err: 'docker daemon down' }
      if (cmd === 'df' && args.at(-1) === '/') return { out: dfLine('/dev/disk3s1', 7000000) }
      return undefined
    })
    const free = await dockerService.hostFreeBytes()
    expect(free.checkedPath).toBe('/')
    expect(free.freeBytes).toBe(7000000 * 1024)
  })

  it('全部读不到 → null（探针只报事实）', async () => {
    scripted((cmd) => {
      if (cmd === 'docker') return { err: 'boom' }
      if (cmd === 'df') return { err: 'boom' }
      return undefined
    })
    expect(await dockerService.hostFreeBytes()).toBeNull()
  })

  it('DockerRootDir 记忆化：连续两次查询只发一次 docker info', async () => {
    scripted((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'info') return { out: '/data/docker\n' }
      if (cmd === 'df') return { out: dfLine('/dev/sdb1', 8000000) }
      return undefined
    })
    await dockerService.hostFreeBytes()
    await dockerService.hostFreeBytes()
    expect(calls.filter((c) => c[0] === 'docker' && c[1] === 'info')).toHaveLength(1)
    expect(calls.filter((c) => c[0] === 'df' && c.at(-1) === '/data/docker')).toHaveLength(2)
  })

  it('hostDiskUsage 保留旧字段并新增 path（磁盘监控/面板兼容）', async () => {
    scripted((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'info') return { out: '/var/lib/docker\n' }
      if (cmd === 'df') return { out: dfLine('/dev/sda1', 9000000, '70%') }
      return undefined
    })
    const usage = await dockerService.hostDiskUsage()
    expect(usage).toMatchObject({
      totalKB: 100000000,
      usedKB: 60000000,
      availableKB: 9000000,
      usePercent: '70%',
      path: '/var/lib/docker',
    })
  })

  it('两个候选都失败 → hostDiskUsage null（旧语义不变）', async () => {
    scripted(() => ({ err: 'nope' }))
    expect(await dockerService.hostDiskUsage()).toBeNull()
  })
})

describe('createContainer：日志轮转参数固定落地（缺口 E）', () => {
  it('docker run 参数带 --log-opt max-size=10m / max-file=3', async () => {
    setSecurityModeForTest('compat')
    scripted((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'run') return { out: 'container-id\n' }
      return undefined
    })
    await dockerService.createContainer('c-log', 40123, 'vol1', '/tmp/p.yml', {
      memory: '512m',
      cpus: '1.0',
      pids: 256,
      disk: '1g',
    })
    const run = calls.find((c) => c[0] === 'docker' && c[1] === 'run')
    expect(run).toBeDefined()
    expect(run).toEqual(expect.arrayContaining(['--log-opt', 'max-size=10m', 'max-file=3']))
  })
})
