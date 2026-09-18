/**
 * 管理端破坏性操作的"当场签名"加固测试。
 *
 * 背景（本测试针对的真实漏洞）：
 *   `admin_session` 是 12 小时有效的 bearer token，`requireAdmin` 只做
 *   sha256 查表 + 过期判断，**不验签**。而租户网关会把浏览器 cookie 原样
 *   转发进租户容器（`path=/` 的 cookie 不按端口隔离），于是"管理员访问过的
 *   租户"能拿到这串 token 并重放 —— 实测仅凭 cookie 可 promote / force-stop。
 *
 * 加固做法：破坏性操作除会话外还要**当场钱包签名**，且签名绑定的内容由
 * 服务端从 (operation, payload) 推导，nonce 一次性、5 分钟过期。
 *
 * 本文件覆盖：
 *   ① 无签名 → SIGNATURE_REQUIRED（核心回归：光有 cookie 不再够）
 *   ② 挑战与执行的操作/目标不一致 → SIGNATURE_MISMATCH（不能偷换）
 *   ③ nonce 重放 → CHALLENGE_INVALID（一次性）
 *   ④ 伪造签名 → SIGNATURE_INVALID
 *   ⑤ 未知操作 → SIGNATURE_NOT_APPLICABLE
 *   ⑥ 给别人的地址签 → 挑战接口 403（不能骗管理员为他人签名）
 *   ⑦ 破坏性操作确实落到业务层（签名正确时不被误伤）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { tenantConfigService } from '../src/services/tenant-config.service.js'
import { adminSessionStore } from '../src/middleware/auth.middleware.js'
import { handleAdminRoutes } from '../src/routes/admin.routes.js'
import { handleTenantRoutes } from '../src/routes/tenant.routes.js'
import { userService } from '../src/services/user.service.js'

const ADMIN_ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const OTHER_ADDR = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'
const TENANT = OTHER_ADDR
/** 第三个地址：专用于"挑战绑的目标 ≠ 执行的目标"用例 */
const THIRD_ADDR = 'j3xhos5osubqmfaekq3rxufrzbbucghwrv'
const ADMIN_TOKEN = 'ab'.repeat(32)
const sha256 = (v) => createHash('sha256').update(v).digest('hex')

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    forceStopContainer: vi.fn(),
    destroyContainer: vi.fn(),
    deleteUserVolume: vi.fn(),
    state: { swtcUsers: {} },
  },
}))
// 数据层走真实实现，但把"会话/状态 load/save"替换为内存空 + 落空，避免测试
// 写入真实 data/（与 routes.test.js 同款策略）
vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    dataService: {
      ...mod.dataService,
      loadSessions: vi.fn(() => ({})),
      loadUserSessions: vi.fn(() => ({})),
      loadCwtRegistry: vi.fn(() => ({})),
      loadCwtApplications: vi.fn(() => []),
      readStateFile: vi.fn(() => null),
      saveState: vi.fn(() => {}),
      saveUserSessions: vi.fn(() => {}),
      saveSessions: vi.fn(() => {}),
      saveCwtRegistry: vi.fn(() => {}),
      saveCwtApplications: vi.fn(() => {}),
      addAdmin: vi.fn(() => true),
      logOperation: vi.fn(),
      getAdminConfig: vi.fn(() => ({ addresses: [], history: [] })),
      saveAdminConfig: vi.fn(),
    },
  }
})
vi.mock('../src/services/docker.service.js', () => ({ dockerService: {} }))
vi.mock('../src/services/cwt-admin.service.js', () => ({ cwtAdminService: {} }))
vi.mock('../src/services/tenant-proxy.service.js', () => ({ tenantGateway: {} }))
vi.mock('../src/services/dsh-version.service.js', () => ({ dshVersionService: {} }))
vi.mock('../src/config/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAdmin: vi.fn(() => true),
}))

