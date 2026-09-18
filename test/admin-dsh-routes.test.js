/**
 * 管理端 DSH 版本 / 镜像升级路由测试
 *
 * 覆盖：
 *   - 鉴权：未登录 / 非管理员 → 403（四个端点全覆盖）
 *   - GET /versions：预发布默认折叠；includePrerelease=1 展开；registry 不可达 → 503
 *   - GET /status：currentImageId 与容器镜像 ID 比对，正确标出 stale 租户
 *   - POST /image：版本校验 + 构建上下文预检（避免任务起不来）
 *   - GET /image：构建任务进度（含"不会永久卡在 running"的失败路径）
 *
 * 隔离：mock docker / dshVersionService / userService.state，不触碰真实 Docker。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/services/docker.service.js', () => ({
  dockerService: {
    imageId: vi.fn(),
    imageDshVersion: vi.fn(),
    containerImageId: vi.fn(),
    containerDshVersion: vi.fn().mockResolvedValue(null),
    buildImage: vi.fn(),
    listImages: vi.fn().mockResolvedValue([]),
    listReferencedImageIds: vi.fn().mockResolvedValue(new Set()),
    listContainerImages: vi.fn().mockResolvedValue([]),
    listLocalVersionTags: vi.fn().mockResolvedValue([]),
    listUntaggedBySignature: vi.fn().mockResolvedValue(new Set()),
    listAvailableImages: vi.fn().mockResolvedValue([]),
    removeImages: vi.fn().mockResolvedValue({ removed: [], failed: [] }),
  },
}))

vi.mock('../src/config/config.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, isAdmin: vi.fn(() => true) }
})

vi.mock('../src/services/cwt-admin.service.js', () => ({ cwtAdminService: {} }))
// 注意：**不整块 mock** tenant-config.service —— 破坏性操作（镜像清理）要走真实的
// 挑战池（issueChallenge/consumeChallenge 的一次性语义），只把密码学部分
// （verifySignature）用 spy 替掉，见 beforeEach。整块 mock 会让验签永远失败。

vi.mock('../src/services/tenant-proxy.service.js', () => ({
  tenantGateway: { listen: vi.fn(), close: vi.fn() },
}))
vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      // user.service.js / cwt.store.js 会在 import 期调用这些（模块初始化），
      // 必须给内存替身，否则加载阶段就炸
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
    },
  }
})

import { handleAdminRoutes } from '../src/routes/admin.routes.js'
import { dockerService } from '../src/services/docker.service.js'
import { dshVersionService } from '../src/services/dsh-version.service.js'
import { userService } from '../src/services/user.service.js'
import { dataService } from '../src/services/data.service.js'
import { adminSessionStore } from '../src/middleware/auth.middleware.js'
import { isAdmin, CONFIG } from '../src/config/config.js'
import { tenantConfigService } from '../src/services/tenant-config.service.js'

const ADMIN_ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const TENANT = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'

import { EventEmitter } from 'node:events'

/**
 * 基于真实 EventEmitter 的 req 替身。
 *
 * 不能用"on() 里同步回调"的简易替身：parseBody 在同一次同步执行里依次
 * req.on('data')/req.on('end')，同步 emit 会让已注册的 'end' 先于尚未注册的
 * 'data' 触发，导致 body 丢失。真实 IncomingMessage 是异步 emit，这里用
 * queueMicrotask 模拟同样的时序。
 */
class MockReq extends EventEmitter {
  constructor({ method, url, cookie, body, headers = {} }) {
    super()
    this.method = method
    this.url = url
    this.headers = { host: '127.0.0.1:8090', cookie, ...headers }
    this.socket = { remoteAddress: '127.0.0.1' }
    this._bodyPayload = body === undefined ? '' : JSON.stringify(body)
  }

  /**
   * 真实的 IncomingMessage 里，'data'/'end' 在监听器注册完成之后才异步触发。
   * parseBody 在同一个同步块里依次注册 'data' 和 'end'，所以这里等到 'end'
   * 的监听器被注册（即 parseBody 已经挂完所有监听）再投递数据，
   * 否则同步 emit 的 'end' 会先于尚未注册的 'data' 触发，body 直接丢失。
   */
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

/**
 * 为破坏性操作领取挑战并返回签名请求头。
 * 与 dsh-apply.test.js 同款：挑战池用真实实现，因此能覆盖
 * "binding 必须一致、nonce 只能用一次"这些契约。
 */
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
  const token = adminSessionStore.create(ADMIN_ADDR, 3600_000)
  return `admin_session=${token}`
}

const json = (res) => JSON.parse(res.body)

