/**
 * 环境模板路由测试（environment-templates PR1，2026-10-27）
 *
 * 覆盖（安全红线逐条钉死）：
 *   - 鉴权：未登录 403；破坏性动作走真实挑战池（signature binding 一致性）
 *   - env-commit：slug 从严；dryRun 不动 docker；成功=账本 draft + 审计；
 *     源容器不在跑 → 409
 *   - env-publish：仅 draft 可上架（revoked 不可复活=重定格重审语义）
 *   - env-apply：仅 published 可分发；**digest 与账本不符即拒**（同名覆盖
 *     攻击面）；镜像消失 → 410；成功走 applyImageVersion + pinnedBy 记账
 *   - env-revoke：撤 listing 不驱逐；重复 revoke=幂等 already
 *
 * 隔离：mock docker/data（env 账本内存替身）/config.isAdmin，不触碰真实 Docker。
 * 脚手架拷贝自 admin-dsh-routes.test.js（同款 MockReq 异步 emit 时序教训）。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/services/docker.service.js', () => ({
  dockerService: {
    imageId: vi.fn(),
    imageDshVersion: vi.fn(),
    containerImageId: vi.fn(),
    containerInfo: vi.fn(),
    commitEnvironment: vi.fn(),
    removeImage: vi.fn(),
  },
}))

vi.mock('../src/services/env-bundle.service.js', () => ({
  envBundleService: {
    exportBundle: vi.fn(async () => ({
      files: [{ p: 'plugins/a.js', size: 3, sha256: 'aa' }],
      bytes: 3,
      scan: {
        rulesVer: 1,
        hits: [],
        secrets: [],
        stats: { scanned: 1, skipped: 0, longLines: [] },
      },
    })),
    removeBundle: vi.fn(),
    inventory: vi.fn(async () => ({
      skills: [{ name: 'cwt-verify', size: 10 }],
      plugins: [],
      roots: [],
    })),
    browse: vi.fn(async () => ({
      dir: '',
      items: [{ name: 'skills', type: 'd', size: 0 }],
      total: 1,
    })),
    verifyBundle: vi.fn(() => ['plugins/a.js']),
    bundleDir: vi.fn(() => '/tmp/dsh-nonexistent-bundle-dir'),
    installBundle: vi.fn(async () => ({ ok: true, copied: [], conflicts: [] })),
    applyBundleTo: vi.fn(async (addr, doc, opts = {}) => ({
      bundleApplied: !opts.dryRun,
      conflicts: opts.dryRun ? [{ p: 'plugins/a.js', size: 3 }] : [],
      skillsInstalled: [],
      skillsFailed: [],
      skillsPlanned: opts.dryRun ? doc.include?.skills || [] : [],
      notices: [],
    })),
  },
}))

vi.mock('../src/config/config.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, isAdmin: vi.fn(() => true) }
})

vi.mock('../src/services/cwt-admin.service.js', () => ({ cwtAdminService: {} }))

vi.mock('../src/services/tenant-proxy.service.js', () => ({
  tenantGateway: { listen: vi.fn(), close: vi.fn() },
}))

vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      loadState: vi.fn(() => ({ swtcUsers: {}, nextPort: 31000 })),
      saveState: vi.fn(() => {}),
      loadSessions: vi.fn(() => ({})),
      saveSessions: vi.fn(() => {}),
      loadUserSessions: vi.fn(() => ({})),
      saveUserSessions: vi.fn(() => {}),
      loadCwtRegistry: vi.fn(() => ({})),
      loadCwtApplications: vi.fn(() => []),
      saveCwtApplications: vi.fn(() => {}),
      readStateFile: vi.fn(() => null),
      getDshImage: vi.fn(() => ({ current: null, history: [] })),
      saveDshImage: vi.fn(() => ({})),
      logOperation: vi.fn(() => {}),
      // env 账本四个方法在 beforeEach 里挂内存替身（工厂期共享变量会撞 TDZ）
    },
  }
})

import { handleAdminRoutes } from '../src/routes/admin.routes.js'
import { dockerService } from '../src/services/docker.service.js'
import { envBundleService } from '../src/services/env-bundle.service.js'
import { userService } from '../src/services/user.service.js'
import { userService } from '../src/services/user.service.js'
import { dataService } from '../src/services/data.service.js'
import { userSessionStore } from '../src/middleware/user-auth.middleware.js'
import { isAdmin } from '../src/config/config.js'
import { tenantConfigService } from '../src/services/tenant-config.service.js'

const ADMIN_ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const TENANT = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'
const TPL = 'dsh-multitenant:env-jga9j9tk-stock-20261027120000'

import { EventEmitter } from 'node:events'

class MockReq extends EventEmitter {
  constructor({ method = 'GET', url = '/', cookie = '', body, headers = {} }) {
    super()
    this.method = method
    this.url = url
    this.headers = { host: '127.0.0.1:8090', cookie, ...headers }
    this.socket = { remoteAddress: '127.0.0.1' }
    this._bodyPayload = body === undefined ? '' : JSON.stringify(body)
  }

  /** 原版时序（admin-dsh-routes 教训注释）：'end' 监听注册后再投递，防 body 蒸发 */
  on(event, listener) {
    super.on(event, listener)
    if (event === 'end') {
      setImmediate(() => {
        if (this._bodyPayload) super.emit('data', this._bodyPayload)
        super.emit('end')
      })
    }
    return this
  }
}

