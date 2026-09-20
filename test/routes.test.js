/**
 * 路由分发回归测试
 *
 * 覆盖本次修复的三个问题：
 *   1. user.routes.js 详情分支不应拦截 /api/user/:address/remove
 *      （修复前返回 400 "Invalid SWTC address"，但删除实际已执行）
 *   2. tenant.routes.js 的 remove / restart 应把 NotFoundError 映射为 404
 *      （修复前 restart 对不存在容器返回 500）
 *   3. admin.routes.js 的 promote 无权限时应返回 true（已处理），
 *      避免 fallthrough 到 SPA fallback 触发 ERR_HTTP_HEADERS_SENT
 *
 * 通过 vi.mock 替换 userService，避免触碰 Docker 与真实 state.json。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { adminSessionStore } from '../src/middleware/auth.middleware.js'

// 有效管理员会话（P0-1：会话 = 服务端随机 token，Cookie 值不再是地址）
const ADMIN_TOKEN = '11'.repeat(32) // 64 位 hex
const sha256 = (v) => createHash('sha256').update(v).digest('hex')

// 全局注入有效会话（内存），所有依赖 admin_session 的用例默认可用
beforeEach(() => {
  adminSessionStore.sessions[sha256(ADMIN_TOKEN)] = {
    address: 'jndwretndumoqbt2uauclmfmx7xbqjykva',
    expiresAt: Date.now() + 3600e3,
  }
})

/**
 * 挑战与验签的 mock（真实实现依赖 SWTC 密码学；这里只关心编排）。
 * `consumeChallenge` 模拟真实的一次性语义：只有发放过的 nonce 能通过一次。
 */
const issuedChallenges = new Set()
function mockChallengeFlow() {
  issuedChallenges.clear()
  tenantConfigService.issueChallenge.mockImplementation((addr) => {
    const nonce = `nonce-${addr}-${issuedChallenges.size}`
    issuedChallenges.add(nonce)
    return nonce
  })
  tenantConfigService.consumeChallenge.mockImplementation((addr, nonce) => {
    if (!issuedChallenges.has(nonce)) return false
    issuedChallenges.delete(nonce)
    return true
  })
  // 真实实现校验"nonce 签名有效 且 公钥推导地址 === 声称地址"；mock 只认本测试的格式
  tenantConfigService.verifySignature.mockImplementation(
    (addr, message, signature) => signature === `sig:${message}`,
  )
}

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    destroyContainer: vi.fn(),
    restartContainer: vi.fn(),
    resetContainer: vi.fn(),
    getUserInfo: vi.fn(),
    getAllUsers: vi.fn(),
    state: { swtcUsers: {} },
  },
}))

vi.mock('../src/services/tenant-config.service.js', () => ({
  tenantConfigService: {
    issueChallenge: vi.fn(),
    consumeChallenge: vi.fn(),
    verifySignature: vi.fn(),
    configure: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(),
    discoverWithAuth: vi.fn(),
    normalizeModelConfig: vi.fn(),
  },
}))

// 数据层默认走真实实现，但把「会话/状态 load/save」全部替换为内存空 + 落空：
// 避免测试写入真实 data/（state.json、user-sessions.json、admin sessions），
// 同时保留 loadCwt* 等只读方法的行为（routes.test.js 不涉及 CWT 用例，空值即可）
vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const mod = await importOriginal()
  const empty = {
    loadSessions: vi.fn(() => ({})),
    loadUserSessions: vi.fn(() => ({})),
    loadCwtRegistry: vi.fn(() => ({})),
    loadCwtApplications: vi.fn(() => []),
    readStateFile: vi.fn(() => null), // migrateLegacy 只读探测，空即可
    saveState: vi.fn(() => {}),
    saveUserSessions: vi.fn(() => {}),
    saveSessions: vi.fn(() => {}),
    saveCwtRegistry: vi.fn(() => {}),
    saveCwtApplications: vi.fn(() => {}),
  }
  return { dataService: { ...mod.dataService, ...empty } }
})

