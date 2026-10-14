/**
 * applyImageVersion / POST /api/admin/dsh/apply 测试
 *
 * 这是破坏性最高的路径（停→删→重建租户容器），因此重点覆盖"安全护栏"：
 *   - 容器不存在 / 已是当前镜像 → 跳过（不无谓重建，避免制造停机）
 *   - 目标镜像不存在 → 提前失败（不能等停了容器才发现）
 *   - 备份失败 → 中止，绝不动容器（没有退路不动手）
 *   - 端口保护：重建窗口内该端口不能被回收池分给别的租户（否则 URL 会变）
 *   - 重建失败 → 状态为 stopped（与"容器已删"一致）+ 回报备份路径
 *   - dryRun → 只报告，不碰容器
 *   - 租户不存在 → 404
 *
 * 隔离：mock docker 全部破坏性调用 + listen + saveState。
 * ensureContainer 被 spy 掉：其内部逻辑已由 finalize-tenant.test.js 单独覆盖，
 * 这里只关心"apply 把容器删干净后交给它重建"。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/services/docker.service.js', () => ({
  dockerService: {
    containerInfo: vi.fn(),
    imageId: vi.fn(),
    containerImageId: vi.fn(),
    imageDshVersion: vi.fn(),
    backupVolume: vi.fn(),
    stopContainer: vi.fn(),
    removeContainer: vi.fn(),
    removeVolume: vi.fn(),
  },
}))

vi.mock('../src/config/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAdmin: vi.fn(() => true),
}))

vi.mock('../src/services/cwt-admin.service.js', () => ({ cwtAdminService: {} }))
// 注意：**不整块 mock** tenantConfigService —— 加固后的破坏性操作要走真实的
// 挑战池（issueChallenge/consumeChallenge 的一次性语义），只把密码学部分
// （verifySignature）用 spy 替掉，见 beforeEach。
vi.mock('../src/services/tenant-proxy.service.js', () => ({
  tenantGateway: { listen: vi.fn(), close: vi.fn() },
}))
vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      loadState: vi.fn(() => ({ swtcUsers: {}, nextPort: 31000 })),
      saveState: vi.fn(() => {}),
      loadSessions: vi.fn(() => ({})),
      saveSessions: vi.fn(() => {}),
      loadUserSessions: vi.fn(() => ({})),
      saveUserSessions: vi.fn(() => ({})),
      loadCwtRegistry: vi.fn(() => ({})),
      loadCwtApplications: vi.fn(() => []),
      saveCwtApplications: vi.fn(() => {}),
      readStateFile: vi.fn(() => null),
      logOperation: vi.fn(() => {}),
    },
  }
})

import { handleAdminRoutes } from '../src/routes/admin.routes.js'
import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { dataService } from '../src/services/data.service.js'
import { adminSessionStore } from '../src/middleware/auth.middleware.js'
import { tenantConfigService } from '../src/services/tenant-config.service.js'
import { isAdmin, CONFIG } from '../src/config/config.js'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ADMIN_ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const TENANT = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'
const PORT = 31009

class MockReq extends EventEmitter {
  constructor({ method, url, cookie, body, ...extraHeaders }) {
    super()
    this.method = method
    this.url = url
    this.headers = { host: '127.0.0.1:8090', cookie, ...extraHeaders }
    this.socket = { remoteAddress: '127.0.0.1' }
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

function makeReq(opts = {}) {
  return new MockReq({ method: 'GET', url: '/', cookie: '', ...opts })
}

function makeRes() {
  return {
    headersSent: false,
    statusCode: null,
    body: '',
    headers: {},
    writeHead(code, h) {
      this.statusCode = code
      this.headers = { ...(h || {}) }
      this.headersSent = true
    },
    end(data) {
      this.body = data || ''
    },
  }
}

const json = (res) => JSON.parse(res.body)
const adminCookie = () => `admin_session=${adminSessionStore.create(ADMIN_ADDR, 3600_000)}`

/**
 * 为一个 dsh/apply 请求生成有效的签名请求头。
 *
 * 加固后 /api/admin/dsh/apply 要求"当场钱包签名"：先按 (operation, payload)
 * 领一次性挑战，再带上签名材料执行。这里走真实的挑战池，只把验签 mock 掉，
 * 因此能覆盖"绑定串必须一致、nonce 只能用一次"这些新契约。
 */
