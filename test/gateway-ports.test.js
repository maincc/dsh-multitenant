/**
 * GET /api/admin/gateway-ports —— 隧道同步面（2026-11-12）。
 * 钉死门禁矩阵：同机回环放行 / 站外无口令 404（不泄露端口地图）/ Bearer 口令
 * 放行 / 口令不符同样 404；以及返回形状（ports+entry）供 frpc 同步脚本消费。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/services/docker.service.js', () => ({
  dockerService: {
    isDockerAvailable: vi.fn(async () => true),
    getContainerStatsMany: vi.fn(async () => new Map()),
    containerDshVersion: vi.fn(async () => null),
    containerImageId: vi.fn(async () => null),
    listSwtcContainers: vi.fn(async () => []),
    listReferencedImageIds: vi.fn(async () => new Set()),
    listImages: vi.fn(async () => []),
    imageCapability: vi.fn(async () => ({ version: null, imageId: null, requiresToken: null })),
  },
}))
vi.mock('../src/services/data.service.js', () => ({
  dataService: {
    saveState: vi.fn(),
    loadState: vi.fn(() => ({})),
    saveUserSessions: vi.fn(),
    loadUserSessions: vi.fn(() => ({})),
    loadSessions: vi.fn(() => ({})),
    saveSessions: vi.fn(),
    getAdminConfig: vi.fn(() => ({ addresses: [], history: [], updatedAt: null })),
    saveAdminConfig: vi.fn(),
  },
}))
vi.mock('../src/services/tenant-proxy.service.js', () => ({
  tenantGateway: {
    listen: vi.fn(),
    close: vi.fn(),
    issueTicket: vi.fn(() => null),
    hasRoute: vi.fn(() => false),
  },
}))
vi.mock('../src/services/cwt.store.js', () => ({
  cwtStore: { getRegistry: () => ({}) },
}))

const { handleAdminRoutes } = await import('../src/routes/admin.routes.js')
const { userService } = await import('../src/services/user.service.js')

const ADDR = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'
const TOKEN = 'sekrit-tunnel-token'
const PATH = '/api/admin/gateway-ports'

const req = (remote, auth) => ({
  method: 'GET',
  url: PATH,
  socket: { remoteAddress: remote },
  headers: auth ? { authorization: auth } : {},
})
const mkRes = () => {
  const r = { statusCode: null, body: '', headers: {} }
  r.writeHead = (c, h) => {
    r.statusCode = c
    r.headers = h || {}
  }
  r.end = (d) => {
    r.body = d
  }
  return r
}

beforeEach(() => {
  userService.state = {
    swtcUsers: {
      [ADDR]: { port: 31005, tier: 1, containerStatus: 'running' },
      jnomappd000000000000000000000000000000: { tier: 1, containerStatus: 'stopped' }, // 无端口租户不入册
    },
    usages: {},
    usageLimit: { enabled: false },
  }
  process.env.TUNNEL_SYNC_TOKEN = TOKEN
})
afterEach(() => {
  delete process.env.TUNNEL_SYNC_TOKEN
  for (const k of ['PUBLIC_HOST', 'PUBLIC_PORT', 'PUBLIC_SCHEME']) delete process.env[k]
})

describe('gateway-ports 隧道同步面', () => {
  it('回环来源 → 200，ports 只含有端口租户，entry 带对外形态', async () => {
    process.env.PUBLIC_HOST = 'dsh.wh.jccdex.cn'
    process.env.PUBLIC_PORT = '8550'
    process.env.PUBLIC_SCHEME = 'https'
    const res = mkRes()
    const handled = await handleAdminRoutes(req('127.0.0.1'), res, PATH)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const j = JSON.parse(res.body)
    expect(j.ports).toEqual([{ address: ADDR, port: 31005, status: 'running' }])
    expect(j.entry).toEqual({ host: 'dsh.wh.jccdex.cn', port: 8550, scheme: 'https' })
  })

  it('站外来源无口令 → 404（与不存在同形）', async () => {
    const res = mkRes()
    await handleAdminRoutes(req('203.0.113.9'), res, PATH)
    expect(res.statusCode).toBe(404)
  })

  it('占用账本与端口段形态透出（混段部署运维面）', async () => {
    userService.state.externalOccupations = {
      40180: { port: 40180, scope: 'public', firstSeen: 1, lastSeen: 2, hits: 3 },
    }
    const res = mkRes()
    await handleAdminRoutes(req('127.0.0.1'), res, PATH)
    const j = JSON.parse(res.body)
    expect(j.occupied).toEqual([
      { port: 40180, scope: 'public', firstSeen: 1, lastSeen: 2, hits: 3 },
    ])
    expect(j.ranges.internal).toBeNull() // 默认单段模式
  })

  it('站外 + Bearer 口令正确 → 200', async () => {
    const res = mkRes()
    await handleAdminRoutes(req('203.0.113.9', `Bearer ${TOKEN}`), res, PATH)
    expect(res.statusCode).toBe(200)
  })

  it('口令不符/长度伪装/ scheme 伪装 → 404', async () => {
    for (const bad of ['Bearer nope', `Bearer ${TOKEN}x`, 'Basic ' + TOKEN]) {
      const res = mkRes()
      await handleAdminRoutes(req('203.0.113.9', bad), res, PATH)
      expect(res.statusCode).toBe(404)
    }
  })

  it('未配置口令时：站外一律 404（回环仍放行）', async () => {
    delete process.env.TUNNEL_SYNC_TOKEN
    const r1 = mkRes()
    await handleAdminRoutes(req('203.0.113.9', 'Bearer whatever'), r1, PATH)
    expect(r1.statusCode).toBe(404)
    const r2 = mkRes()
    await handleAdminRoutes(req('::1'), r2, PATH)
    expect(r2.statusCode).toBe(200)
  })
})
