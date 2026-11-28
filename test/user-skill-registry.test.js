/**
 * 用户/技能域注册表回归测试（refactor-giant-files §P1）
 *
 * 钉死三类语义红线（机制层已在 admin-registry.test.js 覆盖，这里只测域事实）：
 *   ① guard:'user' 单源——无会话时 credential/env 全族 401 载荷逐字等于
 *      原 user.routes 里重复 14 次的块（前端据 UNAUTHORIZED 码走登录引导，勿改）；
 *   ② 顺序红线——/api/user/:address catch-all 必须最后（精确路径不被吞）、
 *      /api/user/<addr>/restart|reset|remove|stop 必须 fallthrough（归 tenant 域）；
 *   ③ 技能域兜底——/api/skills/* 一切未命中恒"已处理 404"（原 catch-all 块行为，
 *      含怪方法），S1 归属闸与 kebab 名校验的错误序保持。
 */

import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ session: null }))

const TARGET = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    state: { swtcUsers: {} },
    applyImageVersion: vi.fn(async () => ({ ok: true })),
    unpinAuthorOnOffshelf: vi.fn(async () => ({ skipped: true })),
    getUserInfo: vi.fn(async () => ({ address: 'x' })),
    upgradeContainer: vi.fn(async () => ({ ok: true })),
  },
}))
vi.mock('../src/services/data.service.js', () => ({
  dataService: {
    logOperation: vi.fn(async () => {}),
    getEnvironment: vi.fn(async () => null),
    listEnvironments: vi.fn(async () => []),
    loadSessions: vi.fn(() => ({})),
    saveSessions: vi.fn(),
    loadUserSessions: vi.fn(() => ({})),
    saveUserSessions: vi.fn(),
    readStateFile: vi.fn(() => null),
    saveState: vi.fn(),
  },
}))
vi.mock('../src/services/docker.service.js', () => ({
  dockerService: {
    containerImageId: vi.fn(async () => null),
    containerInfo: vi.fn(async () => ({ exists: false, status: null })),
    listWorkspaceTop: vi.fn(async () => []),
    imageId: vi.fn(async () => null),
    execSh: vi.fn(async () => {}),
  },
}))
vi.mock('../src/services/env-bundle.service.js', () => ({
  envBundleService: {
    inventory: vi.fn(async () => ({})),
    browse: vi.fn(async () => ({})),
    applyBundleTo: vi.fn(async () => ({})),
    probePluginContent: vi.fn(async () => ({})),
  },
}))
vi.mock('../src/services/env-commit.service.js', () => ({
  runEnvCommit: vi.fn(async () => ({ status: 200, body: { ok: true } })),
  normEnvNames: vi.fn(() => []),
  normEnvWsExcludes: vi.fn(() => []),
  autoSlug: vi.fn(() => 'auto-slug'),
}))
vi.mock('../src/services/skill.service.js', () => ({
  skillService: {
    authenticate: vi.fn(() => TARGET),
    publish: vi.fn(async () => ({})),
    importSkill: vi.fn(async () => ({})),
    mine: vi.fn(async () => ({ published: [], installed: [] })),
    mineView: vi.fn(async () => ({ published: [], installed: [] })),
    list: vi.fn(async () => []),
    detail: vi.fn(async () => ({ name: 'x' })),
    download: vi.fn(async () => ({ fileName: 'x.md', body: 'md' })),
    install: vi.fn(async () => ({})),
    uninstall: vi.fn(async () => ({ ok: true })),
    adminList: vi.fn(async () => []),
    unpublish: vi.fn(async () => ({})),
  },
}))
vi.mock('../src/services/credential.service.js', () => ({
  credentialService: {
    freezeAllowed: vi.fn(async () => true),
    isAdmSync: vi.fn(() => false),
    enter: vi.fn(async () => ({ hasCredential: false, popup: false })),
    getClaimedCredential: vi.fn(async () => ({ credential: null, consistent: true })),
    buildClaimDocument: vi.fn(async () => ({})),
    claimUpload: vi.fn(async () => ({ ok: true })),
    applyCwt: vi.fn(async () => ({ id: 'a1' })),
    myApplication: vi.fn(async () => null),
  },
}))
vi.mock('../src/services/tenant-config.service.js', () => ({
  tenantConfigService: {
    issueChallenge: vi.fn(),
    consumeChallenge: vi.fn(),
    verifySignature: vi.fn(),
    configure: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    discoverWithAuth: vi.fn(async () => []),
    getStatus: vi.fn(async () => ({
      apiKeyConfigured: false,
      baseURL: null,
      models: [],
      providers: [],
    })),
  },
  SIGN_PURPOSE: {
    LOGIN: 'login',
    CONNECT: 'connect',
    TENANT_CONFIG: 'tenant-config',
    SKILLS: 'skills',
    GATEWAY_VERIFY: 'gateway-verify',
  },
  buildSignedMessage: (purpose, address, nonce) =>
    `hex:dsh-multitenant|${purpose}|${address}|${nonce}`,
}))
vi.mock('../src/middleware/user-auth.middleware.js', () => ({
  userSessionStore: {
    sessions: {},
    create: vi.fn(() => 'tok'),
    resolve: vi.fn(() => null),
    revoke: vi.fn(async () => {}),
    init: vi.fn(),
    flush: vi.fn(async () => {}),
  },
  // guard:'user' 的行为入口——getRequestAddress 经 auth.middleware 转调此 mock
  getUserSession: vi.fn(() => h.session),
}))
vi.mock('../src/middleware/admin-signature.middleware.js', async (importOriginal) => {
  // ADMIN_SIGNED_OPERATIONS 必须真值——registry 的 signOp 白名单校验消费它；
  // 只桩掉会触碰密码学/账本的执行两函数
  const actual = await importOriginal()
  return {
    ...actual,
    attachAdminSignature: vi.fn(),
    requireAdminSignature: vi.fn(() => true),
  }
})