async function applySignatureHeaders(payload) {
  const chalReq = makeReq({
    method: 'POST',
    url: '/api/admin/challenge',
    cookie: adminCookie(),
    body: { address: ADMIN_ADDR, operation: 'dsh/apply', payload },
  })
  const chalRes = makeRes()
  await handleAdminRoutes(chalReq, chalRes, '/api/admin/challenge')
  if (chalRes.statusCode !== 200) {
    throw new Error(`挑战发放失败: ${chalRes.statusCode} ${chalRes.body}`)
  }
  const { nonce, message } = json(chalRes)
  return {
    'x-admin-nonce': nonce,
    'x-admin-signature': `sig:${message}`,
    'x-admin-pubkey': 'PUBKEY',
  }
}

/** 注入一个"已在旧镜像上"的租户 */
function injectTenant(overrides = {}) {
  userService.state.swtcUsers[TENANT] = {
    port: PORT,
    tier: 1,
    containerStatus: 'running',
    baseImageVersion: '0.1.5-rc.1',
    ...overrides,
  }
}

let backupDir = null

beforeEach(() => {
  vi.restoreAllMocks()
  isAdmin.mockReturnValue(true)
  adminSessionStore.sessions = {}
  userService.state.swtcUsers = {}
  userService.state.availablePorts = []

  // 生产默认 /backup/dsh-multitenant（deploy/backup.sh 同款）；测试改到临时目录
  backupDir = mkdtempSync(join(tmpdir(), 'dsh-backup-'))
  CONFIG.dsh.backupDir = backupDir

  // 验签依赖 SWTC 密码学 → 用 spy 替掉；挑战池用真实实现（一次性语义要覆盖）
  vi.spyOn(tenantConfigService, 'verifySignature').mockImplementation(
    (addr, message, signature) => signature === `sig:${message}`,
  )

  dockerService.containerInfo.mockResolvedValue({ exists: true, status: 'running' })
  dockerService.imageId.mockResolvedValue('sha256:NEW')
  dockerService.containerImageId.mockResolvedValue('sha256:OLD')
  dockerService.imageDshVersion.mockResolvedValue('0.1.6-alpha.1')
  dockerService.backupVolume.mockResolvedValue('/backup/dsh-multitenant/vol-x.tgz')
  dockerService.stopContainer.mockResolvedValue(undefined)
  dockerService.removeContainer.mockResolvedValue(undefined)
  dockerService.removeVolume.mockResolvedValue(undefined)

  // ensureContainer 内部逻辑另有测试覆盖；这里只验证"交给它重建"
  vi.spyOn(userService, 'ensureContainer').mockResolvedValue(PORT)
  vi.spyOn(userService, 'settleUsage').mockImplementation(() => {})
  vi.spyOn(dataService, 'saveState').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  adminSessionStore.sessions = {}
  userService.state.swtcUsers = {}
  if (backupDir) {
    try {
      rmSync(backupDir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
    backupDir = null
  }
})

describe('applyImageVersion：跳过场景', () => {
  it('租户记录不存在 → 404 语义（NotFoundError）', async () => {
    await expect(userService.applyImageVersion(TENANT)).rejects.toThrow(/租户不存在/)
  })

  it('容器不存在 → skipped（下次连接自动用新镜像，无需重建）', async () => {
    injectTenant()
    dockerService.containerInfo.mockResolvedValue({ exists: false, status: 'missing' })

    const res = await userService.applyImageVersion(TENANT)

    expect(res.skipped).toBe(true)
    expect(res.reason).toMatch(/容器不存在/)
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
  })

  it('已是当前镜像 → skipped:already-current，不重建', async () => {
    injectTenant()
    dockerService.containerImageId.mockResolvedValue('sha256:NEW') // 与 imageId 相同

    const res = await userService.applyImageVersion(TENANT)

    expect(res.skipped).toBe(true)
    expect(res.reason).toBe('already-current')
    expect(dockerService.stopContainer).not.toHaveBeenCalled()
    expect(dockerService.backupVolume).not.toHaveBeenCalled()
  })
})

describe('applyImageVersion：安全护栏', () => {
  it('目标镜像不存在 → 提前失败，且未停容器、未备份', async () => {
    injectTenant()
    dockerService.imageId.mockResolvedValue(null)

    await expect(userService.applyImageVersion(TENANT)).rejects.toThrow(/镜像不存在/)

    // 关键：不能等停了容器才发现镜像没了
    expect(dockerService.stopContainer).not.toHaveBeenCalled()
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
  })

  it('备份失败 → 中止，绝不动容器（没有退路不动手）', async () => {
    injectTenant()
    dockerService.backupVolume.mockRejectedValue(new Error('disk full'))

    await expect(userService.applyImageVersion(TENANT)).rejects.toThrow(/备份失败/)

    expect(dockerService.stopContainer).not.toHaveBeenCalled()
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
    expect(userService.ensureContainer).not.toHaveBeenCalled()
  })

  it('默认会备份（版本切换可能踩存储格式差异）', async () => {
    injectTenant()

    const res = await userService.applyImageVersion(TENANT)

    expect(dockerService.backupVolume).toHaveBeenCalledTimes(1)
    expect(res.backupPath).toMatch(/\.tgz$/)
  })

  it('backup:false 可显式跳过备份', async () => {
    injectTenant()

    await userService.applyImageVersion(TENANT, { backup: false })

    expect(dockerService.backupVolume).not.toHaveBeenCalled()
  })

  it('从不删除数据卷（这是 /apply 与 /reset 的本质区别）', async () => {
    injectTenant()

    await userService.applyImageVersion(TENANT)

    expect(dockerService.removeVolume).not.toHaveBeenCalled()
  })

  it('sync 状态：容器删除后状态为 stopped（与"容器已删"一致）', async () => {
    injectTenant()

    const res = await userService.applyImageVersion(TENANT)

    expect(res.applied).toBe(true)
    // 重建成功后状态由 ensureContainer/finalizeTenant 负责，这里断言它被调用了
    // 第三个参数是目标镜像：null = 平台默认 latest（未指定版本选择时）
    expect(userService.ensureContainer).toHaveBeenCalledWith(TENANT, true, null)
  })
})

describe('applyImageVersion：端口保护', () => {
  it('重建窗口内保留对外端口，且从回收池移除（防止分给别的租户致 URL 变化）', async () => {
    injectTenant()
    // 该端口恰好在回收池里（异常状态）→ 必须被摘掉
    userService.state.availablePorts = [PORT, 32000]

    await userService.applyImageVersion(TENANT)

    expect(userService.state.availablePorts).not.toContain(PORT)
    expect(userService.state.availablePorts).toContain(32000)
    // 记录里的 port 保留，ensureContainer 才能复用同一对外端口
    expect(userService.state.swtcUsers[TENANT].port).toBe(PORT)
  })

  it('结算运行段：重建耗时不计入租户当日用量', async () => {
    injectTenant()

    await userService.applyImageVersion(TENANT)

    expect(userService.settleUsage).toHaveBeenCalledWith(TENANT)
  })
})

describe('applyImageVersion：失败处理', () => {
  it('重建失败 → 抛出并带 backupPath，且状态为 stopped', async () => {
    injectTenant()
    userService.ensureContainer.mockRejectedValue(new Error('did not become ready'))

    let caught
    try {
      await userService.applyImageVersion(TENANT)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    expect(caught.message).toMatch(/重建失败/)
    expect(caught.backupPath).toMatch(/\.tgz$/)
    // 容器已删、重建失败 → 状态必须是 stopped，不能是 running
    expect(userService.state.swtcUsers[TENANT].containerStatus).toBe('stopped')
  })
})

describe('applyImageVersion：dryRun', () => {
  it('只报告计划，不碰容器、不备份', async () => {
    injectTenant()

    const res = await userService.applyImageVersion(TENANT, { dryRun: true })

    expect(res.dryRun).toBe(true)
    expect(res.fromImageId).toBe('sha256:OLD')
    expect(res.toImageId).toBe('sha256:NEW')
    expect(res.targetVersion).toBe('0.1.6-alpha.1')
    expect(dockerService.stopContainer).not.toHaveBeenCalled()
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
    expect(dockerService.backupVolume).not.toHaveBeenCalled()
  })

  // 回归：预览必须报告"备份目录能不能用"。
  // 真实故障：内置默认 backupDir=/backup/dsh-multitenant，在"普通用户直接跑在
  // 宿主机"时根目录无权创建 → 点「更新」才因备份 EPERM 中止（容器已停过一次）。
  // 预览必须提前暴露这个问题。
  it('报告快照目录与其可写性（供管理员提前发现 EPERM）', async () => {
    injectTenant()

    const res = await userService.applyImageVersion(TENANT, { dryRun: true })

    expect(res.backup).toBe(true)
    expect(res.backupDir).toBeTruthy()
    expect(res.backupDirError).toBeNull()
  })

  // 回归：显式配置了一个不可写的备份目录时，预览要报"会降级"，
  // 真实执行要自动降级并显著告警 —— 都不能让「更新」直接失败。
  it('配置的备份目录不可写 → 预览报告 will-fallback（不是直接报死）', async () => {
    injectTenant()
    vi.spyOn(CONFIG.dsh, 'backupDir', 'get').mockReturnValue('/proc/definitely-not-writable')

    const res = await userService.applyImageVersion(TENANT, { dryRun: true })

    expect(res.backupDir).toBeTruthy() // 有可用替代目录
    expect(res.backupDirFallback).toBe('/proc/definitely-not-writable')
    expect(res.backupDirError).toBeNull()
  })

  it('配置的备份目录不可写 → 真实执行降级到平台目录并成功备份', async () => {
    injectTenant()
    vi.spyOn(CONFIG.dsh, 'backupDir', 'get').mockReturnValue('/proc/definitely-not-writable')
    dockerService.backupVolume.mockResolvedValue('/fallback/vol.tgz')
    userService.ensureContainer = vi.fn(async () => 31016)

    await userService.applyImageVersion(TENANT)

    // 备份仍然发生（安全语义不变），只是落在可写目录
    const [volume, dir, file] = dockerService.backupVolume.mock.calls[0]
    expect(volume).toBeTruthy()
    expect(dir).not.toContain('/proc/definitely-not-writable')
    expect(file).toMatch(/\.tgz$/)
  })

  it('不写盘：dryRun 不得创建任何备份目录', async () => {
    injectTenant()
    const dir = join(tmpdir(), `dsh-dryrun-probe-${Date.now()}`)
    vi.spyOn(CONFIG.dsh, 'backupDir', 'get').mockReturnValue(dir)

    await userService.applyImageVersion(TENANT, { dryRun: true })

    expect(existsSync(dir)).toBe(false)
  })
})

describe('POST /api/admin/dsh/apply', () => {
  it('未登录 → 403', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ method: 'POST', url: '/api/admin/dsh/apply', body: { address: TENANT } }),
      res,
      '/api/admin/dsh/apply',
    )
    expect(res.statusCode).toBe(403)
  })

  it('缺少 address 且未传 all → 400', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: {},
      }),
      res,
      '/api/admin/dsh/apply',
    )
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toMatch(/address/)
  })

  it('地址非法 → 400（校验在触达容器之前）', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: { address: 'not-a-real-address' },
      }),
      res,
      '/api/admin/dsh/apply',
    )
    expect(res.statusCode).toBe(400)
    expect(userService.ensureContainer).not.toHaveBeenCalled()
  })

  it('单租户成功 → 200 + 明细', async () => {
    injectTenant()
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: { address: TENANT },
        ...(await applySignatureHeaders({ address: TENANT })),
      }),
      res,
      '/api/admin/dsh/apply',
    )

    const body = json(res)
    expect(res.statusCode).toBe(200)
    expect(body.applied).toBe(1)
    expect(body.results[0]).toMatchObject({ address: TENANT, ok: true })
  })

  it('单租户失败 → 207 + 失败明细（不吞错误）', async () => {
    injectTenant()
    userService.ensureContainer.mockRejectedValue(new Error('boom'))

    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: { address: TENANT },
        ...(await applySignatureHeaders({ address: TENANT })),
      }),
      res,
      '/api/admin/dsh/apply',
    )

    expect(res.statusCode).toBe(207)
    expect(json(res).failed).toBe(1)
    expect(json(res).results[0].ok).toBe(false)
  })

  it('dryRun 同步返回计划，不触发重建', async () => {
    injectTenant()
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: { address: TENANT, dryRun: true },
        ...(await applySignatureHeaders({ address: TENANT })),
      }),
      res,
      '/api/admin/dsh/apply',
    )

    expect(res.statusCode).toBe(200)
    expect(json(res).results[0].dryRun).toBe(true)
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
  })

  // 回归：管理面板的"预览"按钮漏加签名头 → 403 SIGNATURE_REQUIRED，
  // 用户看到的是"点了没反应"（错误只落在结果列表里，没有全局提示）。
  // dryRun 属于 dsh/apply 这个破坏性 operation，必须签名。
  it('dryRun 不带签名 → 403 SIGNATURE_REQUIRED（前端预览按钮的回归）', async () => {
    injectTenant()
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: { address: TENANT, dryRun: true },
      }),
      res,
      '/api/admin/dsh/apply',
    )

    expect(res.statusCode).toBe(403)
    expect(json(res).code).toBe('SIGNATURE_REQUIRED')
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
  })

  it('dryRun 带签名 → 200 且能拿到计划（预览可用）', async () => {
    injectTenant()
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: { address: TENANT, dryRun: true },
        ...(await applySignatureHeaders({ address: TENANT })),
      }),
      res,
      '/api/admin/dsh/apply',
    )

    expect(res.statusCode).toBe(200)
    const body = json(res)
    expect(body.results[0]).toMatchObject({ address: TENANT, dryRun: true })
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
  })

  it('批量预览 all+dryRun 带签名 → 200', async () => {
    injectTenant()
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: { all: true, dryRun: true },
        ...(await applySignatureHeaders({ all: true })),
      }),
      res,
      '/api/admin/dsh/apply',
    )

    expect(res.statusCode).toBe(200)
    expect(json(res).results.length).toBeGreaterThan(0)
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
  })

  it('all=true 无候选租户 → 200 明确说明（不是静默成功）', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        method: 'POST',
        url: '/api/admin/dsh/apply',
        cookie: adminCookie(),
        body: { all: true },
        ...(await applySignatureHeaders({ all: true })),
      }),
      res,
      '/api/admin/dsh/apply',
    )

    expect(res.statusCode).toBe(200)
    expect(json(res).applied).toBe(0)
    expect(json(res).message).toMatch(/没有需要处理/)
  })
})

