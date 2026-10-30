/**
 * 环境模板自助面路由测试（方案③，2026-10-27）
 *
 * 钉死三条契约：
 *   1. 三端点只认会话本人（无会话 401；目标地址恒=会话，无入参面）
 *   2. 供应链闸与 admin 面同口径（published/digest 逐字/镜像缺失 410）
 *   3. 命名避坑：environment/revert **绝不能**被 tenant.routes 的
 *      /api/user/<addr>/reset 删卷端点劫持（断言 resetContainer 零调用）
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    applyImageVersion: vi.fn(),
    resetContainer: vi.fn(),
    state: { swtcUsers: {}, cleanupPolicy: {} },
  },
}))

vi.mock('../src/services/env-bundle.service.js', () => ({
  envBundleService: {
    applyBundleTo: vi.fn(async (addr, doc, opts = {}) => ({
      bundleApplied: !opts.dryRun,
      conflicts: opts.dryRun ? [{ p: 'plugins/a.js', size: 3 }] : [],
      skillsInstalled: [],
      skillsFailed: [],
      skillsPlanned: opts.dryRun ? doc.include?.skills || [] : [],
      notices: [],
    })),
    installBundle: vi.fn(),
    removeBundle: vi.fn(),
    exportBundle: vi.fn(async () => ({ files: [], bytes: 0, scan: { rulesVer: 1 } })),
    inventory: vi.fn(async () => ({
      skills: [{ name: 'cwt-verify', size: 9 }],
      plugins: [],
      roots: [],
    })),
    browse: vi.fn(async () => ({ dir: 'plugins', items: [], total: 0 })),
  },
}))

vi.mock('../src/services/skill.service.js', async (io) => {
  const m = await io()
  return {
    ...m,
    skillService: { ...m.skillService, uninstall: vi.fn(async () => ({ ok: true })) },
  }
})

vi.mock('../src/services/docker.service.js', () => ({
  dockerService: {
    imageId: vi.fn(),
    containerInfo: vi.fn(async () => ({ exists: true, status: 'running' })),
    listWorkspaceTop: vi.fn(async () => [{ name: '策略', sizeBytes: 1024 }]),
    containerImageId: vi.fn(async () => 'sha256:parent'),
    commitEnvironment: vi.fn(),
    removeImage: vi.fn(),
    execSh: vi.fn(async () => ''),
  },
}))

vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    dataService: {
      ...mod.dataService,
      loadState: vi.fn(() => ({ swtcUsers: {}, nextPort: 31000 })),
      saveState: vi.fn(() => {}),
      loadSessions: vi.fn(() => ({})),
      saveSessions: vi.fn(() => {}),
      loadUserSessions: vi.fn(() => ({})),
      saveUserSessions: vi.fn(() => ({})),
      loadCwtRegistry: vi.fn(() => ({})),
      readStateFile: vi.fn(() => null),
      logOperation: vi.fn(() => Promise.resolve()),
    },
  }
})

vi.mock('../src/services/credential.service.js', () => ({
  credentialService: { freezeAllowed: vi.fn(async () => true), isAdmSync: vi.fn(() => false) },
}))

// 限流计数跨用例累积会误伤本文件的语义断言（429 不是被测契约）；
// envapply 限流本身有中间件自己的套件负责
vi.mock('../src/middleware/rate-limit.middleware.js', () => ({
  rateLimit: vi.fn(() => true),
}))

import { handleUserRoutes } from '../src/routes/user.routes.js'
import { userService } from '../src/services/user.service.js'
import { dockerService } from '../src/services/docker.service.js'
import { dataService } from '../src/services/data.service.js'
import { userSessionStore } from '../src/middleware/user-auth.middleware.js'

const USER = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'
const TPL = 'dsh-multitenant:env-aaaaaaaa-stock-20261027120000'

function makeReq({ method = 'GET', url = '/', cookie = '', body } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8090', cookie },
    socket: { remoteAddress: '127.0.0.1' },
    _body: body,
    on(ev, cb) {
      if (ev === 'data' && this._body !== undefined) cb(JSON.stringify(this._body))
      if (ev === 'end') cb()
      return this
    },
  }
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

async function call(path, { method = 'GET', body, cookie = true } = {}) {
  const res = makeRes()
  await handleUserRoutes(
    makeReq({ method, url: path, body, cookie: cookie ? `user_session=${token}` : '' }),
    res,
    path,
  )
  return res
}

let token

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  token = userSessionStore.create(USER)
  globalThis.__envStore = new Map()
  dataService.putEnvironment = vi.fn(async (doc) => {
    globalThis.__envStore.set(doc._id, { ...doc })
    return doc
  })
  dataService.listEnvironments = vi.fn(async () => [...globalThis.__envStore.values()])
  dataService.getEnvironment = vi.fn(async (id) => globalThis.__envStore.get(id) || null)
  dataService.patchEnvironment = vi.fn(async (id, set) => {
    const d = globalThis.__envStore.get(id)
    if (!d) return null
    Object.assign(d, set)
    return { ...d }
  })
  dockerService.imageId.mockResolvedValue('sha256:abc123')
  userService.applyImageVersion.mockResolvedValue({ applied: true })
})

afterEach(() => {
  userSessionStore.sessions = {}
  userService.state.swtcUsers = {}
})

function seed(over = {}) {
  globalThis.__envStore.set(TPL, {
    _id: TPL,
    sourceAddr: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    slug: 'stock',
    imageId: 'sha256:abc123',
    dshVersion: '0.1.5',
    sizeBytes: 1234,
    scrubbed: true,
    status: 'published',
    pinnedBy: [],
    createdAt: '2026-10-27T12:00:00.000Z',
    ...over,
  })
}

describe('GET /api/user/environments', () => {
  it('无会话 → 401；有 user_session → 只列 published + 我当前来源', async () => {
    let res = await call('/api/user/environments', { cookie: false })
    expect(res.statusCode).toBe(401)

    seed()
    globalThis.__envStore.set('draft-one', { _id: 'd', status: 'draft' })
    globalThis.__envStore.set('revo-one', { _id: 'r', status: 'revoked' })
    userService.state.swtcUsers[USER] = { pinnedImage: TPL }
    res = await call('/api/user/environments')
    expect(res.statusCode).toBe(200)
    const body = json(res)
    expect(body.environments.length).toBe(1) // draft/revoked 不进选用面
    expect(body.environments[0].id).toBe(TPL)
    expect(body.environments[0].name).toBe('stock') // 无 displayName 老数据回退 slug
    expect(body.environments[0].manifest).toBeUndefined() // 审核证据不外露
    expect(body.yourCurrent.fromTemplate.slug).toBe('stock')
  })

  it('pin 的是版本镜像（非模板）→ fromTemplate 如实标 null', async () => {
    userService.state.swtcUsers[USER] = { pinnedImage: 'dsh-multitenant:0.2.0' }
    const body = json(await call('/api/user/environments'))
    expect(body.yourCurrent.image).toBe('dsh-multitenant:0.2.0')
    expect(body.yourCurrent.fromTemplate).toBe(null)
  })
})

describe('POST /api/user/environment/apply', () => {
  it('无会话 401；不传目标地址入参——作用面恒为会话本人', async () => {
    seed()
    let res = await call('/api/user/environment/apply', {
      method: 'POST',
      body: { id: TPL },
      cookie: false,
    })
    expect(res.statusCode).toBe(401)
    res = await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(200)
    expect(userService.applyImageVersion).toHaveBeenCalledWith(USER, { image: TPL, dryRun: false })
  })

  it('draft/revoked → 409（审核闸同一张面孔）', async () => {
    seed({ status: 'draft' })
    let res = await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(409)
    seed({ status: 'revoked' })
    res = await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(409)
    expect(userService.applyImageVersion).not.toHaveBeenCalled()
  })

  it('同名覆盖 digest 不符 → 409；镜像消失 → 410', async () => {
    seed()
    dockerService.imageId.mockResolvedValue('sha256:EVIL')
    let res = await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(409)
    dockerService.imageId.mockResolvedValue(null)
    res = await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(410)
  })

  it('dryRun 不记账不审计；正式执行 pinnedBy 记名 + env_apply_self 留痕', async () => {
    seed()
    await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL, dryRun: true } })
    expect(globalThis.__envStore.get(TPL).pinnedBy).toEqual([])
    expect(dataService.logOperation).not.toHaveBeenCalled()

    await call('/api/user/environment/apply', { method: 'POST', body: { id: TPL } })
    expect(globalThis.__envStore.get(TPL).pinnedBy).toContain(USER)
    expect(dataService.logOperation).toHaveBeenCalledWith(
      'env_apply_self',
      expect.objectContaining({ id: TPL, address: USER, operator: USER }),
    )
  })
})

describe('POST /api/user/environment/revert（回平台默认）', () => {
  it('走 applyImageVersion(image=null) + 清引用账本 + 审计', async () => {
    seed({ pinnedBy: [USER] })
    const res = await call('/api/user/environment/revert', { method: 'POST', body: {} })
    expect(res.statusCode).toBe(200)
    expect(userService.applyImageVersion).toHaveBeenCalledWith(USER, {
      image: null,
      dryRun: false,
      workspaceSnapshot: 'archive-only', // 回退=干净默认：工作目录只存档不合回
    })
    expect(globalThis.__envStore.get(TPL).pinnedBy).not.toContain(USER)
    expect(dataService.logOperation).toHaveBeenCalledWith(
      'env_reset_self',
      expect.objectContaining({ address: USER }),
    )
  })

  it('勾「一并清除」：只 rm 清单点名目录（白名单校验，别的都不碰）', async () => {
    seed({
      pinnedBy: [USER],
      include: {
        skills: ['stock-advisor', 'bad name; rm -rf /'],
        plugins: ['stock-close-notify'],
        folders: [],
      },
    })
    const res = await call('/api/user/environment/revert', {
      method: 'POST',
      body: { alsoClean: true },
    })
    expect(res.statusCode).toBe(200)
    const { dockerService } = await import('../src/services/docker.service.js')
    const { skillService } = await import('../src/services/skill.service.js')
    // 技能走正路：uninstall=删文件+销安装账（判例：只 rm 不销账=UI 显示装了个空气）
    expect(skillService.uninstall).toHaveBeenCalledWith(USER, 'stock-advisor')
    expect(skillService.uninstall).not.toHaveBeenCalledWith(USER, expect.stringContaining('bad'))
    expect(dockerService.execSh).toHaveBeenCalledTimes(1)
    const cmd = String(dockerService.execSh.mock.calls[0][1])
    expect(cmd).toContain('rm -rf /dsh-home/plugins/stock-close-notify')
    expect(cmd).not.toContain('skills/')
    expect(cmd).not.toContain('bad name')
    expect(json(res).cleanNote).toContain('2 项')
    expect(json(res).cleanNote).toContain('账本同步销记')
  })

  it('作者已上架的作品也在 myWorks 全状态账里（下架入口不断头）', async () => {
    seed({ status: 'published', sourceAddr: USER })
    globalThis.__envStore.set('other-pub', {
      _id: 'other-pub',
      name: '别人家',
      slug: 'stock',
      status: 'published',
      sourceAddr: 'someoneelseaddrnotmine0000000000000',
      pinnedBy: [],
      include: {},
      createdAt: new Date(),
    })
    const res = await call('/api/user/environments', { method: 'GET' })
    expect(res.statusCode).toBe(200)
    const mine = json(res).myWorks
    expect(mine.some((w) => w.id === TPL && w.status === 'published')).toBe(true)
    expect(mine.some((w) => w.id === 'other-pub')).toBe(false)
    globalThis.__envStore.delete('other-pub')
  })

  it(
    '审查B⑤：dot 目录名（' + '"' + '..' + '"' + '/.' + '"' + '）出闸——rm -rf plugins/.. 端整卷案防',
    async () => {
      seed({
        pinnedBy: [USER],
        include: { skills: ['..', '.', 'good-skill'], plugins: ['..'], folders: [] },
      })
      const res = await call('/api/user/environment/revert', {
        method: 'POST',
        body: { alsoClean: true },
      })
      expect(res.statusCode).toBe(200)
      const { dockerService } = await import('../src/services/docker.service.js')
      const { skillService } = await import('../src/services/skill.service.js')
      expect(skillService.uninstall).toHaveBeenCalledTimes(1)
      expect(skillService.uninstall).toHaveBeenCalledWith(USER, 'good-skill')
      expect(dockerService.execSh).not.toHaveBeenCalled() // 过滤后插件清单为空，execSh 根本不该进
      expect(json(res).cleanNote).toContain('1 项')
    },
  )

  it('审查B③：清除清单以实物 pin 为源——先后套过 A/B 不按旧账清', async () => {
    seed({ pinnedBy: [USER], include: { skills: ['s-A'], plugins: [], folders: [] } })
    const aDoc = globalThis.__envStore.get(TPL)
    globalThis.__envStore.set('tpl-B', {
      ...aDoc,
      _id: 'tpl-B',
      name: 'B',
      pinnedBy: [USER],
      include: { skills: ['s-B'], plugins: [], folders: [] },
    })
    const { userService } = await import('../src/services/user.service.js')
    userService.state.swtcUsers[USER] = { pinnedImage: 'tpl-B' }
    try {
      const res = await call('/api/user/environment/revert', {
        method: 'POST',
        body: { alsoClean: true },
      })
      expect(res.statusCode).toBe(200)
      const { skillService } = await import('../src/services/skill.service.js')
      expect(skillService.uninstall).toHaveBeenCalledWith(USER, 's-B')
      expect(skillService.uninstall).not.toHaveBeenCalledWith(USER, 's-A')
    } finally {
      delete userService.state.swtcUsers[USER] // 别把 pin 遗案留给下一个用例
    }
  })

  it('审查B4：换钉即迁账——A→B 后 A 的引用账不再挂本人', async () => {
    seed({ pinnedBy: [USER] })
    const aDoc = globalThis.__envStore.get(TPL)
    globalThis.__envStore.set('tpl-B', { ...aDoc, _id: 'tpl-B', name: 'B', pinnedBy: [] })
    const res = await call('/api/user/environment/apply', { method: 'POST', body: { id: 'tpl-B' } })
    expect(res.statusCode).toBe(200)
    expect(globalThis.__envStore.get('tpl-B').pinnedBy).toContain(USER)
    expect(globalThis.__envStore.get(TPL).pinnedBy || []).not.toContain(USER)
    globalThis.__envStore.delete('tpl-B')
  })

  it('审查B8：勾了清除但查无套用记录——勾选不被无声吞', async () => {
    seed({ pinnedBy: [] })
    const { userService } = await import('../src/services/user.service.js')
    userService.state.swtcUsers[USER] = { pinnedImage: null }
    try {
      const res = await call('/api/user/environment/revert', {
        method: 'POST',
        body: { alsoClean: true },
      })
      expect(res.statusCode).toBe(200)
      expect(json(res).cleanNote).toContain('查无套用模板')
    } finally {
      delete userService.state.swtcUsers[USER]
    }
  })

  it('命名防劫持钉：revert 绝不落入删卷重建（resetContainer 零调用）', async () => {
    const res = await call('/api/user/environment/revert', { method: 'POST', body: {} })
    expect(res.statusCode).toBe(200)
    expect(userService.resetContainer).not.toHaveBeenCalled()
  })
})

describe('PR2 随行包：自助选用/回退的包语义', () => {
  it('apply 带包模板：冲突预览与 bundleApplied 并入响应', async () => {
    const { envBundleService } = await import('../src/services/env-bundle.service.js')
    seed()
    const res = await call('/api/user/environment/apply', {
      method: 'POST',
      body: { id: TPL, dryRun: true },
    })
    expect(res.statusCode).toBe(200)
    // seed 模板无包 → applyBundleTo 仍被调（短路返回空），响应结构合并成立
    expect(envBundleService.applyBundleTo).toHaveBeenCalled()
  })

  it('revert 绝不触碰随行包（只加不减：装进去的文件拆不拆是用户的事）', async () => {
    const { envBundleService } = await import('../src/services/env-bundle.service.js')
    vi.mocked(envBundleService.installBundle).mockClear()
    seed({ pinnedBy: [USER] })
    const res = await call('/api/user/environment/revert', { method: 'POST', body: {} })
    expect(res.statusCode).toBe(200)
    expect(envBundleService.installBundle).not.toHaveBeenCalled()
    expect(envBundleService.applyBundleTo).not.toHaveBeenCalled()
  })
})

describe('PR3 自助定格（本人面：freezeAllowed + autoSlug + 共用流程）', () => {
  let credentialService
  let envBundleService
  let dockerService
  beforeEach(async () => {
    credentialService = (await import('../src/services/credential.service.js')).credentialService
    envBundleService = (await import('../src/services/env-bundle.service.js')).envBundleService
    dockerService = (await import('../src/services/docker.service.js')).dockerService
    dockerService.commitEnvironment.mockImplementation((name, tag) =>
      Promise.resolve({
        tag,
        imageId: 'sha256:abc123',
        sizeBytes: 1234,
        dshVersion: '0.1.5',
        manifest: ['C /root/.bashrc', 'A /usr/local/bin/trader'],
        scrubbed: true,
      }),
    )
  })

  it('无会话 → 401；无资格 → 403 FREEZE_REQUIRES_CWT（容器不受影响，只锁定格面）', async () => {
    const anon = await call('/api/user/environment-commit', {
      method: 'POST',
      body: {},
      cookie: false,
    })
    expect(anon.statusCode).toBe(401)
    credentialService.freezeAllowed.mockResolvedValueOnce(false)
    const denied = await call('/api/user/environment-commit', {
      method: 'POST',
      body: { displayName: '我的炒股环境' },
    })
    expect(denied.statusCode).toBe(403)
    expect(JSON.parse(denied.body).code).toBe('FREEZE_REQUIRES_CWT')
    expect(dockerService.containerInfo).not.toHaveBeenCalled() // 拦在碰 docker 之前
  })

  it('缺 displayName → 400（起名是定格的语义前提，slug 用户不碰）', async () => {
    const res = await call('/api/user/environment-commit', {
      method: 'POST',
      body: { dryRun: true },
    })
    expect(res.statusCode).toBe(400)
  })

  it('dryRun：中文展示名自动转写 slug=env；步骤/配额/警告全回；零 docker 写', async () => {
    const res = await call('/api/user/environment-commit', {
      method: 'POST',
      body: { displayName: '我的炒股环境', dryRun: true },
    })
    expect(res.statusCode).toBe(200)
    const b = JSON.parse(res.body)
    expect(b.dryRun).toBe(true)
    expect(b.tag).toMatch(/:env-[a-z0-9]{8}-env-\d{14}$/)
    expect(b.quota).toEqual({ used: 0, limit: 5 })
    expect(b.notices.join('')).toContain('默认清空') // workspace 真相提示语在自助面同样成立
    expect(dockerService.commitEnvironment).not.toHaveBeenCalled()
    expect(envBundleService.exportBundle).not.toHaveBeenCalled()
    expect(globalThis.__envStore.size).toBe(0)
  })

  it('真定格：入账本 createdBy=本人 + 审计 env_commit_self + manifest 折叠', async () => {
    const res = await call('/api/user/environment-commit', {
      method: 'POST',
      body: { displayName: 'stock desk', intro: 'akshare 看板' },
    })
    expect(res.statusCode).toBe(200)
    const { template } = JSON.parse(res.body)
    expect(template.slug).toBe('stock-desk') // ascii 可转写时保语义
    expect(template.displayName).toBe('stock desk')
    expect(template.createdBy).toBe(USER) // 本人操作人（代格面记管理员，区分追责）
    expect(template.status).toBe('draft')
    expect(template.manifestCount).toBe(2)
    expect(globalThis.__envStore.get(template._id).intro).toBe('akshare 看板')
    const op = dataService.logOperation.mock.calls.find((c) => c[0] === 'env_commit_self')
    expect(op[1].operator).toBe(USER)
  })

  it('套来的环境上禁止再定格：按实物镜像 ID 亮 409 TEMPLATE_IN_USE（回退后可恢复）', async () => {
    // 容器实物镜像='sha256:parent'（mock），放一条"别人的模板恰好是这个镜像"的账本
    const fakeTpl = {
      _id: 'dsh-multitenant:env-other008-x-1',
      sourceAddr: 'other008xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      slug: 'x',
      displayName: '别人的炒股环境',
      imageId: 'sha256:parent',
      status: 'published',
      pinnedBy: [],
    }
    globalThis.__envStore.set(fakeTpl._id, fakeTpl)
    const res = await call('/api/user/environment-commit', {
      method: 'POST',
      body: { displayName: '我的二版', dryRun: true },
    })
    expect(res.statusCode).toBe(409)
    const b = JSON.parse(res.body)
    expect(b.code).toBe('TEMPLATE_IN_USE')
    expect(b.error).toContain('别人的炒股环境')
    expect(b.error).toContain('翻版') // 判例原话入断言：通俗文案即最终文案
    expect(b.error).toContain('回退到默认') // 拒绝必须给出路
    expect(dockerService.commitEnvironment).not.toHaveBeenCalled()
    // inventory 同一事实给前端侦察字段（亮"先回退"卡而不是灰按钮）
    const inv = await call('/api/user/environment-inventory', { method: 'POST', body: {} })
    const j = JSON.parse(inv.body)
    expect(j.onTemplate).toEqual({ name: '别人的炒股环境', byMe: false })
    // 拿走（=回退后镜像不再是模板）→ 定格恢复可用
    globalThis.__envStore.delete(fakeTpl._id)
    const after = await call('/api/user/environment-commit', {
      method: 'POST',
      body: { displayName: '我的二版', dryRun: true },
    })
    expect(after.statusCode).toBe(200)
  })

  it('inventory/browse：资格门后直通 helper（前端只渲染平台给的安全面）', async () => {
    const inv = await call('/api/user/environment-inventory', { method: 'POST', body: {} })
    expect(inv.statusCode).toBe(200)
    expect(JSON.parse(inv.body).inventory.skills[0].name).toBe('cwt-verify')
    credentialService.freezeAllowed.mockResolvedValueOnce(false)
    const denied = await call('/api/user/environment-browse', {
      method: 'POST',
      body: { dir: 'plugins' },
    })
    expect(denied.statusCode).toBe(403)
  })
})

describe('POST /api/user/environment/unpublish（作者自助下架：published→unlisted）', () => {
  it('无会话 → 401', async () => {
    const res = await call('/api/user/environment/unpublish', {
      method: 'POST',
      body: { id: TPL },
      cookie: false,
    })
    expect(res.statusCode).toBe(401)
  })

  it('不是作者 → 403（只能下架自己的东西）', async () => {
    seed({ sourceAddr: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    const res = await call('/api/user/environment/unpublish', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(403)
    expect(globalThis.__envStore.get(TPL).status).toBe('published')
  })

  it('非上架态 → 400（本就不在市场里，无从下架）', async () => {
    seed({ sourceAddr: USER, status: 'draft' })
    const res = await call('/api/user/environment/unpublish', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(400)
  })

  it('重新提交（出口律：下架有去路）：unlisted→draft 走通并留审计（管理端只认 draft 队列）', async () => {
    seed({ sourceAddr: USER, status: 'unlisted' })
    const res = await call('/api/user/environment/submit', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(200)
    expect(globalThis.__envStore.get(TPL).status).toBe('draft')
    expect(dataService.logOperation).toHaveBeenCalledWith(
      'env_submit_self',
      expect.objectContaining({ address: USER, id: TPL }),
    )
  })

  it('不在下架态不许提交 → 400；不是自己的 → 403', async () => {
    seed({ sourceAddr: USER, status: 'published' })
    expect(
      (await call('/api/user/environment/submit', { method: 'POST', body: { id: TPL } }))
        .statusCode,
    ).toBe(400)
    seed({ sourceAddr: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'draft' })
    expect(
      (await call('/api/user/environment/submit', { method: 'POST', body: { id: TPL } }))
        .statusCode,
    ).toBe(403)
  })

  it('作者下架：published→unlisted、引用账本原样保留（下架≠删除，绝不上锁）、审计在案', async () => {
    seed({ sourceAddr: USER, pinnedBy: ['other008xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', USER] })
    const res = await call('/api/user/environment/unpublish', { method: 'POST', body: { id: TPL } })
    expect(res.statusCode).toBe(200)
    const doc = globalThis.__envStore.get(TPL)
    expect(doc.status).toBe('unlisted')
    expect(doc.pinnedBy.length).toBe(2) // 在用的人不受影响，账本一个字不动
    expect(json(res).usingCount).toBe(2)
    expect(dataService.logOperation).toHaveBeenCalledWith(
      'env_unpublish_self',
      expect.objectContaining({ address: USER, id: TPL }),
    )
  })

  it('货架给作者卡标 isMine（前端下架入口的凭据）', async () => {
    seed({ sourceAddr: USER })
    expect(json(await call('/api/user/environments')).environments[0].isMine).toBe(true)
    seed({ sourceAddr: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(json(await call('/api/user/environments')).environments[0].isMine).toBe(false)
  })
})
