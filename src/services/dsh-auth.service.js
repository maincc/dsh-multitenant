/**
 * DSH 浏览器认证（BrowserAuth）代激活服务
 *
 * 背景：DSH 自 0.1.2-alpha.2 起给 `/` 与 `/api` 加了一层认证：
 *   - 请求必须携带绑定 **authority**（Host，含端口）的签名 cookie
 *     `dsh-auth-<hash>`
 *   - cookie 由**进程级 launch token** 激活后才签发
 *   - token 只由容器内 `dsh web` 启动时打印：
 *       dsh web: http://127.0.0.1:3080/?token=<T> (LAN: http://172.17.0.2:3080/?token=<T>)
 *     激活 URL 指向容器内回环/内网地址，用户浏览器够不着
 *   - 没有开关可以关掉这层认证（client-connection 的 Config 里没有相关项）
 *
 * 结果：直接把用户放进去，用户只会撞上英文
 *   `dsh web authentication required; reopen the URL printed by dsh web.`
 * 而且 `/api` 同样受保护，会让平台的 check-rpc.mjs 收到 401，
 * 把"正在跑任务的会话"误判为空闲并停掉（比界面进不去更危险）。
 *
 * 但服务端可以代做激活 —— 已实测通过：
 *   ① 从容器日志读出 token
 *   ② 用**浏览器请求里的 Host** 请求容器内部端口的 `/?token=<T>`
 *   ③ DSH 回 303 + set-cookie，payload 里的 authority 正是该 Host
 *   ④ 之后转发时带上该 cookie（30 天有效）
 *
 * cookie 能跨容器重启存活：DSH 的签名密钥持久化在租户卷的
 * `.credentials.yaml`（credentials.modifyRecord('client-connection/browser-session')），
 * 变的只是 launch token。
 */

import { execFile } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { CONFIG } from '../config/config.js'

/** DSH 认证 cookie 的前缀（后面跟 authority 的哈希） */
export const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/**
 * 认证 cookie 的默认有效期。
 * DSH 默认 cookieMaxAgeDays=30；这里保守取 29 天，留出余量，
 * 避免在过期边界上刚好失效而让用户莫名撞 401。
 */
export const AUTH_COOKIE_TTL_MS = 29 * 24 * 60 * 60 * 1000

/** 从 DSH 启动输出里提取 launch token（全局匹配，取最后一条） */
const TOKEN_RE = /[?&]token=([A-Za-z0-9_-]+)/g

/**
 * 从容器日志里读出 DSH 的 launch token。
 *
 * ⚠️ 必须取**最后一条**匹配：容器重启后日志里会累积多条
 * `dsh web: http://...?token=...`（每次启动打一条），只有最后一条属于
 * **当前**进程。取第一条会拿到上一次启动的失效 token，激活必然失败
 * ——实测踩过这个坑（表现为拿到空 cookie、用户 401）。
 *
 * token 是进程级的，所以不缓存返回值，每次激活时读一次即可。
 *
 * @param {string} containerName
 * @returns {Promise<string|null>} 读不到返回 null（不抛）
 */
export function readToken(containerName) {
  return new Promise((resolvePromise) => {
    execFile(
      'docker',
      ['logs', containerName],
      { maxBuffer: 8 * 1024 * 1024, timeout: 10000 },
      (err, stdout, stderr) => {
        // docker logs 把容器 stdout 给 stdout、stderr 给 stderr；
        // 且进程已退出时也可能带 err，所以两边都找
        const text = `${stdout || ''}\n${stderr || ''}`
        let last = null
        // 每次调用重置 lastIndex，避免 /g 正则的状态残留
        TOKEN_RE.lastIndex = 0
        for (const m of text.matchAll(TOKEN_RE)) last = m[1]
        resolvePromise(last)
        void err
      },
    )
  })
}

/**
 * 当前生效的 token 读取实现。
 *
 * 做成可替换的，是因为 `vi.spyOn(module, 'readToken')` 对**模块内部**调用无效
 * （ESM 命名导出被 spy 替换后，模块内部的自由引用仍指向原函数）——实测确认。
 * 因此测试改为注入假实现，生产用下面这个真实实现。
 * @type {(containerName: string) => Promise<string|null>}
 */
let tokenReader = readToken

/** 替换 token 读取器（仅测试使用；传 null 恢复真实实现） */
export function setTokenReader(fn) {
  tokenReader = fn || readToken
}

/**
 * 代租户激活，取回可用的 dsh-auth cookie。
 *
 * @param {object} opts
 * @param {number} opts.internalPort 容器内部回环端口
 * @param {string} opts.host 浏览器请求里的 Host（= cookie 要绑定的 authority）
 * @param {string} opts.containerName 容器名（用于读 token）
 * @returns {Promise<string|null>} cookie 的 "name=value"，失败返回 null
 */