describe('GET /api/admin/dsh/apply', () => {
  it('未登录 → 403', async () => {
    const res = makeRes()
    await handleAdminRoutes(makeReq({ url: '/api/admin/dsh/apply' }), res, '/api/admin/dsh/apply')
    expect(res.statusCode).toBe(403)
  })

  it('返回任务状态结构', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: '/api/admin/dsh/apply', cookie: adminCookie() }),
      res,
      '/api/admin/dsh/apply',
    )

    const body = json(res)
    expect(res.statusCode).toBe(200)
    expect(body).toHaveProperty('running')
    expect(body).toHaveProperty('completed')
    expect(body).toHaveProperty('total')
    expect(Array.isArray(body.results)).toBe(true)
  })
})
// ---------------------------------------------------------------------------
// 租户镜像选择：把某个租户钉到指定镜像（回滚 / 多版本并存）
//
// 平台原来只能升到 latest。这里的关键安全点是：
//   ① 指定镜像必须真的存在、且真的是本项目的 DSH 镜像
//   ② 任何校验都必须在动容器之前完成（否则白造一次停机）
//   ③ 选择要记进 state（pinnedImage），重建/重连都按它走
// ---------------------------------------------------------------------------
describe('applyImageVersion：租户镜像选择（钉到指定镜像）', () => {
  it('指定镜像存在且是 DSH 镜像 → 用它重建，并记录 pinnedImage', async () => {
    injectTenant()
    dockerService.containerInfo.mockResolvedValue({ exists: true, status: 'running' })
    dockerService.imageId.mockResolvedValue('sha256:oldoldoldold') // 指定镜像的 ID
    dockerService.imageDshVersion.mockResolvedValue('0.1.0-rc.2')
    dockerService.containerImageId.mockResolvedValue('sha256:newnewnewnew')
    dockerService.stopContainer.mockResolvedValue()
    dockerService.removeContainer.mockResolvedValue()

    const res = await userService.applyImageVersion(TENANT, {
      image: 'dsh-multitenant:0.1.0-rc.2',
      backup: false,
    })

    // 用指定的那个镜像解析出 ID（不是默认 latest）
    expect(dockerService.imageId).toHaveBeenCalledWith('dsh-multitenant:0.1.0-rc.2')
    expect(dockerService.imageDshVersion).toHaveBeenCalledWith('dsh-multitenant:0.1.0-rc.2')
    expect(res.applied).toBe(true)
    expect(res.imageId).toBe('sha256:oldoldoldold')
    expect(res.dshVersion).toBe('0.1.0-rc.2')
    // 重建时把目标镜像传下去
    expect(userService.ensureContainer).toHaveBeenCalledWith(
      TENANT,
      true,
      'dsh-multitenant:0.1.0-rc.2',
    )
    // 选择被记住，否则下次重建会悄悄回到 latest
    expect(userService.state.swtcUsers[TENANT].pinnedImage).toBe('dsh-multitenant:0.1.0-rc.2')
  })

  it('指定了本地不存在的镜像 → 提前 400，绝不碰容器', async () => {
    injectTenant()
    dockerService.containerInfo.mockResolvedValue({ exists: true, status: 'running' })
    dockerService.imageId.mockResolvedValue(null) // 镜像不存在

    await expect(
      userService.applyImageVersion(TENANT, { image: 'dsh-multitenant:9.9.9', backup: false }),
    ).rejects.toThrow(/租户镜像不存在/)

    expect(dockerService.stopContainer).not.toHaveBeenCalled()
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
  })

  it('指定了非 DSH 镜像（读不到版本号）→ 提前 400，绝不碰容器', async () => {
    injectTenant()
    dockerService.containerInfo.mockResolvedValue({ exists: true, status: 'running' })
    dockerService.imageId.mockResolvedValue('sha256:notadshimage')
    dockerService.imageDshVersion.mockResolvedValue(null) // 不是 DSH 镜像

    await expect(
      userService.applyImageVersion(TENANT, { image: 'dsh-multitenant:weird', backup: false }),
    ).rejects.toThrow(/不是可用的 DSH 镜像/)

    expect(dockerService.stopContainer).not.toHaveBeenCalled()
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
  })

  it('不传 image → 行为与改动前一致（走平台默认 latest）', async () => {
    injectTenant()
    dockerService.containerInfo.mockResolvedValue({ exists: true, status: 'running' })
    dockerService.imageId.mockResolvedValue('sha256:platdefault')
    dockerService.imageDshVersion.mockResolvedValue('0.1.5-rc.2')
    dockerService.containerImageId.mockResolvedValue('sha256:other')
    dockerService.stopContainer.mockResolvedValue()
    dockerService.removeContainer.mockResolvedValue()

    const res = await userService.applyImageVersion(TENANT, { backup: false })

    expect(dockerService.imageId).toHaveBeenCalledWith() // 无参 = 默认镜像
    expect(res.applied).toBe(true)
    // 不钉住 → null，跟随平台默认
    expect(userService.state.swtcUsers[TENANT].pinnedImage).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 容器已不存在（destroyed）时的镜像选择
//
// 踩到的真 bug：原来直接返回"无需重建"，把指定的镜像**丢掉了** ——
// 界面上选了版本，实际什么都没发生，下次连接仍用平台默认。
// ---------------------------------------------------------------------------
describe('租户镜像选择：容器不存在（已销毁）的租户', () => {
  it('指定镜像 → 记住 pin（下次创建时生效），且不留停机窗口', async () => {
    injectTenant({ containerStatus: 'destroyed' })
    dockerService.containerInfo.mockResolvedValue({ exists: false })
    dockerService.imageId.mockResolvedValue('sha256:oldver')
    dockerService.imageDshVersion.mockResolvedValue('0.1.1-rc.2')

    const res = await userService.applyImageVersion(TENANT, {
      image: 'dsh-multitenant:0.1.1-rc.2',
      backup: false,
    })

    expect(res.skipped).toBe(true)
    expect(res.pinnedImage).toBe('dsh-multitenant:0.1.1-rc.2')
    expect(userService.state.swtcUsers[TENANT].pinnedImage).toBe('dsh-multitenant:0.1.1-rc.2')
    // 容器本来就不存在 → 不该有任何停/删动作
    expect(dockerService.stopContainer).not.toHaveBeenCalled()
    expect(dockerService.removeContainer).not.toHaveBeenCalled()
  })

  it('指定不存在的镜像 → 报错，不能谎报"无需重建"', async () => {
    injectTenant({ containerStatus: 'destroyed' })
    dockerService.containerInfo.mockResolvedValue({ exists: false })
    dockerService.imageId.mockResolvedValue(null)

    await expect(
      userService.applyImageVersion(TENANT, { image: 'dsh-multitenant:9.9.9', backup: false }),
    ).rejects.toThrow(/租户镜像不存在/)
  })

  it('dryRun 指定镜像 → 只校验，不写入 pin（零副作用）', async () => {
    injectTenant({ containerStatus: 'destroyed' })
    dockerService.containerInfo.mockResolvedValue({ exists: false })
    dockerService.imageId.mockResolvedValue('sha256:oldver')
    dockerService.imageDshVersion.mockResolvedValue('0.1.1-rc.2')

    const res = await userService.applyImageVersion(TENANT, {
      image: 'dsh-multitenant:0.1.1-rc.2',
      dryRun: true,
      backup: false,
    })

    expect(res.skipped).toBe(true)
    expect(userService.state.swtcUsers[TENANT].pinnedImage).toBeUndefined()
  })
})
