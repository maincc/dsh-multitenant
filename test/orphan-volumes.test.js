/**
 * 管理端"清理孤儿卷"功能测试
 *
 * 孤儿卷判定：dsh-data-swtc-* 前缀 + 不属于任何 state 用户 + 无任何容器挂载引用。
 * 本测试 mock dockerService，不触碰真实 Docker；mock userService 提供 state 用户。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { adminSessionStore } from '../src/middleware/auth.middleware.js'

const ADMIN_TOKEN = '11'.repeat(32) // 64 位 hex
const sha256 = (v) => createHash('sha256').update(v).digest('hex')

// state 中存在的用户（其卷必须被保护，绝不列为孤儿）
const STATE_ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const STATE_VOLUME = `dsh-data-swtc-${STATE_ADDR}`

// vi.hoisted：mock 工厂在文件最顶部执行，普通顶层 const 会晚于它初始化，
// 必须用 vi.hoisted 提供 mock 对象（含 vi.fn 引用）
const { dockerServiceMock } = vi.hoisted(() => ({
  dockerServiceMock: {
    listVolumes: vi.fn(),
    listReferencedVolumes: vi.fn(),
    removeVolume: vi.fn(),
  },
}))

vi.mock('../src/services/docker.service.js', () => ({ dockerService: dockerServiceMock }))

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    state: {
      // 注意：mock 工厂会被提升执行，不能引用文件级常量的运行时值；
      // 这里使用与 STATE_ADDR 相同的字面量
      swtcUsers: { jndwretndumoqbt2uauclmfmx7xbqjykva: { containerStatus: 'running' } },
    },
  },
}))

vi.mock('../src/services/cwt-admin.service.js', () => ({ cwtAdminService: {} }))
vi.mock('../src/services/tenant-config.service.js', async (importOriginal) => ({
  ...(await importOriginal()), // 保留 SIGN_PURPOSE / buildSignedMessage 真实导出
  // 加固后 cleanup 要求"当场签名"：密码学部分 mock 掉，一次性挑战池走真实语义
  tenantConfigService: {
    issueChallenge: vi.fn(),
    consumeChallenge: vi.fn(),
    verifySignature: vi.fn(),
  },
}))
vi.mock('../src/services/tenant-proxy.service.js', () => ({
  tenantGateway: { listen: vi.fn(), close: vi.fn() },
}))
vi.mock('../src/config/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAdmin: vi.fn(() => true),
}))
vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const mod = await importOriginal()
  const empty = {
    loadSessions: vi.fn(() => ({})),
    saveSessions: vi.fn(() => {}),
    loadUserSessions: vi.fn(() => ({})),
    saveUserSessions: vi.fn(() => {}),
    loadCwtRegistry: vi.fn(() => ({})),
    loadCwtApplications: vi.fn(() => []),
    readStateFile: vi.fn(() => null),
    saveState: vi.fn(() => {}),
  }
  return { dataService: { ...mod.dataService, ...empty } }
})

import { handleAdminRoutes } from '../src/routes/admin.routes.js'
import { dockerService } from '../src/services/docker.service.js'
import { tenantConfigService } from '../src/services/tenant-config.service.js'
import { normalizeAddress } from '../src/utils/address.js'

/**
 * 真流式 mock：cleanup 端点现在要 parseBody（data/end 事件），
 * 老版 makeReq 的 on() 空转会让 Promise 永远悬挂。
 */
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

function makeReq(opts) {
  return new MockReq(opts)
}

function makeRes() {
  return {
    headersSent: false,
    status: 0,
    body: '',
    writeHead(code) {
      this.status = code
      this.headersSent = true
    },
    end(payload) {
      this.body = payload || ''
      if (typeof payload === 'string' && payload.startsWith('{')) {
        this.json = JSON.parse(payload)
      }
    },
  }
}

const ROUTES = {
  orphanList: '/api/admin/orphan-volumes',
  orphanCleanup: '/api/admin/cleanup-orphan-volumes',
}

/** 典型卷清单：州用户卷 + 被引用卷 + 真孤儿 + 非租户卷 */
const TYPICAL_VOLUMES = [
  STATE_VOLUME,
  'dsh-data-swtc-referencedvol',
  'dsh-data-swtc-orphan1',
  'dsh-data-swtc-orphan2',
  'dsh-other-volume',
]