import { USER_ROUTES } from '../src/routes/user/index.js'
import { SKILL_ROUTES } from '../src/routes/skill/skills.routes.js'
import { handleUserRoutes } from '../src/routes/user.routes.js'
import { handleSkillRoutes } from '../src/routes/skill.routes.js'
import { credentialService } from '../src/services/credential.service.js'
import { skillService } from '../src/services/skill.service.js'

function makeReq({ method = 'GET', url = '/', cookie = '', body, ...extraHeaders } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8090', cookie, ...extraHeaders },
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
    writeHead(code, h2) {
      this.statusCode = code
      this.headers = { ...(h2 || {}) }
      this.headersSent = true
    },
    end(data) {
      this.body = data || ''
    },
  }
}

function keyOf(r) {
  const matcher =
    r.path != null
      ? `path ${r.path}`
      : r.prefix != null
        ? `prefix ${r.prefix}`
        : r.pattern != null
          ? `re ${String(r.pattern)}`
          : 'match(fn)'
  return `${r.method || '*'} ${matcher}`
}

describe('USER_ROUTES 声明面快照（P1 迁移钉）', () => {
  it('25 端点，聚合序承载 catch-all 最后', () => {
    expect(USER_ROUTES.map(keyOf)).toEqual([
      // —— auth（4）
      'POST path /api/user/wallet-login-challenge',
      'POST path /api/user/wallet-login',
      'GET path /api/user/session-info',
      'POST path /api/user/logout',
      // —— credential（6）
      'GET path /api/user/credential-status',
      'GET path /api/user/credential-vc',
      'POST path /api/user/credential-scaffold',
      'POST path /api/user/credential-upload',
      'POST path /api/user/cwt-apply',
      'GET path /api/user/cwt-application',
      // —— environment（8）
      'POST path /api/user/environment-inventory',
      'POST path /api/user/environment-browse',
      'POST path /api/user/environment-commit',
      'GET path /api/user/environments',
      'POST path /api/user/environment/apply',
      'POST path /api/user/environment/submit',
      'POST path /api/user/environment/unpublish',
      'POST path /api/user/environment/revert',
      // —— config（5）
      'POST path /api/user/config-challenge',
      'POST path /api/user/tenant-config',
      'POST path /api/user/tenant-config/discover',
      'DELETE path /api/user/tenant-config',
      'GET path /api/user/tenant-config',
      // —— profile（2；upgrade 在 catch-all 之前，catch-all 必须殿后）
      'POST prefix /api/upgrade/',
      '* match(fn)',
    ])
  })

  it('guard 分布：14 个会话门 + 9 个公开签名门 + 1 个 admin，无一漏声明', () => {
    const by = { user: 0, public: 0, admin: 0, custom: 0 }
    for (const r of USER_ROUTES) by[r.guard]++
    expect(by).toEqual({ user: 14, public: 10, admin: 1, custom: 0 })
  })

  it('signOp 只出现在 admin 守卫（user-upgrade 钉在配额端点）', () => {
    const signed = USER_ROUTES.filter((r) => r.signOp).map((r) => r.signOp)
    expect(signed).toEqual(['user-upgrade'])
  })
})

