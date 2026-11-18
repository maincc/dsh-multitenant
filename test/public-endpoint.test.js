/**
 * public-endpoint 单点判形（2026-11-12 隧道/反代适配）。
 * 钉死四件事：声明优先级（env > config > 自动判形）、非法值不冒充、
 * 端口回退链、secureFlag 跟随声明形态（网关与平台同 host 共享 cookie，
 * 声明 https 就必须全链 secure——混形态红线在 public-endpoint.js 头注）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { CONFIG } from '../src/config/config.js'
import { publicScheme, publicEntryPort } from '../src/utils/public-endpoint.js'
import { secureFlag } from '../src/utils/cookie-flags.js'

const http = { socket: {}, headers: {} }
const tls = { socket: { encrypted: true }, headers: {} }
const fwd = { socket: {}, headers: { 'x-forwarded-proto': 'https' } }

let envBackup = {}
function setEnv(k, v) {
  if (!(k in envBackup)) envBackup[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
function restoreEnv() {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  envBackup = {}
  CONFIG.server.publicScheme = ''
  CONFIG.server.publicPort = 0
}
afterEach(restoreEnv)

describe('publicScheme 声明优先级', () => {
  it('env PUBLIC_SCHEME > config > 自动判形', () => {
    CONFIG.server.publicScheme = 'http'
    setEnv('PUBLIC_SCHEME', 'https')
    expect(publicScheme(http)).toBe('https') // env 压过 config
    setEnv('PUBLIC_SCHEME', undefined)
    expect(publicScheme(tls)).toBe('http') // config 压过请求判形
  })

  it('无声明时自动判形：socket.encrypted / x-forwarded-proto 都算 https', () => {
    expect(publicScheme(tls)).toBe('https')
    expect(publicScheme(fwd)).toBe('https')
    expect(publicScheme(http)).toBe('http')
  })

  it('非法声明值不冒充——落回自动判形', () => {
    setEnv('PUBLIC_SCHEME', 'ftp')
    expect(publicScheme(http)).toBe('http')
    expect(publicScheme(tls)).toBe('https')
  })

  it('大小写与空格宽容（HTTPS/ → https）', () => {
    setEnv('PUBLIC_SCHEME', ' HTTPS ')
    expect(publicScheme(http)).toBe('https')
  })
})

describe('publicEntryPort 回退链', () => {
  it('env > config.publicPort > server.port > 8090', () => {
    CONFIG.server.port = 8090
    CONFIG.server.publicPort = 8550
    expect(publicEntryPort()).toBe(8550)
    setEnv('PUBLIC_PORT', '9000')
    expect(publicEntryPort()).toBe(9000)
    setEnv('PUBLIC_PORT', undefined)
    CONFIG.server.publicPort = 0
    expect(publicEntryPort()).toBe(8090)
  })

  it('非法端口（0/负数/超界/字母）一律落回进程端口', () => {
    CONFIG.server.port = 8090
    for (const bad of [0, -1, 70000, 'abc', '']) {
      setEnv('PUBLIC_PORT', String(bad))
      expect(publicEntryPort()).toBe(8090)
    }
  })
})

describe('secureFlag 跟随声明形态', () => {
  it('声明 https 的明文请求也发 secure（隧道终结 TLS 不回传协议_info 的常态）', () => {
    setEnv('PUBLIC_SCHEME', 'https')
    expect(secureFlag(http)).toBe('; secure')
  })

  it('无声明纯 http → 恒空串（本机形态 cookie 必须裸发）', () => {
    expect(secureFlag(http)).toBe('')
  })
})
