/**
 * v1.4 凭证六端点 HTTP 级会话回归测试
 *
 * 事故复盘（2026-10 全面审计）：credential 端点曾误接 getSessionAddress
 * （admin_session 专用），真实普通用户（只有 user_session）全部 401；
 * 因 credential.test.js 全在 service 层直调、零路由用例，740 全绿掩盖断链，
 * 而管理员自测因浏览器双会话恰好通过。
 *
 * 本文件钉死三条契约：
 *   1. 仅带 user_session 的普通用户 → 六端点全部可达（会话地址透传给服务层）
 *   2. 无任何会话 → 六端点全部 401 UNAUTHORIZED（不落服务层）
 *   3. admin_session 同样可达（管理员本人也走凭证页）
 * 今后谁把 credSession 改回 admin-only，这里立刻红。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('../src/services/credential.service.js', () => ({
  credentialService: {
    enter: vi.fn(),
    getClaimedCredential: vi.fn(),
    buildClaimDocument: vi.fn(),
    claimUpload: vi.fn(),
    applyCwt: vi.fn(),
    myApplication: vi.fn(),
  },
}))

// user.service 模块顶层就 new UserService()（读 state/碰 docker）——mock 成壳
vi.mock('../src/services/user.service.js', () => ({
  userService: {
    destroyContainer: vi.fn(),
    restartContainer: vi.fn(),
    resetContainer: vi.fn(),
    getUserInfo: vi.fn(),
    getAllUsers: vi.fn(),
    state: { swtcUsers: {}, cleanupPolicy: {} },
  },
}))

// 会话持久化走内存空实现：不写真实 data/
vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    dataService: {
      ...mod.dataService,
      loadSessions: vi.fn(() => ({})),
      loadUserSessions: vi.fn(() => ({})),
      readStateFile: vi.fn(() => null),
      saveState: vi.fn(() => {}),
      saveUserSessions: vi.fn(() => {}),
      saveSessions: vi.fn(() => {}),
      logOperation: vi.fn(() => Promise.resolve()),
    },
  }
})

import { handleUserRoutes } from '../src/routes/user.routes.js'
import { credentialService } from '../src/services/credential.service.js'
import { userSessionStore } from '../src/middleware/user-auth.middleware.js'
import { adminSessionStore } from '../src/middleware/auth.middleware.js'

const USER_ADDR = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or' // 普通用户（非管理员）
const ADMIN_ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const sha256 = (v) => createHash('sha256').update(v).digest('hex')

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

/** 端点表：method/path/所需 body/服务层方法名/服务层 mock 返回 */
const ENDPOINTS = [
  {
    name: 'credential-status',
    method: 'GET',
    path: '/api/user/credential-status',
    svc: 'enter',
    svcReturn: { state: 'assigned', kind: 'did' },
  },
  {
    name: 'credential-vc',
    method: 'GET',
    path: '/api/user/credential-vc',
    svc: 'getClaimedCredential',
    svcReturn: { credential: { id: 'vc-1' }, consistent: true },
  },
  {
    name: 'credential-scaffold',
    method: 'POST',
    path: '/api/user/credential-scaffold',
    body: { canonicalAddress: USER_ADDR },
    svc: 'buildClaimDocument',
    svcReturn: { document: {}, fileName: 'f', message: 'm' },
  },
  {
    name: 'credential-upload',
    method: 'POST',
    path: '/api/user/credential-upload',
    body: { document: {}, fileName: 'f', publicKey: 'pk', signature: 'ff' },
    svc: 'claimUpload',
    svcReturn: { ok: true, state: 'claimed' },
  },
  {
    name: 'cwt-apply',
    method: 'POST',
    path: '/api/user/cwt-apply',
    body: { reason: 'r' },
    svc: 'applyCwt',
    svcReturn: { id: 'app-1' },
  },
  {
    name: 'cwt-application',
    method: 'GET',
    path: '/api/user/cwt-application',
    svc: 'myApplication',
    svcReturn: null,
  },
]

describe('凭证六端点 × 会话类型（HTTP 层契约）', () => {
  let userToken

  beforeEach(() => {
    vi.clearAllMocks()
    // 真实签发一个 user_session（json provider → mock 的落盘为空操作）
    userToken = userSessionStore.create(USER_ADDR)
    for (const ep of ENDPOINTS) credentialService[ep.svc].mockResolvedValue(ep.svcReturn)
  })

  describe('普通用户：仅 user_session（曾被误判 401 的事故主体）', () => {
    for (const ep of ENDPOINTS) {
      it(`GET/POST ${ep.path} 可达且会话地址透传`, async () => {
        const req = makeReq({
          method: ep.method,
          url: ep.path,
          cookie: `user_session=${userToken}`,
          body: ep.body,
        })
        const res = makeRes()
        const handled = await handleUserRoutes(req, res, ep.path)
        expect(handled).toBe(true)
        expect(res.statusCode).toBe(200)
        expect(credentialService[ep.svc]).toHaveBeenCalled()
        // 服务层收到的地址 = user_session 绑定的地址
        expect(credentialService[ep.svc].mock.calls[0][0]).toBe(USER_ADDR)
      })
    }
  })

  describe('无会话：全部 401，且不落服务层', () => {
    for (const ep of ENDPOINTS) {
      it(`${ep.path} → 401 UNAUTHORIZED`, async () => {
        const req = makeReq({ method: ep.method, url: ep.path, cookie: '', body: ep.body })
        const res = makeRes()
        const handled = await handleUserRoutes(req, res, ep.path)
        expect(handled).toBe(true)
        expect(res.statusCode).toBe(401)
        expect(json(res).code).toBe('UNAUTHORIZED')
        expect(credentialService[ep.svc]).not.toHaveBeenCalled()
      })
    }
  })

  describe('管理员本人：admin_session 同样可达（自测路径不回退）', () => {
    beforeEach(() => {
      adminSessionStore.sessions[sha256('admintoken-cred-routes')] = {
        address: ADMIN_ADDR,
        expiresAt: Date.now() + 3600e3,
      }
    })
    // ★F9 循环根因钉位（2026-10-23）：admin_session + user_session 并存时凭证端点
    // 必须认 user_session（插件当前登录钱包）——旧实现 getRequestAddress admin 抢先，
    // 自动重签只换 user_session 永远换不掉残留 admin cookie → "会话主人≠当前账户"死循环
    it('双会话并存：user_session 优先（admin 旧 cookie 不抢占凭证身份）', async () => {
      for (const ep of ENDPOINTS) {
        const req = makeReq({
          method: ep.method,
          url: ep.path,
          cookie: `admin_session=admintoken-cred-routes; user_session=${userToken}`,
          body: ep.body,
        })
        const res = makeRes()
        await handleUserRoutes(req, res, ep.path)
        expect(res.statusCode).toBe(200)
        expect(credentialService[ep.svc].mock.calls[0][0]).toBe(USER_ADDR)
      }
    })
    for (const ep of ENDPOINTS) {
      it(`${ep.path} 可达`, async () => {
        const req = makeReq({
          method: ep.method,
          url: ep.path,
          cookie: `admin_session=admintoken-cred-routes`,
          body: ep.body,
        })
        const res = makeRes()
        await handleUserRoutes(req, res, ep.path)
        expect(res.statusCode).toBe(200)
        expect(credentialService[ep.svc].mock.calls[0][0]).toBe(ADMIN_ADDR)
      })
    }
  })
})
