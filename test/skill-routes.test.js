/**
 * 技能路由分发冒烟测试（不触碰 Docker）
 *
 * vi.mock 掉 tenant-config.service（挑战/验签/卷脚本），技能路由只测
 * 分发、鉴权失败、命名防护（路径穿越拒绝）三类行为。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/services/tenant-config.service.js', () => ({
  tenantConfigService: {
    issueChallenge: vi.fn(() => 'deadbeef'.repeat(8)),
    consumeChallenge: vi.fn(() => false), // 默认挑战无效：走鉴权失败路径
    verifySignature: vi.fn(() => false),
    runScript: vi.fn(),
  },
}))

import { handleSkillRoutes } from '../src/routes/skill.routes.js'
import { tenantConfigService } from '../src/services/tenant-config.service.js'

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

  it('POST /api/skills/challenge 返回 nonce', async () => {
    tenantConfigService.issueChallenge.mockReturnValue('ab12cd34')
    const req = makeReq({
      method: 'POST',
      url: '/api/skills/challenge',
      body: { address: VALID_ADDR },
    })
    const res = makeRes()
    const handled = await handleSkillRoutes(req, res, '/api/skills/challenge')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).nonce).toBe('ab12cd34')
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

  it('GET /api/skills/mine?address=合法 返回个人视图（无需签名）', async () => {
    const req = makeReq({ method: 'GET', url: `/api/skills/mine?address=${VALID_ADDR}` })
    const res = makeRes()
    const handled = await handleSkillRoutes(req, res, '/api/skills/mine')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body)
    expect(Array.isArray(data.published)).toBe(true)
    expect(Array.isArray(data.installed)).toBe(true)
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
