/**
 * 认证中间件（security-hardening-plan P0-1）
 *
 * 管理员会话 = 服务端随机会话 token（Cookie 值不再是地址）：
 *   - createAdminSession(address) → 签发 randomBytes(32) token，
 *     存 sha256(token) → { address, expiresAt }，持久化 data/config/sessions.json（0600）
 *   - getAdminSession(req) → 解析 cookie → 查表 + 过期校验 → 返回地址或 null
 *   - requireAdmin / getSessionAddress 复用同一会话解析
 *   - revokeSession(token) → 吊销（logout）
 *   - 过期会话惰性删除（resolve 时）并随下次落盘剔除
 *
 * 废止旧行为：Cookie 值 = 管理员地址直接当会话（可伪造）。现在查不到即 403。
 */

import { createHash, randomBytes } from 'node:crypto'
import { isAdmin } from '../config/config.js'
import { dataService } from '../services/data.service.js'
import { getUserSession } from './user-auth.middleware.js'

const COOKIE_NAME = 'admin_session'
/** 会话有效期：12 小时 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex')

class AdminSessionStore {
  constructor() {
    /** sha256(token) -> { address, expiresAt } */
    this.sessions = dataService.loadSessions() || {}
  }

  _prune() {
    const now = Date.now()
    for (const [k, v] of Object.entries(this.sessions)) {
      if (!v || v.expiresAt < now) delete this.sessions[k]
    }
  }

  _persist() {
    this._prune()
    dataService.saveSessions(this.sessions)
  }

  /** 签发会话，返回明文 token（只把 sha256 存入存储） */
  create(address) {
    const token = randomBytes(32).toString('hex')
    this.sessions[sha256(token)] = { address, expiresAt: Date.now() + SESSION_TTL_MS }
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

  /** 吊销会话（logout） */
  revoke(token) {
    if (!token) return
    delete this.sessions[sha256(token)]
    this._persist()
  }
}

export const adminSessionStore = new AdminSessionStore()

/**
 * 从 Cookie 中获取管理员会话（返回已验证的地址；无效/过期返回 null）
 */
export function getAdminSession(req) {
  const cookie = req.headers.cookie || ''
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  if (!match) return null
  try {
    return adminSessionStore.resolve(decodeURIComponent(match[1]))
  } catch {
    return null
  }
}

/**
 * 管理员权限守卫
 * 返回 true 表示有权限，false 表示无权限（已发送响应）
 */
export function requireAdmin(req, res) {
  const session = getAdminSession(req)
  if (!session || !isAdmin(session)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: '需要管理员权限', code: 'FORBIDDEN' }))
    return false
  }
  return true
}

/**
 * 获取当前会话地址（管理员会话；普通用户会话体系待 P0-2 决策后接入）
 */
export function getSessionAddress(req) {
  return getAdminSession(req)
}

/**
 * 获取请求身份（管理员会话优先，其次是普通用户会话）。
 * 用于"本人或管理员"这类判定：普通用户终于有自己的会话了。
 */
export function getRequestAddress(req) {
  return getAdminSession(req) ?? getUserSession(req)
}