export function activate({ internalPort, host, containerName }) {
  return new Promise((resolvePromise) => {
    void (async () => {
      if (!internalPort || !host || !containerName) {
        resolvePromise(null)
        return
      }
      const token = await tokenReader(containerName)
      if (!token) {
        resolvePromise(null)
        return
      }

      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: internalPort,
          method: 'GET',
          path: `/?token=${encodeURIComponent(token)}`,
          headers: { host },
        },
        (res) => {
          res.resume() // 只关心 set-cookie，丢弃 body
          const raw = res.headers['set-cookie']
          const list = Array.isArray(raw) ? raw : raw ? [raw] : []
          const hit = list.find((c) => c.startsWith(AUTH_COOKIE_PREFIX))
          resolvePromise(hit ? hit.split(';')[0] : null)
        },
      )
      req.on('error', () => resolvePromise(null))
      req.setTimeout(Number(CONFIG.dsh?.authActivateTimeoutMs ?? 8000), () => {
        req.destroy()
        resolvePromise(null)
      })
      req.end()
    })()
  })
}

/**
 * 缓存键：**必须包含 authority**，不能只用端口。
 *
 * DSH 的认证 cookie 把 authority 写进签名载荷，校验时要求请求的 Host
 * 与之一致。同一个端口上可能有两个 authority 轮流被使用：
 *   公网 192.168.77.118:31016  与  回环 127.0.0.1:31016
 * 若缓存按端口存，切换 Host 时会复用绑定到另一个 authority 的 cookie
 * ——实测表现为"两个 Host 交替 200/401"，用户随机撞上
 * `dsh web authentication required; reopen the URL printed by dsh web.`
 * （两种 authority 各自的 cookie 本可以共存，实测互不干扰）。
 *
 * @param {number|string} publicPort
 * @param {string} host authority（Host 头原样）
 */
function cacheKey(publicPort, host) {
  return `${publicPort}|${host ?? ''}`
}

/**
 * 带激活 cookie 的并发安全缓存。
 *
 * 平台上有两类调用者会需要它：租户网关（转发浏览器请求）与
 * check-rpc.mjs 的空闲检测。
 */
export class AuthCookieCache {
  constructor() {
    /** @type {Map<string, {cookie:string|null, expiresAt:number, inflight?:Promise<string|null>}>} */
    this._map = new Map()
    this._hits = 0
    this._misses = 0
  }

  /**
   * 取 cookie（必要时激活）；并发请求合并为一次激活。
   * @param {number} publicPort
   * @param {{internalPort:number, host:string, containerName:string}} opts
   *   host = 本次请求的 authority，参与缓存键且决定 cookie 绑定
   */
  async get(publicPort, { internalPort, host, containerName }) {
    const key = cacheKey(publicPort, host)
    const now = Date.now()
    const hit = this._map.get(key)
    if (hit?.cookie && hit.expiresAt > now) {
      this._hits++
      return hit.cookie
    }
    if (hit?.inflight) return hit.inflight // 合并并发

    this._misses++
    const inflight = activate({ internalPort, host, containerName })
      .then((cookie) => {
        if (cookie) {
          this._map.set(key, {
            cookie,
            expiresAt: Date.now() + AUTH_COOKIE_TTL_MS,
          })
        } else {
          this._map.delete(key)
        }
        return cookie
      })
      .catch(() => {
        this._map.delete(key)
        return null
      })

    this._map.set(key, { cookie: null, expiresAt: 0, inflight })
    return inflight
  }

  /**
   * 该 authority 是否已有可用 cookie（探测状态用，不触发激活）。
   * @param {number} publicPort
   * @param {string} host authority
   */
  peek(publicPort, host) {
    const hit = this._map.get(cacheKey(publicPort, host))
    return hit?.cookie && hit.expiresAt > Date.now() ? hit.cookie : null
  }

  /**
   * 容器重建/换镜像后必须清掉（否则会拿旧容器密钥签发的 cookie 去用）。
   * 不传 publicPort → 清空全部；只传 publicPort → 清掉该端口的**所有
   * authority** 条目（这正是"容器换了"时想要的）。
   */
  clear(publicPort) {
    if (publicPort === undefined) {
      this._map.clear()
      return
    }
    const prefix = `${publicPort}|`
    for (const key of [...this._map.keys()]) {
      if (key.startsWith(prefix)) this._map.delete(key)
    }
  }

  stats() {
    return { size: this._map.size, hits: this._hits, misses: this._misses }
  }
}

export const authCookieCache = new AuthCookieCache()
