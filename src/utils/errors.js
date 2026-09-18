/**
 * 统一错误处理
 */

export class AppError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.name = 'AppError'
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message, 404)
    this.name = 'NotFoundError'
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super('BAD_REQUEST', message, 400)
    this.name = 'BadRequestError'
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', message, 403)
    this.name = 'ForbiddenError'
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super('CONFLICT', message, 409)
    this.name = 'ConflictError'
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request body too large') {
    super('PAYLOAD_TOO_LARGE', message, 413)
    this.name = 'PayloadTooLargeError'
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error') {
    super('INTERNAL_ERROR', message, 500)
    this.name = 'InternalError'
  }
}

/**
 * 全局错误处理函数（用于 HTTP 响应）
 *
 * 注意：本函数在 30+ 处被调用，其中多数调用点没有自行检查 headersSent。
 * 修复前这里直接 writeHead，一旦上游已发送 header 就会抛 ERR_HTTP_HEADERS_SENT
 * ——而它是在 catch 块里抛的，会逃出路由变成 unhandledRejection，客户端永久挂起。
 * 现在：已发 header 则只记日志并尽力结束响应，绝不再抛。
 */
export function handleError(err, res) {
  const statusCode = err.statusCode || 500
  const message = err.message || 'Internal server error'

  if (statusCode >= 500) {
    console.error(`[error] ${statusCode} ${message}`, err.stack || '')
  }

  if (res.headersSent) {
    // 响应已开始：无法再改状态码，尽力收尾，避免连接悬挂
    console.error(`[error] headers already sent, cannot send ${statusCode} ${message}`)
    try {
      res.end()
    } catch {
      // 连接可能已断开，忽略
    }
    return
  }

  try {
    res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: message, code: err.code || 'UNKNOWN' }))
  } catch (writeErr) {
    console.error('[error] failed to write error response:', writeErr.message)
    try {
      res.end()
    } catch {
      // ignore
    }
  }
}
