/**
 * 路由守卫注册表回归测试（refactor-giant-files §P1）
 *
 * 两层覆盖：
 *   A. registry 纯机制——defineRoute 校验闸（guard 必填/匹配器唯一/signOp 白名单/
 *      重复注册）与 dispatchRoutes 匹配序（exact/prefix/pattern × method）。
 *   B. 真实 ADMIN_ROUTES 快照——首批迁入域（session+gateway 共 7 端点）的
 *      守卫声明与匹配语义逐条钉死；未注册路径必须 fallthrough（返回 false），
 *      这是"新端点忘挂守卫在测试阶段就红"的起点防线。
 *
 * 服务全 mock（对齐 routes.test.js 惯例）：本文件测的是**注册表机制与声明面**，
 * 端点业务行为由既有 routes/admin-*.test.js 覆盖。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    state: { swtcUsers: {}, externalOccupations: {} },
    tenantPortRanges: () => ({ pub: { base: 31000, max: 31999 }, internal: null }),
  },
}))
vi.mock('../src/services/data.service.js', () => ({
  dataService: {
    logOperation: vi.fn(() => Promise.resolve()),
    loadSessions: vi.fn(() => ({})),
    loadUserSessions: vi.fn(() => ({})),
    saveUserSessions: vi.fn(),
    saveSessions: vi.fn(),
    saveState: vi.fn(),
    readStateFile: vi.fn(() => null),
  },
}))
vi.mock('../src/services/docker.service.js', () => ({
  dockerService: { isDockerAvailable: vi.fn(async () => true) },
}))
vi.mock('../src/services/env-bundle.service.js', () => ({ envBundleService: {} }))
vi.mock('../src/services/env-commit.service.js', () => ({
  runEnvCommit: vi.fn(),
  normEnvNames: vi.fn(),
  normEnvWsExcludes: vi.fn(),
}))
vi.mock('../src/services/image-inventory.service.js', () => ({
  collectPrunableImages: vi.fn(),
  matchImageId: vi.fn(),
}))
vi.mock('../src/services/dsh-version.service.js', () => ({ dshVersionService: {} }))
vi.mock('../src/services/tenant-proxy.service.js', () => ({
  tenantGateway: { issueTicket: vi.fn() },
}))
vi.mock('../src/services/credential.service.js', () => ({
  credentialService: { isAdmSync: vi.fn(() => false) },
}))
vi.mock('../src/services/tenant-config.service.js', () => ({
  tenantConfigService: {
    issueChallenge: vi.fn(),
    consumeChallenge: vi.fn(),
    verifySignature: vi.fn(),
  },
  SIGN_PURPOSE: {
    LOGIN: 'login',
    CONNECT: 'connect',
    TENANT_CONFIG: 'tenant-config',
    SKILLS: 'skills',
    GATEWAY_VERIFY: 'gateway-verify',
  },
  buildSignedMessage: (purpose, address, nonce) =>
    `hex:dsh-multitenant|${purpose}|${address}|${nonce}`,
}))
vi.mock('../src/middleware/user-auth.middleware.js', () => ({
  userSessionStore: {
    sessions: {},
    create: vi.fn(() => 'tok'),
    revoke: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
  getUserSession: vi.fn(() => null),
}))

import { defineRoute, dispatchRoutes, validateRoutes } from '../src/routes/registry.js'
import { ADMIN_ROUTES } from '../src/routes/admin/index.js'
import { ADMIN_SIGNED_OPERATIONS } from '../src/middleware/admin-signature.middleware.js'
import { handleAdminRoutes } from '../src/routes/admin.routes.js'

/* ------------------------------------------------------------------ */
/* 假 req/res（只喂 dispatch 用到的表面）                                */
/* ------------------------------------------------------------------ */

function fakeReq(method, path, { socket = {}, headers = {} } = {}) {
  return { method, url: path, socket, headers }
}
function fakeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code
      this.headersSent = true
      return this
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
}
const dispatch = (routes, req, res, path, url) =>
  dispatchRoutes(routes, req, res, path, url ?? new URL(req.url, 'http://x'))

