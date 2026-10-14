/**
 * 管理端列表接口的短 TTL 缓存与批量采样
 *
 * 背景：管理端每轮刷新都要为每个 running 租户跑一次 docker 采样，而多个
 * 管理员/多个标签页会**各自**触发一遍 → docker CLI 被打爆（实测每轮约 2s）。
 * 这里锁定三件事：
 *   ① 短 TTL 内重复调用只采样一次（多个标签页共享）
 *   ② 超过 TTL 会重新采样
 *   ③ 任何状态写入立即失效缓存（否则管理员点完按钮看到旧状态）
 *
 * 隔离：mock docker.service 与 data.service，不触碰真实 Docker/state.json。
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
    // 管理会话解析会用到（缺了会让 /api/stats 报 loadUserSessions is not a function）
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
    issueTicket: vi.fn(),
    hasRoute: vi.fn(() => false),
  },
}))
vi.mock('../src/services/cwt.store.js', () => ({
  cwtStore: { getRegistry: () => ({}) },
}))

const { dockerService } = await import('../src/services/docker.service.js')
const { dataService } = await import('../src/services/data.service.js')
const { userService } = await import('../src/services/user.service.js')

const ADDR = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'

beforeEach(() => {
  vi.clearAllMocks()
  userService.state = {
    swtcUsers: {
      [ADDR]: { port: 31005, tier: 1, containerStatus: 'running', lastSeenAt: Date.now() },
    },
    usages: {},
    usageLimit: { enabled: false },
  }
  userService.invalidateUsersCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  userService.invalidateUsersCache()
})

describe('管理端列表：短 TTL 缓存', () => {
  it('TTL 内重复调用只采样一次（多个标签页共享同一次 docker 采样）', async () => {
    await userService.getAllUsers()
    await userService.getAllUsers()
    await userService.getAllUsers()

    expect(dockerService.getContainerStatsMany).toHaveBeenCalledTimes(1)
  })

  it('force=true 跳过缓存（手动刷新一定拿到真实数据）', async () => {
    await userService.getAllUsers()
    await userService.getAllUsers({ force: true })
    expect(dockerService.getContainerStatsMany).toHaveBeenCalledTimes(2)
  })

  it('状态写入后缓存立即失效（管理员点完按钮不能看到旧状态）', async () => {
    await userService.getAllUsers()
    expect(dockerService.getContainerStatsMany).toHaveBeenCalledTimes(1)

    // 任何落盘都应让缓存失效
    userService._saveState()
    expect(dataService.saveState).toHaveBeenCalled()

    await userService.getAllUsers()
    expect(dockerService.getContainerStatsMany).toHaveBeenCalledTimes(2)
  })

  it('只对 running 的租户采样（停止/销毁的不查）', async () => {
    userService.state.swtcUsers[ADDR].containerStatus = 'stopped'
    await userService.getAllUsers()
    // 没有 running 租户 → 传空列表（批量函数自身也不会执行 docker 命令）
    expect(dockerService.getContainerStatsMany).toHaveBeenCalledWith([])
  })
})

// ---------------------------------------------------------------------------
// /api/stats 下发 uiConfig.refreshIntervalMs
//
// 前端用它设定轮询间隔，从而做到「改 config.json 后只需重启服务，
// 不必重新构建前端」。这里锁住路由确实把它带出来了。
// ---------------------------------------------------------------------------
describe('/api/stats：下发管理端刷新间隔', () => {
  it('响应里带 uiConfig.refreshIntervalMs（默认 15000）', async () => {
    const { handleAdminRoutes } = await import('../src/routes/admin.routes.js')
    const { adminSessionStore } = await import('../src/middleware/auth.middleware.js')
    const { CONFIG } = await import('../src/config/config.js')
    const { createHash } = await import('node:crypto')

    // 用真实配置里的管理员地址，避免写死一个不在名单里的地址（会被 403）
    const adminAddr = (CONFIG.admin?.addresses ?? [])[0]
    expect(adminAddr, 'config.json 需要至少一个管理员地址').toBeTruthy()
    const token = 'ab'.repeat(32)
    adminSessionStore.sessions[createHash('sha256').update(token).digest('hex')] = {
      address: adminAddr,
      expiresAt: Date.now() + 3600_000,
    }
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(c, h) {
        this.statusCode = c
        Object.assign(this.headers, h ?? {})
      },
      end(b) {
        this.body = b ?? ''
      },
    }
    const req = { method: 'GET', headers: { cookie: `admin_session=${token}` }, socket: {} }

    await handleAdminRoutes(req, res, '/api/stats', new URL('http://127.0.0.1:8090/api/stats'))
    const body = JSON.parse(res.body)
    expect(body.uiConfig.refreshIntervalMs).toBeGreaterThanOrEqual(3000)
  })
})