beforeEach(() => {
  vi.restoreAllMocks()
  isAdmin.mockReturnValue(true)
  adminSessionStore.sessions = {}
  userService.state.swtcUsers = {}

  vi.spyOn(dshVersionService, 'getVersions').mockResolvedValue({
    ok: true,
    latest: '0.1.5-rc.1',
    tags: { latest: '0.1.5-rc.1' },
    stable: ['0.1.5'],
    prerelease: ['0.1.5-rc.1', '0.1.6-alpha.1'],
    all: ['0.1.5', '0.1.5-rc.1', '0.1.6-alpha.1'],
    fetchedAt: Date.now(),
    stale: false,
  })
  vi.spyOn(dshVersionService, 'isInstallable').mockResolvedValue({ ok: true })
  vi.spyOn(dshVersionService, 'clearCache').mockImplementation(() => {})

  dockerService.imageId.mockResolvedValue('sha256:current')
  dockerService.imageDshVersion.mockResolvedValue('0.1.6-alpha.1')
  dockerService.containerImageId.mockResolvedValue('sha256:current')
  dockerService.buildImage.mockResolvedValue({
    version: '0.1.6-alpha.1',
    imageId: 'sha256:new',
    tag: 'dsh-multitenant:0.1.6-alpha.1',
  })

  // 镜像清单/引用默认为空；个别用例按需覆盖
  dockerService.listImages.mockResolvedValue([])
  dockerService.listReferencedImageIds.mockResolvedValue(new Set())
  dockerService.listContainerImages.mockResolvedValue([])
  dockerService.listLocalVersionTags.mockResolvedValue([])
  dockerService.listUntaggedBySignature.mockResolvedValue(new Set())
  dockerService.listAvailableImages.mockResolvedValue([])
  dockerService.removeImages.mockResolvedValue({ removed: [], failed: [] })

  // 验签依赖 SWTC 密码学 → 用 spy 替掉；挑战池用真实实现（一次性语义要覆盖）
  vi.spyOn(tenantConfigService, 'verifySignature').mockImplementation(
    (addr, message, signature) => signature === `sig:${message}`,
  )

  dataService.getDshImage.mockReturnValue({ current: null, history: [] })
  dataService.saveDshImage.mockReturnValue({})

  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  adminSessionStore.sessions = {}
  userService.state.swtcUsers = {}
})

describe('DSH 版本路由：鉴权', () => {
  const cases = [
    ['GET', '/api/admin/dsh/versions'],
    ['GET', '/api/admin/dsh/status'],
    ['GET', '/api/admin/dsh/image'],
    ['POST', '/api/admin/dsh/image'],
  ]

  for (const [method, url] of cases) {
    it(`${method} ${url} 未登录 → 403`, async () => {
      const res = makeRes()
      await handleAdminRoutes(makeReq({ method, url }), res, url)
      expect(res.statusCode).toBe(403)
    })
  }

  it('非管理员会话 → 403', async () => {
    isAdmin.mockReturnValue(false)
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /api/admin/dsh/versions', () => {
  it('默认折叠预发布', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/versions', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/versions',
    )

    const body = json(res)
    expect(res.statusCode).toBe(200)
    expect(body.latest).toBe('0.1.5-rc.1')
    expect(body.stable).toEqual(['0.1.5'])
    expect(body.prerelease).toEqual([]) // 默认不展开
    expect(body.prereleaseCount).toBe(2) // 但告知有多少个
    expect(body.includePrerelease).toBe(false)
  })

  it('includePrerelease=1 展开预发布', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        url: '/api/admin/dsh/versions?includePrerelease=1',
        cookie: adminCookie(),
      }),
      res,
      '/api/admin/dsh/versions',
    )

    const body = json(res)
    expect(body.prerelease).toEqual(['0.1.5-rc.1', '0.1.6-alpha.1'])
    expect(body.includePrerelease).toBe(true)
  })

  it('registry 不可达 → 503 且带明确 code', async () => {
    dshVersionService.getVersions.mockResolvedValue({ ok: false, error: 'ECONNREFUSED' })

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/versions', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/versions',
    )

    expect(res.statusCode).toBe(503)
    expect(json(res).code).toBe('REGISTRY_UNAVAILABLE')
    expect(json(res).error).toMatch(/ECONNREFUSED/)
  })

  it('缓存过期（stale）时透出 stale:true', async () => {
    dshVersionService.getVersions.mockResolvedValue({
      ok: true,
      latest: '0.1.5-rc.1',
      tags: {},
      stable: [],
      prerelease: [],
      all: [],
      fetchedAt: 1,
      stale: true,
    })

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/versions', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/versions',
    )

    expect(json(res).stale).toBe(true)
  })
})

