/**
 * F2 三段式 token 读取测试（disk-fix 方案：日志轮转与代激活的配套）
 *
 * 背景：供应容器现带 json-file 轮转（10m×3），旧版"全量 docker logs + 8MB
 * maxBuffer"必然踩截断读到旧 token 的雷；readToken 改为：
 *   ① `--tail 2000` 取尾部最后一条 → 命中即按启动代记缓存
 *   ② miss + startedAt 未变 + 同代缓存 → 用缓存（**不重启**）
 *   ③ 仍 miss → 重启一次自愈（5 分钟节流）
 *
 * 隔离：mock node:child_process；不触碰真实 docker。
 * 注意：这里测**真实 readToken**（dsh-capability 那些测试是注入假 reader，
 * 不经过这三段）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { execFile } from 'node:child_process'
import { readToken, clearLaunchTokenCache } from '../src/services/dsh-auth.service.js'

const NAME = 'dsh-swtc-testcontainer'
const TOKEN_LINE = (t) =>
  `dsh web: http://127.0.0.1:3080/?token=${t} (LAN: http://172.17.0.2:3080/?token=${t})`

/** @type {{logsOut: string[], inspectOut: (string|null)[], restartCount: number, seen: string[][]}} */
let env

beforeEach(() => {
  clearLaunchTokenCache()
  process.env.DSH_TOKEN_RECOVERY_SLEEP_MS = '0' // 测试不等 1.5s
  env = { logsOut: [], inspectOut: [], restartCount: 0, seen: [] }
  execFile.mockReset()
  execFile.mockImplementation((cmd, args, opts, cb) => {
    env.seen.push([...args])
    switch (args[0]) {
      case 'logs':
        return cb(null, env.logsOut.length ? env.logsOut.shift() : '', '')
      case 'inspect': {
        const out = env.inspectOut.length ? env.inspectOut.shift() : null
        if (out === null) return cb(new Error('no such container'), '', 'error')
        return cb(null, out, '')
      }
      case 'restart':
        env.restartCount++
        return cb(null, NAME, '')
      default:
        return cb(new Error(`unexpected args: ${args.join(' ')}`), '', '')
    }
  })
})

afterEach(() => {
  delete process.env.DSH_TOKEN_RECOVERY_SLEEP_MS
})

describe('readToken 三段式', () => {
  it('① 尾窗命中：--tail 2000、取**最后一条**、按启动代写缓存', async () => {
    env.logsOut = [`${TOKEN_LINE('OLD1')}\n${TOKEN_LINE('NEW2')}`]
    env.inspectOut = ['2026-09-24T01:00:00Z']
    expect(await readToken(NAME)).toBe('NEW2')
    const logsCall = env.seen.find((a) => a[0] === 'logs')
    expect(logsCall).toEqual(['logs', '--tail', '2000', NAME])
    expect(env.seen.some((a) => a[0] === 'inspect')).toBe(true)
    expect(env.restartCount).toBe(0)
  })

  it('② 尾窗 miss 但同代有缓存 → 用缓存，绝不重启（长跑容器启动行滚出窗口的常态路径）', async () => {
    const BOOT = '2026-09-24T01:00:00Z'
    env.logsOut = [TOKEN_LINE('T1'), ''] // 第一次读到并缓存；第二次日志只剩访问行
    env.inspectOut = [BOOT, BOOT]
    expect(await readToken(NAME)).toBe('T1')
    expect(await readToken(NAME)).toBe('T1')
    expect(env.restartCount).toBe(0)
  })

  it('② 缓存代与当前 startedAt 不一致 → 不能用旧代 token，走 ③', async () => {
    env.logsOut = [TOKEN_LINE('T1'), '', TOKEN_LINE('T2'), TOKEN_LINE('T2')]
    env.inspectOut = ['BOOT-A', 'BOOT-B', 'BOOT-B', 'BOOT-B']
    expect(await readToken(NAME)).toBe('T1') // 缓存 BOOT-A/T1
    expect(await readToken(NAME)).toBe('T2') // miss + 换代 → 重启 → 新 token
    expect(env.restartCount).toBe(1)
  })

  it('③ 无缓存全 miss：重启一次、读新 token、写缓存；节流期内换代再 miss 不反复重启', async () => {
    // 第一次调用：tail miss → inspect BOOT-X → ③ 重启 → tail 命中 FRESH → 再 inspect 写缓存
    env.logsOut = ['', TOKEN_LINE('FRESH')]
    env.inspectOut = ['BOOT-X', 'BOOT-X']
    expect(await readToken(NAME)).toBe('FRESH')
    expect(env.restartCount).toBe(1)
    // 第二次调用：tail 又 miss、换代 BOOT-Y（缓存 BOOT-X 失效）→ 本应 ③，
    // 但节流期内 → 直接 null，不再反复重启（防重启风暴）
    env.logsOut = ['']
    env.inspectOut = ['BOOT-Y']
    expect(await readToken(NAME)).toBeNull()
    expect(env.restartCount).toBe(1)
  })

  it('容器不存在（inspect 失败）→ null，不尝试重启', async () => {
    env.logsOut = ['']
    env.inspectOut = [null]
    expect(await readToken(NAME)).toBeNull()
    expect(env.restartCount).toBe(0)
  })

  it('inspect 偶发失败不影响已读到的 tail token（①的顺序防线）', async () => {
    env.logsOut = [TOKEN_LINE('OK')]
    env.inspectOut = [null] // tail 后的代次确认失败：token 仍要返回
    expect(await readToken(NAME)).toBe('OK')
  })

  it('重启命令失败 → null（不无限挣扎）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      env.seen.push([...args])
      if (args[0] === 'logs') return cb(null, '', '')
      if (args[0] === 'inspect') return cb(null, 'BOOT-Z', '')
      if (args[0] === 'restart') return cb(new Error('daemon error'), '', 'boom')
      return cb(new Error('unexpected'), '', '')
    })
    expect(await readToken(NAME)).toBeNull()
  })
})