function makeReq({ method = 'GET', url = '/', cookie = '', body, headers } = {}) {
  return new MockReq({ method, url, cookie, body, headers })
}

function makeRes() {
  return {
    headersSent: false,
    statusCode: null,
    body: '',
    headers: {},
    writeHead(code, h) {
      this.statusCode = code
      this.headers = { ...(h || {}) }
      this.headersSent = true
    },
    end(data) {
      this.body = data || ''
    },
  }
}

/** 真实挑战池 + verifySignature spy：覆盖"binding 必须一致、nonce 一次性"契约 */
async function adminSignatureHeaders(operation, payload) {
  const chalRes = makeRes()
  await handleAdminRoutes(
    makeReq({
      method: 'POST',
      url: '/api/admin/challenge',
      cookie: adminCookie(),
      body: { address: ADMIN_ADDR, operation, payload },
    }),
    chalRes,
    '/api/admin/challenge',
  )
  if (chalRes.statusCode !== 200) {
    throw new Error(`挑战发放失败: ${chalRes.statusCode} ${chalRes.body}`)
  }
  const { nonce, message } = json(chalRes)
  return {
    'x-admin-nonce': nonce,
    'x-admin-signature': `sig:${message}`,
    'x-admin-pubkey': 'PUBKEY',
  }
}

function adminCookie() {
  const token = userSessionStore.create(ADMIN_ADDR, 3600_000)
  return `user_session=${token}`
}

const json = (res) => JSON.parse(res.body)

async function call(pathname, { method = 'POST', body, sign, cookie = true } = {}) {
  const url = pathname
  let headers = {}
  if (sign) headers = await adminSignatureHeaders(sign.op, sign.payload)
  const res = makeRes()
  await handleAdminRoutes(
    makeReq({ method, url, body, headers, cookie: cookie ? adminCookie() : '' }),
    res,
    url,
  )
  return res
}