describe('GET /api/admin/dsh/status', () => {
  it('镜像一致 → 无 stale 租户', async () => {
    userService.state.swtcUsers[TENANT] = { containerStatus: 'running' }
    dockerService.containerImageId.mockResolvedValue('sha256:current')

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    const body = json(res)
    expect(res.statusCode).toBe(200)
    expect(body.currentImageId).toBe('sha256:current')
    expect(body.currentImageVersion).toBe('0.1.6-alpha.1')
    expect(body.staleTenants).toBe(0)
  })

  it('容器仍引用旧镜像 → 标记 stale（镜像升级对已有容器无效）', async () => {
    userService.state.swtcUsers[TENANT] = { containerStatus: 'running' }
    dockerService.containerImageId.mockResolvedValue('sha256:OLD')

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    const body = json(res)
    expect(body.staleTenants).toBe(1)
    expect(body.tenants[0]).toMatchObject({
      address: TENANT,
      containerImageId: 'sha256:OLD',
      stale: true,
    })
    // 必须把这个语义明确告知前端，避免"升级成功但租户没变"被误判为故障
    expect(body.note).toMatch(/重建容器/)
  })

  // 回归：表格列头写的是「版本」，单元格却渲染成"待更新/已最新"徽章 →
  // 管理员根本看不到租户在跑哪个版本。这里锁定后端必须把版本发出来。
  it('每个租户带上容器实际 DSH 版本（供表格显示）', async () => {
    userService.state.swtcUsers[TENANT] = { containerStatus: 'running' }
    dockerService.containerImageId.mockResolvedValue('sha256:current')
    dockerService.containerDshVersion.mockResolvedValue('0.1.5-rc.1')

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    expect(json(res).tenants[0].dshVersion).toBe('0.1.5-rc.1')
  })

  it('容器读不到版本 → 退回创建时记录值，而不是报错/空白', async () => {
    userService.state.swtcUsers[TENANT] = {
      containerStatus: 'stopped',
      baseImageVersion: '0.1.1-rc.1',
    }
    dockerService.containerImageId.mockResolvedValue('sha256:OLD')
    dockerService.containerDshVersion.mockResolvedValue(null)

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    expect(json(res).tenants[0].dshVersion).toBe('0.1.1-rc.1')
  })

  it('destroyed 租户不计入（无容器可比对）', async () => {
    userService.state.swtcUsers[TENANT] = { containerStatus: 'destroyed' }

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    expect(json(res).tenants).toHaveLength(0)
    expect(dockerService.containerImageId).not.toHaveBeenCalled()
  })

  // ---- 镜像版本落后判定（"当前镜像版本没显示出来"的回归覆盖）----

  it('镜像版本落后于最新 → behind:true（界面据此提示升级）', async () => {
    // 现役镜像 0.1.6-alpha.1，registry 最新 0.1.5-rc.1 之外的场景
    dshVersionService.getVersions.mockResolvedValue({
      ok: true,
      latest: '0.1.9',
      fetchedAt: Date.now(),
    })

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    expect(json(res).upgrade).toMatchObject({ latest: '0.1.9', behind: true })
  })

  it('镜像已是最新 → behind:false', async () => {
    dockerService.imageDshVersion.mockResolvedValue('0.1.5-rc.1')

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    expect(json(res).upgrade).toMatchObject({ latest: '0.1.5-rc.1', behind: false })
  })

  it('只读缓存：调用 compareOnly，不触发联网拉取', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    // /status 必须快：只能读缓存，不能因为对比版本去打 registry
    expect(dshVersionService.getVersions).toHaveBeenCalledWith({ compareOnly: true })
  })

  it('缓存未加载 → upgrade 说明原因，而不是假装已最新', async () => {
    dshVersionService.getVersions.mockResolvedValue({ ok: false, notLoaded: true })

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    const body = json(res)
    expect(body.upgrade.behind).toBeNull()
    expect(body.upgrade.notLoaded).toBe(true)
    expect(body.upgrade.reason).toMatch(/尚未加载/)
  })

  it('镜像版本读不到 → 不做版本对比（避免误报"已最新"）', async () => {
    dockerService.imageDshVersion.mockResolvedValue(null)

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    const body = json(res)
    expect(body.currentImageVersion).toBeNull()
    expect(body.upgrade).toBeNull() // 读不到版本就不给结论
    expect(dshVersionService.getVersions).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/dsh/image', () => {
  it('缺少 version → 400', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ method: 'POST', url: '/api/admin/dsh/image', cookie: adminCookie(), body: {} }),
      res,
      '/api/admin/dsh/image',
    )

    expect(res.statusCode).toBe(400)
    expect(json(res).error).toMatch(/version/)
  })

  it('版本不可安装 → 400，且不触发构建', async () => {
    dshVersionService.isInstallable.mockResolvedValue({
      ok: false,
      error: 'registry 上不存在该版本: 9.9.9',
    })

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/image',
        cookie: adminCookie(),
        body: { version: '9.9.9' },
      }),
      res,
      '/api/admin/dsh/image',
    )

    expect(res.statusCode).toBe(400)
    expect(json(res).error).toMatch(/不存在/)
    expect(dockerService.buildImage).not.toHaveBeenCalled()
  })

  it('构建上下文缺 Dockerfile → 400（立即失败，不留悬挂任务）', async () => {
    const saved = CONFIG.dsh.buildContext
    CONFIG.dsh.buildContext = '/definitely/not/a/real/dir'

    try {
      const res = makeRes()
      await handleAdminRoutes(
        makeReq({
          method: 'POST',
          url: '/api/admin/dsh/image',
          cookie: adminCookie(),
          body: { version: '0.1.6-alpha.1' },
        }),
        res,
        '/api/admin/dsh/image',
      )

      expect(res.statusCode).toBe(400)
      expect(json(res).error).toMatch(/Dockerfile/)
      expect(dockerService.buildImage).not.toHaveBeenCalled()
    } finally {
      CONFIG.dsh.buildContext = saved
    }
  })

  it('成功 → 202 立即返回（构建在后台跑，不占 HTTP 请求）', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/image',
        cookie: adminCookie(),
        body: { version: '0.1.6-alpha.1' },
      }),
      res,
      '/api/admin/dsh/image',
    )

    expect(res.statusCode).toBe(202)
    expect(json(res).started).toBe(true)
    expect(json(res).version).toBe('0.1.6-alpha.1')
    expect(dockerService.buildImage).toHaveBeenCalledWith(
      '0.1.6-alpha.1',
      expect.objectContaining({ context: expect.any(String) }),
    )
  })

  it('refreshVersions 会清缓存（强制重拉 registry）', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/image',
        cookie: adminCookie(),
        body: { version: '0.1.6-alpha.1', refreshVersions: true },
      }),
      res,
      '/api/admin/dsh/image',
    )

    expect(dshVersionService.clearCache).toHaveBeenCalled()
  })
})
// ---------------------------------------------------------------------------
// 版本历史：标出镜像是否仍在本地 + 判定可清理项
//
// 背景：同一版本可被构建多次（每次都产生新镜像 ID，tag 只有一个 → 后来覆盖先前），
// 历史却把每次构建都留着。不标"是否在本地"，管理员会以为多条同版本记录都能回滚。
// ---------------------------------------------------------------------------
describe('GET /api/admin/dsh/status：版本历史标志位', () => {
  const HISTORY = [
    { version: '0.1.5-rc.1', imageId: 'sha256:old1', tag: null, at: 1000, by: 'a' },
    { version: '0.1.5-rc.1', imageId: 'sha256:old2', tag: null, at: 2000, by: 'a' },
    { version: '0.1.5-rc.1', imageId: 'sha256:underTag', tag: 'x', at: 3000, by: 'a' },
    { version: '0.1.5-rc.1', imageId: 'sha256:inUse', tag: null, at: 4000, by: 'a' },
  ]

  const localImages = [
    {
      id: 'old1XXXXXXXX',
      repository: 'dsh-multitenant',
      tag: '<none>',
      sizeBytes: 1024 ** 3,
      createdAt: '',
    },
    {
      id: 'underTagYYYY',
      repository: 'dsh-multitenant',
      tag: '0.1.5-rc.1',
      sizeBytes: 1024 ** 3,
      createdAt: '',
    },
    {
      id: 'inUseZZZZZZZ',
      repository: 'dsh-multitenant',
      tag: '<none>',
      sizeBytes: 1024 ** 3,
      createdAt: '',
    },
    // old2 故意不在本地 → 应标 present=false
  ]

  it('在本地 / 不在本地 标记正确，并给出体积', async () => {
    dataService.getDshImage.mockReturnValue({ current: null, history: HISTORY })
    dockerService.listImages.mockResolvedValue(localImages)

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    const h = json(res).history
    expect(h.find((x) => x.imageId === 'sha256:old1').present).toBe(true)
    expect(h.find((x) => x.imageId === 'sha256:old1').sizeBytes).toBe(1024 ** 3)
    expect(h.find((x) => x.imageId === 'sha256:old2').present).toBe(false)
    expect(h.find((x) => x.imageId === 'sha256:old2').reason).toBe('not_local')
    expect(h.find((x) => x.imageId === 'sha256:old2').sizeBytes).toBe(0)
  })

  it('removable = 在本地 + 非当前 + 无容器引用（带 tag 也可清理）', async () => {
    dataService.getDshImage.mockReturnValue({ current: null, history: HISTORY })
    dockerService.listImages.mockResolvedValue(localImages)
    // inUse 被某容器引用
    dockerService.listContainerImages.mockResolvedValue([
      { name: 'tenant-x', state: 'exited', imageId: 'sha256:inUseZZZZZZZ' },
    ])

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    const h = json(res).history
    expect(h.find((x) => x.imageId === 'sha256:old1').removable).toBe(true)
    expect(h.find((x) => x.imageId === 'sha256:old2').removable).toBe(false) // 不在本地
    // 带 tag 的旧版本同样可清理（判定与 /images 清理面板统一）
    expect(h.find((x) => x.imageId === 'sha256:underTag').removable).toBe(true)
    expect(h.find((x) => x.imageId === 'sha256:inUse').removable).toBe(false) // 有容器在用
    expect(h.find((x) => x.imageId === 'sha256:inUse').reason).toBe('in_use')
  })

  it('current 指向的镜像绝不 removable', async () => {
    dataService.getDshImage.mockReturnValue({
      current: { version: '0.1.5-rc.1', imageId: 'sha256:old1' },
      history: HISTORY,
    })
    dockerService.imageId.mockResolvedValue('sha256:old1')
    dockerService.listImages.mockResolvedValue(localImages)

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    const entry = json(res).history.find((x) => x.imageId === 'sha256:old1')
    expect(entry.removable).toBe(false)
    expect(entry.reason).toBe('current')
  })

  it('拿不到容器引用集合时保守处理：一律不允许清理', async () => {
    dataService.getDshImage.mockReturnValue({ current: null, history: HISTORY })
    dockerService.listImages.mockResolvedValue(localImages)
    dockerService.listContainerImages.mockRejectedValue(new Error('docker 挂了'))

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/status', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/status',
    )

    expect(json(res).history.every((x) => x.removable === false)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// POST /api/admin/dsh/images/prune：清理悬空镜像
//
// 这是破坏性操作，必须走管理端签名；且服务端逐项重新校验，
// 绝不使用 docker image prune（这台机器上还有别的项目的镜像）。
// ---------------------------------------------------------------------------
describe('镜像清理路由', () => {
  const LOCAL = [
    {
      id: 'aaaa11112222',
      repository: 'dsh-multitenant',
      tag: '<none>',
      sizeBytes: 1024 ** 3,
      createdAt: '',
    },
    {
      id: 'bbbb11112222',
      repository: 'dsh-multitenant',
      tag: '0.1.5-rc.1',
      sizeBytes: 1024 ** 3,
      createdAt: '',
    },
    {
      id: 'cccc11112222',
      repository: 'dsh-multitenant',
      tag: '<none>',
      sizeBytes: 1024 ** 3,
      createdAt: '',
    },
    {
      id: 'dddd11112222',
      repository: 'other-project',
      tag: '<none>',
      sizeBytes: 1024 ** 3,
      createdAt: '',
    },
  ]

  it('未登录 → 403', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/images/prune',
        body: { ids: ['aaaa11112222'] },
      }),
      res,
      '/api/admin/dsh/images/prune',
    )
    expect(res.statusCode).toBe(403)
  })

  it('已登录但**无签名** → 403 SIGNATURE_REQUIRED（破坏性操作必须当场签名）', async () => {
    dockerService.listImages.mockResolvedValue(LOCAL)

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/images/prune',
        cookie: adminCookie(),
        body: { ids: ['aaaa11112222'] },
      }),
      res,
      '/api/admin/dsh/images/prune',
    )

    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_REQUIRED')
    expect(dockerService.removeImages).not.toHaveBeenCalled()
  })

  it('签的是 A、传的是 B → 拒绝（绑定串必须一致）', async () => {
    dockerService.listImages.mockResolvedValue(LOCAL)
    // 针对 aaaa 签名，却提交删 cccc
    const headers = await adminSignatureHeaders('dsh/prune-images', {
      ids: ['aaaa11112222'],
    })

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/images/prune',
        cookie: adminCookie(),
        body: { ids: ['cccc11112222'] },
        headers,
      }),
      res,
      '/api/admin/dsh/images/prune',
    )

    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_MISMATCH')
    expect(dockerService.removeImages).not.toHaveBeenCalled()
  })

  it('缺 ids → 400（强制显式列表，避免"删全部"的扩大解释）', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/images/prune',
        cookie: adminCookie(),
        body: {},
      }),
      res,
      '/api/admin/dsh/images/prune',
    )
    expect(res.statusCode).toBe(400)
  })

  it('带 tag / 在用 / 非本项目 的镜像一律跳过，只删悬空的', async () => {
    dockerService.listImages.mockResolvedValue(LOCAL)
    dockerService.listContainerImages.mockResolvedValue([
      { name: 'some-tenant', state: 'exited', imageId: 'sha256:cccc11112222' },
    ])
    dockerService.removeImages.mockResolvedValue({ removed: ['aaaa11112222'], failed: [] })

    const ids = ['aaaa11112222', 'bbbb11112222', 'cccc11112222', 'dddd11112222']
    // binding 里签的就是这份 ids 列表
    const headers = await adminSignatureHeaders('dsh/prune-images', { ids })
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/images/prune',
        cookie: adminCookie(),
        body: { ids },
        headers,
      }),
      res,
      '/api/admin/dsh/images/prune',
    )

    // 只把安全的那一个交给删除
    // 悬空的 aaaa 与带 tag 的 bbbb 都可删（旧 tag 同样占 1.2GB）
    expect(dockerService.removeImages).toHaveBeenCalledWith(['aaaa11112222', 'bbbb11112222'])
    const body = json(res)
    expect(body.removed).toEqual(['aaaa11112222'])
    expect(body.skipped.map((x) => x.reason).sort()).toEqual([
      'in_use_by_container',
      'not_found_or_not_ours',
    ])
    // 必须能看见"谁在用"，否则管理员不知道下一步怎么办
    expect(body.skipped.find((x) => x.reason === 'in_use_by_container').usedBy[0]).toContain(
      'some-tenant',
    )
  })

  it('current 指向的镜像不会被删', async () => {
    dockerService.listImages.mockResolvedValue(LOCAL)
    dockerService.listReferencedImageIds.mockResolvedValue(new Set())
    dataService.getDshImage.mockReturnValue({
      current: { version: '0.1.5-rc.1', imageId: 'aaaa11112222' },
      history: [],
    })
    dockerService.imageId.mockResolvedValue('aaaa11112222')

    const headers = await adminSignatureHeaders('dsh/prune-images', {
      ids: ['aaaa11112222'],
    })
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/images/prune',
        cookie: adminCookie(),
        body: { ids: ['aaaa11112222'] },
        headers,
      }),
      res,
      '/api/admin/dsh/images/prune',
    )

    expect(dockerService.removeImages).not.toHaveBeenCalled()
    expect(json(res).skipped[0].reason).toBe('current')
  })

  it('镜像清单拿不到时保守处理：直接失败，绝不猜着删', async () => {
    // 拿不到清单就无法校验，宁可报错也不删
    dockerService.listImages.mockRejectedValue(new Error('docker 挂了'))

    const headers = await adminSignatureHeaders('dsh/prune-images', {
      ids: ['aaaa11112222'],
    })
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/images/prune',
        cookie: adminCookie(),
        body: { ids: ['aaaa11112222'] },
        headers,
      }),
      res,
      '/api/admin/dsh/images/prune',
    )

    expect(dockerService.removeImages).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(500)
  })

  it('容器信息拿不到时保守处理：报 info_incomplete 且不删', async () => {
    dockerService.listImages.mockResolvedValue(LOCAL)
    dockerService.listContainerImages.mockRejectedValue(new Error('docker 挂了'))

    const ids = ['aaaa11112222']
    const headers = await adminSignatureHeaders('dsh/prune-images', { ids })
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/images/prune',
        cookie: adminCookie(),
        body: { ids },
        headers,
      }),
      res,
      '/api/admin/dsh/images/prune',
    )

    expect(dockerService.removeImages).not.toHaveBeenCalled()
    // 信息不全 → 当作"在用"，且如实告诉管理员是信息不全而不是真的在用
    expect(json(res).skipped[0].reason).toBe('info_incomplete')
  })
})

