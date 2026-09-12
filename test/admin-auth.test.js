/**
 * 管理员签名登录 + 随机会话（security-hardening-plan P0-1）测试
 *
 * 组 1「会话机制」：mock 签名服务，聚焦会话 token 生命周期
 *   （签发/解析/过期/吊销/伪造拒绝/旧"地址即会话"废止）
 * 组 2「端到端」：真实 @swtc/keypairs 生成钱包 + 真实 challenge/验签，
 *   验证完整登录链路密码学可用。
 * 会话存储方法 mock 为内存，不触碰真实 data/config/sessions.json。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Keypairs } from '@swtc/keypairs'
import { createHash } from 'node:crypto'

vi.mock('../src/services/user.service.js', () => ({ userService: { isUsageExempt: vi.fn() } }))
vi.mock('../src/services/cwt-admin.service.js', () => ({ cwtAdminService: {} }))
vi.mock('../src/services/docker.service.js', () => ({ dockerService: {} }))
vi.mock('../src/config/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAdmin: vi.fn(() => true),
}))
vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      loadSessions: vi.fn(() => ({})),
      saveSessions: vi.fn(() => {}),
      loadUserSessions: vi.fn(() => ({})),
      saveUserSessions: vi.fn(() => {}),
      logOperation: vi.fn(() => {}),
    },
  }
})

import { handleAdminRoutes } from '../src/routes/admin.routes.js'
import { tenantConfigService } from '../src/services/tenant-config.service.js'
import {
  requireAdmin,
  getAdminSession,
  adminSessionStore,
} from '../src/middleware/auth.middleware.js'
import { isAdmin } from '../src/config/config.js'

const ADMIN_ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const OTHER_ADDR = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'
const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex')

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

/** 从响应 header 提取 set-cookie 中的 admin_session 值 */
function sessionTokenFrom(res) {
  const sc = res.headers['set-cookie'] || ''
  const m = String(sc).match(/admin_session=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

describe('管理员签名登录（P0-1）', () => {
  beforeEach(() => {
    vi.spyOn(tenantConfigService, 'issueChallenge').mockReturnValue('nonce-test-001')
    vi.spyOn(tenantConfigService, 'verifySignature').mockReturnValue(true)
    vi.spyOn(tenantConfigService, 'consumeChallenge').mockReturnValue(true)
    isAdmin.mockReturnValue(true)
    adminSessionStore.sessions = {}
  })

  afterEach(() => {
    vi.restoreAllMocks()
    adminSessionStore.sessions = {}
  })

  it('验签失败 → 403', async () => {
    tenantConfigService.verifySignature.mockReturnValue(false)
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/login',
        body: { address: ADMIN_ADDR, nonce: 'n', signature: 'bad', publicKey: 'pk' },
      }),
      res,
      '/api/admin/login',
    )
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/签名验证失败/)
  })

  it('挑战被消费（重放）→ 403', async () => {
    tenantConfigService.consumeChallenge.mockReturnValue(false)
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/login',
        body: { address: ADMIN_ADDR, nonce: 'n', signature: 's', publicKey: 'pk' },
      }),
      res,
      '/api/admin/login',
    )
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/挑战已失效/)
  })

  it('非管理员地址 → 403', async () => {
    isAdmin.mockReturnValue(false)
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/login',
        body: { address: OTHER_ADDR, nonce: 'n', signature: 's', publicKey: 'pk' },
      }),
      res,
      '/api/admin/login',
    )
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/不是管理员地址/)
  })

  it('签名登录成功 → 下发随机会话（Cookie 值 ≠ 地址，64 位 hex）', async () => {
    const res = makeRes()
    const handled = await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/login',
        body: { address: ADMIN_ADDR, nonce: 'n', signature: 's', publicKey: 'pk' },
      }),
      res,
      '/api/admin/login',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const token = sessionTokenFrom(res)
    expect(token).toBeTruthy()
    expect(token).not.toBe(ADMIN_ADDR)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    // 会话可解析回地址
    expect(adminSessionStore.resolve(token)).toBe(ADMIN_ADDR)
  })

  it('凭随机会话可访问受保护接口（requireAdmin 通过）', async () => {
    const loginRes = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/login',
        body: { address: ADMIN_ADDR, nonce: 'n', signature: 's', publicKey: 'pk' },
      }),
      loginRes,
      '/api/admin/login',
    )
    const token = sessionTokenFrom(loginRes)

    const res = makeRes()
    const req = makeReq({ cookie: `admin_session=${token}` })
    expect(requireAdmin(req, res)).toBe(true)
    expect(res.headersSent).toBe(false) // 未被拒绝
    expect(getAdminSession(req)).toBe(ADMIN_ADDR)
  })

  it('伪造 admin_session=<地址> → 受保护接口拒绝（旧行为废止）', async () => {
    const res = makeRes()
    const ok = requireAdmin(makeReq({ cookie: `admin_session=${ADMIN_ADDR}` }), res)
    expect(ok).toBe(false)
    expect(res.statusCode).toBe(403)
  })

  it('伪造随机 admin_session → 403', async () => {
    const res = makeRes()
    const ok = requireAdmin(makeReq({ cookie: 'admin_session=a1b2c3d4e5f6' }), res)
    expect(ok).toBe(false)
    expect(res.statusCode).toBe(403)
  })

  it('logout 吊销会话后 → 403', async () => {
    const loginRes = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/login',
        body: { address: ADMIN_ADDR, nonce: 'n', signature: 's', publicKey: 'pk' },
      }),
      loginRes,
      '/api/admin/login',
    )
    const token = sessionTokenFrom(loginRes)

    const out = makeRes()
    await handleAdminRoutes(
      makeReq({ method: 'POST', url: '/api/admin/logout', cookie: `admin_session=${token}` }),
      out,
      '/api/admin/logout',
    )
    expect(out.statusCode).toBe(200)

    const check = makeRes()
    const ok = requireAdmin(makeReq({ cookie: `admin_session=${token}` }), check)
    expect(ok).toBe(false)
    expect(check.statusCode).toBe(403)
  })

  it('过期会话 → 自动失效（resolve null / requireAdmin 403）', async () => {
    const token = 'deadbeef'.repeat(8)
    adminSessionStore.sessions[sha256(token)] = {
      address: ADMIN_ADDR,
      expiresAt: Date.now() - 1000,
    }
    expect(adminSessionStore.resolve(token)).toBeNull()
    const res = makeRes()
    const ok = requireAdmin(makeReq({ cookie: `admin_session=${token}` }), res)
    expect(ok).toBe(false)
  })
})

