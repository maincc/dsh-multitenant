/**
 * 内存滑动窗口速率限制（security-hardening-plan P0-2）
 *
 * 用于未认证端点（/connect、/connect-status、/leave）按 IP 限流，
 * 防洪泛资源耗尽。内存桶定期清理，防自身成为增长面。
 */

const WINDOW_MS = 60 * 1000
const DEFAULT_MAX = 15
const MAX_BUCKETS = 20000
const PRUNE_INTERVAL_MS = 60 * 1000

const buckets = new Map() // key -> { count, windowStart }
let lastPrune = Date.now()

function clientKey(req) {
  return req.socket?.remoteAddress || 'unknown'
}

function prune(now, windowMs) {
  for (const [k, v] of buckets) {
    if (now - v.windowStart >= windowMs) buckets.delete(k)
  }
}

/**
 * 限流检查。未超限返回 true；超限已回写 429 并返回 false。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ max?: number, windowMs?: number, keyPrefix?: string }} [opts]
 * @returns {boolean}
 */
export function rateLimit(
  req,
  res,
  { max = DEFAULT_MAX, windowMs = WINDOW_MS, keyPrefix = 'rl' } = {},
) {
  if (max <= 0) return true // 未启用
  const now = Date.now()
  // 周期性清理过期桶（防 Map 无限增长）
  if (buckets.size > MAX_BUCKETS || now - lastPrune >= PRUNE_INTERVAL_MS) {
    lastPrune = now
    prune(now, windowMs)
  }

  const key = `${keyPrefix}:${clientKey(req)}`
  const rec = buckets.get(key)
  if (!rec || now - rec.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now })
    return true
  }
  rec.count += 1
  if (rec.count > max) {
    if (!res.headersSent) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' }))
    }
    return false
  }
  return true
}