import { handleUserRoutes } from '../src/routes/user.routes.js'
import { handleTenantRoutes } from '../src/routes/tenant.routes.js'
import { handleAdminRoutes } from '../src/routes/admin.routes.js'
import { userSessionStore } from '../src/middleware/user-auth.middleware.js'
import { userService } from '../src/services/user.service.js'
import { tenantConfigService } from '../src/services/tenant-config.service.js'
import { NotFoundError, ForbiddenError } from '../src/utils/errors.js'

const ADMIN_ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva' // 真实 config.json 中的管理员
const TARGET_ADDR = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'

/** 构造最小可用的 mock req（支持 parseBody 的 on('data'/'end')） */
function makeReq({ method = 'GET', url = '/', cookie = '', body, ...extraHeaders } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8090', cookie, ...extraHeaders },
    _body: body,
    on(ev, cb) {
      if (ev === 'data' && this._body !== undefined) cb(JSON.stringify(this._body))
      if (ev === 'end') cb()
      return this
    },
  }
}

/** 构造最小可用的 mock res（记录 writeHead/end，维护 headersSent） */
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
 * 为一次破坏性操作生成有效的签名请求头。
 *
 * 加固后 promote / force-stop / remove / delete-volume / dsh·apply 都要求
 * "当场钱包签名"：挑战先发放（服务端据此记下绑定串），执行时再校验。
 * 这里走真实的挑战→执行流程（只把 tenantConfigService 的验签 mock 掉），
 * 从而覆盖"绑定串一致才放行"这条新契约。
 *
 * @param {{method?:string,url?:string,cookie?:string}} base makeReq 的参数
 * @param {string} operation
 * @param {object} payload
 */
async function makeSignedReq(base, operation, payload) {
  const chalReq = makeReq({
    method: 'POST',
    url: '/api/admin/challenge',
    cookie: base.cookie,
    body: { address: ADMIN_ADDR, operation, payload },
  })
  const chalRes = makeRes()
  await handleAdminRoutes(chalReq, chalRes, '/api/admin/challenge')
  if (chalRes.statusCode !== 200) {
    throw new Error(`挑战发放失败: ${chalRes.statusCode} ${chalRes.body}`)
  }
  const { nonce, message } = JSON.parse(chalRes.body)
  return makeReq({
    ...base,
    body: undefined,
    // 签名材料走请求头（与前端一致）
    'x-admin-nonce': nonce,
    'x-admin-signature': `sig:${message}`,
    'x-admin-pubkey': 'PUBKEY',
  })
}