describe('A. registry 机制', () => {
  it('guard 必填且 ∈ public|admin|custom——缺守卫在注册即抛', () => {
    expect(() => defineRoute({ path: '/x', handler: () => {} })).toThrow(/guard/)
    expect(() => defineRoute({ path: '/x', guard: 'maybe', handler: () => {} })).toThrow(/guard/)
  })

  it('匹配器必须恰好一个（path/prefix/pattern）', () => {
    expect(() => defineRoute({ path: '/x', guard: 'public', handler: () => {} })).not.toThrow()
    expect(() =>
      defineRoute({ path: '/x', prefix: '/y', guard: 'public', handler: () => {} }),
    ).toThrow(/path\/prefix\/pattern/)
    expect(() => defineRoute({ guard: 'public', handler: () => {} })).toThrow(
      /path\/prefix\/pattern/,
    )
  })

  it('pattern 必须 ^…$ 锚定（防半锚正则漏匹配）', () => {
    expect(() => defineRoute({ pattern: /foo/, guard: 'public', handler: () => {} })).toThrow(
      /锚定/,
    )
    expect(() =>
      defineRoute({ pattern: /^foo$/, guard: 'public', handler: () => {} }),
    ).not.toThrow()
  })

  it('signOp 必须在 ADMIN_SIGNED_OPERATIONS 白名单（运行时才知 → 注册时即知）', () => {
    expect(() =>
      defineRoute({ path: '/x', guard: 'admin', signOp: 'not-an-op', handler: () => {} }),
    ).toThrow(/白名单/)
    const real = ADMIN_SIGNED_OPERATIONS[0]
    expect(() =>
      defineRoute({ path: '/x', guard: 'admin', signOp: real, handler: () => {} }),
    ).not.toThrow()
  })

  it('guard=custom 必须附 customGuard', () => {
    expect(() => defineRoute({ path: '/x', guard: 'custom', handler: () => {} })).toThrow(
      /customGuard/,
    )
  })

  it('validateRoutes 拦重复/交叠注册（任一侧不限方法即视为覆盖对方）', () => {
    const a = defineRoute({ path: '/dup', guard: 'public', handler: () => {} })
    const b = defineRoute({ method: 'GET', path: '/dup', guard: 'public', handler: () => {} })
    expect(() => validateRoutes([a, b])).toThrow(/重复\/交叠注册/)
    // 两具体方法不同 → 不交叠，放行
    const c = defineRoute({ method: 'POST', path: '/ok', guard: 'public', handler: () => {} })
    const d = defineRoute({ method: 'GET', path: '/ok', guard: 'public', handler: () => {} })
    expect(() => validateRoutes([c, d])).not.toThrow()
  })

  it('dispatch：exact+method 全匹配才命中；方法不符 fallthrough', async () => {
    const hit = defineRoute({
      method: 'POST',
      path: '/p',
      guard: 'public',
      handler: (_r, res) => res.end('ok'),
    })
    const routes = validateRoutes([hit])
    const r1 = fakeRes()
    expect(await dispatch(routes, fakeReq('GET', '/p'), r1, '/p')).toBe(false) // 方法不符未命中
    const r2 = fakeRes()
    expect(await dispatch(routes, fakeReq('POST', '/p'), r2, '/p')).toBe(true)
    expect(r2.body).toBe('ok')
  })

  it('dispatch：prefix 与 pattern 命中；方法未声明 = 任意方法（对齐原链无 method 检查的分支）', async () => {
    const routes = validateRoutes([
      defineRoute({
        method: 'POST',
        prefix: '/pre/',
        guard: 'public',
        handler: (_r, res) => res.end('p'),
      }),
      defineRoute({
        pattern: /^\/re\/[^/]+\/x$/,
        guard: 'public',
        handler: (_r, res) => res.end('r'),
      }),
      defineRoute({ path: '/any', guard: 'public', handler: (_r, res) => res.end('a') }),
    ])
    const rp = fakeReq('POST', '/pre/abc')
    const rsp = fakeRes()
    expect(await dispatch(routes, rp, rsp, '/pre/abc')).toBe(true)
    expect(rsp.body).toBe('p')
    const rr = fakeReq('POST', '/re/tok/x')
    const rsr = fakeRes()
    expect(await dispatch(routes, rr, rsr, '/re/tok/x')).toBe(true)
    expect(rsr.body).toBe('r')
    for (const m of ['GET', 'PUT', 'POST']) {
      const rq = fakeReq(m, '/any')
      const rs = fakeRes()
      expect(await dispatch(routes, rq, rs, '/any')).toBe(true)
    }
  })

  it('dispatch：guard=admin 无有效会话 → 已写 403 并收敛为已处理（不 fallthrough）', async () => {
    const routes = validateRoutes([
      defineRoute({ path: '/need-admin', guard: 'admin', handler: (_r, res) => res.end('never') }),
    ])
    const req = fakeReq('GET', '/need-admin', { headers: { cookie: 'user_session=ghost' } })
    const res = fakeRes()
    expect(await dispatch(routes, req, res, '/need-admin')).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toBe('never')
  })
})

