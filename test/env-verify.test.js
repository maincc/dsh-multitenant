/**
 * verifyBundle 真身单测（不 mock 本服务——判例：路由测试把它整体 mock 后，
 * "按平铺文件核验 vs 实际产物是 tar"的路径形态错配活了两个 PR 都没被
 * 测试发现，直到用户管理端首点"重跑检测"才炸）。
 * 这里用真 tar、真文件、真哈希。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const TMP = mkdtempSync(join(tmpdir(), 'envverify-'))
vi.mock('../src/services/data.service.js', () => ({
  dataService: {
    dataDir: TMP,
    listEnvironments: async () => globalThis.__envDocs ?? [],
  },
}))
vi.mock('../src/services/docker.service.js', () => ({
  dockerService: {
    runVolumeScript: vi.fn(async () => JSON.stringify({ copied: [], conflicts: [] })),
    listVolumes: vi.fn(async () => ['dsh-data-swtc-jdsharedcas000000000000000000000a']),
  },
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

// ═══ 判例 56：CAS 内容寻址去重（多用户同插件=盘上一份字节）═══
describe('CAS 去重/清扫/真扫', () => {
  const mkRealBundle = (tag, files) => {
    const dir = join(TMP, 'env-bundles', tag.replace(/[^A-Za-z0-9._-]/g, '_'))
    rmSync(dir, { recursive: true, force: true })
    const stage = join(TMP, `mks-${tag.slice(-6)}`)
    rmSync(stage, { recursive: true, force: true })
    const manifest = []
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(join(stage, dirnameOf(p)), { recursive: true })
      writeFileSync(join(stage, p), content)
      const buf = Buffer.from(content)
      manifest.push({ p, size: buf.length, sha256: sha(buf) })
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    execFileSync('tar', ['-czf', join(dir, 'bundle.tar.gz'), '-C', stage, ...topNames(files)])
    rmSync(stage, { recursive: true, force: true })
    return manifest
  }
  const dirnameOf = (p) => p.split('/').slice(0, -1).join('/')
  const topNames = (files) => [...new Set(Object.keys(files).map((p) => p.split('/')[0]))]

  const TAG_A = 'dsh-multitenant:env-jdedupcasaaa-20260102000001'
  const TAG_B = 'dsh-multitenant:env-jdedupcasbbb-20260102000002'
  const SHARED = 'export const shared = "同一份作者代码";\n'
  const OWN_A = 'export const a = 1;\n'
  const OWN_B = 'export const b = 2;\n'
  let manA, manB

  it('migrateCas：收编后 tar 出局；同字节两引用只存一份', () => {
    manA = mkRealBundle(TAG_A, { 'plugins/shared/index.mjs': SHARED, 'plugins/onlya/x.mjs': OWN_A })
    manB = mkRealBundle(TAG_B, { 'plugins/shared/index.mjs': SHARED, 'plugins/onlyb/y.mjs': OWN_B })
    const migrated = envBundleService.migrateCas()
    expect(migrated).toContain(TAG_A.replace(/[^A-Za-z0-9._-]/g, '_'))
    const dirA = join(TMP, 'env-bundles', TAG_A.replace(/[^A-Za-z0-9._-]/g, '_'))
    expect(existsSync(join(dirA, 'bundle.tar.gz'))).toBe(false)
    const sharedBlob = envBundleService.blobPath(sha(Buffer.from(SHARED)))
    expect(existsSync(sharedBlob)).toBe(true)
    const seg = sharedBlob.split('/').slice(-2)[0]
    const segDir = join(envBundleService.blobRoot, seg)
    const names = readdirSync(segDir)
    expect(names).toContain(sha(Buffer.from(SHARED)).slice(2))
    expect(names).not.toContain(sha(Buffer.from(OWN_A)).slice(2)) // 不同前缀不同分片——数共享片只此一份
    expect(names).not.toContain(sha(Buffer.from(OWN_B)).slice(2))
  })

  it('CAS 形态 verify：两账共一字节，哈希不符照样现形', async () => {
    expect(await envBundleService.verifyBundle(TAG_A, manA)).toHaveLength(2)
    expect(await envBundleService.verifyBundle(TAG_B, manB)).toHaveLength(2)
    const blob = envBundleService.blobPath(sha(Buffer.from(OWN_B)))
    writeFileSync(blob, 'export const b = 3;\n') // 等长篡改：必须走到哈希关才现形
    await expect(envBundleService.verifyBundle(TAG_B, manB)).rejects.toThrow(/哈希不符/)
    writeFileSync(blob, OWN_B) // 复原——后面还要用
  })

  it('scanOnStage 读真身：scanned 从此数得着（假绿收案）', () => {
    const scan = envBundleService.scanOnStage(TAG_A, manA)
    expect(scan.stats.scanned).toBe(2)
    expect(scan.stats.skipped).toBe(0)
  })

  it('installBundle CAS 形态：/blobs 只读挂载 + plan 逐块取字节', async () => {
    const { dockerService } = await import('../src/services/docker.service.js')
    const r = await envBundleService.installBundle('jdsharedcas000000000000000000000a', TAG_B, manB)
    expect(r.copied).toEqual([])
    const call = dockerService.runVolumeScript.mock.calls.at(-1)
    const payload = JSON.parse(Buffer.from(call[3][0], 'base64').toString())
    expect(payload.plan.map((x) => x.p).sort()).toEqual([...manB.map((f) => f.p)].sort())
    expect(call[4].bindBlobs).toBe(envBundleService.blobRoot)
    expect(call[4].bindOutRo).toBeUndefined()
  })

  it('sweepBlobs：账无引用者清，被引用者一根不碰（被引用之物不可删）', async () => {
    const orphan = mkRealBundle('dsh-multitenant:env-jdedupcasccc-20260102000003', {
      'plugins/orphan/z.mjs': 'export const z = 3;\n',
    })
    envBundleService.migrateCas() // 新包也走收编（tar→CAS）才谈得上清扫
    const orphanBlob = envBundleService.blobPath(orphan[0].sha256)
    expect(existsSync(orphanBlob)).toBe(true)
    globalThis.__envDocs = [{ bundle: { files: [...manA, ...manB] } }]
    const swept = await envBundleService.sweepBlobs()
    expect(swept.deleted).toBe(1)
    expect(existsSync(orphanBlob)).toBe(false)
    expect(existsSync(envBundleService.blobPath(sha(Buffer.from(SHARED))))).toBe(true)
    expect(swept.kept).toBe(3) // SHARED+onlya+onlyb——共享字节两块账点只算一份实物
  })
})
