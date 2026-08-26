#!/usr/bin/env node
/**
 * DSH 任务状态检测：通过容器内 RPC 查询是否有正在运行的会话
 *
 * 在租户镜像的辅助容器内运行，且必须共享租户容器的网络命名空间：
 *   docker run --rm --network container:<tenant> ... node check-rpc.mjs
 * 此时 127.0.0.1:3080 就是租户容器内 DSH 的 API。
 *
 * 原理：DSH 的 session.list 为每个会话返回 running: boolean——
 * agent 驱动正在处理（对话响应中、任务执行中、静默等待 LLM/外部 API）时
 * running 为 true，即使此时没有新事件写入会话文件（解决了"静默等待任务
 * 被误判空闲"的盲区）。配置平面 loopback-only 限制只拒绝非回环请求，
 * 容器内 127.0.0.1 调用不受影响。
 *
 * 输出（stdout，JSON）：
 *   { "ok": true,  "runningSessions": N, "totalSessions": M }
 *   { "ok": false, "error": "..." }          调用失败（超时/非 200）
 */
import { randomUUID } from 'node:crypto'

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 5000)

try {
  const res = await fetch('http://127.0.0.1:3080/api/session.list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: 'session.list',
      payload: {},
    }),
    signal: controller.signal,
  })
  if (!res.ok) {
    console.log(JSON.stringify({ ok: false, error: `HTTP ${res.status}` }))
    process.exit(0)
  }
  const data = await res.json()
  // session.list 响应：{ ok, value: { items: [ { id, title, running, updatedAt, ... } ] } }
  const items = Array.isArray(data?.result?.value?.items)
    ? data.result.value.items
    : Array.isArray(data?.result?.value?.sessions)
      ? data.result.value.sessions
      : []
  const running = items.filter((s) => s.running === true).length
  console.log(JSON.stringify({ ok: true, runningSessions: running, totalSessions: items.length }))
} catch (e) {
  console.log(
    JSON.stringify({
      ok: false,
      error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e),
    }),
  )
} finally {
  clearTimeout(timer)
}
