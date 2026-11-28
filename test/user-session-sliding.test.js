/**
 * user_session 会话时效（滑动续期）单元测试
 *
 * 背景（用户实测返修）：签发点曾硬编码 2h TTL，而 cookie max-age=12h——2~12h
 * 错配窗口内 credential-status 必 401，页面开着过夜的用户/管理员集体"读取不到
 * 凭证"。修复=①create 统一用 12h 默认（与 cookie 对齐）②resolve 过半程滑动
 * 续期（活跃不掉线，闲置满 12h 才需重签）。本测钉死三条语义防回退：
 *   过半续满 / 未过半不写 / 过期判死绝不被"救活"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/services/data.service.js', () => ({
  dataService: {
    saveUserSessions: vi.fn(),
    loadUserSessions: () => ({}),
  },
}))

import { userSessionStore, USER_SESSION_TTL_MS } from '../src/middleware/user-auth.middleware.js'

const BASE = 1_700_000_000_000 // 固定起点，配合假定时器

const recOf = (token) => {
  const rec = Object.values(userSessionStore.sessions).find((r) => r.address === token.address)
  return rec
}

describe('user_session 滑动续期', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE)
    userSessionStore.sessions = {}
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('创建即默认 12h（与 cookie max-age 一致，不再有 2h 错配窗口）', () => {
    expect(USER_SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000)
    userSessionStore.create('addr_new')
    const rec = userSessionStore.sessions[Object.keys(userSessionStore.sessions)[0]]
    expect(rec.expiresAt).toBe(BASE + 12 * 60 * 60 * 1000)
  })

  it('过半程 resolve：续满新 12h（活跃用户永不中途掉线）', () => {
    const t = userSessionStore.create('addr_active')
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 60 * 1000) // 6h01m > 半程
    expect(userSessionStore.resolve(t)).toBe('addr_active')
    const rec = recOf({ address: 'addr_active' })
    expect(rec.expiresAt).toBe(BASE + 6 * 3600_000 + 60_000 + 12 * 3600_000)
  })

  it('未过半程 resolve：不续不写（写放大受控，每会话至多每半程落一次盘）', () => {
    const t = userSessionStore.create('addr_half')
    vi.advanceTimersByTime(3 * 60 * 60 * 1000) // 3h < 半程
    expect(userSessionStore.resolve(t)).toBe('addr_half')
    const rec = recOf({ address: 'addr_half' })
    expect(rec.expiresAt).toBe(BASE + 12 * 60 * 60 * 1000) // 纹丝不动
  })

  it('满 TTL 后判死：过期即删，滑动绝不清活（安全面：闲置 12h 必须重签）', () => {
    const t = userSessionStore.create('addr_dead')
    vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 1000)
    expect(userSessionStore.resolve(t)).toBeNull()
    expect(Object.keys(userSessionStore.sessions).length).toBe(0)
  })
})
