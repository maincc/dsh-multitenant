/**
 * /connect 所有权签名测试：
 * 所有路径都要求钱包签名（challenge + 验签 + 一次性）——匿名一律 401 挑战，
 * 绝不在 302/JSON 里带出容器端口（P2-3）；需要创建时签名证明地址归属。
 *
 * userService.mock（containerExists/ensureContainer），
 * tenant-config 挑战/验签用真实实现（内存 Map），签名用真实 @swtc/keypairs。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { Keypairs } from '@swtc/keypairs'

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    containerExists: vi.fn(),
    ensureContainer: vi.fn(),
  },
}))

// user-sessions 存储 mock 为内存：签名成功会写会话，避免污染真实 data/ 文件
vi.mock('../src/services/data.service.js', () => ({
  dataService: {
    loadUserSessions: vi.fn(() => ({})),
    saveUserSessions: vi.fn(() => {}),
    loadSessions: vi.fn(() => ({})), // tenant.routes → tenant-proxy → admin session store 构造需要
  },
}))

import { handleTenantRoutes } from '../src/routes/tenant.routes.js'
import { userService } from '../src/services/user.service.js'
import { tenantConfigService, SIGN_PURPOSE } from '../src/services/tenant-config.service.js'

const ADDR = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'

/** 生成真实 SWTC 账户（ed25519） */
function makeWallet() {
  const seed = Keypairs.generateSeed({ algorithm: 'ed25519' })
  const kp = Keypairs.deriveKeypair(seed)
  return {
    publicKey: kp.publicKey,
    address: Keypairs.deriveAddress(kp.publicKey).toLowerCase(),
    sign: (msg) => Keypairs.sign(msg, kp.privateKey),
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

// 每个请求独立 IP，避免共享限流桶干扰断言
let ipCounter = 0
function makeReq() {
  ipCounter += 1
  return { headers: {}, socket: { remoteAddress: `127.0.0.${100 + ipCounter}` } }
}

function connectUrl(params) {
  const q = new URLSearchParams(params)
  return new URL(`http://127.0.0.1:8090/connect?${q}`)
}

async function bareConnect(address) {
  const res = makeRes()
  await handleTenantRoutes(makeReq(), res, '/connect', connectUrl({ address }))
  return res
}

describe('/connect 所有权签名（一律要求签名，匿名 401）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('容器已存在 + 无签名材料 → 401（匿名一律挑战，不再免签直连泄露端口）', async () => {
    userService.containerExists.mockResolvedValue(true)
    userService.ensureContainer.mockResolvedValue(31001)

    const res = await bareConnect(ADDR)
    expect(res.statusCode).toBe(401)
    expect(res.headers.location).toBeUndefined()
    expect(JSON.parse(res.body).code).toBe('SIGNATURE_REQUIRED')
    expect(userService.ensureContainer).not.toHaveBeenCalled()
  })

  it('容器不存在 + 无签名材料 → 401 SIGNATURE_REQUIRED 并下发 nonce', async () => {
    userService.containerExists.mockResolvedValue(false)

    const res = await bareConnect(ADDR)
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body)
    expect(body.code).toBe('SIGNATURE_REQUIRED')
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
    // 新增：同时下发"用途绑定后的被签内容"（hex），客户端签的是它
    expect(body.message).toMatch(/^[0-9a-f]+$/)
    expect(userService.ensureContainer).not.toHaveBeenCalled()
  })

  it('容器不存在 + 伪造签名 → 403（验签失败，不创建）', async () => {
    userService.containerExists.mockResolvedValue(false)

    const res = await bareConnect(ADDR)
    const nonce = JSON.parse(res.body).nonce

    const res2 = makeRes()
    const url = connectUrl({
      address: ADDR,
      nonce,
      signature: 'f'.repeat(128),
      publicKey: '0f'.repeat(33),
    })
    await handleTenantRoutes(makeReq(), res2, '/connect', url)
    expect(res2.statusCode).toBe(403)
    expect(userService.ensureContainer).not.toHaveBeenCalled()
  })

  it('容器不存在 + 真实签名 → 验签通过 302（创建流程被调）', async () => {
    const wallet = makeWallet()
    userService.containerExists.mockResolvedValue(false)
    userService.ensureContainer.mockResolvedValue(31002)

    const first = await bareConnect(wallet.address)
    expect(first.statusCode).toBe(401)
    const { nonce, message } = JSON.parse(first.body)

    const res = makeRes()
    const url = connectUrl({
      address: wallet.address,
      nonce,
      signature: wallet.sign(message),
      publicKey: wallet.publicKey,
    })
    await handleTenantRoutes(makeReq(), res, '/connect', url)
    expect(res.statusCode).toBe(302)
    expect(userService.ensureContainer).toHaveBeenCalledWith(wallet.address)
  })

  it('跨用途签名：拿 CONNECT 的挑战却签 CONFIG 用途消息 → 403（用途绑定加固）', async () => {
    const wallet = makeWallet()
    userService.containerExists.mockResolvedValue(false)
    userService.ensureContainer.mockResolvedValue(31002)

    const first = await bareConnect(wallet.address)
    const { nonce } = JSON.parse(first.body)
    // 攻击者持有的是"配置用途"的签名：地址正确、nonce 正确，但用途不同 → 必须拒绝
    const configCh = tenantConfigService.issueChallenge(wallet.address, SIGN_PURPOSE.TENANT_CONFIG)

    const res = makeRes()
    const url = connectUrl({
      address: wallet.address,
      nonce,
      signature: wallet.sign(configCh.message),
      publicKey: wallet.publicKey,
    })
    await handleTenantRoutes(makeReq(), res, '/connect', url)
    expect(res.statusCode).toBe(403)
    expect(userService.ensureContainer).not.toHaveBeenCalled()
  })

  it('container exists + signed + format=json → 200 JSON {url} + user_session cookie', async () => {
    const wallet = makeWallet()
    userService.containerExists.mockResolvedValue(false) // 不存在 → 第一步返回 401 挑战
    userService.ensureContainer.mockResolvedValue(31004)

    const first = await bareConnect(wallet.address)
    expect(first.statusCode).toBe(401)
    const { nonce, message } = JSON.parse(first.body)

    const res = makeRes()
    const url = connectUrl({
      address: wallet.address,
      nonce,
      signature: wallet.sign(message),
      publicKey: wallet.publicKey,
      format: 'json',
    })
    await handleTenantRoutes(makeReq(), res, '/connect', url)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.url).toMatch(/^http:\/\/[^/]+:31004\/$/)
    expect(body.address).toBe(wallet.address)
    expect(res.headers['set-cookie'] || '').toMatch(/^user_session=[a-f0-9]{64}/)
  })

  it('nonce 一次性：同 nonce 重放 → 403（防重放）', async () => {
    const wallet = makeWallet()
    userService.containerExists.mockResolvedValue(false)
    userService.ensureContainer.mockResolvedValue(31003)

    const first = await bareConnect(wallet.address)
    const { nonce, message } = JSON.parse(first.body)
    const sig = wallet.sign(message)
    const url = connectUrl({
      address: wallet.address,
      nonce,
      signature: sig,
      publicKey: wallet.publicKey,
    })

    const ok = makeRes()
    await handleTenantRoutes(makeReq(), ok, '/connect', url)
    expect(ok.statusCode).toBe(302)

    // 第二次同 nonce → 挑战已被消费
    const replay = makeRes()
    await handleTenantRoutes(makeReq(), replay, '/connect', url)
    expect(replay.statusCode).toBe(403)
    expect(JSON.parse(replay.body).error).toMatch(/挑战已失效/)
  })

  it('公钥与声称地址不符（他钱包签名）→ 403', async () => {
    const claimed = ADDR
    const strangerWallet = makeWallet() // 陌生钱包的密钥
    userService.containerExists.mockResolvedValue(false)

    const first = await bareConnect(claimed)
    const { nonce, message } = JSON.parse(first.body)

    const res = makeRes()
    const url = connectUrl({
      address: claimed,
      nonce,
      signature: strangerWallet.sign(message), // 用陌生钱包签
      publicKey: strangerWallet.publicKey, // deriveAddress !== claimed
    })
    await handleTenantRoutes(makeReq(), res, '/connect', url)
    expect(res.statusCode).toBe(403)
    expect(userService.ensureContainer).not.toHaveBeenCalled()
  })
})