beforeEach(() => {
  vi.clearAllMocks()
  adminSessionStore.sessions[sha256(ADMIN_TOKEN)] = {
    address: STATE_ADDR,
    expiresAt: Date.now() + 3600e3,
  }
  dockerServiceMock.listVolumes.mockResolvedValue([...TYPICAL_VOLUMES])
  dockerServiceMock.listReferencedVolumes.mockResolvedValue(
    new Set(['dsh-data-swtc-referencedvol']),
  )
  dockerServiceMock.removeVolume.mockResolvedValue(undefined)
  mockChallengeFlow()
})

/** 一次性挑战池（密码学 mock 掉，语义走真实：只有发放过的 nonce 能消费一次） */
const issuedChallenges = new Set()
function mockChallengeFlow() {
  issuedChallenges.clear()
  tenantConfigService.issueChallenge.mockImplementation((addr, purpose) => {
    const nonce = `nonce-${addr}-${issuedChallenges.size}`
    issuedChallenges.add(nonce)
    return { nonce, message: `dsh-multitenant|${purpose}|${addr}|${nonce}` }
  })
  tenantConfigService.consumeChallenge.mockImplementation((addr, nonce) => {
    if (!issuedChallenges.has(nonce)) return false
    issuedChallenges.delete(nonce)
    return true
  })
  tenantConfigService.verifySignature.mockImplementation(
    (addr, message, signature) => signature === `sig:${message}`,
  )
}

/** 领一个绑定 (operation,payload) 的挑战，返回签名请求头 */
async function signedHeaders(operation, payload) {
  const res = makeRes()
  await handleAdminRoutes(
    makeReq({
      method: 'POST',
      url: '/api/admin/challenge',
      cookie: `admin_session=${ADMIN_TOKEN}`,
      body: { address: STATE_ADDR, operation, payload },
    }),
    res,
    '/api/admin/challenge',
    new URL('http://x/api/admin/challenge'),
  )
  if (res.status !== 200) throw new Error(`挑战发放失败: ${res.status} ${res.body}`)
  const { nonce, message } = res.json
  return {
    'x-admin-nonce': nonce,
    'x-admin-signature': `sig:${message}`,
    'x-admin-pubkey': 'PUBKEY',
  }
}

/** 发起一次 cleanup POST（可带签名头与 body） */
async function callCleanup({ headers = {}, body } = {}) {
  const res = makeRes()
  await handleAdminRoutes(
    makeReq({
      method: 'POST',
      url: ROUTES.orphanCleanup,
      cookie: `admin_session=${ADMIN_TOKEN}`,
      body,
      ...headers,
    }),
    res,
    ROUTES.orphanCleanup,
    new URL(`http://x${ROUTES.orphanCleanup}`),
  )
  return res
}

