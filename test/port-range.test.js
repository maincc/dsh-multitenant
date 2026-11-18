/**
 * 端口段纪律（方案 B 配套，2026-11）
 *
 * 背景：B 形态要求 frpc/安全组预先开通固定段（如 31000-31019），平台发号
 * 必须以 [docker.basePort, docker.maxPort] 为界——段外发号等于给用户一个
 * 隧道没映射的死链接。三个来源都要滤：
 *   ① 回收池里的越界旧号 → 就地丢弃
 *   ② 租户 own 端口越界（收段场景）→ 视为无号，重新发号并随迁移 state
 *   ③ nextPort 越界 → 走既有征用/耗尽路径，征用时也只收段内号
 *
 * 隔离方式沿用 finalize-tenant.test.js：真实模块 + spy 掉 IO；preflightCheck
 * 直接 stub 成 ok（端口耗尽的"抛 exhausted"是分配器层行为，与 enforce/warn
 * 模式的排队分流无关，不让测试依赖宿主 config 的 preflight 档位）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { dataService } from '../src/services/data.service.js'
import { tenantGateway } from '../src/services/tenant-proxy.service.js'
import { CONFIG } from '../src/config/config.js'

const ADDR = 'jrangeportsa00000000000000000000000000000000000000'
const INTERNAL_PORT = 41555

let savedBase, savedMax

beforeEach(() => {
  // 整表隔离：宿主 state（json/mongo 真实数据）里有 destroyed 状态的旧租户
  // （31010/31017/31019 都在段内），不隔离会被征用逻辑捞进池污染断言。
  // vitest 每个文件独立模块实例，此处替换不外溢其他测试文件。
  userService.state.swtcUsers = {}
  savedBase = CONFIG.docker.basePort
  savedMax = CONFIG.docker.maxPort
  CONFIG.docker.basePort = 31000
  CONFIG.docker.maxPort = 31019
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
  vi.spyOn(dockerService, 'stopContainer').mockResolvedValue(undefined)
  vi.spyOn(dockerService, 'removeContainer').mockResolvedValue(undefined)
  vi.spyOn(dockerService, 'removeVolume').mockResolvedValue(undefined)
  vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: false })
  vi.spyOn(dockerService, 'publishedPort').mockResolvedValue(INTERNAL_PORT)
  vi.spyOn(dockerService, 'createContainer').mockResolvedValue(undefined)
  vi.spyOn(userService, 'allocateInternalPort').mockReturnValue(INTERNAL_PORT)
  vi.spyOn(tenantGateway, 'listen').mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  CONFIG.docker.basePort = savedBase
  CONFIG.docker.maxPort = savedMax
  delete userService.state.swtcUsers[ADDR]
  vi.restoreAllMocks()
})

function injectFresh(addr, extra = {}) {
  userService.state.swtcUsers[addr] = {
    tier: 1,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    containerStatus: 'destroyed',
    ...extra,
  }
}

describe('端口段纪律', () => {
  it('回收池：越界旧号就地丢弃，段内号照常发放且不推进 nextPort', async () => {
    injectFresh(ADDR)
    userService.state.nextPort = 31011
    userService.state.availablePorts = [31050, 31007]
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(31007)
    expect(userService.state.availablePorts).not.toContain(31050)
    expect(userService.state.nextPort).toBe(31011)
    expect(tenantGateway.listen.mock.calls[0][0]).toBe(31007)
  })

  it('own 越界（收段场景）→ 视为无号重发，state 随迁，不撞段外旧口', async () => {
    injectFresh(ADDR, { port: 31050 })
    userService.state.nextPort = 31012
    userService.state.availablePorts = []
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(31012)
    expect(userService.state.swtcUsers[ADDR].port).toBe(31012)
    expect(userService.state.nextPort).toBe(31013)
  })

  it('own 在段内 → 原号续用（既有行为不因收段改变）', async () => {
    injectFresh(ADDR, { port: 31015 })
    userService.state.nextPort = 31016
    userService.state.availablePorts = []
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(31015)
    expect(userService.state.nextPort).toBe(31016)
  })

  it('nextPort 越界但段内有空号 → 探号改派段内首个可用（不再抛 exhausted）', async () => {
    injectFresh(ADDR)
    userService.state.nextPort = 31020
    userService.state.availablePorts = []
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(31000) // 段首 31000 无人占（探针实 bind 验证）
    expect(tenantGateway.listen.mock.calls[0][0]).toBe(31000)
  })

  it('候选号被外部程序监听 → 段内自动改派下一个空号（40xxx 混段场景）', async () => {
    // 真实占位：起一个 stray 监听器绑走 31011
    const net = await import('node:net')
    const stray = net.createServer()
    await new Promise((ok, rej) => {
      stray.once('error', rej)
      stray.listen(31011, '0.0.0.0', ok)
    })
    try {
      injectFresh(ADDR)
      userService.state.nextPort = 31011
      userService.state.availablePorts = []
      const port = await userService.ensureContainer(ADDR)
      expect(port).toBe(31012) // 撞外部占用 → 跳过
      expect(userService.state.nextPort).toBe(31013)
    } finally {
      stray.close()
    }
  })

  it('整段占满 → PORT_RANGE_FULL 明确报错，绝不绑他人端口', async () => {
    const net = await import('node:net')
    const strays = []
    for (let p = 31000; p <= 31019; p++) {
      const srv = net.createServer()
      const bound = await new Promise((ok) => {
        srv.once('error', () => ok(false))
        srv.listen(p, '0.0.0.0', () => ok(true))
      })
      if (bound) strays.push(srv) // 已有占用者也算"占满"，不必是我们绑的
    }
    try {
      injectFresh(ADDR)
      userService.state.nextPort = 31011
      userService.state.availablePorts = []
      await expect(userService.ensureContainer(ADDR)).rejects.toThrow(
        /PORT_RANGE_FULL|占满|无可绑定/,
      )
      expect(tenantGateway.listen).not.toHaveBeenCalled()
    } finally {
      for (const s of strays) s.close()
    }
  })

  it('容器存在但记账号越界/弃号 → exists 分支探号领号，拆容器重建（卷不动）', async () => {
    injectFresh(ADDR, { port: 31050, containerStatus: 'running' }) // 段外旧号
    userService.state.nextPort = 31012
    userService.state.availablePorts = []
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValueOnce({
      exists: true,
      status: 'running',
    })
    const port = await userService.ensureContainer(ADDR)
    expect(dockerService.removeContainer).toHaveBeenCalled() // 换号必重建映射
    expect(port).toBe(31012) // 创建路径重新领号
    expect(userService.state.swtcUsers[ADDR].port).toBe(31012)
    expect(dockerService.removeVolume).not.toHaveBeenCalled() // 卷数据绝不碰
  })

  it('越界耗尽触发征用：destroyed 租户只收段内号，越界号不进池也不动记录', async () => {
    injectFresh(ADDR)
    const OTHER_IN = 'jotherintenant00000000000000000000000000000a'
    const OTHER_OUT = 'jotherouttenant0000000000000000000000000000b'
    userService.state.swtcUsers[OTHER_IN] = { port: 31016, containerStatus: 'destroyed', tier: 1 }
    userService.state.swtcUsers[OTHER_OUT] = { port: 31060, containerStatus: 'destroyed', tier: 1 }
    userService.state.nextPort = 31020
    userService.state.availablePorts = []
    const port = await userService.ensureContainer(ADDR)
    expect(port).toBe(31016) // 段内的被征用；越界 31060 被 reclaim 的滤子挡下
    expect(userService.state.swtcUsers[OTHER_IN].port).toBeUndefined() // 已被征走
    expect(userService.state.swtcUsers[OTHER_OUT].port).toBe(31060) // 越界保留，待其重连时重发号
    delete userService.state.swtcUsers[OTHER_IN]
    delete userService.state.swtcUsers[OTHER_OUT]
  })

  it('reclaimDestroyedPorts 公开入口同样遵守段纪律（回收池不被越界号污染）', async () => {
    const OTHER_OUT = 'joutofrangeonly00000000000000000000000000000c'
    userService.state.swtcUsers[OTHER_OUT] = { port: 31099, containerStatus: 'destroyed', tier: 1 }
    userService.state.availablePorts = []
    const n = await userService.reclaimDestroyedPorts(ADDR)
    expect(n).toBe(0)
    expect(userService.state.availablePorts).toEqual([])
    delete userService.state.swtcUsers[OTHER_OUT]
  })
})
