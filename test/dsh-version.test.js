/**
 * DSH 版本列表服务测试
 *
 * 覆盖：
 *   - 正常解析：latest / stable / prerelease 分组（含 '-' 视为预发布）
 *   - 缓存：TTL 内不重复打 registry；force 强制刷新
 *   - 并发合并：同时多个请求只打一次 registry
 *   - registry 失败 → 有旧缓存则降级返回 stale；无缓存则 ok:false
 *   - isInstallable：格式校验（防注入到 docker build / npm install）+ 存在性校验
 *
 * 隔离：mock node:child_process 的 execFile，不打真实 npm registry。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { execFile } from 'node:child_process'
import { dshVersionService } from '../src/services/dsh-version.service.js'
import { CONFIG } from '../src/config/config.js'

/** registry 元数据替身（npm view --json 形状） */
function registryPayload({ versions, distTags }) {
  return JSON.stringify({
    name: '@deepseek-ai/dsh',
    'dist-tags': distTags,
    versions,
  })
}

/** 让 npm view 成功返回给定 payload */
function mockRegistry(payload) {
  execFile.mockImplementation((cmd, args, opts, cb) => cb(null, payload, ''))
}

/** 让下一次调用失败 */
function mockRegistryFail(message = 'ETIMEDOUT') {
  execFile.mockImplementation((cmd, args, opts, cb) => cb(new Error(message), '', ''))
}