/** 预置一个模板到账本（返 draft 或指定态） */
function seedTemplate(over = {}) {
  const doc = {
    _id: TPL,
    sourceAddr: TENANT,
    slug: 'stock',
    imageTag: TPL,
    imageId: 'sha256:abc123',
    parentImage: 'sha256:parent',
    dshVersion: '0.1.5',
    sizeBytes: 1234,
    scrubbed: true,
    manifest: ['C /root/.bashrc', 'A /usr/local/bin/trader'],
    status: 'draft',
    pinnedBy: [],
    createdBy: ADMIN_ADDR,
    createdAt: '2026-10-27T12:00:00.000Z',
    ...over,
  }
  globalThis.__envStore.set(doc._id, doc) // 键必须是 doc._id（over 带 id 的 seed 曾静默错位）
  return doc
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  isAdmin.mockReturnValue(true)
  userSessionStore.sessions = {}
  userService.state.swtcUsers = {}

  globalThis.__envStore = new Map()
  dataService.listEnvironments = vi.fn(async () => [...globalThis.__envStore.values()])
  dataService.getEnvironment = vi.fn(async (id) => globalThis.__envStore.get(id) || null)
  dataService.putEnvironment = vi.fn(async (doc) => {
    globalThis.__envStore.set(doc._id, { ...doc })
    return doc
  })
  dataService.patchEnvironment = vi.fn(async (id, set) => {
    const d = globalThis.__envStore.get(id)
    if (!d) return null
    Object.assign(d, set)
    return { ...d }
  })

  dockerService.containerInfo = vi.fn().mockResolvedValue({ exists: true, status: 'running' })
  dockerService.containerImageId = vi.fn().mockResolvedValue('sha256:parent')
  dockerService.imageId = vi.fn().mockResolvedValue('sha256:abc123')
  dockerService.imageDshVersion = vi.fn().mockResolvedValue('0.1.5')
  dockerService.commitEnvironment = vi.fn(async (name, tag) => ({
    tag,
    imageId: 'sha256:abc123',
    sizeBytes: 1234,
    dshVersion: '0.1.5',
    manifest: ['C /root/.bashrc', 'A /usr/local/bin/trader'],
    scrubbed: true,
  }))

  vi.spyOn(tenantConfigService, 'verifySignature').mockImplementation(
    (addr, message, signature) => signature === `sig:${message}`,
  )

  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  userSessionStore.sessions = {}
  userService.state.swtcUsers = {}
})

