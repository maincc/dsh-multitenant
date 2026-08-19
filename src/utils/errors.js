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

export class InternalError extends AppError {
  constructor(message = 'Internal server error') {
    super('INTERNAL_ERROR', message, 500)
    this.name = 'InternalError'
  }
}

/**
 * 全局错误处理函数（用于 HTTP 响应）
 */
export function handleError(err, res) {
  const statusCode = err.statusCode || 500
  const message = err.message || 'Internal server error'
  
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: message, code: err.code || 'UNKNOWN' }))
  
  // 记录错误日志
  if (statusCode >= 500) {
    console.error(`[error] ${statusCode} ${message}`, err.stack || '')
  }
}
