/**
 * finalizeTenant 顺序与失败回滚测试
 *
 * 修复的缺陷（"假 running"窗口）：
 *   旧顺序 = 写 containerStatus:'running' + saveState → await waitReady（最长 120s）
 *            → tenantGateway.listen()
 *   这期间状态与接口都报 running 并给出端口，但网关还没监听 → 用户 302 过去是
 *   connection refused。且 waitReady 失败时容器已创建在跑，却不 stop/rm/回滚，
 *   留下"容器在跑、状态说在跑、网关没监听"的孤儿态。
 *
 *   新顺序 = await waitReady → listen（成功才算）→ 最后才写 running 并落盘。
 *
 * 另外覆盖 listen 的 Promise 化：bind 失败必须让调用方看见，而不是被吞成日志
 * 却照样写入 routes、照样落盘 running（那会给用户一个没人监听的 URL）。
 *
 * 隔离：mock 全部破坏性 docker 调用、listen 与 saveState，不触碰真实 Docker/state。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { dataService } from '../src/services/data.service.js'
import { tenantGateway } from '../src/services/tenant-proxy.service.js'

const ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const NAME = `dsh-swtc-${ADDR}`
const PORT = 31009
const INTERNAL_PORT = 41234

function injectUser(overrides = {}) {
  userService.state.swtcUsers[ADDR] = {
    port: PORT,
    tier: 1,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    containerStatus: 'stopped',
    ...overrides,
  }
  return userService.state.swtcUsers[ADDR]
}

beforeEach(() => {
  delete userService.state.swtcUsers[ADDR]
  vi.spyOn(dataService, 'saveState').mockImplementation(() => {})
  vi.spyOn(dockerService, 'waitReady').mockResolvedValue(true)
  // 启动失败时要采集现场；stub 掉以免测试真的去 docker inspect/logs
  vi.spyOn(dockerService, 'containerDiagnostics').mockResolvedValue(
    '[诊断] status=exited exit=1 oom=false memLimit=536870912',
  )
  // finalizeTenant 会记录镜像能力（网关据此决定放行/拒绝）：
  // 默认给"老版本、不需要认证"→ 让这些测试专注收尾顺序本身
  vi.spyOn(dockerService, 'imageCapability').mockResolvedValue({
    version: '0.1.1-rc.2',
    requiresToken: false,
    imageId: 'sha256:test',
    tokenAuthSince: '0.1.2-alpha.2',
  })
  vi.spyOn(dockerService, 'stopContainer').mockResolvedValue(undefined)
  vi.spyOn(dockerService, 'removeContainer').mockResolvedValue(undefined)
  // 也 spy 掉 removeVolume：回滚绝不能删数据卷，且万一回归也不会碰真实卷
  vi.spyOn(dockerService, 'removeVolume').mockResolvedValue(undefined)
  vi.spyOn(tenantGateway, 'listen').mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete userService.state.swtcUsers[ADDR]
})

describe('finalizeTenant：成功路径', () => {
  it('就绪 + 网关绑定都通过 → 才写 running 并落盘', async () => {
    injectUser()

    const result = await userService.finalizeTenant(ADDR, NAME, PORT, INTERNAL_PORT)

    expect(result).toBe(PORT)
    // 第三个参数带 containerName：让 waitReady 能在容器早退时快速失败
    expect(dockerService.waitReady).toHaveBeenCalledWith(INTERNAL_PORT, undefined, {
      containerName: NAME,
    })
    // 能力随路由交给网关（网关不 import user.service，避免循环依赖）
    expect(tenantGateway.listen).toHaveBeenCalledWith(PORT, INTERNAL_PORT, ADDR, {
      requiresToken: false,
      version: '0.1.1-rc.2',
      tokenAuthSince: '0.1.2-alpha.2',
    })
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('running')
    expect(userService.state.swtcUsers[ADDR].internalPort).toBe(INTERNAL_PORT)
    // 能力落盘：网关重启/恢复时不需重新探测镜像
    expect(userService.state.swtcUsers[ADDR].requiresToken).toBe(false)
    expect(userService.state.swtcUsers[ADDR].baseImageVersion).toBe('0.1.1-rc.2')
    expect(userService.state.swtcUsers[ADDR].stoppedAt).toBeUndefined()
    expect(dataService.saveState).toHaveBeenCalled()
  })

  it('先 waitReady 再 listen 再落盘：顺序不可颠倒', async () => {
    injectUser()
    const order = []
    dockerService.waitReady.mockImplementation(async () => {
      order.push('waitReady')
      return true
    })
    tenantGateway.listen.mockImplementation(async () => {
      order.push('listen')
    })
    dataService.saveState.mockImplementation(() => {
      order.push('saveState')
    })

    await userService.finalizeTenant(ADDR, NAME, PORT, INTERNAL_PORT)

    // 关键断言：整个过程中不允许出现"先落盘 running、后 listen"
    expect(order).toEqual(['waitReady', 'listen', 'saveState'])
  })
})

describe('finalizeTenant：waitReady 失败 → 回滚容器', () => {
  it('回滚：删容器、保数据卷、状态置 destroyed、不写 running', async () => {
    injectUser()

    dockerService.waitReady.mockResolvedValue(false)

    // 失败时必须带上现场：状态/退出码/OOM/日志尾部（回滚会删容器，日志随之消失）
    await expect(userService.finalizeTenant(ADDR, NAME, PORT, INTERNAL_PORT)).rejects.toThrow(
      /did not become ready[\s\S]*\[诊断\] status=exited exit=1/,
    )
    // 采集必须发生在回滚之前才能拿到日志
    const diagOrder = dockerService.containerDiagnostics.mock.invocationCallOrder[0]
    const removeOrder = dockerService.removeContainer.mock.invocationCallOrder[0]
    expect(diagOrder).toBeLessThan(removeOrder)

    // 容器被停掉并移除（removeContainer 不删卷，用户数据保留）
    expect(dockerService.stopContainer).toHaveBeenCalledWith(NAME, 10)
    expect(dockerService.removeContainer).toHaveBeenCalledWith(NAME)
    expect(dockerService.removeVolume).not.toHaveBeenCalled()

    // 状态绝不能是 running
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('destroyed')
    expect(userService.state.swtcUsers[ADDR].usageStartedAt).toBeUndefined()
    expect(userService.state.swtcUsers[ADDR].stoppedAt).toBeUndefined()
    // 对外端口保留在记录里，供下次重连复用
    expect(userService.state.swtcUsers[ADDR].port).toBe(PORT)
  })

  it('就绪失败时不开放网关（端口不该被占用）', async () => {
    injectUser()
    dockerService.waitReady.mockResolvedValue(false)

    await expect(userService.finalizeTenant(ADDR, NAME, PORT, INTERNAL_PORT)).rejects.toThrow()

    expect(tenantGateway.listen).not.toHaveBeenCalled()
  })
})

describe('finalizeTenant：网关 bind 失败 → 保留容器但标记 stopped', () => {
  it('listen 拒绝 → 抛错、状态 stopped（绝不 running）、容器不被删除', async () => {
    injectUser()

    tenantGateway.listen.mockRejectedValue(new Error('EADDRINUSE'))

    await expect(userService.finalizeTenant(ADDR, NAME, PORT, INTERNAL_PORT)).rejects.toThrow(
      /绑定失败/,
    )

    // 容器本身是好的，只是对外端口绑不上 → 保留容器与卷
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
    expect(dockerService.stopContainer).not.toHaveBeenCalled()

    const rec = userService.state.swtcUsers[ADDR]
    expect(rec.containerStatus).toBe('stopped')
    expect(rec.stoppedAt).toBeGreaterThan(0)
    expect(rec.port).toBe(PORT)
    expect(rec.internalPort).toBe(INTERNAL_PORT)
    expect(dataService.saveState).toHaveBeenCalled()
  })
})
// ---------------------------------------------------------------------------
// 租户镜像选择的关键断言：钉住的镜像必须在**重建时真的用上**
//
// 否则这个功能是假的 —— 界面显示"已钉：0.1.1-rc.2"，容器却照样跑 latest。
// 走的是容器不存在时的创建路径（ensureContainer → createContainer）。
// ---------------------------------------------------------------------------
describe('ensureContainer：沿用租户钉住的镜像', () => {
  it('state 里有 pinnedImage → createContainer 用它，而不是平台默认', async () => {
    injectUser({ containerStatus: 'destroyed', pinnedImage: 'dsh-multitenant:0.1.1-rc.2' })
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: false })
    vi.spyOn(dockerService, 'publishedPort').mockResolvedValue(INTERNAL_PORT)
    vi.spyOn(userService, 'allocateInternalPort').mockReturnValue(INTERNAL_PORT)
    const create = vi.spyOn(dockerService, 'createContainer').mockResolvedValue(undefined)
    vi.spyOn(userService, 'finalizeTenant').mockResolvedValue(PORT)

    await userService.ensureContainer(ADDR, true)

    expect(create).toHaveBeenCalled()
    // 最后一个参数是 opts，其中 image 必须是钉住的那个
    const opts = create.mock.calls[0][5]
    expect(opts).toMatchObject({ image: 'dsh-multitenant:0.1.1-rc.2' })
  })

  it('没有 pinnedImage → image 为 null（走平台默认 latest，行为不变）', async () => {
    injectUser({ containerStatus: 'destroyed' })
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: false })
    vi.spyOn(dockerService, 'publishedPort').mockResolvedValue(INTERNAL_PORT)
    vi.spyOn(userService, 'allocateInternalPort').mockReturnValue(INTERNAL_PORT)
    const create = vi.spyOn(dockerService, 'createContainer').mockResolvedValue(undefined)
    vi.spyOn(userService, 'finalizeTenant').mockResolvedValue(PORT)

    await userService.ensureContainer(ADDR, true)

    expect(create.mock.calls[0][5]).toMatchObject({ image: null })
  })

  it('显式传入的镜像优先于 pinnedImage（apply 指定版本时）', async () => {
    injectUser({ containerStatus: 'destroyed', pinnedImage: 'dsh-multitenant:0.1.1-rc.2' })
    vi.spyOn(dockerService, 'containerInfo').mockResolvedValue({ exists: false })
    vi.spyOn(dockerService, 'publishedPort').mockResolvedValue(INTERNAL_PORT)
    vi.spyOn(userService, 'allocateInternalPort').mockReturnValue(INTERNAL_PORT)
    const create = vi.spyOn(dockerService, 'createContainer').mockResolvedValue(undefined)
    vi.spyOn(userService, 'finalizeTenant').mockResolvedValue(PORT)

    await userService.ensureContainer(ADDR, true, 'dsh-multitenant:0.1.5-rc.2')

    expect(create.mock.calls[0][5]).toMatchObject({ image: 'dsh-multitenant:0.1.5-rc.2' })
  })
})
