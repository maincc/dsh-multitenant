#!/usr/bin/env node
/**
 * DSH 任务状态检测：通过容器内 RPC 查询是否有正在运行的会话
 *
 * 在租户镜像的辅助容器内运行，且必须共享租户容器的网络命名空间：
 *   docker run --rm --network container:<tenant> ... node check-rpc.mjs
 * 此时 127.0.0.1:3080 就是租户容器内 DSH 的 API。
 *
 * 原理：会话列表为每个会话返回 running: boolean——
 * agent 驱动正在处理（对话响应中、任务执行中、静默等待 LLM/外部 API）时
 * running 为 true，即使此时没有新事件写入会话文件（解决了"静默等待任务
 * 被误判空闲"的盲区）。
 *
 * ⚠️ 三个实测踩过的坑，缺一个就会静默失效（表现为"正在跑任务的会话被
 *    误判空闲并停掉"，比界面进不去严重得多）：
 *
 *  1) **RPC 路径与载荷跨版本变了**（互斥，只能靠探测适配）：
 *       ≤ 0.1.1-rc.2 : POST /api/session.list  payload {}
 *       ≥ 0.1.2-alpha.2: POST /api/session/list  payload {args:{_request:{}}}
 *     新版若用旧格式会 404 not found；旧版若用新格式同样 404。
 *     所以下面先试新格式，404 再回退旧格式。
 *
 *  2) **必须用 http.request，不能用 fetch**：实测 Node 的 fetch 会忽略自定义
 *     host 头（实际发出连接目标 127.0.0.1:3080），DSH 的 authority 校验必然
 *     不过 → 401。http.request 才会原样发送我们指定的 Host。
 *
 *  3) **新版 /api 也要认证**：DSH 自 0.1.2-alpha.2 起给 /api 加了绑定 authority
 *     的签名 cookie。平台把代激活得到的 authority + cookie 传进来
 *     （见 user.service 的 rpcAuthFor）。
 *
 * 参数：
 *   --authority=<Host>     DSH 校验的 authority（必须与 cookie 绑定的那个一致）
 *   --cookie=<name=value>  平台代激活得到的 dsh-auth cookie
 *   --port=<n>             RPC 端口（默认 3080；仅供测试注入假端点）
 *
 * 输出（stdout，JSON）：
 *   { "ok": true,  "runningSessions": N, "totalSessions": M }
 *   { "ok": false, "error": "..." }          调用失败（超时/非 200）
 *   { "ok": false, "error": "HTTP 401", "authRequired": true }
 *     认证失败。**上游必须保守处理**（不可判空闲），否则会误停容器。
 */
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

/** 解析 --key=value 形式的参数 */
function argOf(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const authority = argOf('authority')
const cookie = argOf('cookie')
// RPC 端口：容器内固定 3080；参数化只是为了测试能起一个假 DSH 端点
const rpcPort = Number(argOf('port') || 3080)

/**
 * 发一次 RPC 调用并收全 body。
 * @returns {Promise<{status:number, data:string, error?:string}>} 永不抛
 */
function rpc(path, method, payload, timeoutMs) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: randomUUID(),
    method,
    payload,
  })
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  }
  // Host 必须与 cookie 绑定的 authority 一致，且 http.request 才会真的发它
  if (authority) headers.host = authority
  if (cookie) headers.cookie = cookie

  return new Promise((resolvePromise) => {
    const req = httpRequest({ host: '127.0.0.1', port: rpcPort, path, method: 'POST', headers }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        data += c
      })
      res.on('end', () => resolvePromise({ status: res.statusCode, data }))
    })
    req.on('error', (err) => resolvePromise({ status: 0, data: '', error: String(err?.message ?? err) }))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolvePromise({ status: 0, data: '', error: 'timeout' })
    })
    req.end(body)
  })
}

/** 从 server-response 里取出会话数组（两种格式的 result 形状一致） */
function itemsOf(data) {
  try {
    const parsed = JSON.parse(data)
    if (parsed?.result?.ok !== true) return null
    const value = parsed.result.value
    if (Array.isArray(value?.items)) return value.items
    if (Array.isArray(value?.sessions)) return value.sessions
    return []
  } catch {
    return null
  }
}

try {
  // 先试新版格式，404 再回退旧版（两者互斥，见文件头注释）
  let res = await rpc('/api/session/list', 'session/list', { args: { _request: {} } }, 5000)
  let items = res.status === 200 ? itemsOf(res.data) : null

  if (items === null && (res.status === 404 || res.status === 200)) {
    res = await rpc('/api/session.list', 'session.list', {}, 5000)
    items = res.status === 200 ? itemsOf(res.data) : null
  }

  if (res.error) {
    console.log(JSON.stringify({ ok: false, error: res.error }))
  } else if (items === null) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `HTTP ${res.status}`,
        authRequired: res.status === 401,
      }),
    )
  } else {
    const running = items.filter((s) => s.running === true).length
    console.log(JSON.stringify({ ok: true, runningSessions: running, totalSessions: items.length }))
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
}