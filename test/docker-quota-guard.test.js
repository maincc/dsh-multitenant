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
import { dockerService } from '../src/services/docker.service.js'

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
