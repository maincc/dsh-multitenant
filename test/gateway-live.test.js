/**
 * 网关环境切换雷达（用户验收：回退/选用后**不刷新**，平台捕捉到自动恢复）
 *
 * 真 HTTP 集成：假上游容器 + 真 TenantGateway 监听，验证——
 *   ① 代理出去的 text/html 尾部注入雷达 script（chunked、剥 content-length）
 *   ② 非 HTML / 压缩流原样放行（fail-open：注入条件不满足就完全不碰）
 *   ③ /__dsh-live/status 报代际；换容器（re-listen 新 epoch）后状态随之变
 *   ④ /__dsh-live/live.js 由网关自答（含 location.reload 逻辑）
 *   ⑤ 门禁：无会话访问雷达端点 403（别人的代际/脚本都不给）
 * 会话判定只 spy getUserSession/getAdminSession，其余走真码。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { Agent } from 'undici'

const ADDR = 'testaddrgatewayliveradar000000000000000000'
const PUB = 39711

vi.mock('../src/middleware/user-auth.middleware.js', async (io) => {
  const m = await io()
  return {
    ...m,
    getUserSession: vi.fn((req) =>
      String(req.headers?.cookie || '').includes(`user_session=${ADDR}`) ? ADDR : null,
    ),
  }
})
vi.mock('../src/middleware/auth.middleware.js', async (io) => {
  const m = await io()
  return { ...m, getAdminSession: vi.fn(() => null) }
})

const { tenantGateway } = await import('../src/services/tenant-proxy.service.js')

let upstream
let upPort

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.url === '/') {
      // 模拟带条件再验证的 SPA 文档请求：有 if-none-match 就答 304
      if (req.headers['if-none-match'] || req.headers['if-modified-since']) {
        res.writeHead(304)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"idx"' })
      res.end('<html><body>SPA首页</body></html>')
      return
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body>容器页</body></html>')
      return
    }
    if (req.url === '/gz') {
      const body = gzipSync(Buffer.from('压缩内容测试'))
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
        'content-length': String(body.length),
      })
      res.end(body)
      return
    }
    if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"from":"upstream"}')
      return
    }
    res.writeHead(404)
    res.end('nf')
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  upPort = upstream.address().port
})

afterAll(() => {
  tenantGateway.close(PUB)
  upstream?.close()
})

// 每次新建 dispatcher：网关重绑会杀掉旧 server 的 keep-alive 连接，
// undici 连接池复用死亡 socket 会 ECONNRESET——测试要的是"新请求"语义
const get = (path, cookie = `user_session=${ADDR}`) => {
  const agent = new Agent()
  return fetch(`http://127.0.0.1:${PUB}${path}`, {
    headers: cookie ? { cookie } : {},
    signal: AbortSignal.timeout(5000),
    dispatcher: agent,
  }).finally(() => agent.close())
}

describe('租户网关·环境切换雷达', () => {
  it('① 代理 HTML 尾部注入雷达脚本（不破坏原页）', async () => {
    await tenantGateway.listen(PUB, upPort, ADDR, { requiresToken: false, version: 'test' }, 'e1')
    const res = await get('/page')
    const text = await res.text()
    expect(text).toContain('容器页')
    expect(text).toContain('<script src="/__dsh-live/live.js"')
    // chunked 注入后 content-length 必须消失（否则长度对不上、页面截断）
    expect(res.headers.get('content-length')).toBeNull()
  })

  it('② 压缩流与非 HTML 一律不碰（fail-open）', async () => {
    const gz = await get('/gz')
    expect(await gz.text()).toBe('压缩内容测试') // 解压后即原文——尾部没被追加 script
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    const api = await get('/api')
    expect(await api.text()).toBe('{"from":"upstream"}') // JSON 不注入
  })

  it('③④ 雷达端点：status 报代际、live.js 网关自答、换容器即变', async () => {
    const st = await get('/__dsh-live/status')
    expect((await st.json()).epoch).toBe('e1')
    const js = await get('/__dsh-live/live.js')
    expect(js.headers.get('content-type')).toContain('javascript')
    expect(await js.text()).toContain('location.reload')
    // 换容器（apply/revert 重建后 finalize 带新 rebuildEpoch 重绑）→ 状态变
    await tenantGateway.listen(PUB, upPort, ADDR, { requiresToken: false, version: 'test' }, 'e2')
    expect((await (await get('/__dsh-live/status')).json()).epoch).toBe('e2')
  })

  it('④½ 文档刷新不再被 304 劫走：网关剥再验证头，雷达必达', async () => {
    const { Agent } = await import('undici')
    const agent = new Agent()
    // 模拟浏览器"刷新"语义：带 if-none-match 来问变没变
    const res = await fetch(`http://127.0.0.1:${PUB}/`, {
      headers: { cookie: `user_session=${ADDR}`, 'if-none-match': '"idx"' },
      dispatcher: agent,
    })
    await agent.close()
    const text = await res.text()
    expect(res.status).toBe(200) // 不许 304：缓存再验证被网关拦下，换回真页
    expect(text).toContain('SPA首页')
    expect(text).toContain('<script src="/__dsh-live/live.js"')
  })

  it('⑤ 门禁：无会话访问雷达端点 403', async () => {
    const res = await get('/__dsh-live/status', '')
    expect(res.status).toBe(403)
  })
})
