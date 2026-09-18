/**
 * createContainer 磁盘配额参数防御测试
 *
 * 背景：配额字段由 memorySwap 改名为 disk 后，旧 config.json（只有 memorySwap）
 * 会让 limits.disk 缺失 → 参数拼成 "--storage-opt size=undefined"。在 overlayfs 下
 * 被忽略，但 btrfs/zfs 驱动会解析该值而拒绝启动容器。
 *
 * 覆盖：
 *   - disk 合法 → 传 --storage-opt size=<值>
 *   - disk 缺失（旧配置场景）→ 不传该参数 + console.warn 迁移提示
 *   - disk 非法格式 → 不传该参数
 *   - 大小写单位兼容（1G / 512M）
 *
 * 隔离：mock node:child_process 的 execFile，不执行真实 docker。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { execFile } from 'node:child_process'
import { dockerService, setStorageOptSupportedForTest } from '../src/services/docker.service.js'

/** 最近一次 docker 调用的参数数组 */
const lastArgs = () => execFile.mock.calls.at(-1)?.[1] ?? []

beforeEach(() => {
  execFile.mockReset()
  // sh() 约定：execFile(cmd, args, opts, callback)
  execFile.mockImplementation((cmd, args, opts, cb) => cb(null, 'container-id\n', ''))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createContainer：磁盘配额参数防御', () => {
  const base = { memory: '512m', cpus: '1.0', pids: 256 }

  it('disk 合法 → 传 --storage-opt size=<值>', async () => {
    await dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', {
      ...base,
      disk: '1g',
    })

    const args = lastArgs()
    expect(args).toContain('--storage-opt')
    expect(args).toContain('size=1g')
  })

  it('disk 缺失（旧配置只有 memorySwap）→ 不传该参数且告警', async () => {
    await dockerService.createContainer('c2', 40002, 'vol2', '/tmp/p.yml', {
      ...base,
      memorySwap: '1g', // 旧字段：现已不识别
    })

    const args = lastArgs()
    expect(args).not.toContain('--storage-opt')
    // 关键：不能把 undefined 拼进参数
    expect(args.some((a) => String(a).includes('undefined'))).toBe(false)
    expect(console.warn).toHaveBeenCalled()

    const warned = console.warn.mock.calls.flat().join(' ')
    expect(warned).toContain('memorySwap') // 提示迁移
  })

  it('disk 非法格式（abc）→ 不传该参数', async () => {
    await dockerService.createContainer('c3', 40003, 'vol3', '/tmp/p.yml', {
      ...base,
      disk: 'abc',
    })

    expect(lastArgs()).not.toContain('--storage-opt')
    expect(console.warn).toHaveBeenCalled()
  })

  it('disk 单位大小写兼容（1G / 512M）', async () => {
    await dockerService.createContainer('c4', 40004, 'vol4', '/tmp/p.yml', {
      ...base,
      disk: '1G',
    })
    expect(lastArgs()).toContain('size=1G')

    await dockerService.createContainer('c5', 40005, 'vol5', '/tmp/p.yml', {
      ...base,
      disk: '512M',
    })
    expect(lastArgs()).toContain('size=512M')
  })

  it('内存/CPU/PID 等原有硬限制不受影响', async () => {
    await dockerService.createContainer('c6', 40006, 'vol6', '/tmp/p.yml', {
      ...base,
      disk: '2g',
    })

    const args = lastArgs()
    expect(args).toContain('--memory')
    expect(args).toContain('512m')
    expect(args).toContain('--cpus')
    expect(args).toContain('--pids-limit')
    // 旧的 --memory-swap 已彻底移除
    expect(args).not.toContain('--memory-swap')
  })
})

// ---------------------------------------------------------------------------
// 宿主不支持 --storage-opt 时的降级（线上实测故障）
//
// /home/oc-skywelld-1 那台服务器不是 overlay2+xfs(pquota)，Docker 对整个
// `docker run` 硬拒绝并返回 125：
//   "--storage-opt is supported only for overlay over xfs with 'pquota' mount option"
// 修复前 → 容器创建彻底失败，租户全部进不去。
// 修复后 → 去掉该参数重试一次（配额退化为不限制），并记住宿主能力。
// ---------------------------------------------------------------------------
describe('createContainer：宿主不支持磁盘配额时降级重试', () => {
  const base = { memory: '512m', cpus: '1.0', pids: 256 }
  const quotaErr = () =>
    Object.assign(new Error('Command failed: docker run ...'), {
      code: 125,
      stderr:
        'docker: Error response from daemon: --storage-opt is supported only for ' +
        "overlay over xfs with 'pquota' mount option.\nSee 'docker run --help'.\n",
    })

  beforeEach(() => {
    // 模块级缓存会在用例间残留，必须逐条重置
    setStorageOptSupportedForTest(null)
  })

  it('第一次被拒 → 去掉 --storage-opt 重试成功，容器照常创建', async () => {
    let call = 0
    execFile.mockImplementation((cmd, args, opts, cb) => {
      call += 1
      if (call === 1) return cb(quotaErr(), '', quotaErr().stderr)
      return cb(null, 'container-id\n', '')
    })

    await expect(
      dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', { ...base, disk: '1g' }),
    ).resolves.toBeUndefined()

    expect(execFile).toHaveBeenCalledTimes(2)
    const [first, second] = execFile.mock.calls.map((c) => c[1])
    expect(first).toContain('--storage-opt')
    expect(second).not.toContain('--storage-opt')
    // 其余关键参数在重试时必须原样保留（不能顺手丢配额之外的东西）
    expect(second).toEqual(expect.arrayContaining(['--cap-add', 'SYS_ADMIN', '--memory', '512m']))
    expect(second).toContain('vol1:/dsh-home')
    expect(second).toContain('c1')
  })

  it('记住宿主能力：后续创建不再尝试该参数（不再先失败一次）', async () => {
    let call = 0
    execFile.mockImplementation((cmd, args, opts, cb) => {
      call += 1
      if (call === 1) return cb(quotaErr(), '', quotaErr().stderr)
      return cb(null, 'container-id\n', '')
    })

    await dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', { ...base, disk: '1g' })
    execFile.mockClear()

    await dockerService.createContainer('c2', 40002, 'vol2', '/tmp/p.yml', { ...base, disk: '1g' })

    expect(execFile).toHaveBeenCalledTimes(1) // 一次成功，无失败重试
    expect(lastArgs()).not.toContain('--storage-opt')
  })

  it('只是"不支持"才降级：其它 docker 错误必须原样上抛', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      const e = Object.assign(new Error('Command failed: docker run ...'), {
        code: 125,
        stderr:
          'docker: Error response from daemon: Conflict. The container name "/c1" is already in use',
      })
      return cb(e, '', e.stderr)
    })

    // 真实 sh() 的 err.message 是 "Command failed: docker run …"，
    // 细节在 stderr —— 断言要看 stderr，否则测不到真正的失败原因
    await expect(
      dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', { ...base, disk: '1g' }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/already in use/) })
    expect(execFile).toHaveBeenCalledTimes(1) // 没有盲目重试
  })

  it('宿主支持时不受影响：配额参数照常下发（回归保护）', async () => {
    setStorageOptSupportedForTest(true)
    await dockerService.createContainer('c1', 40001, 'vol1', '/tmp/p.yml', {
      ...base,
      disk: '2g',
    })
    expect(lastArgs()).toEqual(expect.arrayContaining(['--storage-opt', 'size=2g']))
  })
})