class MockReq extends EventEmitter {
  constructor({ method = 'GET', url = '/', cookie = '', body, ...extraHeaders } = {}) {
    super()
    this.method = method
    this.url = url
    this.headers = { host: '127.0.0.1:8090', cookie, ...extraHeaders }
    this._payload = body === undefined ? '' : JSON.stringify(body)
  }
  on(event, listener) {
    super.on(event, listener)
    if (event === 'end') {
      setImmediate(() => {
        if (this._payload) super.emit('data', this._payload)
        super.emit('end')
      })
    }
    return this
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

function makeReq(opts) {
  return new MockReq(opts)
}

const adminCookie = () => `admin_session=${ADMIN_TOKEN}`

/** 走真实的挑战池领一个绑定到 (operation,payload) 的挑战 */
async function issueChallenge(operation, payload, { address = ADMIN_ADDR } = {}) {
  const res = makeRes()
  await handleAdminRoutes(
    makeReq({
      method: 'POST',
      url: '/api/admin/challenge',
      cookie: adminCookie(),
      body: { address, operation, payload },
    }),
    res,
    '/api/admin/challenge',
  )
  return { res, data: res.statusCode === 200 ? json(res) : null }
}

/** 用挑战结果拼出签名请求头（签名格式与 mock 的 verifySignature 对齐） */
function headersFor(data, { signature } = {}) {
  return {
    'x-admin-nonce': data.nonce,
    'x-admin-signature': signature ?? `sig:${data.message}`,
    'x-admin-pubkey': 'PUBKEY',
  }
}

/** 执行一次 promote（最短路径的破坏性操作） */
async function callPromote(headers, address = TENANT) {
  const res = makeRes()
  await handleAdminRoutes(
    makeReq({
      method: 'POST',
      url: `/api/admin/promote/${address}`,
      cookie: adminCookie(),
      ...headers,
    }),
    res,
    `/api/admin/promote/${address}`,
  )
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  // 只把密码学部分替掉，挑战池用真实实现（一次性语义必须被真实验证）
  vi.spyOn(tenantConfigService, 'verifySignature').mockImplementation(
    (addr, message, signature) => signature === `sig:${message}`,
  )
  adminSessionStore.sessions = {
    [sha256(ADMIN_TOKEN)]: { address: ADMIN_ADDR, expiresAt: Date.now() + 3600e3 },
  }
  userService.state.swtcUsers = {}
})

describe('加固：破坏性操作必须当场签名', () => {
  it('① 只有 admin_session、没有任何签名 → SIGNATURE_REQUIRED（核心回归）', async () => {
    const res = await callPromote({})
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_REQUIRED')
    // 关键：业务层**绝不能**被触达
    expect(userService.state.swtcUsers[TENANT]).toBeUndefined()
  })

  it('①b 只带部分签名材料（缺公钥）同样拒绝', async () => {
    const { data } = await issueChallenge('promote', { address: TENANT })
    const res = await callPromote({
      'x-admin-nonce': data.nonce,
      'x-admin-signature': `sig:${data.message}`,
      // 故意不给公钥
    })
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_REQUIRED')
  })

  it('② 挑战绑定别的目标、却执行本目标 → SIGNATURE_MISMATCH（不能偷换目标）', async () => {
    // 会话身份不变（挑战必须绑在会话地址上），但绑定的目标故意换成 THIRD_ADDR；
    // 执行时打 TENANT → 服务端推导出的 binding 不同，必须拒。
    const { data } = await issueChallenge('promote', { address: THIRD_ADDR })
    expect(data.binding).toBe(`promote:address=${THIRD_ADDR}`)
    const res = await callPromote(headersFor(data), TENANT)
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_MISMATCH')
  })

  it('②b 用 promote 的挑战去 force-stop → SIGNATURE_MISMATCH', async () => {
    const { data } = await issueChallenge('promote', { address: TENANT })
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: `/api/admin/force-stop/${TENANT}`,
        cookie: adminCookie(),
        ...headersFor(data),
      }),
      res,
      `/api/admin/force-stop/${TENANT}`,
    )
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_MISMATCH')
    expect(userService.forceStopContainer).not.toHaveBeenCalled()
  })

  it('③ nonce 重放（同一份签名用两次）→ 第二次 CHALLENGE_INVALID', async () => {
    userService.destroyContainer.mockResolvedValue({ ok: true })
    const { data } = await issueChallenge('remove', { address: TENANT, keepVolume: false })
    const headers = headersFor(data)

    const first = makeRes()
    await handleTenantRoutes(
      makeReq({
        method: 'POST',
        url: `/api/user/${TENANT}/remove`,
        cookie: adminCookie(),
        ...headers,
      }),
      first,
      `/api/user/${TENANT}/remove`,
      new URL(`http://127.0.0.1:8090/api/user/${TENANT}/remove`),
    )
    expect(first.statusCode).toBe(200)

    const second = makeRes()
    await handleTenantRoutes(
      makeReq({
        method: 'POST',
        url: `/api/user/${TENANT}/remove`,
        cookie: adminCookie(),
        ...headers,
      }),
      second,
      `/api/user/${TENANT}/remove`,
      new URL(`http://127.0.0.1:8090/api/user/${TENANT}/remove`),
    )
    expect(second.statusCode).toBe(403)
    expect(json(second).code).toBe('CHALLENGE_INVALID')
    // 只应真正删过一次
    expect(userService.destroyContainer).toHaveBeenCalledTimes(1)
  })

  it('④ 伪造签名（签的不是服务端下发的 message）→ SIGNATURE_INVALID', async () => {
    const { data } = await issueChallenge('promote', { address: TENANT })
    const res = await callPromote(headersFor(data, { signature: 'sig:伪造的内容' }))
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_INVALID')
  })

  it('⑤ 没有先领挑战就执行 → CHALLENGE_INVALID（不能自造 nonce）', async () => {
    const res = await callPromote({
      'x-admin-nonce': 'i-made-this-up',
      'x-admin-signature': 'sig:i-made-this-up',
      'x-admin-pubkey': 'PUBKEY',
    })
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('CHALLENGE_INVALID')
  })

  it('⑥ 给非本人地址领挑战 → 403（不能骗管理员为他人签名）', async () => {
    const { res } = await issueChallenge('promote', { address: TENANT }, { address: OTHER_ADDR })
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('FORBIDDEN')
  })

  it('⑤b 未知操作 → SIGNATURE_NOT_APPLICABLE', async () => {
    const { res } = await issueChallenge('rm-rf', { address: TENANT })
    expect(res.statusCode).toBe(400)
    expect(json(res).code).toBe('SIGNATURE_NOT_APPLICABLE')
  })

  it('⑦ 签名正确时不误伤：remove 落到业务层且 keepVolume 语义正确', async () => {
    userService.destroyContainer.mockResolvedValue({ ok: true, volume: 'kept' })
    const { data } = await issueChallenge('remove', { address: TENANT, keepVolume: true })
    const res = makeRes()
    await handleTenantRoutes(
      makeReq({
        method: 'POST',
        url: `/api/user/${TENANT}/remove?keepVolume=1`,
        cookie: adminCookie(),
        ...headersFor(data),
      }),
      res,
      `/api/user/${TENANT}/remove`,
      new URL(`http://127.0.0.1:8090/api/user/${TENANT}/remove?keepVolume=1`),
    )
    expect(res.statusCode).toBe(200)
    expect(userService.destroyContainer).toHaveBeenCalledWith(TENANT, true, { keepVolume: true })
  })

  it('⑦b keepVolume 不同的两次挑战不能互换（绑定含 keepVolume）', async () => {
    const { data } = await issueChallenge('remove', { address: TENANT, keepVolume: false })
    const res = makeRes()
    await handleTenantRoutes(
      makeReq({
        method: 'POST',
        url: `/api/user/${TENANT}/remove?keepVolume=1`,
        cookie: adminCookie(),
        ...headersFor(data),
      }),
      res,
      `/api/user/${TENANT}/remove`,
      new URL(`http://127.0.0.1:8090/api/user/${TENANT}/remove?keepVolume=1`),
    )
    // 签的是 keepVolume=0，执行的是 keepVolume=1 → 语义不一致，必须拒
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_MISMATCH')
    expect(userService.destroyContainer).not.toHaveBeenCalled()
  })

  it('⑧ 无会话时仍是 FORBIDDEN（签名不能替代身份）', async () => {
    const { data } = await issueChallenge('promote', { address: TENANT })
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: `/api/admin/promote/${TENANT}`,
        cookie: '',
        ...headersFor(data),
      }),
      res,
      `/api/admin/promote/${TENANT}`,
    )
    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('FORBIDDEN')
  })
})

