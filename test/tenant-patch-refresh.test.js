/**
 * 租户 patch 的 trustedHosts 必须在重启时跟随当前 PUBLIC_HOST 刷新
 *
 * 背景（真实故障）：
 *   patch 是创建容器时烘死的（宿主文件 bind-mount 进容器 /patches/tenant.patch.yml，
 *   DSH 启动时读取），trustedHosts 由 PUBLIC_HOST 推导。运维改了 config.json 的
 *   server.publicHost（.118 → .121）后，旧容器仍只信任 .118：DSH 的 /api fence 对
 *   "非回环且不在 trustedHosts"的 authority 直接返回 403 `forbidden`，前端表现为
 *   `client api: directoryPicker/list failed: transport failure ... HTTP 403`。
 *
 *   修复前 restartContainer 只在 patch **文件缺失**时才重写，所以重启也救不回来。
 *   这里锁定"每次都按当前 PUBLIC_HOST 重建"的行为。
 *
 * 隔离：mock docker / data / tenant-proxy，不触碰真实容器与 state.json。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../src/services/docker.service.js', () => ({
  dockerService: {
    containerInfo: vi.fn(),
    restartContainer: vi.fn(),
    // 漂移重建路径会用到（ensureContainer → 创建容器）
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    removeContainer: vi.fn(),
    stopContainer: vi.fn(),
    updateContainer: vi.fn(),
    // 启动自愈路径会用到（凭据文件损坏 → 隔离 + 重启一次）
    containerDiagnostics: vi.fn(),
    quarantineVolumeFile: vi.fn(),
    publishedPort: vi.fn(),
    waitReady: vi.fn(),
    imageCapability: vi.fn(),
  },
}))

vi.mock('../src/services/data.service.js', () => ({
  dataService: { saveState: vi.fn(), loadState: vi.fn(() => ({})) },
}))

vi.mock('../src/services/tenant-proxy.service.js', () => ({
  tenantGateway: {
    listen: vi.fn(),
    close: vi.fn(),
    issueTicket: vi.fn(),
    rebuildRoute: vi.fn(),
    capabilityOf: vi.fn(),
  },
}))

vi.mock('../src/services/cwt.store.js', () => ({
  // ensureContainer 的额度门会查豁免名单（isUsageExempt → getRegistry）
  cwtStore: { getRegistry: () => ({}) },
}))

const { dockerService } = await import('../src/services/docker.service.js')
const { userService, setPatchDirForTest } = await import('../src/services/user.service.js')

const ADDR = 'jhfamgqipxtakkdnamduoppim4shcdztea'
const PORT = 31016
const NAME = `dsh-swtc-${ADDR}`

let dir

beforeEach(() => {
  vi.clearAllMocks()
  process.env.PUBLIC_HOST = '192.168.77.121'
  // 把 patch 目录指向临时目录，避免污染仓库里的 patches/
  dir = mkdtempSync(join(tmpdir(), 'patch-refresh-'))
  dockerService.publishedPort.mockResolvedValue(45377)
  dockerService.containerInfo.mockResolvedValue({ exists: true, status: 'running' })
  dockerService.restartContainer.mockResolvedValue(undefined)
  dockerService.waitReady.mockResolvedValue(true)
  dockerService.imageCapability.mockResolvedValue({ requiresToken: false })
  userService.state = { swtcUsers: { [ADDR]: { port: PORT, internalPort: 45377 } } }
  setPatchDirForTest(dir)
})

afterEach(() => {
  delete process.env.PUBLIC_HOST
  setPatchDirForTest(null)
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('restartContainer 刷新租户 patch', () => {
  it('publicHost 变了 → 重启时把 trustedHosts 改成新 IP', async () => {
    // 模拟"创建时是 .118"的旧 patch
    const file = join(dir, `swtc-${ADDR}.yml`)
    writeFileSync(
      file,
      'trustedHosts: ["127.0.0.1:31016", "localhost:31016", "192.168.77.118:31016"]',
    )

    await userService.restartContainer(ADDR)

    const after = readFileSync(file, 'utf8')
    expect(after).toContain('192.168.77.121:31016')
    expect(after).not.toContain('192.168.77.118:31016')
  })

  it('patch 缺失时照旧重建（避免 Docker 把源补建成目录）', async () => {
    await userService.restartContainer(ADDR)

    const after = readFileSync(join(dir, `swtc-${ADDR}.yml`), 'utf8')
    expect(after).toContain('192.168.77.121:31016')
  })

  it('patch 已是最新 → 不重复写（避免无意义 I/O 与日志噪声）', async () => {
    const file = join(dir, `swtc-${ADDR}.yml`)
    await userService.restartContainer(ADDR) // 先写成最新
    const first = readFileSync(file, 'utf8')
    const mtimeBefore = readFileSync(file, 'utf8').length

    await userService.restartContainer(ADDR)
    expect(readFileSync(file, 'utf8')).toBe(first)
    expect(readFileSync(file, 'utf8').length).toBe(mtimeBefore)
  })
})

describe('syncTenantPatches：启动时自愈配置漂移', () => {
  const OTHER = 'j3xhos5osubqmfaekq3rxufrzbbucghwrv'

  it('检测到漂移且容器在运行 → 重写 patch 并重启该容器', async () => {
    userService.state = {
      swtcUsers: {
        [ADDR]: { port: PORT, internalPort: 45377 },
        [OTHER]: { port: 31017, internalPort: 40760 },
      },
    }
    // 两个都是旧 IP 的 patch
    for (const [a, p] of [
      [ADDR, PORT],
      [OTHER, 31017],
    ]) {
      writeFileSync(
        join(dir, `swtc-${a}.yml`),
        `trustedHosts: ["127.0.0.1:${p}", "localhost:${p}", "192.168.77.118:${p}"]`,
      )
    }

    const res = await userService.syncTenantPatches()

    expect(res.refreshed.sort()).toEqual([ADDR, OTHER].sort())
    expect(res.failed).toEqual([])
    // 两个 patch 都换成了新 IP
    for (const [a, p] of [
      [ADDR, PORT],
      [OTHER, 31017],
    ]) {
      const body = readFileSync(join(dir, `swtc-${a}.yml`), 'utf8')
      expect(body).toContain(`192.168.77.121:${p}`)
      expect(body).not.toContain('192.168.77.118')
    }
    // 两个运行中的容器都被重启（DSH 不热重载 patch，必须重启）
    expect(dockerService.restartContainer).toHaveBeenCalledTimes(2)
  })

  it('没有漂移 → 不重启任何容器（避免无谓打扰在用租户）', async () => {
    await userService.syncTenantPatches() // 先按当前配置写一遍
    dockerService.restartContainer.mockClear()

    const res = await userService.syncTenantPatches()

    expect(res.refreshed).toEqual([])
    expect(dockerService.restartContainer).not.toHaveBeenCalled()
  })

  it('容器已停 → 只刷新文件，不重启（不把停掉的容器捞起来跑）', async () => {
    writeFileSync(
      join(dir, `swtc-${ADDR}.yml`),
      'trustedHosts: ["127.0.0.1:31016", "localhost:31016", "192.168.77.118:31016"]',
    )
    dockerService.containerInfo.mockResolvedValue({ exists: true, status: 'exited' })

    const res = await userService.syncTenantPatches()

    expect(res.refreshed).toEqual([ADDR])
    expect(dockerService.restartContainer).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, `swtc-${ADDR}.yml`), 'utf8')).toContain('192.168.77.121:31016')
  })

  it('单个租户重启失败 → 记入 failed，不影响其它租户', async () => {
    const OTHER = 'j3xhos5osubqmfaekq3rxufrzbbucghwrv'
    userService.state = {
      swtcUsers: {
        [ADDR]: { port: PORT, internalPort: 45377 },
        [OTHER]: { port: 31017, internalPort: 40760 },
      },
    }
    for (const [a, p] of [
      [ADDR, PORT],
      [OTHER, 31017],
    ]) {
      writeFileSync(
        join(dir, `swtc-${a}.yml`),
        `trustedHosts: ["127.0.0.1:${p}", "localhost:${p}", "192.168.77.118:${p}"]`,
      )
    }
    dockerService.restartContainer.mockRejectedValueOnce(new Error('daemon busy'))

    const res = await userService.syncTenantPatches()

    expect(res.failed.length).toBe(1)
    expect(res.refreshed.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 线上故障：「重启 DSH」报 Container ... not found
//
// 成因：状态漂移 —— 清理定时器在界面停留期间把已停止 >60min 的容器销毁了，
// 用户再点重启，restartContainer 对着不存在的容器执行 docker restart → 404。
// 修法：容器不在了就把"重启"降级为"启动"（ensureContainer：停止→start、
// 缺失→重建含 pinnedImage），而不是报错。
// ---------------------------------------------------------------------------
describe('restartContainer：容器已不存在的漂移场景', () => {
  it('容器已被销毁 → 重建（不再抛 404）', async () => {
    dockerService.containerInfo.mockResolvedValue({ exists: false })
    const create = vi.spyOn(dockerService, 'createContainer').mockResolvedValue(undefined)
    vi.spyOn(dockerService, 'startContainer').mockResolvedValue(undefined)
    // 预检会真的 spawn sysctl/df/docker：全量并发跑时会拖过 5s 超时。
    // 这里打桩，保证测试只验证"漂移 → 重建"这条逻辑，不依赖主机状态。
    vi.spyOn(userService, 'preflightCheck').mockResolvedValue({
      ok: true,
      checks: {},
      failed: [],
    })

    userService.state = {
      swtcUsers: { [ADDR]: { port: PORT, internalPort: 45377, tier: 1 } },
      nextPort: 31017,
      usages: {},
    }

    const spy = vi.spyOn(userService, 'ensureContainer')
    const res = await userService.restartContainer(ADDR)

    expect(spy).toHaveBeenCalledWith(ADDR) // 语义 = 用户按"启动"
    expect(create).toHaveBeenCalled() // 真走了创建
    expect(res).toMatchObject({ recreated: true })
    // 绝不能再对不存在的容器执行 restart
    expect(dockerService.restartContainer).not.toHaveBeenCalled()
  })

  it('钉过版本的租户漂移后重建 → 仍用钉住的镜像（pin 不被重启路径重置）', async () => {
    dockerService.containerInfo.mockResolvedValue({ exists: false })
    const create = vi.spyOn(dockerService, 'createContainer').mockResolvedValue(undefined)
    vi.spyOn(userService, 'preflightCheck').mockResolvedValue({
      ok: true,
      checks: {},
      failed: [],
    })

    userService.state = {
      swtcUsers: {
        [ADDR]: {
          port: PORT,
          internalPort: 45377,
          tier: 1,
          pinnedImage: 'dsh-multitenant:0.1.1-rc.2',
        },
      },
      nextPort: 31017,
      usages: {},
    }

    await userService.restartContainer(ADDR)

    expect(create.mock.calls[0][5]).toMatchObject({ image: 'dsh-multitenant:0.1.1-rc.2' })
  })

  it('state 里没有该租户 → 仍报 404（不能凭空给未知地址造容器）', async () => {
    dockerService.containerInfo.mockResolvedValue({ exists: false })
    userService.state = { swtcUsers: {}, usages: {} }

    await expect(userService.restartContainer(ADDR)).rejects.toThrow(/租户不存在/)
  })

  it('容器还在 → 正常重启路径不受影响（回归保护）', async () => {
    const spy = vi.spyOn(userService, 'ensureContainer')
    await userService.restartContainer(ADDR)

    expect(dockerService.restartContainer).toHaveBeenCalledWith(NAME)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 同一漂移（容器已不存在）下，其余三个操作的正确语义。
// 共同点：绝不抛 "Container not found" —— 那只是把状态不一致转嫁给用户。
// ---------------------------------------------------------------------------
describe('其余操作的漂移语义（容器不存在时）', () => {
  beforeEach(() => {
    dockerService.containerInfo.mockResolvedValue({ exists: false })
    userService.state = {
      swtcUsers: {
        [ADDR]: { port: PORT, internalPort: 45377, tier: 1, usageStartedAt: Date.now() - 60000 },
      },
      nextPort: 31017,
      usages: {},
    }
  })

  it('stopContainerForUser：目标已达成 → 结算额度 + 对齐状态 + 成功返回', async () => {
    const res = await userService.stopContainerForUser(ADDR)

    expect(res).toMatchObject({ ok: true, status: 'already_stopped' })
    // 额度保全：运行段必须结算（usageStartedAt 被清掉）
    expect(userService.state.swtcUsers[ADDR].usageStartedAt).toBeUndefined()
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('stopped')
    expect(dockerService.stopContainer).not.toHaveBeenCalled()
  })

  it('forceStopContainer：已销毁状态不被覆盖回 stopped', async () => {
    userService.state.swtcUsers[ADDR].containerStatus = 'destroyed'

    const res = await userService.forceStopContainer(ADDR)

    expect(res).toMatchObject({ ok: true, status: 'already_stopped' })
    // 清理定时器的结论不能被管理动作改写（否则 destroyed 记录倒退回可销毁态）
    expect(userService.state.swtcUsers[ADDR].containerStatus).toBe('destroyed')
  })

  it('upgradeContainer：无容器 → 只落配额，下次创建生效，不炸调用方', async () => {
    const res = await userService.upgradeContainer(ADDR, 2)

    expect(res).toMatchObject({ tier: 2, deferredToNextCreate: true })
    expect(userService.state.swtcUsers[ADDR].tier).toBe(2)
    // 没有任何"对不存在容器动手"的调用
    expect(dockerService.updateContainer).not.toHaveBeenCalled()
    expect(dockerService.stopContainer).not.toHaveBeenCalled()
    expect(dockerService.startContainer).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 重启路径的启动自愈：凭据文件损坏 → 隔离 + 重启一次
// ---------------------------------------------------------------------------
describe('restartContainer：凭据文件损坏时自愈', () => {
  it('诊断为凭据损坏 → 隔离坏文件并再启一次，最终成功', async () => {
    dockerService.containerDiagnostics.mockResolvedValue(
      'status=exited exit=1\nError: credentials-local: invalid document at ' +
        '/dsh-home/.credentials.yaml: MULTILINE_IMPLICIT_KEY at line 1',
    )
    const quarantine = dockerService.quarantineVolumeFile.mockResolvedValue(
      '/dsh-home/.credentials.yaml.broken-2026-09-18',
    )
    dockerService.waitReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    const res = await userService.restartContainer(ADDR)

    expect(res).toMatchObject({ ok: true })
    expect(quarantine).toHaveBeenCalledWith(`dsh-data-swtc-${ADDR}`, '.credentials.yaml')
    // 隔离后必须真再启一次，并用第二次探测确认就绪
    expect(dockerService.startContainer).toHaveBeenCalledWith(NAME)
    expect(dockerService.waitReady).toHaveBeenCalledTimes(2)
    expect(userService.state.swtcUsers[ADDR].credentialsQuarantinedAt).toBeTypeOf('number')
  })

  it('非凭据故障 → 不隔离、原样抛错（不误伤用户凭据）', async () => {
    dockerService.containerDiagnostics.mockResolvedValue('status=exited exit=137 oom=true')
    dockerService.waitReady.mockResolvedValue(false)

    await expect(userService.restartContainer(ADDR)).rejects.toThrow(/did not become ready/)

    expect(dockerService.quarantineVolumeFile).not.toHaveBeenCalled()
  })
})