describe('SKILL_ROUTES 声明面快照（P1 迁移钉）', () => {
  it('14 条目：7 exact + 6 个 :name 族 pattern + match 兜底（注册最后；P1 审查 L2 订正构成计数）', () => {
    expect(SKILL_ROUTES.map(keyOf)).toEqual([
      'POST path /api/skills/challenge',
      'POST path /api/skills/publish',
      'POST path /api/skills/import',
      'POST path /api/skills/mine',
      'GET path /api/skills/mine',
      'GET path /api/skills/admin',
      'GET path /api/skills',
      'GET re /^\\/api\\/skills\\/[^/]+$/',
      'DELETE re /^\\/api\\/skills\\/[^/]+$/',
      'GET re /^\\/api\\/skills\\/[^/]+\\/download$/',
      'POST re /^\\/api\\/skills\\/[^/]+\\/install$/',
      'POST re /^\\/api\\/skills\\/[^/]+\\/uninstall$/',
      'POST re /^\\/api\\/skills\\/[^/]+\\/hide$/',
      '* match(fn)',
    ])
  })

  it('admin 守卫恰好两条：/admin 列表与 :name/hide（hide 带 skill-hide 签名）', () => {
    const admins = SKILL_ROUTES.filter((r) => r.guard === 'admin')
    expect(admins.map((r) => r.signOp ?? null)).toEqual([null, 'skill-hide'])
  })
})

