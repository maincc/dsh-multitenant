/**
 * secureFlag（S2 配套 · 2026-11-12）：会话 cookie 的 secure 必须按 TLS 条件化——
 * 纯 http 形态带上它浏览器直接丢 cookie（会话当场死），https 形态不带它票可被
 * 明文链路截获。两形态共存是硬约束，本测试钉死判形不回归。
 */
import { describe, expect, it } from 'vitest'
import { secureFlag } from '../src/utils/cookie-flags.js'

const req = (over = {}) => ({
  socket: {},
  headers: { host: '192.168.77.123:8090' },
  ...over,
})

describe('secureFlag 条件化', () => {
  it('纯 http（本机 8090 形态）→ 空串：cookie 不带 secure', () => {
    expect(secureFlag(req())).toBe('')
  })

  it('原生 TLS → ; secure', () => {
    expect(secureFlag(req({ socket: { encrypted: true } }))).toBe('; secure')
  })

  it('反代终结 https（x-forwarded-proto）→ ; secure', () => {
    expect(secureFlag(req({ headers: { 'x-forwarded-proto': 'https' } }))).toBe('; secure')
  })

  it('多级代理链取首跳、大小写不敏感', () => {
    expect(secureFlag(req({ headers: { 'x-forwarded-proto': 'HTTPS, http' } }))).toBe('; secure')
  })

  it('forwarded http（明文反代）→ 空串，不冒充 TLS', () => {
    expect(secureFlag(req({ headers: { 'x-forwarded-proto': 'http' } }))).toBe('')
  })

  it('req 残缺（无 socket/headers）不炸——防御纵深', () => {
    expect(secureFlag({})).toBe('')
    expect(secureFlag(undefined)).toBe('')
  })
})
