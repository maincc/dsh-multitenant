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
  cwtStore: {},
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