describe('guard:user 单源行为（判例 58 清偿面）', () => {
  it('无会话访问 credential-status → 401 载荷逐字等于原重复块', async () => {
    h.session = null
    const res = makeRes()
    const handled = await handleUserRoutes(
      makeReq({ method: 'GET', url: '/api/user/credential-status' }),
      res,
      '/api/user/credential-status',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(401)
    expect(res.body).toBe(
      JSON.stringify({ error: '需要登录（钱包签名会话）', code: 'UNAUTHORIZED' }),
    )
    // 服务层零触达（原语义：401 在任何业务之前）
    expect(credentialService.enter).not.toHaveBeenCalled()
  })

  it('有会话 → 会话地址直达 service（单源身份，判例 2026-10-30）', async () => {
    h.session = TARGET
    const res = makeRes()
    const handled = await handleUserRoutes(
      makeReq({ method: 'GET', url: '/api/user/credential-status' }),
      res,
      '/api/user/credential-status',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(credentialService.enter).toHaveBeenCalledWith(TARGET, expect.any(Object))
    h.session = null
  })

  it('env 族资格门顺序保持：会话门(401) 先于 freeze(403) 先于限流', async () => {
    h.session = null
    const res = makeRes()
    await handleUserRoutes(
      makeReq({ method: 'POST', url: '/api/user/environment-commit', body: {} }),
      res,
      '/api/user/environment-commit',
    )
    expect(res.statusCode).toBe(401) // 无会话先撞 guard，不会先到 freeze 面
    h.session = TARGET
    credentialService.freezeAllowed.mockResolvedValueOnce(false)
    const res2 = makeRes()
    await handleUserRoutes(
      makeReq({ method: 'POST', url: '/api/user/environment-commit', body: {} }),
      res2,
      '/api/user/environment-commit',
    )
    expect(res2.statusCode).toBe(403)
    expect(JSON.parse(res2.body).code).toBe('FREEZE_REQUIRES_CWT')
    h.session = null
  })
})

describe('顺序红线与 fallthrough（原 if 链语义等价物）', () => {
  it('/api/user/<addr>/restart 不被 user 域吞掉（归 tenant.routes）', async () => {
    h.session = TARGET
    const res = makeRes()
    const handled = await handleUserRoutes(
      makeReq({ method: 'POST', url: `/api/user/${TARGET}/restart` }),
      res,
      `/api/user/${TARGET}/restart`,
    )
    expect(handled).toBe(false)
    expect(res.headersSent).toBe(false)
    h.session = null
  })

  it('catch-all 殿后：credential-status 不被详情 match 吞成 400', async () => {
    h.session = TARGET
    const res = makeRes()
    const handled = await handleUserRoutes(
      makeReq({ method: 'GET', url: '/api/user/credential-status' }),
      res,
      '/api/user/credential-status',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200) // 若被 match(fn) 吞：400 Invalid SWTC address
    h.session = null
  })

  it('非法地址详情 GET → 400 且视为已处理（无 fallthrough 双写窗口）', async () => {
    h.session = null
    const res = makeRes()
    const handled = await handleUserRoutes(
      makeReq({ method: 'GET', url: '/api/user/NOT_AN_ADDR' }),
      res,
      '/api/user/NOT_AN_ADDR',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
  })

  it('匿名 /api/upgrade → 403（guard:admin 结构性前置）', async () => {
    const res = makeRes()
    const handled = await handleUserRoutes(
      makeReq({ method: 'POST', url: `/api/upgrade/${TARGET}`, body: { tier: '1' } }),
      res,
      `/api/upgrade/${TARGET}`,
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
  })
})

describe('技能域兜底与错误序（原 catch-all 块等价）', () => {
  it('PUT /api/skills/foo → 前缀兜底 404 "Not found"（原块恒处理，不 fallthrough）', async () => {
    const res = makeRes()
    const handled = await handleSkillRoutes(
      makeReq({ method: 'PUT', url: '/api/skills/foo' }),
      res,
      '/api/skills/foo',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toBe('Not found')
  })

  it('非法 kebab 名先 404 "技能 …不存在"（名校验先于限流/签名/归属）', async () => {
    const res = makeRes()
    await handleSkillRoutes(
      makeReq({ method: 'POST', url: '/api/skills/Bad_Name/install', body: {} }),
      res,
      '/api/skills/Bad_Name/install',
    )
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('技能 Bad_Name 不存在或已下架')
    expect(skillService.install).not.toHaveBeenCalled()
  })

  it('GET /api/skills/mine?address= 匿名 → 403（S1 归属闸原位）', async () => {
    const res = makeRes()
    const handled = await handleSkillRoutes(
      makeReq({ method: 'GET', url: `/api/skills/mine?address=${TARGET}` }),
      res,
      '/api/skills/mine',
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(skillService.mineView).not.toHaveBeenCalled()
  })

  it('GET /api/skills/admin 匿名 → 403（guard:admin）', async () => {
    const res = makeRes()
    await handleSkillRoutes(
      makeReq({ method: 'GET', url: '/api/skills/admin' }),
      res,
      '/api/skills/admin',
    )
    expect(res.statusCode).toBe(403)
  })

  it('非 /api/skills 前缀零认领（server.js 分发面不变）', async () => {
    const res = makeRes()
    expect(await handleSkillRoutes(makeReq({ url: '/api/skillsx' }), res, '/api/skillsx')).toBe(
      false,
    )
    const res2 = makeRes()
    expect(await handleSkillRoutes(makeReq({ url: '/api/other' }), res2, '/api/other')).toBe(false)
  })
})