const SAMPLE = registryPayload({
  versions: ['0.0.1-rc.1', '0.1.2-alpha.3', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.6-alpha.1'],
  distTags: { latest: '0.1.5-rc.1', next: '0.1.5-rc.2', alpha: '0.1.6-alpha.1' },
})

beforeEach(() => {
  execFile.mockReset()
  dshVersionService.clearCache()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dshVersionService：版本列表', () => {
  it('解析 latest / stable / prerelease 分组', async () => {
    mockRegistry(SAMPLE)

    const res = await dshVersionService.getVersions()

    expect(res.ok).toBe(true)
    expect(res.latest).toBe('0.1.5-rc.1')
    expect(res.tags.next).toBe('0.1.5-rc.2')
    // 样本里全是预发布版本 → stable 为空、prerelease 全收
    expect(res.stable).toEqual([])
    expect(res.prerelease).toHaveLength(5)
    expect(res.all).toHaveLength(5)
    expect(res.stale).toBe(false)
    expect(res.fetchedAt).toBeGreaterThan(0)
  })

  it('正式版本排在预发布前面', async () => {
    mockRegistry(
      registryPayload({
        versions: ['0.1.6-alpha.1', '0.1.5', '0.1.4', '0.1.5-rc.1'],
        distTags: { latest: '0.1.5' },
      }),
    )

    const res = await dshVersionService.getVersions()

    expect(res.stable).toEqual(['0.1.5', '0.1.4'])
    expect(res.prerelease).toEqual(['0.1.6-alpha.1', '0.1.5-rc.1'])
    // all 前两个必须是正式版
    expect(res.all.slice(0, 2)).toEqual(['0.1.5', '0.1.4'])
  })

  it('versions 以对象形式返回时也能解析（npm view 两种输出形态）', async () => {
    mockRegistry(
      JSON.stringify({
        'dist-tags': { latest: '0.1.5' },
        versions: { '0.1.5': {}, '0.1.4': {} },
      }),
    )

    const res = await dshVersionService.getVersions()

    expect(res.ok).toBe(true)
    expect(res.all).toEqual(['0.1.5', '0.1.4'])
  })

  it('TTL 内命中缓存，不再打 registry', async () => {
    mockRegistry(SAMPLE)
    await dshVersionService.getVersions()
    expect(execFile).toHaveBeenCalledTimes(1)

    await dshVersionService.getVersions()
    expect(execFile).toHaveBeenCalledTimes(1) // 走缓存
  })

  it('force=true 忽略缓存强制刷新', async () => {
    mockRegistry(SAMPLE)
    await dshVersionService.getVersions()
    expect(execFile).toHaveBeenCalledTimes(1)

    await dshVersionService.getVersions({ force: true })
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('并发请求合并为一次 registry 调用', async () => {
    // 用延迟回调模拟在途请求，确保并发窗口存在
    execFile.mockImplementation((cmd, args, opts, cb) => {
      setTimeout(() => cb(null, SAMPLE, ''), 10)
    })

    const [a, b, c] = await Promise.all([
      dshVersionService.getVersions(),
      dshVersionService.getVersions(),
      dshVersionService.getVersions(),
    ])

    expect(execFile).toHaveBeenCalledTimes(1)
    expect(a.latest).toBe('0.1.5-rc.1')
    expect(b.latest).toBe('0.1.5-rc.1')
    expect(c.latest).toBe('0.1.5-rc.1')
  })
})

describe('dshVersionService：registry 不可达', () => {
  it('有旧缓存 → 降级返回 stale:true 而不是整页失败', async () => {
    mockRegistry(SAMPLE)
    await dshVersionService.getVersions()

    mockRegistryFail('ECONNREFUSED')
    const res = await dshVersionService.getVersions({ force: true })

    expect(res.ok).toBe(true) // 仍可用
    expect(res.stale).toBe(true)
    expect(res.latest).toBe('0.1.5-rc.1') // 旧数据仍在
    expect(res.error).toMatch(/ECONNREFUSED/)
  })

  it('无任何缓存 → ok:false 带错误原因', async () => {
    mockRegistryFail('ENOTFOUND registry.npmjs.org')

    const res = await dshVersionService.getVersions()

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/ENOTFOUND/)
  })

  it('响应不是合法 JSON → ok:false，不抛异常', async () => {
    mockRegistry('这不是 json')

    const res = await dshVersionService.getVersions()

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/解析失败/)
  })
})

describe('dshVersionService：compareOnly（只读缓存，绝不联网）', () => {
  it('无缓存 → notLoaded，且不调用外部命令', async () => {
    mockRegistry(SAMPLE)

    const res = await dshVersionService.getVersions({ compareOnly: true })

    expect(res.ok).toBe(false)
    expect(res.notLoaded).toBe(true)
    // 关键：/status 要快，绝不能因为对比版本去打 registry
    expect(execFile).not.toHaveBeenCalled()
  })

  it('有缓存 → 直接用缓存（哪怕已过期），不联网', async () => {
    mockRegistry(SAMPLE)
    await dshVersionService.getVersions()
    const callsAfterWarm = execFile.mock.calls.length

    // 让缓存过期
    dshVersionService._cache.at = Date.now() - dshVersionService.ttlMs - 1000

    const res = await dshVersionService.getVersions({ compareOnly: true })

    expect(res.ok).toBe(true)
    expect(res.latest).toBeTruthy()
    expect(res.stale).toBe(true) // 过期但仍可用，比让管理面板卡住强
    expect(execFile.mock.calls.length).toBe(callsAfterWarm)
  })
})

describe('dshVersionService：isInstallable 校验', () => {
  it('空值 / 非字符串 → 拒绝', async () => {
    expect((await dshVersionService.isInstallable('')).ok).toBe(false)
    expect((await dshVersionService.isInstallable(null)).ok).toBe(false)
    expect((await dshVersionService.isInstallable(undefined)).ok).toBe(false)
    expect((await dshVersionService.isInstallable(123)).ok).toBe(false)
  })

  it('非法字符 → 拒绝（防注入到 docker build / npm install）', async () => {
    mockRegistry(SAMPLE)

    for (const bad of [
      '0.1.5; rm -rf /',
      '0.1.5 && curl evil',
      '$(whoami)',
      '../../etc/passwd',
      '0.1.5 --registry=http://evil',
      '-0.1.5',
    ]) {
      const res = await dshVersionService.isInstallable(bad)
      expect(res.ok).toBe(false)
    }
  })

  it('latest 直通（不需要查列表）', async () => {
    const res = await dshVersionService.isInstallable('latest')
    expect(res.ok).toBe(true)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('registry 上有该版本 → 放行', async () => {
    mockRegistry(SAMPLE)

    const res = await dshVersionService.isInstallable('0.1.6-alpha.1')

    expect(res.ok).toBe(true)
  })

  it('registry 上不存在该版本 → 拒绝', async () => {
    mockRegistry(SAMPLE)

    const res = await dshVersionService.isInstallable('9.9.9')

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/不存在/)
  })

  it('registry 不可达时不肯放行确切版本（避免构建不存在的版本）', async () => {
    mockRegistryFail('ETIMEDOUT')

    const res = await dshVersionService.isInstallable('0.1.5-rc.1')

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/无法校验/)
  })
})
// 回归：宿主 ~/.npm/_cacache 不可写（root 拥有的历史文件）时，`npm view` 会直接
// EPERM，管理页显示"无法获取 DSH 版本列表"。修法是给 npm 显式指定一个确定可写
// 的缓存目录，不再依赖平台运行用户的 ~/.npm 状态。
// 注意：缓存目录与 registry 无关（registry 由 --registry 显式指定），所以这不改变
// "用哪个源"的语义。
describe('dshVersionService：npm 缓存目录（规避宿主 ~/.npm EPERM）', () => {
  it('调用 npm view 时始终传入可写的 npm_config_cache', async () => {
    mockRegistry(SAMPLE)

    await dshVersionService.getVersions({ force: true })

    const call = execFile.mock.calls[0]
    const env = call[2]?.env
    expect(env?.npm_config_cache).toBeTruthy()
    // 必须是绝对路径
    expect(String(env.npm_config_cache).startsWith('/')).toBe(true)
  })

  it('缓存目录与 registry 显式参数并存（不改变源）', async () => {
    mockRegistry(SAMPLE)

    await dshVersionService.getVersions({ force: true })

    const [cmd, args, opts] = execFile.mock.calls[0]
    expect(cmd).toBe('npm')
    expect(args).toContain('--registry')
    expect(opts.env.npm_config_cache).toBeTruthy()
  })

  it('解析一次后复用，不会每次调用都重新探测目录', async () => {
    mockRegistry(SAMPLE)
    dshVersionService._cacheDir = undefined

    const first = dshVersionService._resolveCacheDir()
    const second = dshVersionService._resolveCacheDir()

    expect(first).toBe(second)
    expect(first).toBeTruthy()
  })

  it('显式配置优先于自动探测', async () => {
    dshVersionService._cacheDir = undefined
    const spy = vi.spyOn(CONFIG.dsh, 'npmCacheDir', 'get').mockReturnValue('/tmp/custom-npm-cache')

    expect(dshVersionService._resolveCacheDir()).toBe('/tmp/custom-npm-cache')

    spy.mockRestore()
    dshVersionService._cacheDir = undefined
  })
})
