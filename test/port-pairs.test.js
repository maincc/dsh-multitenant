/**
 * 双端口段配对模式（2026-11-14，混段部署）
 *
 * 语义：
 *   - public 段 = 给用户看的对外端口（隧道 DNAT/安全组开通面）
 *   - internal 段 = 容器宿主回环映射段（docker -p 127.0.0.1:int:3080）
 *   - 运行期一一对应：internal = internalBase + (public - publicBase)
 *   - 发号整对探测：任一端被外部监听 → 整对跳过、试下一对
 *   - **非本服务产生的占用**记入 state.externalOccupations 账本
 *     （gateway-ports 接口透出，见 gateway-ports.test.js）
 *
 * 段选 47100/47200：与 port-range.test（31000 段）、dsh-capability（39/45 段）
 * 等并行测试文件互不占号。探针是真实 bind，断言外部占用即真实监听器。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { dataService } from '../src/services/data.service.js'
import { tenantGateway } from '../src/services/tenant-proxy.service.js'
import { CONFIG } from '../src/config/config.js'

const ADDR = 'jpairportsa000000000000000000000000000000000000000'
const PUB = [47100, 47109]
const INT = [47200, 47209]

let saved
const strays = []

function bind(host, port) {
  return new Promise((ok, rej) => {
    const srv = createServer()
    srv.once('error', rej)
    srv.listen(port, host, () => {
      strays.push(srv)
      ok()
    })
  })
}

beforeEach(() => {
  userService.state.swtcUsers = {}
  userService.state.externalOccupations = {}
  saved = { ...CONFIG.docker }
  Object.assign(CONFIG.docker, {
    basePort: PUB[0], // 对外段唯一真源（public* 重复键已删，六键收敛四键）
    maxPort: PUB[1],
    internalBasePort: INT[0],
    internalMaxPort: INT[1],
  })
  userService.state.usages = {}
  userService.state.usageLimit = { enabled: false }
  vi.spyOn(dataService, 'saveState').mockImplementation(() => {})
  vi.spyOn(userService, 'preflightCheck').mockResolvedValue({ ok: true, checks: {} })
  vi.spyOn(dockerService, 'waitReady').mockResolvedValue(true)
  vi.spyOn(dockerService, 'containerDiagnostics').mockResolvedValue('[诊断] stub')
  vi.spyOn(dockerService, 'ensureDshWorkspace').mockResolvedValue(true)
  vi.spyOn(dockerService, 'imageCapability').mockResolvedValue({
    version: '0.1.1-rc.2',
    requiresToken: false,
    imageId: 'sha256:test',
    tokenAuthSince: '0.1.2-alpha.2',
  })
  vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: false })
  vi.spyOn(dockerService, 'createContainer').mockResolvedValue(undefined)
  vi.spyOn(dockerService, 'removeContainer').mockResolvedValue(undefined)
  vi.spyOn(dockerService, 'removeVolume').mockResolvedValue(undefined)
  vi.spyOn(userService, 'allocateInternalPort').mockReturnValue(41555) // 若被调用即配对失守
  vi.spyOn(tenantGateway, 'listen').mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  Object.assign(CONFIG.docker, saved)
  while (strays.length) strays.pop().close()
  delete userService.state.swtcUsers[ADDR]
  userService.state.externalOccupations = {}
  vi.restoreAllMocks()
})

function freshRecord(extra = {}) {
  userService.state.swtcUsers[ADDR] = {
    tier: 1,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    containerStatus: 'destroyed',
    ...extra,
  }
}

describe('双端口段配对', () => {
  it('领号即配对：对外 47100 → 容器映射 47200（不用随机内部口）', async () => {
    freshRecord()
    userService.state.nextPort = 47100
    userService.state.availablePorts = []
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(47100)
    expect(dockerService.createContainer.mock.calls[0][1]).toBe(47200)
    expect(userService.allocateInternalPort).not.toHaveBeenCalled()
  })

  it('对外端被外部监听 → 整对跳过，占用记入账本 scope=public', async () => {
    await bind('0.0.0.0', 47102)
    freshRecord()
    userService.state.nextPort = 47102
    userService.state.availablePorts = []
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(47103)
    expect(dockerService.createContainer.mock.calls[0][1]).toBe(47203)
    const occ = userService.state.externalOccupations
    expect(occ['47102']).toMatchObject({ port: 47102, scope: 'public' })
    expect(occ['47102'].hits).toBeGreaterThanOrEqual(1)
  })

  it('回环端被外部监听（绑在 127.0.0.1，connect 面不可见）→ 整对跳过，记 scope=internal', async () => {
    await bind('127.0.0.1', 47204)
    freshRecord()
    userService.state.nextPort = 47104
    userService.state.availablePorts = []
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(47105) // 配对的 47205 空闲，整对下移一号
    expect(dockerService.createContainer.mock.calls[0][1]).toBe(47205)
    expect(userService.state.externalOccupations['47204']).toMatchObject({
      port: 47204,
      scope: 'internal',
    })
  })

  it('自己网关在册的配对号 → 幂等复用，不探测不跳号', async () => {
    freshRecord({ port: 47106 })
    userService.state.availablePorts = []
    vi.spyOn(tenantGateway, 'ownerOf').mockImplementation((p) => (p === 47106 ? ADDR : null))
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(47106)
    expect(dockerService.createContainer.mock.calls[0][1]).toBe(47206)
  })

  it('internal 段短于 public 段（配置不齐）→ 配不上的对跳过，回绕到配得上的一对', async () => {
    Object.assign(CONFIG.docker, { internalBasePort: 47200, internalMaxPort: 47201 })
    freshRecord()
    userService.state.nextPort = 47105 // 从这里起配 47205 > 段界 → 全 skip → 回绕
    userService.state.availablePorts = []
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(47100) // 回绕后首个可配对号（47100↔47200）
    expect(dockerService.createContainer.mock.calls[0][1]).toBe(47200)
  })

  it('整段占满 → PORT_RANGE_FULL，不创建容器', async () => {
    for (let p = 47100; p <= 47109; p++) {
      try {
        await bind('0.0.0.0', p)
      } catch {} // 已有占用者也算占满
    }
    freshRecord()
    userService.state.nextPort = 47100
    userService.state.availablePorts = []
    await expect(userService.ensureContainer(ADDR)).rejects.toThrow(/PORT_RANGE_FULL|整对|占满/)
    expect(dockerService.createContainer).not.toHaveBeenCalled()
  })

  it('exists 换号重建：自家旧容器的回环口只跳过、不记外部占用（迁移日幽灵账判例）', async () => {
    // 场景复刻 league-temp 迁移首连：记录里是旧机段号（当前段外）→ exists 分支
    // 必须探号换发。此刻旧容器还活着，其 127.0.0.1:47200 映射是**真实监听**——
    // 无豁免则每租户留一笔 scope=internal 假账，gateway-ports 面板迁移当天全脏。
    await bind('127.0.0.1', 47200) // 模拟自家旧容器的 docker -p 占用
    freshRecord({ port: 47199, containerStatus: 'running' }) // 47199=越段旧号
    userService.state.availablePorts = []
    userService.state.nextPort = 47100
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValueOnce({
      exists: true,
      status: 'running',
    })
    vi.spyOn(dockerService, 'publishedPort').mockResolvedValue(47200) // 自家内部口
    const port = await userService.ensureContainer(ADDR)
    expect(dockerService.removeContainer).toHaveBeenCalled() // 换号必拆旧映射
    // exists 探号得 47101（47100↔47200 撞自家旧口跳过）→ 弃号 fallthrough 重建，
    // 创建路径从被推到的 nextPort=47102 再领（47101 作废——跳号无害纪律）
    expect(port).toBe(47102)
    expect(dockerService.createContainer.mock.calls[0][1]).toBe(47202)
    expect(userService.state.externalOccupations['47200']).toBeUndefined() // 幽灵账零笔
    expect(dockerService.removeVolume).not.toHaveBeenCalled() // 卷数据绝不碰
  })

  it('旧单段模式（internal*=0）行为不变：对外段照旧 + 内部口走随机分配', async () => {
    Object.assign(CONFIG.docker, {
      basePort: 47300,
      maxPort: 47309,
      internalBasePort: 0,
      internalMaxPort: 0,
    })
    userService.state.swtcUsers = {}
    freshRecord()
    userService.state.nextPort = 47305
    userService.state.availablePorts = []
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(47305) // 独立段 47300+：并行文件各自占 31xxx 互不干扰
    expect(dockerService.createContainer.mock.calls[0][1]).toBe(41555) // 随机桩值
    expect(userService.allocateInternalPort).toHaveBeenCalled()
  })
})
