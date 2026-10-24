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
import { credentialService } from '../services/credential.service.js'
import { dataService } from '../services/data.service.js'
import { getUserSession } from './user-auth.middleware.js'
import { SessionMirror } from '../services/session.store.js'

const COOKIE_NAME = 'admin_session'
/** 会话有效期：12 小时 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex')

class AdminSessionStore {
  constructor() {
    /** sha256(token) -> { address, expiresAt } */
    this.sessions = dataService.loadSessions() || {}
    this._mirror = new SessionMirror('admin')
  }

  _prune() {
    const now = Date.now()
    for (const [k, v] of Object.entries(this.sessions)) {
      if (!v || v.expiresAt < now) delete this.sessions[k]
    }
  }

  _persist() {
    this._prune()
    if (this._mirror.provider !== 'json') {
      this._mirror.enqueue(this.sessions) // 串行镜像 + TTL 兜底（同 user 侧）
      return
    }
    dataService.saveSessions(this.sessions)
  }

  /** provider='mongodb' 时从 sessions 集合水合（server 启动链调；json=no-op） */
  async init() {
    const map = await this._mirror.hydrate()
    if (map) this.sessions = map
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
  /** 排空镜像队列（优雅关停/测试用；json 形态 resolve 即刻） */
  flush() {
    return this._mirror.flush()
  }

  async revoke(token) {
    if (!token) return
    delete this.sessions[sha256(token)]
    this._persist()
    await this._mirror.flush() // 吊销写确认（不确认=崩溃重启复活会话）
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
 * 管理员权限守卫（v1.5：判权走凭证结论快照 isAdmSync——对账完成前/凭证停用自动落
 * config∪admin.json 名册兜底，升级期绝不上锁）
 * 返回 true 表示有权限，false 表示无权限（已发送响应）
 */
export function requireAdmin(req, res) {
  const session = getAdminSession(req)
  if (!session || !credentialService.isAdmSync(session)) {
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
 * 获取请求身份（**user_session 优先，admin_session 仅作无用户会话时的回退**）。
 * 用于"本人或管理员"这类判定。方向翻正史（2026-10-23）：原为 admin 优先——那是
 * 2026-10 审计"真用户（只有 user_session）被凭证端点整体误判 401"事故时的矫枉，
 * 结果管理员浏览器残留 admin cookie 会**抢占**插件当前钱包的身份（F9 会话不一致
 * 循环、本人 restart 被 403 等一族串号 bug 的同根因）。插件当前登录的钱包才是
 * "操作人"；管理员代他人操作走各自的管理签名闸，不依赖本函数的优先方向。
 */
export function getRequestAddress(req) {
  return getUserSession(req) ?? getAdminSession(req)
}
