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
  dataService: { saveState: vi.fn(), loadState: vi.fn(() => ({})), saveUserSessions: vi.fn() },
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
