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

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    destroyContainer: vi.fn(),
    restartContainer: vi.fn(),
    resetContainer: vi.fn(),
    getUserInfo: vi.fn(),
    getAllUsers: vi.fn(),
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

import { handleUserRoutes } from '../src/routes/user.routes.js'
import { handleTenantRoutes } from '../src/routes/tenant.routes.js'
import { handleAdminRoutes } from '../src/routes/admin.routes.js'
import { userService } from '../src/services/user.service.js'
import { tenantConfigService } from '../src/services/tenant-config.service.js'
import { NotFoundError, ForbiddenError } from '../src/utils/errors.js'

const ADMIN_ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva' // 真实 config.json 中的管理员
const TARGET_ADDR = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'

/** 构造最小可用的 mock req（支持 parseBody 的 on('data'/'end')） */
function makeReq({ method = 'GET', url = '/', cookie = '', body } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8090', cookie },
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

describe('user.routes.js 详情分支', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('POST /api/user/:address/remove 不应被详情分支拦截（返回 false，不写响应）', async () => {
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/remove`,
      cookie: `admin_session=${ADMIN_ADDR}`,
    })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, `/api/user/${TARGET_ADDR}/remove`)
    expect(handled).toBe(false)
    expect(res.headersSent).toBe(false)
  })

  it('GET /api/user/:address 详情分支仍正常工作', async () => {
    userService.getUserInfo.mockResolvedValue({ address: TARGET_ADDR, port: 31001 })
    const req = makeReq({ method: 'GET', url: `/api/user/${TARGET_ADDR}` })
    const res = makeRes()

    const handled = await handleUserRoutes(req, res, `/api/user/${TARGET_ADDR}`)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).address).toBe(TARGET_ADDR)
  })
})

describe('tenant.routes.js remove / restart 错误码', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('remove 对不存在用户返回 404（而非 400）', async () => {
    userService.destroyContainer.mockRejectedValue(new NotFoundError('User not found'))
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/remove`,
      cookie: `admin_session=${ADMIN_ADDR}`,
    })
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
    expect(userService.destroyContainer).toHaveBeenCalledWith(TARGET_ADDR, true)
  })

  it('remove 成功返回 200', async () => {
    userService.destroyContainer.mockResolvedValue({ ok: true, status: 'removed' })
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/remove`,
      cookie: `admin_session=${ADMIN_ADDR}`,
    })
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
  })

  it('restart 对不存在容器返回 404（而非 500）', async () => {
    userService.restartContainer.mockRejectedValue(
      new NotFoundError(`Container dsh-swtc-${TARGET_ADDR} not found`),
    )
    const req = makeReq({
      method: 'POST',
      url: `/api/user/${TARGET_ADDR}/restart`,
      cookie: `admin_session=${ADMIN_ADDR}`,
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
      cookie: `admin_session=${ADMIN_ADDR}`,
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