describe('管理端孤儿卷管理', () => {
  it('无管理员会话 → 拒绝（非 200）', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: ROUTES.orphanList }),
      res,
      ROUTES.orphanList,
      new URL(`http://x${ROUTES.orphanList}`),
    )
    expect(res.status).not.toBe(200)
    expect(dockerServiceMock.listVolumes).not.toHaveBeenCalled()
  })

  it('GET 列出孤儿卷：只包含「非 state 用户 + 无引用」的 dsh-data-swtc-* 卷', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: ROUTES.orphanList, cookie: `admin_session=${ADMIN_TOKEN}` }),
      res,
      ROUTES.orphanList,
      new URL(`http://x${ROUTES.orphanList}`),
    )
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(res.json.orphanVolumes).toEqual(['dsh-data-swtc-orphan1', 'dsh-data-swtc-orphan2'])
    expect(res.json.total).toBe(2)
    // state 用户卷不在孤儿列表
    expect(res.json.orphanVolumes).not.toContain(STATE_VOLUME)
  })

  it('state 地址大小写归一化后再比对，大写卷名同样受保护', async () => {
    dockerServiceMock.listVolumes.mockResolvedValue([
      `dsh-data-swtc-${normalizeAddress(STATE_ADDR).toUpperCase()}`,
      'dsh-data-swtc-orphan9',
    ])
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: ROUTES.orphanList, cookie: `admin_session=${ADMIN_TOKEN}` }),
      res,
      ROUTES.orphanList,
      new URL(`http://x${ROUTES.orphanList}`),
    )
    expect(res.json.orphanVolumes).toEqual(['dsh-data-swtc-orphan9'])
  })

  it('POST 清理：只删除【签署清单 ∩ 仍是孤儿】，state 用户卷与被引用卷不受影响', async () => {
    const volumes = ['dsh-data-swtc-orphan1', 'dsh-data-swtc-orphan2']
    const headers = await signedHeaders('cleanup-orphan-volumes', { volumes })
    const res = await callCleanup({ headers, body: { volumes } })
    expect(res.status).toBe(200)
    expect(res.json.removed).toEqual(['dsh-data-swtc-orphan1', 'dsh-data-swtc-orphan2'])
    expect(res.json.failed).toEqual([])
    expect(res.json.skipped).toEqual([])
    // removeVolume 只对孤儿调用
    const removedCalls = dockerServiceMock.removeVolume.mock.calls.map((c) => c[0])
    expect(removedCalls).toEqual(['dsh-data-swtc-orphan1', 'dsh-data-swtc-orphan2'])
    expect(removedCalls).not.toContain(STATE_VOLUME)
    expect(removedCalls).not.toContain('dsh-data-swtc-referencedvol')
  })

  it('POST 清理：删除失败逐个记录，不影响其他卷', async () => {
    dockerServiceMock.removeVolume.mockImplementation((v) => {
      if (v.includes('orphan2')) return Promise.reject(new Error('volume in use'))
      return Promise.resolve()
    })
    const volumes = ['dsh-data-swtc-orphan1', 'dsh-data-swtc-orphan2']
    const headers = await signedHeaders('cleanup-orphan-volumes', { volumes })
    const res = await callCleanup({ headers, body: { volumes } })
    expect(res.json.removed).toEqual(['dsh-data-swtc-orphan1'])
    expect(res.json.failed).toEqual([{ name: 'dsh-data-swtc-orphan2', error: 'volume in use' }])
  })

  it('POST 清理：只有会话没有签名 → 403 SIGNATURE_REQUIRED，一个卷都不删（红线收口）', async () => {
    const res = await callCleanup({
      body: { volumes: ['dsh-data-swtc-orphan1', 'dsh-data-swtc-orphan2'] },
    })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('SIGNATURE_REQUIRED')
    expect(dockerServiceMock.removeVolume).not.toHaveBeenCalled()
  })

  it('POST 清理：不携带 volumes 清单 → 400（批量删除必须显式列出目标）', async () => {
    const res = await callCleanup({ body: {} })
    expect(res.status).toBe(400)
    expect(res.json.code).toBe('BAD_REQUEST')
    expect(dockerServiceMock.removeVolume).not.toHaveBeenCalled()
  })

  it('POST 清理：签了 1 个卷却执行 2 个 → SIGNATURE_MISMATCH（清单绑进签名，不可偷换）', async () => {
    const headers = await signedHeaders('cleanup-orphan-volumes', {
      volumes: ['dsh-data-swtc-orphan1'],
    })
    // 执行时把"被引用的卷"偷塞进清单——它在孤儿集里根本不存在，即便清单被改写
    // 也进不了删除循环；但更根本的是：签名内容与执行内容不一致，先被 binding 拒掉
    const res = await callCleanup({
      headers,
      body: { volumes: ['dsh-data-swtc-orphan1', 'dsh-data-swtc-referencedvol'] },
    })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('SIGNATURE_MISMATCH')
    expect(dockerServiceMock.removeVolume).not.toHaveBeenCalled()
  })

  it('POST 清理：签署清单里已不再是孤儿的卷 → skipped，绝不越界删除', async () => {
    // orphan2 被新容器重新挂上（用户回来了）：本轮 collect 它不再是孤儿
    dockerServiceMock.listVolumes.mockResolvedValue([
      STATE_VOLUME,
      'dsh-data-swtc-orphan1',
      'dsh-data-swtc-orphan2',
    ])
    dockerServiceMock.listReferencedVolumes.mockResolvedValue(new Set(['dsh-data-swtc-orphan2']))
    const volumes = ['dsh-data-swtc-orphan1', 'dsh-data-swtc-orphan2']
    const headers = await signedHeaders('cleanup-orphan-volumes', { volumes })
    const res = await callCleanup({ headers, body: { volumes } })
    expect(res.status).toBe(200)
    expect(res.json.removed).toEqual(['dsh-data-swtc-orphan1'])
    expect(res.json.skipped).toEqual(['dsh-data-swtc-orphan2'])
    const removedCalls = dockerServiceMock.removeVolume.mock.calls.map((c) => c[0])
    expect(removedCalls).not.toContain('dsh-data-swtc-orphan2')
  })
})
