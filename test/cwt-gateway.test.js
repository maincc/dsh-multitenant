/**
 * CWT 出示入场（/api/cwt/gateway-enter）测试：
 * - 真实 cwtService 验签（node crypto 造 token，@swtc 双路径验签）
 * - userService.ensureContainer mock（避免真实 Docker）
 * - registry mock（控制 approved/revoked/缺席）
 *
 * 核心不变量：放行必须"验签通过 + registry approved"二合一，
 * 只有 registry 记录、token 无效、过期、地址不符，一律 403。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createHash, createPublicKey, createSign, generateKeyPairSync } from 'node:crypto'
import { Keypairs } from '@swtc/keypairs'

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    ensureContainer: vi.fn(),
    containerExists: vi.fn(),
  },
}))
vi.mock('../src/services/cwt.store.js', () => ({
  cwtStore: {
    getRegistry: vi.fn(() => ({})),
    // 防误用：测试内外都不允许 appendApplication
    appendApplication: vi.fn(),
  },
}))
vi.mock('../src/services/data.service.js', () => ({
  dataService: {
    loadSessions: vi.fn(() => ({})),
    saveSessions: vi.fn(() => {}),
    loadUserSessions: vi.fn(() => ({})),
    saveUserSessions: vi.fn(() => {}),
  },
}))

import { handleUserRoutes } from '../src/routes/user.routes.js'
import { userService } from '../src/services/user.service.js'
import { cwtStore } from '../src/services/cwt.store.js'

const b64url = (v) => Buffer.from(v).toString('base64url')

function compressedHexFromJwk(jwk) {
  const x = Buffer.from(jwk.x, 'base64url')
  const y = Buffer.from(jwk.y, 'base64url')
  return `${y[y.length - 1] % 2 === 0 ? '02' : '03'}${x.toString('hex')}`
}

function makeSecpWallet() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
  const pem = publicKey.export({ type: 'spki', format: 'pem' })
  const pubHex = compressedHexFromJwk(createPublicKey(pem).export({ format: 'jwk' }))
  return {
    publicPem: pem,
    address: Keypairs.deriveAddress(pubHex).toLowerCase(),
    sign: (input) => createSign('sha256').update(input).sign(privateKey).toString('base64url'),
  }
}

function buildToken(wallet, overrides = {}) {
  const { header = {}, payload = {}, sig } = overrides
  const h = {
    x5c: [wallet.publicPem],
    type: 'CWT',
    chain: 'jingtum',
    alg: 'secp256k1',
    ...header,
  }
  const p = { usr: 'dsh-usr', time: Math.floor(Date.now() / 1000), ...payload }
  const h64 = b64url(JSON.stringify(h))
  const p64 = b64url(JSON.stringify(p))
  const signature = sig ?? wallet.sign(`${h64}.${p64}`)
  return `${h64}.${p64}.${signature}`
}

function tamperPayload(token, patch) {
  const [h, p, s] = token.split('.')
  const parsed = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
  Object.assign(parsed, patch)
  return `${h}.${b64url(JSON.stringify(parsed))}.${s}`
}

function makeReq(body) {
  let sent = false
  return {
    method: 'POST',
    url: '/api/cwt/gateway-enter',
    headers: { host: '127.0.0.1:8090' },
    _queued: null,
    on(ev, cb) {
      if (ev === 'data' && !sent) {
        sent = true
        cb(JSON.stringify(body))
      }
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

const walletA = makeSecpWallet()
const walletB = makeSecpWallet()
const approvedRegistry = {
  [walletA.address]: { usr: 'dsh-usr', status: 'approved', approvedAt: Date.now() },
}

describe('POST /api/cwt/gateway-enter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userService.ensureContainer.mockResolvedValue(31000)
  })

  it('合法 token + registry approved → 200 + 下发 user_session cookie + url', async () => {
    cwtStore.getRegistry.mockReturnValue(approvedRegistry)
    const token = buildToken(walletA)
    const res = makeRes()
    const handled = await handleUserRoutes(
      makeReq({ address: walletA.address, token }),
      res,
      '/api/cwt/gateway-enter',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.url).toMatch(new RegExp(`:${31000}/$`))
    expect(res.headers['set-cookie']).toMatch(/^user_session=[a-f0-9]{64}/)
    expect(userService.ensureContainer).toHaveBeenCalledWith(walletA.address)
  })

  it('token 有效但地址不在 registry → 403', async () => {
    cwtStore.getRegistry.mockReturnValue({}) // 空注册表
    const token = buildToken(walletA)
    const res = makeRes()
    await handleUserRoutes(
      makeReq({ address: walletA.address, token }),
      res,
      '/api/cwt/gateway-enter',
    )
    expect(res.statusCode).toBe(403)
    expect(userService.ensureContainer).not.toHaveBeenCalled()
  })

  it('registry status=revoked → 403', async () => {
    cwtStore.getRegistry.mockReturnValue({
      [walletA.address]: { usr: 'dsh-usr', status: 'revoked' },
    })
    const token = buildToken(walletA)
    const res = makeRes()
    await handleUserRoutes(
      makeReq({ address: walletA.address, token }),
      res,
      '/api/cwt/gateway-enter',
    )
    expect(res.statusCode).toBe(403)
  })

  it('过期 token（time 超窗口）→ 403', async () => {
    cwtStore.getRegistry.mockReturnValue(approvedRegistry)
    const token = buildToken(walletA, { payload: { time: Math.floor(Date.now() / 1000) - 3600 } })
    const res = makeRes()
    await handleUserRoutes(
      makeReq({ address: walletA.address, token }),
      res,
      '/api/cwt/gateway-enter',
    )
    expect(res.statusCode).toBe(403)
  })

  it('篡改 payload（签名不匹配）→ 403', async () => {
    cwtStore.getRegistry.mockReturnValue(approvedRegistry)
    const token = tamperPayload(buildToken(walletA), { usr: 'evil' })
    const res = makeRes()
    await handleUserRoutes(
      makeReq({ address: walletA.address, token }),
      res,
      '/api/cwt/gateway-enter',
    )
    expect(res.statusCode).toBe(403)
  })

  it('钱包 B 的合法 token 请求地址 A → 403（expectedAddress 不匹配）', async () => {
    cwtStore.getRegistry.mockReturnValue(approvedRegistry)
    const token = buildToken(walletB) // token 推导地址 = B
    const res = makeRes()
    await handleUserRoutes(
      makeReq({ address: walletA.address, token }),
      res,
      '/api/cwt/gateway-enter',
    )
    expect(res.statusCode).toBe(403)
  })

  it('伪造 token → 403', async () => {
    cwtStore.getRegistry.mockReturnValue(approvedRegistry)
    const res = makeRes()
    await handleUserRoutes(
      makeReq({ address: walletA.address, token: 'a.b.c' }),
      res,
      '/api/cwt/gateway-enter',
    )
    expect(res.statusCode).toBe(403)
  })

  it('缺 token → 400', async () => {
    const res = makeRes()
    await handleUserRoutes(makeReq({ address: walletA.address }), res, '/api/cwt/gateway-enter')
    expect(res.statusCode).toBe(400)
  })

  it('容器创建受资源限制 → 202（排队）', async () => {
    cwtStore.getRegistry.mockReturnValue(approvedRegistry)
    const token = buildToken(walletA)
    const err = new Error('资源不足')
    err.code = 'RESOURCE_EXHAUSTED'
    err.queuePosition = 3
    userService.ensureContainer.mockRejectedValue(err)
    const res = makeRes()
    await handleUserRoutes(
      makeReq({ address: walletA.address, token }),
      res,
      '/api/cwt/gateway-enter',
    )
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body).code).toBe('RESOURCE_EXHAUSTED')
  })
})
