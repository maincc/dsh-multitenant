/**
 * 平台资源探针（F1，disk-fix）单元测试
 *
 * 覆盖：
 *   - parseMemorySpecToBytes：'512m'/'1g'/'2G'/纯数字/非法值
 *   - readMemAvailableKB：Linux 正常解析 / 读失败 null / 无 MemAvailable 行 null /
 *     非 Linux 直接 null（不发起读取）
 *
 * 隔离：mock node:fs/promises（本模块图里只有 host-resources 用它）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))

import { readFile } from 'node:fs/promises'
import {
  MEM_HEADROOM_BYTES,
  parseMemorySpecToBytes,
  readMemAvailableKB,
} from '../src/utils/host-resources.js'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  readFile.mockReset()
})

describe('parseMemorySpecToBytes', () => {
  it('解析 docker 风格单位（大小写兼容）', () => {
    expect(parseMemorySpecToBytes('512m')).toBe(512 * 1024 * 1024)
    expect(parseMemorySpecToBytes('1g')).toBe(1024 * 1024 * 1024)
    expect(parseMemorySpecToBytes('2G')).toBe(2 * 1024 * 1024 * 1024)
    expect(parseMemorySpecToBytes('1k')).toBe(1024)
  })

  it('纯数字按字节；非法输入返回 null（调用方走缺省水位）', () => {
    expect(parseMemorySpecToBytes('1048576')).toBe(1048576)
    expect(parseMemorySpecToBytes('')).toBeNull()
    expect(parseMemorySpecToBytes('abc')).toBeNull()
    expect(parseMemorySpecToBytes(undefined)).toBeNull()
  })

  it('tiers 配置里的三个水位都能解析（防止有人把 memory 写成怪格式静默失效）', () => {
    for (const spec of ['512m', '1g', '2g']) {
      expect(parseMemorySpecToBytes(spec)).toBeGreaterThan(0)
    }
    expect(MEM_HEADROOM_BYTES).toBe(512 * 1024 * 1024)
  })
})

describe('readMemAvailableKB', () => {
  it('Linux：解析 /proc/meminfo 的 MemAvailable（KB）', async () => {
    setPlatform('linux')
    readFile.mockResolvedValue(
      'MemTotal: 16384000 kB\nMemFree: 100 kB\nMemAvailable:   4194304 kB\nBuffers: 0 kB\n',
    )
    expect(await readMemAvailableKB()).toBe(4194304)
  })

  it('Linux：文件读不到 → null（探针只报事实，fail-closed 由调用方决定）', async () => {
    setPlatform('linux')
    readFile.mockRejectedValue(new Error('ENOENT'))
    expect(await readMemAvailableKB()).toBeNull()
  })

  it('Linux：读得到但没有 MemAvailable 行 → null', async () => {
    setPlatform('linux')
    readFile.mockResolvedValue('MemTotal: 1 kB\n')
    expect(await readMemAvailableKB()).toBeNull()
  })

  it('非 Linux：直接 null，且不发起文件读取', async () => {
    setPlatform('darwin')
    expect(await readMemAvailableKB()).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })
})