describe('user.routes.js 详情分支', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('POST /api/user/:address/remove 不应被详情分支拦截（返回 false，不写响应）', async () => {
    // 本用例只验证"详情分支不拦截 /remove"，不进入 handler，因此不需要签名材料
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/remove`,
      cookie: `admin_session=${ADMIN_TOKEN}`,
    })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, `/api/user/${TARGET_ADDR}/remove`)
    expect(handled).toBe(false)
    expect(res.headersSent).toBe(false)
  })

  it('GET /api/user/:address 详情分支仍正常工作（带会话）', async () => {
    userService.getUserInfo.mockResolvedValue({ address: TARGET_ADDR, port: 31001 })
    const req = makeReq({
      method: 'GET',
      url: `/api/user/${TARGET_ADDR}`,
      cookie: `admin_session=${ADMIN_TOKEN}`,
    })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, `/api/user/${TARGET_ADDR}`)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).address).toBe(TARGET_ADDR)
  })

  it('GET /api/user/:address 匿名访问 → 200 脱敏壳（无 port，P1-3 不泄露）', async () => {
    userService.getUserInfo.mockResolvedValue({ address: TARGET_ADDR, port: 31001 })
    const req = makeReq({ method: 'GET', url: `/api/user/${TARGET_ADDR}` })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, `/api/user/${TARGET_ADDR}`)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // 脱敏壳：只有存在性，绝无端口/用量/tier
    expect(body.address).toBe(TARGET_ADDR)
    expect('port' in body).toBe(false)
    expect('tier' in body).toBe(false)
    expect('usage' in body).toBe(false)
  })

  it('GET /api/user/:address 已登录但非本人 → 403', async () => {
    userService.getUserInfo.mockResolvedValue({ address: TARGET_ADDR, port: 31001 })
    // 另一个非管理员地址的会话访问 TARGET_ADDR
    const strangerToken = 'aa'.repeat(32)
    adminSessionStore.sessions[sha256(strangerToken)] = {
      address: 'jpfx5i4xxnzggbl1sgm1cfabayvyyb9vzp', // 非管理员、非 TARGET_ADDR
      expiresAt: Date.now() + 3600e3,
    }
    const req = makeReq({
      method: 'GET',
      url: `/api/user/${TARGET_ADDR}`,
      cookie: `admin_session=${strangerToken}`,
    })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, `/api/user/${TARGET_ADDR}`)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
  })
})

describe('tenant.routes.js remove / restart 错误码', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChallengeFlow()
  })

  it('remove 对不存在用户返回 404（而非 400）', async () => {
    userService.destroyContainer.mockRejectedValue(new NotFoundError('User not found'))
    const req = await makeSignedReq(
      {
        method: 'POST',
        url: `/api/user/${TARGET_ADDR}/remove`,
        cookie: `admin_session=${ADMIN_TOKEN}`,
      },
      'remove',
      { address: TARGET_ADDR, keepVolume: false },
    )
    const res = makeRes()

    const handled = await handleTenantRoutes(
      req,
      res,
      `/api/user/${TARGET_ADDR}/remove`,
      new URL(`http://127.0.0.1:8090/api/user/${TARGET_ADDR}/remove`),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('NOT_FOUND')
    expect(userService.destroyContainer).toHaveBeenCalledWith(TARGET_ADDR, true, {
      keepVolume: false,
    })
  })

  it('remove 成功返回 200', async () => {
    userService.destroyContainer.mockResolvedValue({ ok: true, status: 'removed' })
    const req = await makeSignedReq(
      {
        method: 'POST',
        url: `/api/user/${TARGET_ADDR}/remove`,
        cookie: `admin_session=${ADMIN_TOKEN}`,
      },
      'remove',
      { address: TARGET_ADDR, keepVolume: false },
    )
    const res = makeRes()

    const handled = await handleTenantRoutes(
      req,
      res,
      `/api/user/${TARGET_ADDR}/remove`,
      new URL(`http://127.0.0.1:8090/api/user/${TARGET_ADDR}/remove`),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
    expect(userService.destroyContainer).toHaveBeenCalledWith(TARGET_ADDR, true, {
      keepVolume: false,
    })
  })

  it('remove?keepVolume=1 → 保留数据卷（keepVolume=true）', async () => {
    userService.destroyContainer.mockResolvedValue({ ok: true, status: 'removed', volume: 'kept' })
    const req = await makeSignedReq(
      {
        method: 'POST',
        url: `/api/user/${TARGET_ADDR}/remove?keepVolume=1`,
        cookie: `admin_session=${ADMIN_TOKEN}`,
      },
      'remove',
      { address: TARGET_ADDR, keepVolume: true },
    )
    const res = makeRes()

    const handled = await handleTenantRoutes(
      req,
      res,
      `/api/user/${TARGET_ADDR}/remove`,
      new URL(`http://127.0.0.1:8090/api/user/${TARGET_ADDR}/remove?keepVolume=1`),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).volume).toBe('kept')
    expect(userService.destroyContainer).toHaveBeenCalledWith(TARGET_ADDR, true, {
      keepVolume: true,
    })
  })

  it('reset 成功 → 200 + 重建端口 + url + 签发会话（一步进入新容器）', async () => {
    userService.resetContainer.mockResolvedValue({
      ok: true,
      address: TARGET_ADDR,
      port: 31005,
      rebuilt: true,
    })
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/reset`,
      cookie: `admin_session=${ADMIN_TOKEN}`,
    })
    const res = makeRes()

    const handled = await handleTenantRoutes(
      req,
      res,
      `/api/user/${TARGET_ADDR}/reset`,
      new URL(`http://127.0.0.1:8090/api/user/${TARGET_ADDR}/reset`),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.port).toBe(31005)
    expect(body.rebuilt).toBe(true)
    expect(body.url).toBe('http://127.0.0.1:31005/') // 跟随请求 Host=127.0.0.1:8090
    expect(res.headers['set-cookie']).toMatch(/user_session=[0-9a-f]{64}/)
    expect(userService.resetContainer).toHaveBeenCalledWith(TARGET_ADDR)
  })

  it('reset 且无 Home 头回退 PUBLIC_HOST 构造 url 不报错', async () => {
    userService.resetContainer.mockResolvedValue({ ok: true, address: TARGET_ADDR, port: 31006 })
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/reset`,
      cookie: `admin_session=${ADMIN_TOKEN}`,
    })
    delete req.headers.host
    const res = makeRes()

    const handled = await handleTenantRoutes(
      req,
      res,
      `/api/user/${TARGET_ADDR}/reset`,
      new URL(`http://127.0.0.1:8090/api/user/${TARGET_ADDR}/reset`),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.url).toMatch(/^http:\/\/[^/]+:31006\/$/)
  })

  it('reset：普通用户（只有 user_session）重置【自己】的容器 → 200（回归：曾恒 403）', async () => {
    // 曾经这里用 getSessionAddress（只读管理员会话），普通用户的 session 恒为
    // null → 重置自己的容器永远 403「没有权限重置此容器」。上面两条用例都是
    // 拿 admin_session 测的，所以一直没暴露。
    userService.resetContainer.mockResolvedValue({
      ok: true,
      address: TARGET_ADDR,
      port: 31007,
      rebuilt: true,
    })
    const token = userSessionStore.create(TARGET_ADDR, 3600_000)
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/reset`,
      cookie: `user_session=${token}`,
    })
    const res = makeRes()

    const handled = await handleTenantRoutes(
      req,
      res,
      `/api/user/${TARGET_ADDR}/reset`,
      new URL(`http://127.0.0.1:8090/api/user/${TARGET_ADDR}/reset`),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(userService.resetContainer).toHaveBeenCalledWith(TARGET_ADDR)
  })

  it('reset：普通用户重置【别人】的容器 → 403 且不触碰容器', async () => {
    const OTHER_ADDR = 'j3xhos5osubqmfaekq3rxufrzbbucghwrv' // 非管理员
    const token = userSessionStore.create(OTHER_ADDR, 3600_000)
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/reset`,
      cookie: `user_session=${token}`,
    })
    const res = makeRes()

    const handled = await handleTenantRoutes(
      req,
      res,
      `/api/user/${TARGET_ADDR}/reset`,
      new URL(`http://127.0.0.1:8090/api/user/${TARGET_ADDR}/reset`),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).code).toBe('FORBIDDEN')
    expect(userService.resetContainer).not.toHaveBeenCalled()
  })

  it('restart 对不存在容器返回 404（而非 500）', async () => {
    userService.restartContainer.mockRejectedValue(
      new NotFoundError(`Container dsh-swtc-${TARGET_ADDR} not found`),
    )
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/restart`,
      cookie: `admin_session=${ADMIN_TOKEN}`,
    })
    const res = makeRes()

    const handled = await handleTenantRoutes(
      req,
      res,
      `/api/user/${TARGET_ADDR}/restart`,
      new URL(`http://127.0.0.1:8090/api/user/${TARGET_ADDR}/restart`),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('NOT_FOUND')
  })

  it('restart 成功返回 200', async () => {
    userService.restartContainer.mockResolvedValue({ ok: true, status: 'restarted' })
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/restart`,
      cookie: `admin_session=${ADMIN_TOKEN}`,
    })
    const res = makeRes()

    const handled = await handleTenantRoutes(
      req,
      res,
      `/api/user/${TARGET_ADDR}/restart`,
      new URL(`http://127.0.0.1:8090/api/user/${TARGET_ADDR}/restart`),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
  })
})

