import { describe, it, expect, vi } from 'vitest'
import {
  AppError,
  NotFoundError,
  BadRequestError,
  ForbiddenError,
  ConflictError,
  InternalError,
  handleError,
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

describe('handleError 响应写入', () => {
  /** 最小 res 替身：记录 writeHead/end 调用 */
  function fakeRes({ headersSent = false } = {}) {
    return {
      headersSent,
      writeHead: vi.fn(),
      end: vi.fn(),
    }
  }

  it('正常路径：写状态码 + JSON body', () => {
    const res = fakeRes()
    handleError(new BadRequestError('参数不对'), res)

    expect(res.writeHead).toHaveBeenCalledWith(400, {
      'content-type': 'application/json; charset=utf-8',
    })
    const body = JSON.parse(res.end.mock.calls[0][0])
    expect(body.error).toBe('参数不对')
    expect(body.code).toBe('BAD_REQUEST')
  })

  it('默认 500 + UNKNOWN code', () => {
    const res = fakeRes()
    handleError(new Error('炸了'), res)

    expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything())
    const body = JSON.parse(res.end.mock.calls[0][0])
    expect(body.code).toBe('UNKNOWN')
  })

  it('headersSent 已为 true → 不写头、不抛异常（只收尾）', () => {
    const res = fakeRes({ headersSent: true })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // 修复前这里会 writeHead 抛 ERR_HTTP_HEADERS_SENT，逃出 catch 变成
    // unhandledRejection，客户端永久挂起
    expect(() => handleError(new Error('晚到的错误'), res)).not.toThrow()

    expect(res.writeHead).not.toHaveBeenCalled()
    expect(res.end).toHaveBeenCalled()
    expect(spy).toHaveBeenCalled()

    spy.mockRestore()
  })

  it('writeHead 自身抛错 → 不再向外抛，尽力收尾', () => {
    const res = fakeRes()
    res.writeHead.mockImplementation(() => {
      throw new Error('socket destroyed')
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => handleError(new Error('底层炸了'), res)).not.toThrow()
    expect(res.end).toHaveBeenCalled()

    spy.mockRestore()
  })

  it('5xx 会记录日志，4xx 不记录', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    handleError(new BadRequestError('4xx'), fakeRes())
    expect(spy).not.toHaveBeenCalled()

    handleError(new InternalError('5xx'), fakeRes())
    expect(spy).toHaveBeenCalled()

    spy.mockRestore()
  })
})