// ---------------------------------------------------------------------------
// GET /api/admin/dsh/images：悬空镜像的归属判定
//
// 真实 bug（实测发现）：镜像被 untag 后 `docker images` 的 Repository 变成
// `<none>` —— 而那正是要清理的悬空构建。早期只按 `repository === 'dsh-multitenant'`
// 过滤，导致"可清理项"永远是 0，功能完全失效。
// 必须用平台构建历史里的镜像 ID 来认领自己人。
// ---------------------------------------------------------------------------
describe('GET /api/admin/dsh/images：悬空镜像归属', () => {
  it('无 tag、Repository=<none>、但在平台历史里的镜像 → 可清理', async () => {
    dockerService.listImages.mockResolvedValue([
      {
        id: 'aaaa11112222',
        repository: '<none>',
        tag: '<none>',
        sizeBytes: 5 * 1024 ** 2,
        createdAt: '',
      },
    ])
    dataService.getDshImage.mockReturnValue({
      current: { version: '0.1.1-rc.2', imageId: 'sha256:other' },
      history: [{ version: '0.1.5-rc.1', imageId: 'sha256:aaaa11112222', at: 1, by: 'x' }],
    })
    dockerService.listContainerImages.mockResolvedValue([])

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/images', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/images',
    )

    const body = json(res)
    expect(body.items).toHaveLength(1)
    expect(body.removableCount).toBe(1)
    expect(body.removableBytes).toBe(5 * 1024 ** 2)
  })

  it('别项目的悬空镜像绝不被认领（哪怕同样没有 tag）', async () => {
    dockerService.listImages.mockResolvedValue([
      {
        id: 'ffff99998888',
        repository: '<none>',
        tag: '<none>',
        sizeBytes: 1024 ** 3,
        createdAt: '',
      },
    ])
    // 历史里没有这个 ID
    dataService.getDshImage.mockReturnValue({
      current: { version: '0.1.1-rc.2', imageId: 'sha256:other' },
      history: [],
    })

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/images', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/images',
    )

    expect(json(res).items).toHaveLength(0)
    expect(json(res).removableCount).toBe(0)
  })

  it('带本项目 tag 的镜像（仓库名可辨）仍被纳入，且不可清理', async () => {
    dockerService.listImages.mockResolvedValue([
      {
        id: 'bbbb11112222',
        repository: 'dsh-multitenant',
        tag: '0.1.1-rc.1',
        sizeBytes: 1024 ** 3,
        createdAt: '',
      },
    ])
    dataService.getDshImage.mockReturnValue({ current: null, history: [] })

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/images', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/images',
    )

    const body = json(res)
    expect(body.items).toHaveLength(1)
    // 带 tag 的旧版本现在也可清理（旧 tag 一样占 1.2GB）
    expect(body.items[0].removable).toBe(true)
    expect(body.removableCount).toBe(1)
    expect(body.taggedCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// GET /api/admin/dsh/versions：本地已构建版本的标记
//
// 管理页要分两层看：远端有哪些版本 vs 本地手上已有哪些版本。
// 缺了后者，管理员无法回答"这个版本我是不是已经建过、能直接拿去回滚"。
// ---------------------------------------------------------------------------
describe('GET /api/admin/dsh/versions：本地版本标记', () => {
  it('标出每个远端版本是否已在本地构建，并给出本地版本清单', async () => {
    dockerService.listLocalVersionTags.mockResolvedValue([
      { tag: 'dsh-multitenant:0.1.5', version: '0.1.5', imageId: 'aaa', createdAt: '' },
      { tag: 'dsh-multitenant:latest', version: 'latest', imageId: 'bbb', createdAt: '' },
    ])
    dataService.getDshImage.mockReturnValue({
      current: { version: '0.1.5', imageId: 'bbb' },
      history: [],
    })

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/versions?includePrerelease=1', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/versions',
    )

    const body = json(res)
    // latest 是移动标签，不算"某个具体版本已在本地"
    expect(body.localVersions).toEqual(['0.1.5'])
    const stable = body.stableLocal.find((x) => x.version === '0.1.5')
    expect(stable.local).toBe(true)
    const notBuilt = body.stableLocal.find((x) => x.version !== '0.1.5')
    if (notBuilt) expect(notBuilt.local).toBe(false)
    expect(body.currentVersion).toBe('0.1.5')
    // 预发布也要带上同样的标记
    expect(body.prereleaseLocal.length).toBe(body.prerelease.length)
  })

  it('本地一个都没有时，全部标为未构建（不报错）', async () => {
    dockerService.listLocalVersionTags.mockResolvedValue([])
    dataService.getDshImage.mockReturnValue({ current: null, history: [] })

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/versions', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/versions',
    )

    const body = json(res)
    expect(body.localVersions).toEqual([])
    expect(body.stableLocal.every((x) => x.local === false)).toBe(true)
    expect(body.prereleaseLocal).toEqual([]) // 默认折叠
  })
})