describe('端到端：真实钱包签名登录（P0-1）', () => {
  beforeEach(() => {
    vi.restoreAllMocks() // 恢复真实 tenantConfigService（challenge/验签）
    isAdmin.mockReturnValue(true)
    adminSessionStore.sessions = {}
  })

  afterEach(() => {
    vi.restoreAllMocks()
    adminSessionStore.sessions = {}
  })

  it('无签名材料直接登录 → 403（真实验签拒绝，旧"地址即凭证"失效）', async () => {
    const seed = Keypairs.generateSeed({ algorithm: 'ed25519' })
    const kp = Keypairs.deriveKeypair(seed)
    const address = Keypairs.deriveAddress(kp.publicKey).toLowerCase()
    const res = makeRes()
    const handled = await handleAdminRoutes(
      makeReq({ method: 'POST', url: '/api/admin/login', body: { address } }),
      res,
      '/api/admin/login',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/签名验证失败/)
  })

  it('challenge → 插件签名 → 登录 → 会话可用（真实 Keypairs 链路）', async () => {
    // 真实 SWTC 账户
    const seed = Keypairs.generateSeed({ algorithm: 'ed25519' })
    const kp = Keypairs.deriveKeypair(seed)
    const wallet = {
      publicKey: kp.publicKey,
      address: Keypairs.deriveAddress(kp.publicKey).toLowerCase(),
      sign: (msg) => Keypairs.sign(msg, kp.privateKey),
    }

    // 1) 领取挑战
    const chalRes = makeRes()
    await handleAdminRoutes(
      makeReq({ method: 'POST', url: '/api/admin/challenge', body: { address: wallet.address } }),
      chalRes,
      '/api/admin/challenge',
    )
    expect(chalRes.statusCode).toBe(200)
    const nonce = JSON.parse(chalRes.body).nonce
    expect(nonce).toBeTruthy()
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)

    // 2) 真实签名登录
    const signature = wallet.sign(nonce)
    const loginRes = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/login',
        body: { address: wallet.address, nonce, signature, publicKey: wallet.publicKey },
      }),
      loginRes,
      '/api/admin/login',
    )
    expect(loginRes.statusCode).toBe(200)
    const token = sessionTokenFrom(loginRes)
    expect(token).toMatch(/^[0-9a-f]{64}$/)

    // 3) 会话可解析（且是签名的那个地址）
    expect(adminSessionStore.resolve(token)).toBe(wallet.address)

    // 4) 同一 nonce 重放登录 → 403（一次性）
    const replayRes = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/login',
        body: { address: wallet.address, nonce, signature, publicKey: wallet.publicKey },
      }),
      replayRes,
      '/api/admin/login',
    )
    expect(replayRes.statusCode).toBe(403)
  })
})