describe('admin.routes.js promote 无权限', () => {
  it('无 admin cookie 时返回 403 且返回 true（不 fallthrough 到 SPA）', async () => {
    const req = makeReq({ method: 'POST', url: `/api/admin/promote/${TARGET_ADDR}` })
    const res = makeRes()

    const handled = await handleAdminRoutes(
      req,
      res,
      `/api/admin/promote/${TARGET_ADDR}`,
      new URL(`http://127.0.0.1:8090/api/admin/promote/${TARGET_ADDR}`),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(res.body).toContain('FORBIDDEN')
  })
})

describe('user.routes.js 模型配置端点', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET /api/user/tenant-config 返回扩展状态（key + baseURL + models，不回显 key）', async () => {
    tenantConfigService.getStatus.mockResolvedValue({
      apiKeyConfigured: true,
      baseURL: 'https://gw.example.com',
      models: [{ id: 'm1', name: 'M1' }],
    })
    const req = makeReq({ method: 'GET', url: `/api/user/tenant-config?address=${TARGET_ADDR}` })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, '/api/user/tenant-config')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.configured).toBe(true)
    expect(body.apiKeyConfigured).toBe(true)
    expect(body.baseURL).toBe('https://gw.example.com')
    expect(body.models).toEqual([{ id: 'm1', name: 'M1' }])
    expect(JSON.stringify(body)).not.toContain('sk-')
  })

  it('POST /api/user/tenant-config 透传 apiKey + baseURL + models 到 service', async () => {
    tenantConfigService.configure.mockResolvedValue()
    const payload = {
      address: TARGET_ADDR,
      nonce: 'n',
      signature: 's',
      publicKey: 'p',
      apiKey: 'sk-abc',
      baseURL: 'https://gw.example.com',
      models: [{ id: 'm1' }],
    }
    const req = makeReq({ method: 'POST', url: '/api/user/tenant-config', body: payload })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, '/api/user/tenant-config')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    // configure(address, {...}) —— 第二个参数不含 address 字段
    const { address: _addr, ...expectedConfig } = payload
    expect(tenantConfigService.configure).toHaveBeenCalledWith(TARGET_ADDR, expectedConfig)
  })

  it('POST /api/user/tenant-config/discover 成功返回模型列表', async () => {
    tenantConfigService.discoverWithAuth.mockResolvedValue([
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'model-b' },
    ])
    const payload = {
      address: TARGET_ADDR,
      nonce: 'n',
      signature: 's',
      publicKey: 'p',
      baseURL: 'https://gw.example.com',
    }
    const req = makeReq({ method: 'POST', url: '/api/user/tenant-config/discover', body: payload })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, '/api/user/tenant-config/discover')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.models).toHaveLength(2)
    // discoverWithAuth(address, {nonce, signature, publicKey, baseURL, apiKey})
    const { address: _addr, ...expectedArgs } = payload
    expect(tenantConfigService.discoverWithAuth).toHaveBeenCalledWith(TARGET_ADDR, {
      ...expectedArgs,
      apiKey: undefined,
    })
  })

  it('POST discover 验签失败返回 403', async () => {
    tenantConfigService.discoverWithAuth.mockRejectedValue(
      new ForbiddenError('签名验证失败：无法确认该地址归您所有'),
    )
    const payload = {
      address: TARGET_ADDR,
      nonce: 'n',
      signature: 'bad',
      publicKey: 'p',
      baseURL: 'https://gw.example.com',
    }
    const req = makeReq({ method: 'POST', url: '/api/user/tenant-config/discover', body: payload })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, '/api/user/tenant-config/discover')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(res.body).toContain('FORBIDDEN')
  })

  it('POST discover 不被详情分支拦截（返回 true 而非 400）', async () => {
    tenantConfigService.discoverWithAuth.mockResolvedValue([])
    const payload = {
      address: TARGET_ADDR,
      nonce: 'n',
      signature: 's',
      publicKey: 'p',
      baseURL: 'https://gw.example.com',
    }
    const req = makeReq({ method: 'POST', url: '/api/user/tenant-config/discover', body: payload })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, '/api/user/tenant-config/discover')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('Invalid SWTC address')
  })

  it('DELETE /api/user/tenant-config 透传 scope=official-key（只删官方 key）', async () => {
    tenantConfigService.clear.mockResolvedValue()
    const payload = {
      address: TARGET_ADDR,
      nonce: 'n',
      signature: 's',
      publicKey: 'p',
      scope: 'official-key',
    }
    const req = makeReq({ method: 'DELETE', url: '/api/user/tenant-config', body: payload })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, '/api/user/tenant-config')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const { address: _addr, ...expectedArgs } = payload
    expect(tenantConfigService.clear).toHaveBeenCalledWith(TARGET_ADDR, expectedArgs)
  })

  it('DELETE /api/user/tenant-config 默认 scope 清全部', async () => {
    tenantConfigService.clear.mockResolvedValue()
    const payload = { address: TARGET_ADDR, nonce: 'n', signature: 's', publicKey: 'p' }
    const req = makeReq({ method: 'DELETE', url: '/api/user/tenant-config', body: payload })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, '/api/user/tenant-config')
    expect(handled).toBe(true)
    expect(tenantConfigService.clear).toHaveBeenCalledWith(TARGET_ADDR, {
      nonce: 'n',
      signature: 's',
      publicKey: 'p',
      scope: undefined,
    })
  })
})

