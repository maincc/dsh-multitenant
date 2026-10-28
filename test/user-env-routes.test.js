/**
 * 环境模板自助面路由测试（方案③，2026-10-27）
 *
 * 钉死三条契约：
 *   1. 三端点只认会话本人（无会话 401；目标地址恒=会话，无入参面）
 *   2. 供应链闸与 admin 面同口径（published/digest 逐字/镜像缺失 410）
 *   3. 命名避坑：environment/revert **绝不能**被 tenant.routes 的
 *      /api/user/<addr>/reset 删卷端点劫持（断言 resetContainer 零调用）
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    applyImageVersion: vi.fn(),
    resetContainer: vi.fn(),
    state: { swtcUsers: {}, cleanupPolicy: {} },
  },
}))

vi.mock('../src/services/docker.service.js', () => ({
  dockerService: { imageId: vi.fn() },
}))

vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    dataService: {
      ...mod.dataService,
      loadState: vi.fn(() => ({ swtcUsers: {}, nextPort: 31000 })),
      saveState: vi.fn(() => {}),
      loadSessions: vi.fn(() => ({})),
      saveSessions: vi.fn(() => {}),
      loadUserSessions: vi.fn(() => ({})),
      saveUserSessions: vi.fn(() => ({})),
      loadCwtRegistry: vi.fn(() => ({})),
      readStateFile: vi.fn(() => null),
      logOperation: vi.fn(() => Promise.resolve()),
    },
  }
})

vi.mock('../src/services/credential.service.js', () => ({
  credentialService: { isAdmSync: vi.fn(() => false) },
}))

// 限流计数跨用例累积会误伤本文件的语义断言（429 不是被测契约）；
// envapply 限流本身有中间件自己的套件负责
vi.mock('../src/middleware/rate-limit.middleware.js', () => ({
  rateLimit: vi.fn(() => true),
}))

import { handleUserRoutes } from '../src/routes/user.routes.js'
import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { dataService } from '../src/services/data.service.js'
import { userSessionStore } from '../src/middleware/user-auth.middleware.js'

const USER = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'
const TPL = 'dsh-multitenant:env-aaaaaaaa-stock-20261027120000'

function makeReq({ method = 'GET', url = '/', cookie = '', body } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8090', cookie },
    socket: { remoteAddress: '127.0.0.1' },
    _body: body,
    on(ev, cb) {
      if (ev === 'data' && this._body !== undefined) cb(JSON.stringify(this._body))
      if (ev === 'end') cb()
      return this
    },
  }
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

const json = (res) => JSON.parse(res.body)

async function call(path, { method = 'GET', body, cookie = true } = {}) {
  const res = makeRes()
  await handleUserRoutes(
    makeReq({ method, url: path, body, cookie: cookie ? `user_session=${token}` : '' }),
    res,
    path,
  )
  return res
}

let token

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  token = userSessionStore.create(USER)
  globalThis.__envStore = new Map()
  dataService.listEnvironments = vi.fn(async () => [...globalThis.__envStore.values()])
  dataService.getEnvironment = vi.fn(async (id) => globalThis.__envStore.get(id) || null)
  dataService.patchEnvironment = vi.fn(async (id, set) => {
    const d = globalThis.__envStore.get(id)
    if (!d) return null
    Object.assign(d, set)
    return { ...d }
  })
  dockerService.imageId.mockResolvedValue('sha256:abc123')
  userService.applyImageVersion.mockResolvedValue({ applied: true })
})

afterEach(() => {
  userSessionStore.sessions = {}
  userService.state.swtcUsers = {}
})

function seed(over = {}) {
  globalThis.__envStore.set(TPL, {
    _id: TPL,
    sourceAddr: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    slug: 'stock',
    imageId: 'sha256:abc123',
    dshVersion: '0.1.5',
    sizeBytes: 1234,
    scrubbed: true,
    status: 'published',
    pinnedBy: [],
    createdAt: '2026-10-27T12:00:00.000Z',
    ...over,
  })
}

describe('GET /api/user/environments', () => {
  it('无会话 → 401；有 user_session → 只列 published + 我当前来源', async () => {
    let res = await call('/api/user/environments', { cookie: false })
    expect(res.statusCode).toBe(401)

    seed()
    globalThis.__envStore.set('draft-one', { _id: 'd', status: 'draft' })
    globalThis.__envStore.set('revo-one', { _id: 'r', status: 'revoked' })
    userService.state.swtcUsers[USER] = { pinnedImage: TPL }
    res = await call('/api/user/environments')
    expect(res.statusCode).toBe(200)
    const body = json(res)
    expect(body.environments.length).toBe(1) // draft/revoked 不进选用面
    expect(body.environments[0].id).toBe(TPL)
    expect(body.environments[0].manifest).toBeUndefined() // 审核证据不外露
    expect(body.yourCurrent.fromTemplate.slug).toBe('stock')
  })

  it('pin 的是版本镜像（非模板）→ fromTemplate 如实标 null', async () => {
    userService.state.swtcUsers[USER] = { pinnedImage: 'dsh-multitenant:0.2.0' }
    const body = json(await call('/api/user/environments'))
    expect(body.yourCurrent.image).toBe('dsh-multitenant:0.2.0')
    expect(body.yourCurrent.fromTemplate).toBe(null)
  })
})

describe('POST /api/user/environment/apply', () => {
  it('无会话 401；不传目标地址入参——作用面恒为会话本人', async () => {
    seed()
    let res = await call('/api/user/environment/apply', {
      method: 'POST',
      body: { id: TPL },
      cookie: false,
    })
    expect(res.statusCode).toBe(401)
    res = await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(200)
    expect(userService.applyImageVersion).toHaveBeenCalledWith(USER, { image: TPL, dryRun: false })
  })

  it('draft/revoked → 409（审核闸同一张面孔）', async () => {
    seed({ status: 'draft' })
    let res = await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(409)
    seed({ status: 'revoked' })
    res = await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(409)
    expect(userService.applyImageVersion).not.toHaveBeenCalled()
  })

  it('同名覆盖 digest 不符 → 409；镜像消失 → 410', async () => {
    seed()
    dockerService.imageId.mockResolvedValue('sha256:EVIL')
    let res = await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(409)
    dockerService.imageId.mockResolvedValue(null)
    res = await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(410)
  })

  it('dryRun 不记账不审计；正式执行 pinnedBy 记名 + env_apply_self 留痕', async () => {
    seed()
    await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL, dryRun: true } })
    expect(globalThis.__envStore.get(TPL).pinnedBy).toEqual([])
    expect(dataService.logOperation).not.toHaveBeenCalled()

    await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(globalThis.__envStore.get(TPL).pinnedBy).toContain(USER)
    expect(dataService.logOperation).toHaveBeenCalledWith(
      'env_apply_self',
      expect.objectContaining({ id: TPL, address: USER, operator: USER }),
    )
  })
})

describe('POST /api/user/environment/revert（回平台默认）', () => {
  it('走 applyImageVersion(image=null) + 清引用账本 + 审计', async () => {
    seed({ pinnedBy: [USER] })
    const res = await call('/api/user/environment/revert', { method: 'POST', body: {} })
    expect(res.statusCode).toBe(200)
    expect(userService.applyImageVersion).toHaveBeenCalledWith(USER, { image: null, dryRun: false })
    expect(globalThis.__envStore.get(TPL).pinnedBy).not.toContain(USER)
    expect(dataService.logOperation).toHaveBeenCalledWith(
      'env_reset_self',
      expect.objectContaining({ address: USER }),
    )
  })

  it('命名防劫持钉：revert 绝不落入删卷重建（resetContainer 零调用）', async () => {
    const res = await call('/api/user/environment/revert', { method: 'POST', body: {} })
    expect(res.statusCode).toBe(200)
    expect(userService.resetContainer).not.toHaveBeenCalled()
  })
})
