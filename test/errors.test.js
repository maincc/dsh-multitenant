import { describe, it, expect } from 'vitest'
import {
  AppError,
  NotFoundError,
  BadRequestError,
  ForbiddenError,
  ConflictError,
  InternalError,
} from '../src/utils/errors.js'

describe('错误类', () => {
  it('AppError 应该正确设置属性', () => {
    const err = new AppError('TEST', 'test error', 400)
    expect(err.code).toBe('TEST')
    expect(err.message).toBe('test error')
    expect(err.statusCode).toBe(400)
    expect(err.name).toBe('AppError')
  })

  it('NotFoundError 应该默认 404', () => {
    const err = new NotFoundError()
    expect(err.statusCode).toBe(404)
    expect(err.code).toBe('NOT_FOUND')
  })

  it('BadRequestError 应该默认 400', () => {
    const err = new BadRequestError()
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('BAD_REQUEST')
  })

  it('ForbiddenError 应该默认 403', () => {
    const err = new ForbiddenError()
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('FORBIDDEN')
  })

  it('ConflictError 应该默认 409', () => {
    const err = new ConflictError()
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('CONFLICT')
  })

  it('InternalError 应该默认 500', () => {
    const err = new InternalError()
    expect(err.statusCode).toBe(500)
    expect(err.code).toBe('INTERNAL_ERROR')
  })
})
