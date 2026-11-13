/**
 * 技能路由分发冒烟测试（不触碰 Docker）
 *
 * vi.mock 掉 tenant-config.service（挑战/验签/卷脚本），技能路由只测
 * 分发、鉴权失败、命名防护（路径穿越拒绝）三类行为。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/services/tenant-config.service.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    // 保留 SIGN_PURPOSE / buildSignedMessage 等真实导出（验签逻辑要用）
    ...actual,
    tenantConfigService: {
      issueChallenge: vi.fn(() => ({ nonce: 'deadbeef'.repeat(8), message: 'ab'.repeat(16) })),
      consumeChallenge: vi.fn(() => false), // 默认挑战无效：走鉴权失败路径
      verifySignature: vi.fn(() => false),
      runScript: vi.fn(),
    },
  }
})

// S1 用例需要 userSessionStore.create——会话表读写换成内存空轨，
// 防测试把假会话落进真实 data/config/user-sessions.json（gateway 测试同款）
vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const mod = await importOriginal()
  const orig = mod.dataService
  // 原型方法（readJson/loadSkillsIndex 等）必须保留——spread 只拷 own 属性会丢
  // 类方法（现场炸过 readJson is not a function），故克隆原型链再覆盖两枚
  // 会话持久化函数
  const clone = Object.assign(Object.create(Object.getPrototypeOf(orig)), orig, {
    loadUserSessions: vi.fn(() => ({})),
    saveUserSessions: vi.fn(() => {}),
  })
  return { ...mod, dataService: clone }
})

import { handleSkillRoutes } from '../src/routes/skill.routes.js'
import { tenantConfigService } from '../src/services/tenant-config.service.js'
import { dataService } from '../src/services/data.service.js'
import { isolateOpsLog } from './ops-log-isolation.js'
isolateOpsLog(dataService) // 留痕 json 轨进临时目录，防写真实 operations.log

const VALID_ADDR = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'

/** 构造最小可用的 mock req（支持 parseBody 的 on('data'/'end')） */
function makeReq({ method = 'GET', url = '/', cookie = '', body } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8090', cookie },
    _body: body,
    on(ev, cb) {
      if (ev === 'data' && this._body !== undefined) cb(JSON.stringify(this._body))
      if (ev === 'end') cb()
      return this
    },
  }
}

/** 构造最小可用的 mock res */
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

describe('技能市场路由冒烟', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET /api/skills 返回 200 与 skills 数组', async () => {
    const req = makeReq({ method: 'GET', url: '/api/skills' })
    const res = makeRes()
    const handled = await handleSkillRoutes(req, res, '/api/skills')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(JSON.parse(res.body).skills)).toBe(true)
  })

  it('GET /api/skills?address=非法地址 不报错（幂等返回列表）', async () => {
    const req = makeReq({ method: 'GET', url: '/api/skills?address=not-an-address' })
    const res = makeRes()
    await handleSkillRoutes(req, res, '/api/skills')
    expect(res.statusCode).toBe(200)
  })

  it('POST /api/skills/challenge 返回 nonce 与用途绑定 message', async () => {
    tenantConfigService.issueChallenge.mockReturnValue({ nonce: 'ab12cd34', message: 'cd12ab34' })
    const req = makeReq({
      method: 'POST',
      url: '/api/skills/challenge',
      body: { address: VALID_ADDR },
    })
    const res = makeRes()
    const handled = await handleSkillRoutes(req, res, '/api/skills/challenge')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.nonce).toBe('ab12cd34')
    expect(body.message).toBe('cd12ab34')
  })

  it('POST /api/skills/challenge 非法地址返回 400', async () => {
    const req = makeReq({ method: 'POST', url: '/api/skills/challenge', body: { address: 'nope' } })
    const res = makeRes()
    await handleSkillRoutes(req, res, '/api/skills/challenge')
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/skills/:name/install 无有效签名 → 403', async () => {
    tenantConfigService.consumeChallenge.mockReturnValue(false)
    const req = makeReq({
      method: 'POST',
      url: '/api/skills/x/install',
      body: {
        address: VALID_ADDR,
        nonce: 'x',
        signature: 'y',
        publicKey: 'z',
      },
    })
    const res = makeRes()
    const handled = await handleSkillRoutes(req, res, '/api/skills/x/install')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).code).toBe('FORBIDDEN')
  })

  it('GET /api/skills/..%2Fetc 路径穿越名 → 404（命名白名单）', async () => {
    const req = makeReq({ method: 'GET', url: '/api/skills/..%2Fetc' })
    const res = makeRes()
    const handled = await handleSkillRoutes(req, res, '/api/skills/..%2Fetc')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/skills/:name 不存在 → 404', async () => {
    const req = makeReq({ method: 'GET', url: '/api/skills/no-such-skill' })
    const res = makeRes()
    await handleSkillRoutes(req, res, '/api/skills/no-such-skill')
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/skills/mine?address= 本人会话 → 200 个人视图（S1：仍需本人，不再匿名）', async () => {
    // S1 修复（2026-11-12 审计）：mineView 读他人安装账 + 探目标容器卷 + 就地销账，
    // 匿名可读是侦察/篡改面——现在只有【会话地址===目标】或管理员能读。
    const { userSessionStore } = await import('../src/middleware/user-auth.middleware.js')
    const token = userSessionStore.create(VALID_ADDR)
    const req = makeReq({
      method: 'GET',
      url: `/api/skills/mine?address=${VALID_ADDR}`,
      cookie: `user_session=${token}`,
    })
    const res = makeRes()
    const handled = await handleSkillRoutes(req, res, '/api/skills/mine')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body)
    expect(Array.isArray(data.published)).toBe(true)
    expect(Array.isArray(data.installed)).toBe(true)
  })

  it('GET /api/skills/mine 匿名（无会话）读他人 → 403（S1）', async () => {
    const req = makeReq({ method: 'GET', url: `/api/skills/mine?address=${VALID_ADDR}` })
    const res = makeRes()
    await handleSkillRoutes(req, res, '/api/skills/mine')
    expect(res.statusCode).toBe(403)
  })

  it('GET /api/skills/mine 他人会话读 → 403（S1：装了别人的 cookie 也看不了别人的账）', async () => {
    const { userSessionStore } = await import('../src/middleware/user-auth.middleware.js')
    const token = userSessionStore.create('jpp9j9tkqtbcuohe2zqhvffbguved6o9oa')
    const req = makeReq({
      method: 'GET',
      url: `/api/skills/mine?address=${VALID_ADDR}`,
      cookie: `user_session=${token}`,
    })
    const res = makeRes()
    await handleSkillRoutes(req, res, '/api/skills/mine')
    expect(res.statusCode).toBe(403)
  })

  it('GET /api/skills/mine 缺地址或非法地址 → 400', async () => {
    const req1 = makeReq({ method: 'GET', url: '/api/skills/mine' })
    const res1 = makeRes()
    await handleSkillRoutes(req1, res1, '/api/skills/mine')
    expect(res1.statusCode).toBe(400)

    const req2 = makeReq({ method: 'GET', url: '/api/skills/mine?address=nope' })
    const res2 = makeRes()
    await handleSkillRoutes(req2, res2, '/api/skills/mine')
    expect(res2.statusCode).toBe(400)
  })
})