describe('加固：绑定串由服务端推导', () => {
  it('promote / force-stop / delete-volume 绑定各自的操作名', async () => {
    const cases = [
      ['promote', `promote:address=${TENANT}`],
      ['force-stop', `force-stop:address=${TENANT}`],
      ['delete-volume', `delete-volume:address=${TENANT}`],
    ]
    for (const [op, expected] of cases) {
      const { data } = await issueChallenge(op, { address: TENANT })
      expect(data.binding).toBe(expected)
      expect(data.message).toBe(`${data.nonce}|${expected}`)
    }
  })

  it('dsh/apply 单租户绑地址、批量绑 all=1', async () => {
    const one = await issueChallenge('dsh/apply', { address: TENANT })
    expect(one.data.binding).toBe(`dsh/apply:address=${TENANT}`)
    const all = await issueChallenge('dsh/apply', { all: true })
    expect(all.data.binding).toBe('dsh/apply:all=1')
  })

  it('remove 绑定 keepVolume 语义', async () => {
    const keep = await issueChallenge('remove', { address: TENANT, keepVolume: true })
    expect(keep.data.binding).toBe(`remove:address=${TENANT}:keepVolume=1`)
    const wipe = await issueChallenge('remove', { address: TENANT, keepVolume: false })
    expect(wipe.data.binding).toBe(`remove:address=${TENANT}:keepVolume=0`)
  })

  it('地址大小写不影响绑定（统一小写）', async () => {
    const lower = await issueChallenge('promote', { address: TENANT.toLowerCase() })
    const upper = await issueChallenge('promote', { address: TENANT.toUpperCase() })
    expect(lower.data.binding).toBe(upper.data.binding)
  })
})