describe('网关门禁会话（TTL 分权 + logout 吊销）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('create(address) 默认 12h；create(address, ttl) 使用自定义 TTL（CWT 入场 30min）', () => {
    const shortToken = userSessionStore.create(TARGET_ADDR, 30 * 60 * 1000)
    const longToken = userSessionStore.create(TARGET_ADDR)
    const shortEntry = userSessionStore.sessions[sha256(shortToken)]
    const longEntry = userSessionStore.sessions[sha256(longToken)]
    const skew = Date.now()
    expect(shortEntry.expiresAt - skew).toBeGreaterThan(29 * 60 * 1000)
    expect(shortEntry.expiresAt - skew).toBeLessThanOrEqual(30 * 60 * 1000)
    expect(longEntry.expiresAt - skew).toBeGreaterThan(11 * 60 * 60 * 1000)
    expect(longEntry.expiresAt - skew).toBeLessThanOrEqual(12 * 60 * 60 * 1000)
  })

  it('POST /api/user/logout 吊销当前会话并下发清 cookie（切钱包后旧钥匙即刻作废）', async () => {
    const token = userSessionStore.create(TARGET_ADDR)
    const req = makeReq({
      method: 'POST',
      url: '/api/user/logout',
      cookie: `user_session=${token}`,
    })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, '/api/user/logout')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['set-cookie']).toContain('max-age=0')
    expect(userSessionStore.resolve(token)).toBeNull() // 钥匙已被吊销
  })

  it('logout 无 cookie 时也正常返回（幂等）', async () => {
    const res = makeRes()
    const handled = await handleUserRoutes(
      makeReq({ method: 'POST', url: '/api/user/logout' }),
      res,
      '/api/user/logout',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
  })

  it('GET /api/user/session-info 返回 cookie 会话绑定的地址', async () => {
    const token = userSessionStore.create(TARGET_ADDR)
    const res = makeRes()
    const handled = await handleUserRoutes(
      makeReq({ url: '/api/user/session-info', cookie: `user_session=${token}` }),
      res,
      '/api/user/session-info',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).address).toBe(TARGET_ADDR)
  })

  it('GET /api/user/session-info 无会话时返回 address: null', async () => {
    const res = makeRes()
    const handled = await handleUserRoutes(
      makeReq({ url: '/api/user/session-info' }),
      res,
      '/api/user/session-info',
    )
    expect(handled).toBe(true)
    expect(JSON.parse(res.body).address).toBeNull()
  })
})
