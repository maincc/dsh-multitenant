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

/** 日志尾部读取行数。轮转后启动行会滚出窗口 → 走 ② 缓存 / ③ 重启自愈（F2 三段式） */
const TOKEN_TAIL_LINES = Number(process.env.DSH_TOKEN_TAIL_LINES || 2000)

/** ③ 自愈重启的最小间隔（防"读不到 token 的容器被每次激活反复重启"） */
const RECOVERY_MIN_INTERVAL_MS = 5 * 60 * 1000

/**
 * 启动 token 缓存：containerName → { startedAt, token }。
 *
 * 为什么必须有：供应容器已带 json-file 轮转（10m×3，disk-fix 缺口 E），
 * 长跑容器的**启动行迟早滚出 tail 窗口**；没有这层缓存，读不到 token 的
 * 唯一出路就是重启容器——那会把"面板开着几天后的普通激活"也意外重启。
 * startedAt 作键防"缓存写入后容器又重启过"：重启后的新进程 token 必然
 * 落在新日志尾部，① 直接命中，不会用到旧启动代的缓存。
 */
const launchTokenCache = new Map()

/** 自愈重启节流：containerName → 上次 ③ 的时间戳 */
const recoveryThrottle = new Map()

/** 清启动 token 缓存（测试/运维用；不传 name 清全部。生产路径靠 startedAt 键自洽） */
export function clearLaunchTokenCache(name) {
  if (name === undefined) {
    launchTokenCache.clear()
    recoveryThrottle.clear()
  } else {
    launchTokenCache.delete(name)
    recoveryThrottle.delete(name)
  }
}

/** docker CLI → { stdout, stderr, err }，永不 reject（docker logs 进程退出时也输出，两边都要 parse） */
function dockerCli(args, opts = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      'docker',
      args,
      { maxBuffer: 4 * 1024 * 1024, timeout: 10000, ...opts },
      (err, stdout, stderr) => resolvePromise({ stdout: stdout || '', stderr: stderr || '', err }),
    )
  })
}

/** 取**最后一条** token：容器每次启动打印一条，只有最后一条属于当前进程（实测踩坑，语义不变） */
function lastTokenIn(text) {
  let last = null
  for (const m of text.matchAll(TOKEN_RE)) last = m[1]
  return last
}

/** 容器当前进程启动时间（同一"启动代"的标识）；容器不存在/查不到 → null */
async function readStartedAt(containerName) {
  const { stdout, err } = await dockerCli(
    ['inspect', '-f', '{{.State.StartedAt}}', containerName],
    { timeout: 10000 },
  )
  if (err) return null
  const v = stdout.trim()
  return v && !v.includes('<no') ? v : null
}

/** ① 读日志尾部窗口里的最后一条 token */
async function readTailToken(containerName) {
  const { stdout, stderr } = await dockerCli(
    ['logs', '--tail', String(TOKEN_TAIL_LINES), containerName],
    { timeout: 15000 },
  )
  return lastTokenIn(`${stdout}\n${stderr}`)
}

/**
 * 从容器日志读出 DSH 的 launch token（F2 三段式，2026-09 磁盘防复发方案）。
 *
 * 改造原因：旧版全量读 `docker logs`（maxBuffer 8MB）。日志一旦超 8MB，
 * execFile 直接截断——只能读到**开头**的旧启动 token，激活必然失败，
 * 且随供应侧 json-file 轮转 + 面板轮询访问日志，这枚雷必然被踩到。
 *
 * 三段式（①→②→③，全失败才返回 null）：
 * ① `docker logs --tail 2000` 取尾部最后一条 token（新启动/意外重启/未滚出
 *    窗口都命中），成功即按当前启动代记入缓存；
 * ② miss → 若 startedAt 未变且有同代缓存 → 用缓存 token（启动行只是滚出了
 *    窗口，容器无需动）；
 * ③ 仍 miss（平台进程重启丢了记忆等）→ 重启一次容器重新打印 token。到这步
 *    激活本来就是死局（用户 401 进不去），重启是把死局换活局；租户数据在
 *    卷上不受影响。带 5 分钟节流防重启风暴。
 *
 * @param {string} containerName
 * @returns {Promise<string|null>} 读不到返回 null（不抛）
 */
export async function readToken(containerName) {
  // ① 先读尾部：命中就用——inspect 偶发失败不能把已到手的 token 丢掉
  const tail = await readTailToken(containerName)
  if (tail) {
    const boot = await readStartedAt(containerName)
    if (boot) launchTokenCache.set(containerName, { startedAt: boot, token: tail })
    return tail
  }
  const startedAt = await readStartedAt(containerName)
  if (startedAt === null) return null // 容器都不在：重启无意义，交给供应/重建路径

  // ② 同一启动代的缓存（启动行只是滚出了 tail 窗口）
  const cached = launchTokenCache.get(containerName)
  if (cached && cached.startedAt === startedAt) {
    return cached.token
  }

  // ③ 最后兜底：重启一次，让容器重新打印 token
  const now = Date.now()
  if (now - (recoveryThrottle.get(containerName) || 0) < RECOVERY_MIN_INTERVAL_MS) {
    return null // 刚自救过还是读不到：别再反复重启，让上层给明确 401
  }
  recoveryThrottle.set(containerName, now)
  console.warn(
    `[dsh-auth] ${containerName}: 日志尾部读不到 token 且无同代缓存，重启一次自愈（token 缓存与日志轮转的配套兜底）`,
  )
  const restarted = await dockerCli(['restart', containerName], { timeout: 60000 })
  if (restarted.err) return null
  // 容器内 dsh web 打印 token 需要 1~3s；等待时长可配（测试置 0）
  await new Promise((r) => setTimeout(r, Number(process.env.DSH_TOKEN_RECOVERY_SLEEP_MS ?? 1500)))
  const fresh = await readTailToken(containerName)
  if (fresh) {
    const newStarted = (await readStartedAt(containerName)) || startedAt
    launchTokenCache.set(containerName, { startedAt: newStarted, token: fresh })
    return fresh
  }
  return null
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