// ---------------------------------------------------------------------------
// 本地版本标记的两个真实坑（都实测踩到过）
// ---------------------------------------------------------------------------
describe('GET /api/admin/dsh/versions：本地标记的正确性', () => {
  it('短 ID 与完整 sha256 也能匹配出"当前"（docker 给短 ID，平台存完整 ID）', async () => {
    dockerService.listLocalVersionTags.mockResolvedValue([
      { tag: 'dsh-multitenant:0.1.5', version: '0.1.5', imageId: '08aa5694d305', createdAt: '' },
    ])
    dataService.getDshImage.mockReturnValue({
      current: {
        version: '0.1.5',
        imageId: 'sha256:08aa5694d30556d40292fabe5a1bbde8b3e015b3fd2acd6bdf31a4a6dad2c24e',
      },
      history: [],
    })
    dockerService.listImages.mockResolvedValue([
      {
        id: '08aa5694d305',
        repository: 'dsh-multitenant',
        tag: '0.1.5',
        sizeBytes: 1,
        createdAt: '',
      },
    ])

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/versions', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/versions',
    )

    expect(json(res).localTags[0].isCurrent).toBe(true)
  })

  it('旧构建已被 untag 但仍留在本地时，该版本仍算"已构建"（tag 挪走不等于镜像消失）', async () => {
    // docker image ls 只看到最新 tag，旧版本没了 tag
    dockerService.listLocalVersionTags.mockResolvedValue([
      { tag: 'dsh-multitenant:0.1.6', version: '0.1.6', imageId: 'newnewnewnew', createdAt: '' },
    ])
    dataService.getDshImage.mockReturnValue({
      current: { version: '0.1.6', imageId: 'sha256:newnewnewnew' },
      history: [
        { version: '0.1.5', imageId: 'sha256:oldoldoldold', at: 1, by: 'x' },
        { version: '0.1.4', imageId: 'sha256:gonegonegone', at: 1, by: 'x' },
      ],
    })
    // 0.1.5 的悬空镜像还在本地；0.1.4 的已被清掉
    dockerService.listImages.mockResolvedValue([
      { id: 'oldoldoldold', repository: '<none>', tag: '<none>', sizeBytes: 1, createdAt: '' },
    ])

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/versions', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/versions',
    )

    const body = json(res)
    expect(body.localVersions).toContain('0.1.5')
    expect(body.localVersions).not.toContain('0.1.4')
    expect(body.localVersions).toContain('0.1.6')
  })
})

