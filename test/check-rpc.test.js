/**
 * check-rpc.mjs 的跨版本 RPC 适配测试
 *
 * 为什么值得单独测：这个脚本一旦静默失效，上游会把"正在跑任务的会话"
 * 误判为空闲并**停掉容器**——比界面进不去严重得多。而它的失效方式是
 * "看起来正常的 404/401"，不会抛异常。
 *
 * 实测确立的事实（两种格式互斥，只能靠探测适配）：
 *   ≤ 0.1.1-rc.2     : POST /api/session.list  payload {}
 *   ≥ 0.1.2-alpha.2  : POST /api/session/list  payload {args:{_request:{}}}
 *
 * 测试用真子进程跑脚本，起一个假 DSH 端点，从而覆盖真实的 HTTP 行为
 * （包括"必须用 http.request 才能发自定义 Host"这个关键点）。
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'services',
  'check-rpc.mjs',
)

/** 起一个假 DSH 端点；handlers 决定各路径如何响应 */
async function fakeDsh(handlers) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      seen.push({ path: req.url, host: req.headers.host, cookie: req.headers.cookie, body })
      const h = handlers[req.url]
      if (!h) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      if (typeof h === 'function') h(req, res, body)
      else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(h))
      }
    })
  })
  const port = await new Promise((r) => {
    server.listen(0, '127.0.0.1', () => r(server.address().port))
  })
  return { server, port, seen, close: () => server.close() }
}

/** 跑脚本，返回解析后的 stdout JSON */
async function runScript(args) {
  try {
    const { stdout } = await execFileAsync('node', [SCRIPT, ...args], { timeout: 20000 })
    return JSON.parse(stdout.trim().split('\n').pop())
  } catch (err) {
    return { ok: false, error: `脚本异常: ${err.message}`, stdout: err.stdout }
  }
}

/** 新版 server-response 包装 */
function newFormatResponse(items) {
  return { type: 'server-response', rpcId: 'x', result: { ok: true, value: { items } } }
}
/** 旧版 server-response 包装 */
function oldFormatResponse(items) {
  return { type: 'server-response', rpcId: 'x', result: { ok: true, value: { items } } }
}

let active = null
afterEach(() => {
  active?.close()
  active = null
})

describe('check-rpc.mjs 跨版本适配', () => {
  it('新版格式（/api/session/list + args._request）→ 正确读出 running 会话数', async () => {
    active = await fakeDsh({
      '/api/session/list': newFormatResponse([
        { id: 'a', running: true },
        { id: 'b', running: false },
      ]),
    })
    const out = await runScript([`--port=${active.port}`])

    expect(out.ok).toBe(true)
    expect(out.runningSessions).toBe(1)
    expect(out.totalSessions).toBe(2)
  })

  it('旧版格式（/api/session.list）→ 新版 404 后自动回退，仍读出会话', async () => {
    // 只认旧格式的端点：新版路径 404 → 脚本必须回退
    active = await fakeDsh({
      '/api/session.list': oldFormatResponse([{ id: 'a', running: true }]),
    })
    const out = await runScript([`--port=${active.port}`])

    expect(out.ok).toBe(true)
    expect(out.runningSessions).toBe(1)
    // 确认确实先试了新版、再回退旧版
    expect(active.seen.map((s) => s.path)).toEqual(['/api/session/list', '/api/session.list'])
  })

  it('两种格式都 404 → ok:false 且带上 HTTP 状态（上游保守处理）', async () => {
    active = await fakeDsh({})
    const out = await runScript([`--port=${active.port}`])

    expect(out.ok).toBe(false)
    expect(out.error).toBe('HTTP 404')
    // 404 不是认证问题，不应被标成 authRequired
    expect(out.authRequired).toBeFalsy()
  })

  it('认证失败（401）→ 标记 authRequired，供上游保守判活跃', async () => {
    active = await fakeDsh({
      '/api/session/list': (req, res) => {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('unauthorized')
      },
      '/api/session.list': (req, res) => {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('unauthorized')
      },
    })
    const out = await runScript([`--port=${active.port}`])

    expect(out.ok).toBe(false)
    expect(out.authRequired).toBe(true)
  })

  it('认证参数被原样发出：Host 与 cookie 都到了服务端', async () => {
    // 这条锁定"必须用 http.request 而非 fetch"：Node 的 fetch 会丢掉自定义 Host
    active = await fakeDsh({
      '/api/session/list': newFormatResponse([]),
    })
    await runScript([
      `--port=${active.port}`,
      '--authority=192.168.1.9:31016',
      '--cookie=dsh-auth-ABC=v1.payload.sig',
    ])

    const hit = active.seen[0]
    expect(hit.host).toBe('192.168.1.9:31016') // ← fetch 做不到这点
    expect(hit.cookie).toBe('dsh-auth-ABC=v1.payload.sig')
  })

  it('result.ok=false（参数不匹配等）→ 视为失败，不误报 0 个 running', async () => {
    // 若把这种响应当成"没有 running 会话"，正在跑任务的容器就会被误停
    active = await fakeDsh({
      '/api/session/list': {
        type: 'server-response',
        rpcId: 'x',
        result: { ok: false, error: { code: 'gateway/internal', message: 'bad args' } },
      },
    })
    const out = await runScript([`--port=${active.port}`])

    expect(out.ok).toBe(false)
  })

  it('连接不上（端口无人监听）→ ok:false，不抛', async () => {
    const out = await runScript(['--port=1'])
    expect(out.ok).toBe(false)
    expect(typeof out.error).toBe('string')
  })
})