describe('B. ADMIN_ROUTES 真实注册面（首批：session+gateway）', () => {
  // 快照：迁移完成后此表将扩到 41 端点。任何"删注册/漏注册"都会红。
  const SNAPSHOT = [
    'POST /api/admin/challenge',
    'POST /api/admin/login',
    'POST /api/admin/logout',
    '* /api/admin/check',
    'GET /api/admin/tenant-url',
    'GET /api/admin/gateway-ports',
    '* /api/docker/status',
  ]
  const keyOf = (r) => `${r.method ?? '*'} ${r.path ?? r.prefix ?? String(r.pattern)}`

  it('已迁端点集合与快照一致', () => {
    expect(ADMIN_ROUTES.map(keyOf).sort()).toEqual([...SNAPSHOT].sort())
  })

  it('每条都显式声明了 guard（免鉴权也必须写明 public）', () => {
    for (const r of ADMIN_ROUTES) {
      expect(['public', 'admin', 'custom']).toContain(r.guard)
    }
  })

  it('登录三件套 + check = public；tenant-url/docker-status = admin；gateway-ports = custom', () => {
    const by = Object.fromEntries(ADMIN_ROUTES.map((r) => [r.path, r.guard]))
    expect(by['/api/admin/challenge']).toBe('public')
    expect(by['/api/admin/login']).toBe('public')
    expect(by['/api/admin/logout']).toBe('public')
    expect(by['/api/admin/check']).toBe('public')
    expect(by['/api/admin/tenant-url']).toBe('admin')
    expect(by['/api/docker/status']).toBe('admin')
    expect(by['/api/admin/gateway-ports']).toBe('custom')
  })

  it('/api/admin/check 带限流声明（2026-10 审计 #5 的名单枚举闸）', () => {
    const check = ADMIN_ROUTES.find((r) => r.path === '/api/admin/check')
    expect(check.rateLimit).toMatchObject({ max: 20, keyPrefix: 'admincheck' })
  })

  it('handleAdminRoutes：已迁端点由注册表接管；未注册 /api/admin/* 返回 false（由 server.js 404 兜底）', async () => {
    // check 走 public+限流，直落 handler——200 即证明"注册表接管"生效
    const req1 = fakeReq('GET', '/api/admin/check?address=jndwretndumoqbt2uauclmfmx7xbqjykva', {
      socket: { remoteAddress: '127.0.0.1' },
    })
    const res1 = fakeRes()
    expect(
      await handleAdminRoutes(req1, res1, '/api/admin/check', new URL(req1.url, 'http://x')),
    ).toBe(true)
    expect(res1.statusCode).toBe(200)

    const req2 = fakeReq('GET', '/api/admin/definitely-not-registered', { socket: {} })
    const res2 = fakeRes()
    expect(
      await handleAdminRoutes(
        req2,
        res2,
        '/api/admin/definitely-not-registered',
        new URL(req2.url, 'http://x'),
      ),
    ).toBe(false)
  })

  it('gateway-ports 现场信任门禁：非回环且无 token → 404 伪装（不泄网络地图）', async () => {
    const req = fakeReq('GET', '/api/admin/gateway-ports', {
      socket: { remoteAddress: '203.0.113.9' },
    })
    const res = fakeRes()
    expect(
      await handleAdminRoutes(req, res, '/api/admin/gateway-ports', new URL(req.url, 'http://x')),
    ).toBe(true)
    expect(res.statusCode).toBe(404)
  })
})