// ---------------------------------------------------------------------------
// 未记录的自家悬空构建（构建中途失败 / 手工 docker build 的产物）
//
// 只靠平台历史认领会把它们当"别人的镜像"而永远清不掉（实测踩到过一个 843MB 的）。
// ---------------------------------------------------------------------------
describe('镜像归属：靠 Dockerfile 签名补认未记录的悬空构建', () => {
  it('无 tag、不在历史里，但签名命中 → 纳入并可清理', async () => {
    dataService.getDshImage.mockReturnValue({ current: null, history: [] })
    dockerService.listImages.mockResolvedValue([
      {
        id: '90d4ec8122ed',
        repository: '<none>',
        tag: '<none>',
        sizeBytes: 843 * 1024 ** 2,
        createdAt: '',
      },
    ])
    dockerService.listUntaggedBySignature.mockResolvedValue(new Set(['90d4ec8122ed']))
    dockerService.listContainerImages.mockResolvedValue([])

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/images', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/images',
    )

    const body = json(res)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].removable).toBe(true)
    expect(body.removableCount).toBe(1)
  })

  it('签名没命中（别人的悬空镜像）→ 绝不纳入、绝不删', async () => {
    dataService.getDshImage.mockReturnValue({ current: null, history: [] })
    dockerService.listImages.mockResolvedValue([
      { id: 'someoneelse1', repository: '<none>', tag: '<none>', sizeBytes: 1024, createdAt: '' },
    ])
    dockerService.listUntaggedBySignature.mockResolvedValue(new Set())
    dockerService.listContainerImages.mockResolvedValue([])

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/images', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/images',
    )

    expect(json(res).items).toHaveLength(0)
  })

  it('签名认领失败时不报错，只是少认几个（不误删）', async () => {
    dataService.getDshImage.mockReturnValue({ current: null, history: [] })
    dockerService.listImages.mockResolvedValue([
      { id: 'aaaabbbbcccc', repository: '<none>', tag: '<none>', sizeBytes: 1024, createdAt: '' },
    ])
    dockerService.listUntaggedBySignature.mockRejectedValue(new Error('inspect 挂了'))
    dockerService.listContainerImages.mockResolvedValue([])

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/images', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/images',
    )

    expect(res.statusCode).toBe(200)
    expect(json(res).items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 租户镜像选择：POST /dsh/apply 的 image 参数
// ---------------------------------------------------------------------------
describe('镜像选择：apply 路由的 image 参数', () => {
  it('image 必须属于本平台仓库（挡住把租户指向任意镜像）', async () => {
    const ids = { address: 'j'.repeat(34), image: 'nginx:alpine' }
    const headers = await adminSignatureHeaders('dsh/apply', ids)
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: ids,
        headers,
      }),
      res,
      '/api/admin/dsh/apply',
    )
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toMatch(/必须属于/)
  })

  it('image 要签进绑定：签 latest、提交别的版本 → 签名不匹配', async () => {
    const address = 'j'.repeat(34)
    // 签的是默认（不钉版本）
    const headers = await adminSignatureHeaders('dsh/apply', { address, image: null })
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: { address, image: 'dsh-multitenant:0.1.0-rc.2' },
        headers,
      }),
      res,
      '/api/admin/dsh/apply',
    )
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_MISMATCH')
  })
})
