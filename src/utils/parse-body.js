/**
 * 共享请求体解析（带大小上限 + Content-Length 预检）
 *
 * 加固（security-hardening-plan P0-3）：
 *   - Content-Length 预检：声明超限直接 413，不消费 body
 *   - 流式累计上限：chunked / 谎报长度时超限即中止并 413
 *   - 超限 reject PayloadTooLargeError（路由层 handleError 转 413）
 */

import { PayloadTooLargeError } from './errors.js'

export const DEFAULT_BODY_LIMIT = 64 * 1024 // 64KB

/**
 * 读取请求体原文。reject 时为 PayloadTooLargeError（超限）或原始流错误。
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<string>}
 */
export function parseBody(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'])
    if (Number.isFinite(contentLength) && contentLength > limit) {
      reject(new PayloadTooLargeError(`Request body exceeds ${limit} bytes limit`))
      return
    }

    let data = ''
    let finished = false

    const fail = (err) => {
      if (finished) return
      finished = true
      cleanup()
      reject(err)
    }
    const cleanup = () => {
      // mock req（测试）可能没有 removeListener；真实 IncomingMessage 有
      if (typeof req.removeListener !== 'function') return
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
    }
    const onData = (chunk) => {
      if (finished) return
      data += chunk
      if (Buffer.byteLength(data, 'utf8') > limit) {
        fail(new PayloadTooLargeError(`Request body exceeds ${limit} bytes limit`))
      }
    }
    const onEnd = () => {
      if (finished) return
      finished = true
      cleanup()
      resolve(data)
    }
    const onError = (err) => fail(err)
    const onAborted = () => fail(new Error('Request aborted'))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

/**
 * 安全解析 JSON 请求体（非法 JSON / 超限返回 null 并回写错误响应）
 * @returns {Promise<object|null>}
 */
export async function parseJsonBody(req, res) {
  try {
    return JSON.parse((await parseBody(req)) || '{}')
  } catch (err) {
    const status = err.statusCode || 400
    const message = err.statusCode ? err.message : 'Invalid JSON body'
    const code = err.statusCode ? err.code : 'BAD_REQUEST'
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: message, code }))
    }
    return null
  }
}