describe('env-commit（定格）', () => {
  const sign = { op: 'env-commit', payload: { address: TENANT, slug: 'stock' } }

  it('未登录 → 403', async () => {
    const res = await call('/api/admin/env-commit', {
      body: { address: TENANT, slug: 'stock' },
      cookie: false,
    })
    expect(res.statusCode).toBe(403)
  })

  it('无签名 → SIGNATURE_REQUIRED（不落到 docker 面）', async () => {
    const res = await call('/api/admin/env-commit', {
      body: { address: TENANT, slug: 'stock' },
    })
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_REQUIRED')
    expect(dockerService.commitEnvironment).not.toHaveBeenCalled()
  })

  it('slug 非法字符 → 400（先于签名检查，不让人签注定失败的操作）', async () => {
    const res = await call('/api/admin/env-commit', {
      body: { address: TENANT, slug: 'Bad Slug!' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('dryRun → 200 预览，零 docker 动作零账本写入', async () => {
    const res = await call('/api/admin/env-commit', {
      body: { address: TENANT, slug: 'stock', dryRun: true },
      sign,
    })
    expect(res.statusCode).toBe(200)
    const body = json(res)
    expect(body.dryRun).toBe(true)
    expect(body.tag).toMatch(/^dsh-multitenant:env-jga9j9tk-stock-\d{14}$/)
    // 大白话承诺行（判例文案变更随 UI：隔离承诺必须在场，载体是人话不是路径名）
    expect(body.notices.join('')).toContain('不会被带走')
    expect(body.notices.join('')).toContain('/root/workspace')
    expect(dockerService.commitEnvironment).not.toHaveBeenCalled()
    expect(globalThis.__envStore.size).toBe(0)
  })

  it('成功 → 账本 draft + 审计留痕；发布权在 env-publish 不在这里', async () => {
    const res = await call('/api/admin/env-commit', {
      body: {
        address: TENANT,
        slug: 'stock',
        displayName: '我的炒股环境',
        intro: '装了 akshare',
      },
      sign,
    })
    expect(res.statusCode).toBe(200)
    const { template, notice } = json(res)
    expect(template.status).toBe('draft')
    expect(template.displayName).toBe('我的炒股环境') // 展示名自由文本（中文空格无限制）
    expect(template.intro).toBe('装了 akshare')
    expect(template.imageId).toBe('sha256:abc123')
    expect(template.manifest).toBeUndefined() // 列表面折叠
    expect(template.manifestCount).toBe(2)
    expect(notice).toContain('publish')
    expect(globalThis.__envStore.get(template._id).manifest.length).toBe(2) // 账本存全量
    expect(dataService.logOperation).toHaveBeenCalledWith(
      'env_commit',
      expect.objectContaining({ address: TENANT }),
    )
  })

  it('源容器不在跑 → 409（签名之后、docker 之前拦下）', async () => {
    dockerService.containerInfo.mockResolvedValue({ exists: true, status: 'exited' })
    const res = await call('/api/admin/env-commit', {
      body: { address: TENANT, slug: 'stock' },
      sign,
    })
    expect(res.statusCode).toBe(409)
    expect(dockerService.commitEnvironment).not.toHaveBeenCalled()
  })

  it('同来源未下架模板达 5 → 409（镜像存储不在 tier 配额内，从严）', async () => {
    for (let i = 0; i < 5; i++) {
      globalThis.__envStore.set(`t${i}`, { sourceAddr: TENANT, status: 'published' })
    }
    const res = await call('/api/admin/env-commit', {
      body: { address: TENANT, slug: 'stock' },
      sign,
    })
    expect(res.statusCode).toBe(409)
    expect(json(res).error).toContain('上限')
  })
})

describe('env-publish / env-revoke（审核闸与下架语义）', () => {
  it('draft → published；重复 publish → 409', async () => {
    seedTemplate()
    let res = await call('/api/admin/env-publish', {
      body: { id: TPL },
      sign: { op: 'env-publish', payload: { id: TPL } },
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).template.status).toBe('published')
    res = await call('/api/admin/env-publish', {
      body: { id: TPL },
      sign: { op: 'env-publish', payload: { id: TPL } },
    })
    expect(res.statusCode).toBe(409)
  })

  it('revoked 不可复活（重定格重审语义钉死）', async () => {
    seedTemplate({ status: 'revoked' })
    const res = await call('/api/admin/env-publish', {
      body: { id: TPL },
      sign: { op: 'env-publish', payload: { id: TPL } },
    })
    expect(res.statusCode).toBe(409)
  })

  it('判例：已下架(unlisted)可改判撤板——封死"重新提交审核"去路（后端本允许，补入口即闭环）', async () => {
    seedTemplate({ status: 'unlisted', pinnedBy: [TENANT] })
    const res = await call('/api/admin/env-revoke', {
      body: { id: TPL },
      sign: { op: 'env-revoke', payload: { id: TPL } },
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).template.status).toBe('revoked')
    expect(json(res).note).toContain('不受影响')
    // 管理员也无绕行上架门：revoked 不可复活
    const pub = await call('/api/admin/env-publish', {
      body: { id: TPL },
      sign: { op: 'env-publish', payload: { id: TPL } },
    })
    expect(pub.statusCode).toBe(409)
  })

  it('revoke：撤 listing、在用者写进 note；重复 revoke 幂等', async () => {
    seedTemplate({ status: 'published', pinnedBy: [TENANT] })
    let res = await call('/api/admin/env-revoke', {
      body: { id: TPL },
      sign: { op: 'env-revoke', payload: { id: TPL } },
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).template.status).toBe('revoked')
    expect(json(res).note).toContain('1 个在用租户不受影响')
    res = await call('/api/admin/env-revoke', {
      body: { id: TPL },
      sign: { op: 'env-revoke', payload: { id: TPL } },
    })
    expect(json(res).already).toBe(true)
  })

  it('裁定 2026-10-30：撤板作者回落默认——只解作者的钉，在用他人不驱逐（判例并存）', async () => {
    const OTHER = 'j2otherpinholder000000000000000000' // 必须真·异于 TENANT（自撞测试曾假摔）
    expect(OTHER).not.toBe(TENANT)
    seedTemplate({ status: 'published', pinnedBy: [TENANT, OTHER] })
    userService.state.swtcUsers = {
      [TENANT]: { pinnedImage: TPL },
      [OTHER]: { pinnedImage: TPL },
    }
    const res = await call('/api/admin/env-revoke', {
      body: { id: TPL },
      sign: { op: 'env-revoke', payload: { id: TPL } },
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).selfUnpinned).toBe(true)
    expect(json(res).note).toContain('作者已回落默认环境')
    expect(json(res).note).toContain('1 个在用租户不受影响')
    expect(userService.state.swtcUsers[TENANT].pinnedImage).toBe(null)
    expect(userService.state.swtcUsers[OTHER].pinnedImage).toBe(TPL) // 在用者不驱逐
    expect(globalThis.__envStore.get(TPL).pinnedBy).toEqual([OTHER])
    delete userService.state.swtcUsers[TENANT]
    delete userService.state.swtcUsers[OTHER]
  })

  it('签名绑定偷换：签 A 模板发布 B 模板 → 拒', async () => {
    seedTemplate()
    const headers = await adminSignatureHeaders('env-publish', { id: 'other-id' })
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/env-publish',
        body: { id: TPL },
        headers,
        cookie: adminCookie(),
      }),
      res,
      '/api/admin/env-publish',
    )
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_MISMATCH')
  })
})

describe('env-apply（分发：digest 逐字校验）', () => {
  const target = { address: TENANT }

  it('draft 未审 → 409 拒发（审核闸在分发面二次把关）', async () => {
    seedTemplate()
    const res = await call('/api/admin/env-apply', {
      body: { id: TPL, address: TENANT },
      sign: { op: 'env-apply', payload: { id: TPL, address: TENANT } },
    })
    expect(res.statusCode).toBe(409)
  })

  it('tag 被同名覆盖（digest 不符）→ 409 且报 expected/actual', async () => {
    seedTemplate({ status: 'published' })
    dockerService.imageId.mockResolvedValue('sha256:EVIL-overwritten')
    const res = await call('/api/admin/env-apply', {
      body: { id: TPL, address: TENANT },
      sign: { op: 'env-apply', payload: { id: TPL, address: TENANT } },
    })
    expect(res.statusCode).toBe(409)
    expect(json(res).expected).toBe('sha256:abc123')
    expect(json(res).actual).toBe('sha256:EVIL-overwritten')
  })

  it('模板镜像已不在本机 → 410', async () => {
    seedTemplate({ status: 'published' })
    dockerService.imageId.mockResolvedValue(null)
    const res = await call('/api/admin/env-apply', {
      body: { id: TPL, address: TENANT },
      sign: { op: 'env-apply', payload: { id: TPL, address: TENANT } },
    })
    expect(res.statusCode).toBe(410)
  })

  it('published + digest 相符 → applyImageVersion 收治 + pinnedBy 记账 + 审计', async () => {
    seedTemplate({ status: 'published' })
    const spy = vi.spyOn(userService, 'applyImageVersion').mockResolvedValue({ applied: true })
    const res = await call('/api/admin/env-apply', {
      body: { id: TPL, address: TENANT },
      sign: { op: 'env-apply', payload: { id: TPL, address: TENANT } },
    })
    expect(res.statusCode).toBe(200)
    expect(spy).toHaveBeenCalledWith(TENANT, { image: TPL, dryRun: false })
    expect(json(res).userNotices[0]).toContain('容器环境')
    expect(globalThis.__envStore.get(TPL).pinnedBy).toContain(TENANT)
    expect(dataService.logOperation).toHaveBeenCalledWith(
      'env_apply',
      expect.objectContaining({ id: TPL, ...target }),
    )
  })

  it('revoked 之后禁新 pin（下架=只撤 listing，绝不驱逐在用者的另一半）', async () => {
    seedTemplate({ status: 'revoked', pinnedBy: [TENANT] })
    const res = await call('/api/admin/env-apply', {
      body: { id: TPL, address: ADMIN_ADDR }, // 给另一个租户钉也照样拒
      sign: { op: 'env-apply', payload: { id: TPL, address: ADMIN_ADDR } },
    })
    expect(res.statusCode).toBe(409)
  })

  it('dryRun 不动世界：无 pinnedBy、无审计', async () => {
    seedTemplate({ status: 'published' })
    vi.spyOn(userService, 'applyImageVersion').mockResolvedValue({ dryRun: true })
    const res = await call('/api/admin/env-apply', {
      body: { id: TPL, address: TENANT, dryRun: true },
      sign: { op: 'env-apply', payload: { id: TPL, address: TENANT } },
    })
    expect(res.statusCode).toBe(200)
    expect(globalThis.__envStore.get(TPL).pinnedBy).toEqual([])
  })
})

describe('environments 浏览面', () => {
  it('列表：manifest 折叠成 manifestCount，按时间倒序', async () => {
    seedTemplate()
    globalThis.__envStore.set('other', {
      _id: 'other',
      sourceAddr: TENANT,
      status: 'published',
      pinnedBy: [ADMIN_ADDR],
      manifest: ['A /x'],
      createdAt: '2026-10-28T00:00:00.000Z',
    })
    const res = await call('/api/admin/environments', { method: 'GET', cookie: true })
    expect(res.statusCode).toBe(200)
    const list = json(res).environments
    expect(list.length).toBe(2)
    expect(list[0]._id).toBe('other') // 新的在前
    expect(list[0].manifest).toBeUndefined()
    expect(list[0].manifestCount).toBe(1)
  })

  it('单查带全量 manifest；不存在 404', async () => {
    seedTemplate()
    let res = await call(`/api/admin/environments/${encodeURIComponent(TPL)}`, {
      method: 'GET',
      cookie: true,
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).template.manifest).toContain('A /usr/local/bin/trader')
    res = await call('/api/admin/environments/nope', { method: 'GET', cookie: true })
    expect(res.statusCode).toBe(404)
  })
})

describe('PR2 随行包接线（include/导出/驳回/检测/装包）', () => {
  it('定格带 include → scrubKeep 进清洗、plugins 导出成包、账本记 bundle/scan、审计留勾选快照', async () => {
    const res = await call('/api/admin/env-commit', {
      body: {
        address: TENANT,
        slug: 'stock',
        include: { skills: ['cwt-verify'], plugins: ['a.js'], folders: ['策略'] },
      },
      sign: { op: 'env-commit', payload: { address: TENANT, slug: 'stock' } },
    })
    expect(res.statusCode).toBe(200)
    const { template } = json(res)
    expect(dockerService.commitEnvironment.mock.lastCall[2].scrubKeep).toEqual(['策略'])
    expect(envBundleService.exportBundle).toHaveBeenCalledWith(TENANT, template._id, [
      { root: 'plugins', name: 'a.js' },
    ])
    expect(template.include).toEqual({
      skills: ['cwt-verify'],
      plugins: ['a.js'],
      folders: ['策略'],
      wsExcludes: [], // 子项摘除清单入账（判例 2026-10-30），空也要如实记
    })
    expect(template.bundle.files).toHaveLength(1)
    expect(template.scan.rulesVer).toBe(1)
    expect(
      dataService.logOperation.mock.calls.find((c) => c[0] === 'env_commit')[1].includeSnapshot,
    ).toEqual({
      skills: ['cwt-verify'],
      plugins: ['a.js'],
      folders: ['策略'],
      wsExcludes: [], // 子项摘除清单入账（判例 2026-10-30），空也要如实记
    }) // 知情留痕：勾选=公开同意入审计
  })

  it('导出失败 → 定格整体作废：删像删包、账本零残留', async () => {
    envBundleService.exportBundle.mockRejectedValueOnce(new Error('bundle-too-big'))
    const before = globalThis.__envStore.size
    const res = await call('/api/admin/env-commit', {
      body: { address: TENANT, slug: 'stock', include: { plugins: ['big.js'] } },
      sign: { op: 'env-commit', payload: { address: TENANT, slug: 'stock' } },
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).toContain('作废')
    expect(dockerService.removeImage).toHaveBeenCalled()
    expect(envBundleService.removeBundle).toHaveBeenCalled()
    expect(globalThis.__envStore.size).toBe(before)
  })

  it('驳回即弃同时解绑所有钉（判例 2026-10-30：像没了钉还挂着=重建吊空炸）', async () => {
    seedTemplate({
      _id: 'TPL_R2',
      imageTag: 'TPL_R2',
      status: 'draft',
      pinnedBy: ['addrholder1', 'addrholder2'],
    })
    userService.state.swtcUsers = userService.state.swtcUsers || {}
    userService.state.swtcUsers.addrholder1 = { pinnedImage: 'TPL_R2' }
    userService.state.swtcUsers.addrholder2 = { pinnedImage: 'OTHER' }
    const r = await call('/api/admin/env-reject', {
      body: { id: 'TPL_R2', reason: '测试驳回' },
      sign: { op: 'env-reject', payload: { id: 'TPL_R2' } },
    })
    expect(r.statusCode).toBe(200)
    expect(userService.state.swtcUsers.addrholder1.pinnedImage).toBe(null)
    expect(userService.state.swtcUsers.addrholder2.pinnedImage).toBe('OTHER') // 不相干的不动
    expect(globalThis.__envStore.get('TPL_R2').pinnedBy).toEqual([])
    expect(JSON.parse(r.body).notice).toContain('解绑')
    delete userService.state.swtcUsers.addrholder1
    delete userService.state.swtcUsers.addrholder2
  })

  it('env-reject：无理由 400（先于签名）；draft 即弃删像删包；published 409；重复 already', async () => {
    seedTemplate({ _id: 'TPL_R1', imageTag: 'TPL_R1', status: 'draft' })
    const noReason = await call('/api/admin/env-reject', { body: { id: 'TPL_R1' } })
    expect(noReason.statusCode).toBe(400) // 不让人签一个注定失败的操作
    const res = await call('/api/admin/env-reject', {
      body: { id: 'TPL_R1', reason: '插件含可疑网络行为' },
      sign: { op: 'env-reject', payload: { id: 'TPL_R1' } },
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).discarded).toBe(true)
    expect(globalThis.__envStore.get('TPL_R1').status).toBe('rejected')
    expect(globalThis.__envStore.get('TPL_R1').rejectReason).toBe('插件含可疑网络行为')
    expect(dockerService.removeImage).toHaveBeenCalledWith('TPL_R1')
    expect(envBundleService.removeBundle).toHaveBeenCalledWith('TPL_R1')
    const again = await call('/api/admin/env-reject', {
      body: { id: 'TPL_R1', reason: '再驳一次' },
      sign: { op: 'env-reject', payload: { id: 'TPL_R1' } },
    })
    expect(json(again).already).toBe(true)
    seedTemplate({ _id: 'TPL_R2', imageTag: 'TPL_R2', status: 'published' })
    const pub = await call('/api/admin/env-reject', {
      body: { id: 'TPL_R2', reason: 'x' },
      sign: { op: 'env-reject', payload: { id: 'TPL_R2' } },
    })
    expect(pub.statusCode).toBe(409) // published 只能 revoke
  })

  it('env-scan：无包模板 409；带包 verify 后重扫回账本', async () => {
    seedTemplate({ _id: 'TPL_S1', imageTag: 'TPL_S1', status: 'published' })
    const none = await call('/api/admin/env-scan', {
      body: { id: 'TPL_S1' },
      sign: { op: 'env-scan', payload: { id: 'TPL_S1' } },
    })
    expect(none.statusCode).toBe(409)
    seedTemplate({
      _id: 'TPL_S2',
      imageTag: 'TPL_S2',
      status: 'published',
      bundle: { path: 'p', bytes: 3, files: [{ p: 'plugins/a.js', size: 3, sha256: 'aa' }] },
    })
    const res = await call('/api/admin/env-scan', {
      body: { id: 'TPL_S2' },
      sign: { op: 'env-scan', payload: { id: 'TPL_S2' } },
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).scan.rulesVer).toBe(1)
    expect(envBundleService.verifyBundle).toHaveBeenCalledWith('TPL_S2', [
      { p: 'plugins/a.js', size: 3, sha256: 'aa' },
    ])
    expect(globalThis.__envStore.get('TPL_S2').scan.rulesVer).toBe(1)
  })

  it('inventory/browse：只读免签直通 helper', async () => {
    const res = await call('/api/admin/env-inventory', { body: { address: TENANT } })
    expect(res.statusCode).toBe(200)
    expect(json(res).inventory.skills[0].name).toBe('cwt-verify')
    expect(envBundleService.inventory).toHaveBeenCalledWith(TENANT)
    const b = await call('/api/admin/env-browse', { body: { address: TENANT, dir: 'plugins' } })
    expect(json(b).items[0].name).toBe('skills')
    expect(envBundleService.browse).toHaveBeenCalledWith(TENANT, 'plugins')
  })

  it('env-apply 带包：dryRun 回冲突与 skillsPlanned；实装走 applyBundleTo(false)；装包炸了如实 bundleError（镜像切换不谎报）', async () => {
    seedTemplate({
      _id: 'TPL_A1',
      imageTag: 'TPL_A1',
      status: 'published',
      bundle: { path: 'p', bytes: 3, files: [{ p: 'plugins/a.js', size: 3, sha256: 'aa' }] },
      include: { skills: ['cwt-verify'], plugins: ['a.js'], folders: [] },
    })
    const spy = vi.spyOn(userService, 'applyImageVersion').mockResolvedValue({ applied: true })
    const dry = await call('/api/admin/env-apply', {
      body: { id: 'TPL_A1', address: TENANT, dryRun: true },
      sign: { op: 'env-apply', payload: { id: 'TPL_A1', address: TENANT } },
    })
    expect(json(dry).conflicts).toHaveLength(1)
    expect(json(dry).skillsPlanned).toEqual(['cwt-verify'])
    const real = await call('/api/admin/env-apply', {
      body: { id: 'TPL_A1', address: TENANT },
      sign: { op: 'env-apply', payload: { id: 'TPL_A1', address: TENANT } },
    })
    expect(json(real).bundleApplied).toBe(true)
    expect(envBundleService.applyBundleTo).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ _id: 'TPL_A1' }),
      { dryRun: false },
    )
    envBundleService.applyBundleTo.mockRejectedValueOnce(new Error('expect-mismatch'))
    const boom = await call('/api/admin/env-apply', {
      body: { id: 'TPL_A1', address: TENANT },
      sign: { op: 'env-apply', payload: { id: 'TPL_A1', address: TENANT } },
    })
    expect(boom.statusCode).toBe(200) // 镜像切换是既成事实，不假装失败回滚
    expect(json(boom).bundleError).toContain('expect-mismatch')
    expect(spy).toHaveBeenCalled()
  })
})
