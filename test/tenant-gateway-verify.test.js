/**
 * 租户网关门禁：顶层导航一致性校验（插件实时地址 vs 会话地址）
 *
 * 安全模型（根治"切了钱包但旧 URL 仍能进"）：
 *   - 顶层导航（sec-fetch-mode: navigate）且无 gw_ok 放行 cookie
 *     → 网关不直接转发，先返回「身份校验页」（HTML/JS）
 *     → 校验页实时读取插件地址，与 /__gw__/session-info 的会话地址比对
 *     → 一致：写 5 秒 gw_ok 放行 cookie 并自动跳回 → 进容器
 *     → 不一致：/__gw__/logout 吊销会话 → 拒绝
 *   - 子资源/fetch/WebSocket 不经过校验页（只有"进入页面"这一次校验）
 *   - 管理员代开 ?gateway_ticket= 仍然直接放行（管理员授权即信任）
 *
 * 通过 vi.mock 隔离数据层（会话表为内存空），listen 真实随机端口验证。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const mod = await importOriginal()
  const empty = {
    loadSessions: vi.fn(() => ({})),
    loadUserSessions: vi.fn(() => ({})),
    saveUserSessions: vi.fn(() => {}),
    saveSessions: vi.fn(() => {}),
  }
  return { dataService: { ...mod.dataService, ...empty } }
})

import { tenantGateway } from '../src/services/tenant-proxy.service.js'
import { userSessionStore } from '../src/middleware/user-auth.middleware.js'
import { Keypairs } from '@swtc/keypairs'

const OWNER = 'jga9j9tkqtbcuohe2zqhvffbguved6o9or'

describe('租户网关门禁：顶层导航一致性校验（插件地址 vs 会话地址）', () => {
  let publicPort, internalPort
  beforeEach(async () => {
    publicPort = 39100 + Math.floor(Math.random() * 500)
    internalPort = 39700 + Math.floor(Math.random() * 200)
    tenantGateway.listen(publicPort, internalPort, OWNER)
    await new Promise((r) => setTimeout(r, 40)) // 等 server.listen 就绪
  })
  afterEach(() => {
    tenantGateway.closeAll()
  })

  it('无会话的顶层导航 → 403', async () => {
    const res = await fetch(`http://127.0.0.1:${publicPort}/`, {
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    })
    expect(res.status).toBe(403)
  })

  it('有会话的顶层导航（无 gw_ok）→ 返回校验页（含 __gw__/session-info）', async () => {
    const token = userSessionStore.create(OWNER)
    const res = await fetch(`http://127.0.0.1:${publicPort}/`, {
      headers: {
        'sec-fetch-mode': 'navigate',
        accept: 'text/html',
        cookie: `user_session=${token}`,
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('__gw__/session-info')
    expect(body).toContain('__gw__/challenge')
    expect(body).toContain('swtc_signMessage')
    expect(body).toContain('正在校验访问身份')
  })

  it('有会话 + gw_ok=1 → 跳过校验页，直接转发（上游不可达 → 502）', async () => {
    const token = userSessionStore.create(OWNER)
    const res = await fetch(`http://127.0.0.1:${publicPort}/`, {
      headers: {
        'sec-fetch-mode': 'navigate',
        accept: 'text/html',
        cookie: `user_session=${token}; gw_ok=1`,
      },
    })
    expect(res.status).toBe(502) // forward 到未监听的内部口
    expect(await res.text()).toContain('gateway: upstream unreachable')
  })

  it('非导航子资源（js/css/fetch）→ 走原始门禁，不返回校验页', async () => {
    const token = userSessionStore.create(OWNER)
    const res = await fetch(`http://127.0.0.1:${publicPort}/assets/app.js`, {
      headers: { 'sec-fetch-mode': 'no-cors', cookie: `user_session=${token}` },
    })
    expect(res.status).toBe(502) // 已放行转发（而非校验页 200/403）
  })

  it('非导航无会话 → 403 JSON（原始门禁）', async () => {
    const res = await fetch(`http://127.0.0.1:${publicPort}/api/whatever`, {
      headers: { 'sec-fetch-mode': 'cors' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('/__gw__/session-info：带会话返回地址，无会话返回 null', async () => {
    const token = userSessionStore.create(OWNER)
    let r = await fetch(`http://127.0.0.1:${publicPort}/__gw__/session-info`, {
      headers: { cookie: `user_session=${token}` },
    })
    expect(await r.json()).toEqual({ ok: true, address: OWNER })
    r = await fetch(`http://127.0.0.1:${publicPort}/__gw__/session-info`)
    expect(await r.json()).toEqual({ ok: true, address: null })
  })

  it('/__gw__/logout 吊销会话并下发清 cookie', async () => {
    const token = userSessionStore.create(OWNER)
    const r = await fetch(`http://127.0.0.1:${publicPort}/__gw__/logout`, {
      method: 'POST',
      headers: { cookie: `user_session=${token}` },
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('set-cookie') || '').toContain('max-age=0')
    expect(userSessionStore.resolve(token)).toBeNull()
  })

  it('管理员代开 ticket 的导航 → 直接放行（不要求插件校验）', async () => {
    const ticket = tenantGateway.issueTicket(OWNER)
    expect(ticket).toBeTruthy()
    const res = await fetch(`http://127.0.0.1:${publicPort}/?gateway_ticket=${ticket}`, {
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    })
    // ticket 换取会话后放行 → 转发到不可达内部口 → 502（而非 403/校验页）
    expect(res.status).toBe(502)
  })

  it('有会话 + URL 带一次性 ticket → 消费 ticket 直接放行（官网进入路径，不弹校验页）', async () => {
    const token = userSessionStore.create(OWNER)
    const ticket = tenantGateway.issueTicket(OWNER)
    const res = await fetch(`http://127.0.0.1:${publicPort}/?gateway_ticket=${ticket}`, {
      headers: {
        'sec-fetch-mode': 'navigate',
        accept: 'text/html',
        cookie: `user_session=${token}`,
      },
    })
    expect(res.status).toBe(502) // 放行转发（非校验页）
    expect(await res.text()).toContain('gateway: upstream unreachable')
  })

  it('/__gw__/challenge：有会话发 nonce，无会话返回 address:null', async () => {
    let r = await fetch(`http://127.0.0.1:${publicPort}/__gw__/challenge`)
    expect(await r.json()).toEqual({ ok: true, address: null })

    const token = userSessionStore.create(OWNER)
    r = await fetch(`http://127.0.0.1:${publicPort}/__gw__/challenge`, {
      headers: { cookie: `user_session=${token}` },
    })
    const j = await r.json()
    expect(j.ok).toBe(true)
    expect(j.address).toBe(OWNER)
    expect(typeof j.nonce).toBe('string')
    expect(j.nonce.length).toBeGreaterThan(20)
  })

  it('/__gw__/verify：假签名（非本人）→ valid:false', async () => {
    const token = userSessionStore.create(OWNER)
    const nonce = 'ab'.repeat(32)
    const res = await fetch(`http://127.0.0.1:${publicPort}/__gw__/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `user_session=${token}` },
      body: JSON.stringify({
        address: OWNER,
        nonce,
        signature: '00'.repeat(64),
        publicKey: '04' + '11'.repeat(32),
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, valid: false })
  })

  it('/__gw__/verify：会话地址与声称地址不一致 → valid:false', async () => {
    const token = userSessionStore.create(OWNER)
    const res = await fetch(`http://127.0.0.1:${publicPort}/__gw__/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `user_session=${token}` },
      body: JSON.stringify({
        address: 'jga9j9tkqtbcuohe2zqhvffbguved6o9or', // 另一个地址
        nonce: 'ab'.repeat(32),
        signature: '00'.repeat(64),
        publicKey: '04' + '11'.repeat(32),
      }),
    })
    expect(await res.json()).toMatchObject({ ok: true, valid: false })
  })

  it('/__gw__/verify 正路径：对 challenge nonce 的真实签名 → valid:true', async () => {
    // 真实密钥对 → 动态地址 → 会话；challenge 拿 nonce → 签名 → 验证
    const seed = Keypairs.generateSeed()
    const kp = Keypairs.deriveKeypair(seed)
    const addr = Keypairs.deriveAddress(kp.publicKey).toLowerCase()
    const token = userSessionStore.create(addr)

    // challenge
    const cRes = await fetch(`http://127.0.0.1:${publicPort}/__gw__/challenge`, {
      headers: { cookie: `user_session=${token}` },
    })
    const { nonce } = await cRes.json()
    expect(typeof nonce).toBe('string')

    // 签名（与平台配置签名同一算法：Keypairs.sign(nonceHex, privateKey)）
    const signature = Keypairs.sign(nonce, kp.privateKey)

    const vRes = await fetch(`http://127.0.0.1:${publicPort}/__gw__/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `user_session=${token}` },
      body: JSON.stringify({
        address: addr,
        nonce,
        signature,
        publicKey: kp.publicKey,
      }),
    })
    const j = await vRes.json()
    expect(j.valid).toBe(true) // body 被正确解析 + 真实签名验证通过
  })
})
