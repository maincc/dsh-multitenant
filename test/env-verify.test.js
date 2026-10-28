/**
 * verifyBundle 真身单测（不 mock 本服务——判例：路由测试把它整体 mock 后，
 * "按平铺文件核验 vs 实际产物是 tar"的路径形态错配活了两个 PR 都没被
 * 测试发现，直到用户管理端首点"重跑检测"才炸）。
 * 这里用真 tar、真文件、真哈希。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const TMP = mkdtempSync(join(tmpdir(), 'envverify-'))
vi.mock('../src/services/data.service.js', () => ({
  dataService: { dataDir: TMP },
}))

let envBundleService
const TAG = 'dsh-multitenant:env-jga9j9tk-verify-20260101000000'
const DIR = join(TMP, 'env-bundles', TAG.replace(/[^A-Za-z0-9._-]/g, '_'))
const sha = (b) => createHash('sha256').update(b).digest('hex')

function buildTar(files) {
  rmSync(DIR, { recursive: true, force: true })
  const stage = join(TMP, 'stage')
  rmSync(stage, { recursive: true, force: true })
  for (const [p, content] of Object.entries(files)) {
    const buf = Buffer.from(content)
    mkdirSync(join(stage, p.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(join(stage, p), buf)
  }
  mkdirSync(DIR, { recursive: true })
  execFileSync('tar', [
    '-czf',
    join(DIR, 'bundle.tar.gz'),
    '-C',
    stage,
    ...Object.keys(files).map((p) => p.split('/')[0]),
  ])
  rmSync(stage, { recursive: true, force: true })
  return Object.entries(files).map(([p, content]) => ({
    p,
    size: Buffer.byteLength(content),
    sha256: sha(Buffer.from(content)),
  }))
}

beforeAll(async () => {
  envBundleService = (await import('../src/services/env-bundle.service.js')).envBundleService
})

describe('verifyBundle 实体核验（真 tar）', () => {
  it('账本与包内实物一致 → 通过并返回清单', async () => {
    const expected = buildTar({
      'plugins/stock-close-notify/index.mjs': 'export const x = 1;\n',
      'plugins/stock-close-notify/plugin.json': '{"name":"stock-close-notify"}',
    })
    expect(await envBundleService.verifyBundle(TAG, expected)).toEqual([
      'plugins/stock-close-notify/index.mjs',
      'plugins/stock-close-notify/plugin.json',
    ])
  })

  it('账本说有两个文件、包里少一个 → 缺文件（本次事故的原症状）', async () => {
    const expected = buildTar({ 'plugins/a/only.js': '1' })
    expected.push({ p: 'plugins/a/ghost.js', size: 1, sha256: sha('1') })
    await expect(envBundleService.verifyBundle(TAG, expected)).rejects.toThrow(/缺文件 .*ghost\.js/)
  })

  it('字节数对不上 → 大小不符', async () => {
    const expected = buildTar({ 'plugins/a/x.js': 'hello' })
    expected[0].size = 99999
    await expect(envBundleService.verifyBundle(TAG, expected)).rejects.toThrow(/大小不符/)
  })

  it('尺寸碰巧对但内容被换 → 哈希不符（换包防护的正身）', async () => {
    const expected = buildTar({ 'plugins/a/x.js': 'hello!!' })
    // 保持 size=7 不变，换成另一个 7 字节内容 + 旧哈希
    const old = sha('hello!!')
    const swapped = buildTar({ 'plugins/a/x.js': 'HELLO!!' })
    expect(swapped[0].size).toBe(7)
    swapped[0].sha256 = old
    await expect(envBundleService.verifyBundle(TAG, swapped)).rejects.toThrow(/哈希不符/)
  })

  it('老账本没记 sha256 → 尺寸核验兜底（不误伤历史数据）', async () => {
    const expected = buildTar({ 'plugins/a/y.js': 'abc' })
    expected[0].sha256 = undefined
    expect(await envBundleService.verifyBundle(TAG, expected)).toEqual(['plugins/a/y.js'])
  })

  it('tar 不存在 → bundle-missing（未导出/已即弃的面）', async () => {
    rmSync(DIR, { recursive: true, force: true })
    expect(existsSync(DIR)).toBe(false)
    await expect(envBundleService.verifyBundle(TAG, [])).rejects.toThrow('bundle-missing')
  })
})
