/**
 * 网关路由自愈（ensureGatewayRoutes）回归测试。
 *
 * 背景（真实故障）：
 *   `restoreFromDocker()` 只在**平台启动那一刻**检查容器状态。但容器可以在平台
 *   运行期间被重建（清理机制先销毁 → 用户再连接时新建），于是出现
 *   "容器 running、state.port 有值、平台却没有该端口的路由"。用户访问容器 URL
 *   拿到网关的 403「该租户容器需要登录会话才能访问，请回到平台重新连接」，
 *   而容器本身完全正常（实测：平台重启后路由才回来）。
 *
 * 自愈要求：幂等、只补不拆、单个租户失败不影响其它租户。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/services/docker.service.js', () => ({
  dockerService: {
    publishedPort: vi.fn(),
    containerInfo: vi.fn(),
    restartContainer: vi.fn(),
    waitReady: vi.fn(),
    imageCapability: vi.fn(),
  },
}))

vi.mock('../src/services/tenant-proxy.service.js', () => ({
  tenantGateway: {
    hasRoute: vi.fn(),
    listen: vi.fn(),
    close: vi.fn(),
    closeAll: vi.fn(),
    ownerOf: vi.fn(),
  },
  AUTH_COOKIE_PREFIX: 'dsh-auth-',
}))

vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const mod = await importOriginal()
  const empty = {
    loadState: vi.fn(() => ({
      swtcUsers: {},
      availablePorts: [],
      usages: {},
      cleanupPolicy: {},
    })),
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
  }
  return { dataService: { ...mod.dataService, ...empty } }
})

vi.mock('../src/services/cwt-admin.service.js', () => ({ cwtAdminService: {} }))

import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { tenantGateway } from '../src/services/tenant-proxy.service.js'

const A1 = 'jhfamgqipxtakkdnamduoppim4shcdztea'
const A2 = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const A3 = 'jga9j9tkqtbcuohe2zqhvffbgguved6o9or'

describe('ensureGatewayRoutes：网关路由自愈', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // capability 探测走镜像 → 这里只关心路由注册，返回固定能力
    vi.spyOn(userService, 'resolveTenantCapability').mockResolvedValue({
      requiresToken: true,
      version: '0.1.5-rc.1',
    })
    tenantGateway.listen.mockResolvedValue(undefined)
    dockerService.publishedPort.mockResolvedValue(45377)
  })

  it('running 但无路由 → 补回监听', async () => {
    userService.state.swtcUsers = {
      [A1]: { port: 31016, containerStatus: 'running' },
    }
    tenantGateway.hasRoute.mockReturnValue(false)

    const r = await userService.ensureGatewayRoutes()

    expect(r).toEqual({ checked: 1, restored: 1, failed: 0 })
    expect(tenantGateway.listen).toHaveBeenCalledWith(
      31016,
      45377,
      A1,
      expect.objectContaining({ requiresToken: true }),
    )
  })

  it('已有正确路由 → 不重复 listen（幂等）', async () => {
    userService.state.swtcUsers = {
      [A1]: { port: 31016, containerStatus: 'running' },
    }
    tenantGateway.hasRoute.mockReturnValue(true)

    const r = await userService.ensureGatewayRoutes()

    expect(r).toEqual({ checked: 1, restored: 0, failed: 0 })
    expect(tenantGateway.listen).not.toHaveBeenCalled()
  })

  it('只处理 running：stopped / destroyed 一律跳过', async () => {
    userService.state.swtcUsers = {
      [A1]: { port: 31016, containerStatus: 'stopped' },
      [A2]: { port: 31017, containerStatus: 'destroyed' },
      [A3]: { port: 31018, containerStatus: 'running' },
    }
    tenantGateway.hasRoute.mockReturnValue(false)

    const r = await userService.ensureGatewayRoutes()

    expect(r.checked).toBe(1) // 只有 A3
    expect(tenantGateway.listen).toHaveBeenCalledTimes(1)
    expect(tenantGateway.listen.mock.calls[0][2]).toBe(A3)
  })

  it('没有 port 的 running 租户跳过（不误绑端口）', async () => {
    userService.state.swtcUsers = {
      [A1]: { port: null, containerStatus: 'running' },
    }
    tenantGateway.hasRoute.mockReturnValue(false)

    const r = await userService.ensureGatewayRoutes()

    expect(r).toEqual({ checked: 0, restored: 0, failed: 0 })
    expect(tenantGateway.listen).not.toHaveBeenCalled()
  })

  it('读不到映射端口 → 记 failed，不抛', async () => {
    userService.state.swtcUsers = {
      [A1]: { port: 31016, containerStatus: 'running' },
    }
    tenantGateway.hasRoute.mockReturnValue(false)
    dockerService.publishedPort.mockResolvedValue(null)

    const r = await userService.ensureGatewayRoutes()

    expect(r).toEqual({ checked: 1, restored: 0, failed: 1 })
    expect(tenantGateway.listen).not.toHaveBeenCalled()
  })

  it('单个租户绑定失败（端口被占）不影响其它租户', async () => {
    userService.state.swtcUsers = {
      [A1]: { port: 31016, containerStatus: 'running' },
      [A3]: { port: 31018, containerStatus: 'running' },
    }
    tenantGateway.hasRoute.mockReturnValue(false)
    tenantGateway.listen
      .mockRejectedValueOnce(new Error('EADDRINUSE'))
      .mockResolvedValueOnce(undefined)

    const r = await userService.ensureGatewayRoutes()

    expect(r.checked).toBe(2)
    expect(r.restored).toBe(1)
    expect(r.failed).toBe(1)
    // 第二个租户仍然被处理
    expect(tenantGateway.listen).toHaveBeenCalledTimes(2)
  })

  it('空 state → 不报错、全零', async () => {
    userService.state.swtcUsers = {}
    const r = await userService.ensureGatewayRoutes()
    expect(r).toEqual({ checked: 0, restored: 0, failed: 0 })
  })
})
