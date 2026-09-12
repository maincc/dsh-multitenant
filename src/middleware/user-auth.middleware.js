/**
 * 普通用户会话（user_session cookie）
 *
 * 与管理员会话（auth.middleware.js）同构：
 *   - Cookie 值 = randomBytes(32) 随机会话 token（不是地址）
 *   - 存储只存 sha256(token) -> { address, expiresAt }，持久化 data/config/user-sessions.json（0600）
 *   - 12h 过期、可吊销、过期惰性删除
 *
 * 用途：租户网关（tenant-proxy.service.js）的门禁凭据——浏览器访问租户 DSH
 * 必须携带与目标地址匹配的 user_session（或管理员会话），否则 403。
 * 签发点：/connect 钱包签名验证通过后（tenant.routes.js）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { dataService } from '../services/data.service.js'

const COOKIE_NAME = 'user_session'
/** 会话有效期：12 小时（与管理员会话一致） */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex')

class UserSessionStore {
  constructor() {
    /** sha256(token) -> { address, expiresAt } */
    this.sessions = dataService.loadUserSessions() || {}
  }

  _prune() {
    const now = Date.now()
    for (const [k, v] of Object.entries(this.sessions)) {
      if (!v || v.expiresAt < now) delete this.sessions[k]
    }
  }

  _persist() {
    this._prune()
    dataService.saveUserSessions(this.sessions)
  }

  /** 签发会话，返回明文 token（只把 sha256 存入存储）
   *  @param {string} address 绑定的 SWTC 地址
   *  @param {number} [ttlMs] 会话时长（默认 12h；CWT 入场等场景可传更短值） */
  create(address, ttlMs = SESSION_TTL_MS) {
    const token = randomBytes(32).toString('hex')
    this.sessions[sha256(token)] = {
      address,
      expiresAt: Date.now() + ttlMs,
    }
    this._persist()
    return token
  }

  /** 解析 token → 地址；无效/过期返回 null */
  resolve(token) {
    if (!token) return null
    const rec = this.sessions[sha256(token)]
    if (!rec) return null
    if (rec.expiresAt < Date.now()) {
      delete this.sessions[sha256(token)]
      this._persist()
      return null
    }
    return rec.address
  }

  /** 吊销会话 */
  revoke(token) {
    if (!token) return
    delete this.sessions[sha256(token)]
    this._persist()
  }
}

export const userSessionStore = new UserSessionStore()

/**
 * 从 Cookie 中获取用户会话（返回已验证的地址；无效/过期返回 null）
 */
export function getUserSession(req) {
  const cookie = req.headers.cookie || ''
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  if (!match) return null
  try {
    return userSessionStore.resolve(decodeURIComponent(match[1]))
  } catch {
    return null
  }
}

export const USER_SESSION_COOKIE = COOKIE_NAME
export const USER_SESSION_TTL_MS = SESSION_TTL_MS
