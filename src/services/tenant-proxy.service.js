/**
 * 租户网关（端口级反向代理 + 会话门禁）
 *
 * 安全模型（根治"URL 即钥匙"）：
 *   - 每个租户一个对外端口 publicPort（面向用户，URL/Host 不变）
 *   - 真实容器只绑定宿主回环 127.0.0.1:<internalPort>，外部网络物理不可达
 *   - 网关是唯一进路，且必须先过门禁：
 *       请求必须携带与该端口所属地址匹配的 user_session（或管理员会话）
 *       → 别人拿到 URL 直连 → 403；只有绑定该地址的会话才能进
 *   - 放行后原样转发（HTTP + WebSocket upgrade），不改 Host、不加工内容，
 *     浏览器与容器内 DSH 均感知不到网关存在。
 *
 * 生命周期：
 *   - user.service finalizeTenant / restoreFromDocker → listen(publicPort, internalPort, address)
 *   - destroy / remove / reset → close(publicPort)（stop 不关闭：重连即恢复）
 */
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { getUserSession, userSessionStore } from '../middleware/user-auth.middleware.js'
import { getAdminSession } from '../middleware/auth.middleware.js'
import { CONFIG } from '../config/config.js'
import { credentialService } from './credential.service.js'
import { tenantConfigService, SIGN_PURPOSE, buildSignedMessage } from './tenant-config.service.js'
// 只取纯函数 requiresToken（dsh-version.service 仅依赖 config，不成环）。
// 用于区分"容器落后于平台镜像"与"平台镜像本身就需要认证"这两种拒绝原因。
import { requiresToken } from './dsh-version.service.js'
// DSH 浏览器认证代激活（读容器日志里的 token → 换 cookie → 注入转发）
import { authCookieCache, AUTH_COOKIE_PREFIX } from './dsh-auth.service.js'
import { swtcContainerName } from '../utils/address.js'
import { parseBody } from '../utils/parse-body.js'

/** 逐跳头：转发时必须剥离（由代理重新处理），否则会篡改上下游语义 */
// RFC 7230 hop-by-hop 头。注意：Host 是端到端头（不是 hop-by-hop），必须透传——
// 容器内 DSH 的 /api fence 校验 Origin 与 Host 逐字符相等（含端口），
// 转发时若用内部地址重写 Host（如 127.0.0.1:<internalPort>），
// 浏览器 Origin（对外 :310xx）与 Host 不一致 → 宿主 API 一律 403 forbidden。
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * 平台自身的门禁 cookie —— **绝不转发进租户容器**。
 *
 * ## 为什么（H1 加固）
 *
 * 浏览器 cookie 按 host 隔离、**不按端口隔离**（RFC 6265），`SameSite=Strict`
 * 也不判端口。租户容器的页面与平台入口同 host（只是端口不同），所以管理员
 * 打开 `http://<host>:<租户端口>/` 时，浏览器会把 `admin_session` 一起带上。
 * 而租户**完全掌控自己的容器**（有 shell，甚至能替换 3080 上的监听进程），
 * 于是这串 12 小时有效的 bearer token 就落到了租户手里 —— 拿去重放即可冒充
 * 管理员（`admin-signature.middleware.js` 开头记录了这条实测链）。
 *
 * `user_session` 同理：它是网关门禁凭据，容器内的 DSH 根本不需要它。
 * `gw_ok` 只对网关自己的校验页有意义。
 *
 * 注意：容器内 DSH 自己的认证 cookie（`dsh-auth-*`）由平台从容器 launch
 * token 现换后**注入**，不在此列（见 `mergeDshAuthCookie`）。
 */
const PLATFORM_COOKIE_NAMES = new Set(['admin_session', 'user_session', 'gw_ok'])

/** 取 cookie 条目的名字（`a=b` → `a`），小写 */
function cookieName(entry) {
  const eq = entry.indexOf('=')
  return (eq === -1 ? entry : entry.slice(0, eq)).trim().toLowerCase()
}

/**
 * 按谓词过滤 Cookie 头里的条目。
 * @param {string|undefined} cookieHeader
 * @param {(name: string) => boolean} shouldDrop 返回 true 的条目被剔除
 * @returns {string} 过滤后的 Cookie 头（可能为空串）
 */
function filterCookies(cookieHeader, shouldDrop) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return ''
  return cookieHeader
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !shouldDrop(cookieName(c)))
    .join('; ')
}

/**
 * 剔除平台自身的门禁 cookie（`admin_session` / `user_session` / `gw_ok`）。
 */
function stripPlatformCookies(cookieHeader) {
  return filterCookies(cookieHeader, (name) => PLATFORM_COOKIE_NAMES.has(name))
}

/**
 * cookie 替换策略。
 *
 * - `'replace'`（生产默认）：剔除浏览器带来的 `dsh-auth-*`，只注入平台现换的那份。
 * - `'legacy'`  ：旧行为（"有 dsh-auth 就跳过注入"），**仅供回归测试复现 bug**。
 *
 * 保留这个开关是为了让测试能证明"旧行为确实会把失效 cookie 转发出去并 401"，
 * 而不是只断言新行为看起来对。
 */
let dshAuthCookieMode = 'replace'
/** @internal 仅供测试 */
export function _setDshAuthCookieModeForTest(mode) {
  dshAuthCookieMode = mode === 'legacy' ? 'legacy' : 'replace'
}

/**
 * 按当前策略合并 Cookie 头。
 *
 * 无论 `authCookie` 是否存在，**平台自身的门禁 cookie 一律剥离**
 * （`admin_session` / `user_session` / `gw_ok`）—— 这是 H1 的纵深防御：
 * 即使管理员的 `admin_session` 因为同 host 不同端口被浏览器带上，
 * 也绝不进入租户容器。
 *
 * @param {string|undefined} original 浏览器带来的 Cookie 头
 * @param {string|null} authCookie 平台代激活得到的那一份（`dsh-auth-<hash>=<值>`）
 * @returns {string} 要转发给容器的 Cookie 头（可能为空串）
 */
function mergeDshAuthCookie(original, authCookie) {
  // 第一步：平台自身 cookie 永不出境
  const withoutPlatform = stripPlatformCookies(original)
  // legacy 模式（仅回归测试复现旧 bug）：保留浏览器带来的 dsh-auth-*
  if (dshAuthCookieMode === 'legacy' && hasAuthCookie(withoutPlatform)) {
    return withoutPlatform
  }
  // 第二步：剔除浏览器带来的 dsh-auth-*，只注入平台现换的那份
  const rest = stripDshAuthCookies(withoutPlatform)
  if (!authCookie) return rest
  return rest ? `${rest}; ${authCookie}` : authCookie
}

/**
 * 浏览器请求里是否已经带了 DSH 的认证 cookie（仅 legacy 复现用）。
 */
function hasAuthCookie(cookieHeader) {
  return typeof cookieHeader === 'string' && cookieHeader.includes(AUTH_COOKIE_PREFIX)
}

/**
 * 剔除请求里所有 `dsh-auth-*` cookie，返回剩余部分。
 *
 * 为什么必须剔除而不是"有就跳过注入"：
 *
 * DSH 的认证 cookie 把 **authority 与进程密钥**都写进签名载荷。容器重建、
 * DSH 重启、或平台换过 `publicHost` 之后，浏览器里那一份旧 cookie 就已经
 * 失效；但 `hasAuthCookie()` 只看前缀，会认为"已经有了"从而**跳过平台
 * 代激活的新 cookie**，把失效 cookie 原样转发给容器 → DSH 回 401：
 *   `dsh web authentication required; reopen the URL printed by dsh web.`
 * 用户看到的就是这句（实测复现）。
 *
 * 浏览器的 cookie 不按端口隔离（RFC 6265），但**只发送与当前 host 匹配的
 * cookie**；网关每个公网端口只服务一个 tenant + 一个 authority，所以这里
 * 清掉 `dsh-auth-*` 不会影响同 host 其它端口的页面（那些请求压根不带本
 * 端口的 cookie）。平台的 cookie 由服务端从容器 launch token 现换，天然
 * 权威 —— 必须让它说了算。
 *
 * @param {string|undefined} cookieHeader
 * @returns {string} 过滤后的 Cookie 头（可能为空串）
 */
function stripDshAuthCookies(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return ''
  return cookieHeader
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(AUTH_COOKIE_PREFIX))
    .join('; ')
}

/**
 * 顶层导航一致性校验页（写入浏览器前由网关直接返回，不转发给容器）。
 * 用途（根治"切了钱包但旧 URL 仍能进"）：
 *   用户在插件里切换地址后，直接粘贴旧容器 URL →
 *   网关先返回本页 → 页面 JS 实时读取插件当前地址 B，
 *   与网关卡里的会话地址 A（/__gw__/session-info）比对：
 *     B === A → 写 5 秒放行 cookie（gw_ok）并自动跳回 → 进容器
 *     B ≠ A   → 自动吊销会话（/__gw__/logout）→ 显示拒绝
 *   由此保证：URL 直访的"当前身份"永远由插件实时地址把关，
 *   而不再只依赖可能残留的会话 cookie。
 */
const VERIFY_PAGE_TEMPLATE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>容器身份校验</title>
<style>
  body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f7fa;color:#1f2937}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:40px 48px;max-width:460px;text-align:center;box-shadow:0 4px 24px rgba(15,23,42,.06)}
  .icon{font-size:40px;margin-bottom:6px}
  h1{font-size:18px;margin:10px 0 10px;color:#1f2937}
  p{color:#6b7280;font-size:13.5px;line-height:1.8;margin:0 0 24px;word-break:break-all}
  a{display:block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-decoration:none;padding:12px;border-radius:10px;font-weight:600;font-size:14px}
  a:hover{opacity:.92}
  .ok{color:#065f46}.no{color:#b91c1c}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🛡️</div>
  <h1>正在校验访问身份…</h1>
  <p id="desc">正在核对插件钱包地址与会话身份…</p>
  <a id="btn" href="__PLATFORM_URL__" style="display:none">返回平台重新连接</a>
</div>
<script>
(function(){
  var PLATFORM_URL = '__PLATFORM_URL__'
  function show(title, desc, good, showBtn) {
    document.querySelector('h1').textContent = title
    var p = document.getElementById('desc')
    p.textContent = desc
    p.className = good ? 'ok' : 'no'
    if (showBtn) document.getElementById('btn').style.display = 'block'
  }
  function pluginAccounts() {
    // 对齐 frontend/src/api/wallet.js：ccdao.request 是 Promise 式（返回 accounts 数组）。
    // 注意：数组第 0 位未必是"当前选中"账户（插件可能管理多个账户），
    // 因此一致性判定以"列表是否包含会话地址"为准，而不是死取 accounts[0]。
    // 2 秒超时兜底，绝不卡死。
    return new Promise(function (resolve) {
      var done = false
      var settle = function (list) {
        if (!done) {
          done = true
          clearTimeout(timer)
          resolve(list)
        }
      }
      var timer = setTimeout(function () { settle(null) }, 2000)
      // 注意：保留插件返回的【原始大小写】——swtc_signMessage 的 from 参数
      // 必须与插件账户逐字符一致（大小写敏感），签名前再自行 toLowerCase 比对。
      var norm = function (accounts) {
        if (!accounts || !accounts.length) return []
        return accounts.map(function (a) { return String(a) })
      }
      try {
        if (window.ccdao && window.ccdao.request) {
          var p
          try { p = window.ccdao.request({ method: 'swtc_requestAccounts', params: [] }) } catch (e) { p = null }
          if (p && typeof p.then === 'function') {
            p.then(
              function (accounts) { settle(norm(accounts)) },
              function () { settle([]) }
            )
          } else { settle([]) }
        } else if (window.ethereum && window.ethereum.request) {
          var q
          try { q = window.ethereum.request({ method: 'swtc_requestAccounts', params: [] }) } catch (e) { q = null }
          if (q && typeof q.then === 'function') {
            q.then(
              function (accounts) { settle(norm(accounts)) },
              function () { settle([]) }
            )
          } else { settle([]) }
        } else { settle([]) }
      } catch (e) { settle([]) }
    })
  }
  function withTimeout(p, ms) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(null) }, ms)
      Promise.resolve(p).then(
        function (v) { clearTimeout(t); resolve(v) },
        function () { clearTimeout(t); resolve(null) }
      )
    })
  }
  (async function () {
    var cookieAddr = null
    try {
      var ctrl = new AbortController()
      var to = setTimeout(function () { ctrl.abort() }, 3000)
      var r = await fetch('/__gw__/session-info', { credentials: 'same-origin', signal: ctrl.signal })
      clearTimeout(to)
      cookieAddr = (await r.json()).address
    } catch (e) { /* 网关本地 API 不可达 → 按无会话处理 */ }
    if (!cookieAddr) {
      show('未检测到登录会话', '请回到平台重新连接容器，将自动签发访问身份。', false, true)
      return
    }
    var accounts = await pluginAccounts()
    if (!accounts) {
      show('无法读取插件钱包地址', '请先安装并连接 CCDAO 插件，再刷新本页重试。', false, true)
      return
    }
    // 在插件账户集合里找"会话地址"的原始大小写条目（swtc_signMessage 的 from 必须逐字符一致）。
    // 不依赖 accounts[0]（插件按网站记忆当前账户，容器域读到的不等于平台域）。
    var rawAddr = null
    for (var i = 0; i < accounts.length; i++) {
      if (String(accounts[i]).toLowerCase() === cookieAddr) { rawAddr = accounts[i]; break }
    }
    if (!rawAddr) {
      show('插件账户与会话身份不一致，已注销本次访问',
        '当前插件账户列表中没有容器会话地址（' + cookieAddr.slice(0, 10) + '…）。' +
        '请点击 CCDAO 插件图标切换账户，或在平台重新连接。', false, true)
      return
    }
    // 签名证明：让插件用"会话地址"的私钥对挑战消息（GATEWAY 用途绑定）签名
    // （弹窗确认，用户可见签的是谁）。
    // 能签出来 = 当前持有该身份；签不了（已切走/非本人）= 拒绝。
    show('请在 CCDAO 插件中确认签名', '正在请求 ' + cookieAddr.slice(0, 12) + '… 对本次访问签名确认…', false, false)
    var nonce = null
    var message = null
    try {
      var cr = await fetch('/__gw__/challenge', { credentials: 'same-origin' })
      var cj = await cr.json()
      nonce = cj.nonce
      message = cj.message
    } catch (e) { nonce = null; message = null }
    if (!nonce || !message) {
      show('签名挑战获取失败', '请刷新本页重试；若持续失败请联系平台。', false, true)
      return
    }
    var signature = null
    var publicKey = null
    try {
      if (window.ccdao && window.ccdao.request) {
        signature = await withTimeout(window.ccdao.request({ method: 'swtc_signMessage', params: [rawAddr, message] }), 8000)
        publicKey = await withTimeout(window.ccdao.request({ method: 'swtc_getPublicKey', params: [rawAddr] }), 5000)
      } else if (window.ethereum && window.ethereum.request) {
        signature = await withTimeout(window.ethereum.request({ method: 'swtc_signMessage', params: [rawAddr, message] }), 8000)
        publicKey = await withTimeout(window.ethereum.request({ method: 'swtc_getPublicKey', params: [rawAddr] }), 5000)
      }
    } catch (e) { signature = null }
    if (!signature || !publicKey) {
      show('签名被拒绝或失败', '插件未完成签名确认，未获取访问资格。如需进入请重试。', false, true)
      return
    }
    var valid = false
    try {
      var vr = await fetch('/__gw__/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: cookieAddr,
          nonce: nonce,
          signature: signature,
          publicKey: publicKey,
        }),
      })
      valid = (await vr.json()).valid === true
    } catch (e) { valid = false }
    if (valid) {
      // 签名证明通过：5 分钟放行窗口（期间刷新/重进不再弹签名）
      document.cookie = 'gw_ok=__GWOK_TOKEN__; path=/; max-age=300'
      location.replace(location.href)
    } else {
      show('身份验证未通过，已注销本次访问',
        '签名验证失败。请回到平台重新连接后再进入容器。', false, true)
    }
  })()
})();
</script>
</body>
</html>`

/** 顶层导航判定：浏览器页面级请求（资源/fetch/WS 不受此路径影响） */
function isNavigationRequest(req) {
  if ((req.headers['sec-fetch-mode'] || '').toLowerCase() === 'navigate') return true
  const method = req.method || 'GET'
  const accept = req.headers.accept || ''
  return method === 'GET' && accept.includes('text/html') && !req.headers['x-requested-with']
}

/**
 * 放行凭证与"租户+端口"绑定（2026-10 全面审计）。
 * 旧值是常量 "1"：cookie 按 host 共享、**不分端口**——在同宿主先进租户 A
 * 过校验的用户，访问租户 B 时浏览器照带 gw_ok=1，B 的签名校验被整体跳过
 * （插件地址一致性防线对"串门"用户失效）。按 (address, port) 派生后，
 * A 的放行只解 A 的门。
 */
export function gwOkToken(address, publicPort) {
  return createHash('sha256').update(`gw-ok|${address}|${publicPort}`).digest('hex').slice(0, 32)
}

/** 校验放行 cookie：5 秒窗口（校验页跳回后的本次页面加载），不足则重新校验 */
function hasGwOk(req, token) {
  if (!token) return false
  const m = /(^|;\s*)gw_ok=([^;]*)/.exec(req.headers.cookie || '')
  return !!m && m[2] === token
}

/** 组装校验页（平台 URL 跟随请求 Host 推导：310xx → :8090/user） */
function buildVerifyPage(req, gwToken) {
  // 2026-10 审计：Host 是攻击者可控头，此前原样拼进 HTML/跳转链接——
  // 恶意 Host 可把校验页的"返回平台"投毒成任意域。只收 [A-Za-z0-9._-]
  // 形态的主机名（IPv4/域名足够），其余一律回退 publicHost；端口取配置，
  // 不再用硬编码 8090 猜。
  const raw = (req.headers.host || '').replace(/:\d+$/, '')
  const hostname = /^[A-Za-z0-9._-]{1,253}$/.test(raw)
    ? raw
    : String(CONFIG.server.publicHost || '127.0.0.1')
  const port = Number.isFinite(CONFIG.server.port) ? CONFIG.server.port : 8090
  const platformUrl = `http://${hostname}:${port}/user`
  return VERIFY_PAGE_TEMPLATE.replaceAll('__PLATFORM_URL__', platformUrl).replaceAll(
    '__GWOK_TOKEN__',
    String(gwToken || ''),
  )
}

class TenantGateway {
  constructor() {
    /** publicPort -> { server, address, internalPort } */
    this.routes = new Map()
    /** 一次性代开票 ticket -> { address, expiresAt }（管理员代开租户，1 分钟有效） */
    this.tickets = new Map()
  }

  /**
   * 管理员代开票：生成一次性 ticket，URL 拼接 ?gateway_ticket= 首次访问即可换取会话
   * @param {string} address 目标租户地址（必须是已存在租户，否则生成无意义）
   * @returns {string|null} ticket（null 表示该地址没有对外端口）
   */
  issueTicket(address) {
    const route = [...this.routes.values()].find((r) => r.address === address)
    if (!route) return null
    // 2026-10 审计：开了没被消费的票此前**永留 Map**（tryTicket 只在校验时判
    // 过期，过期票不删除）——管理员代开/用户放弃进入每漏一张就永久占内存。
    // 开票顺带扫一遍过期票（票量级极小，O(n) 无害）。
    const now = Date.now()
    for (const [t, rec] of this.tickets) if (rec.expiresAt <= now) this.tickets.delete(t)
    const token = randomBytes(24).toString('hex')
    this.tickets.set(token, { address, expiresAt: now + 60_000 })
    return token
  }

  /**
   * 尝试用 ?gateway_ticket= 换取放行：
   *   校验 ticket 属于该租户且未过期 → 一次性消费 → 直接签发该租户的会话 cookie → 放行
   * @returns {boolean} 是否已换取成功（成功即放行）
   */
  tryTicket(req, res, publicPort) {
    const owner = this.ownerOf(publicPort)
    if (!owner) return false
    const url = new URL(req.url, 'http://placeholder')
    const ticket = url.searchParams.get('gateway_ticket')
    if (!ticket) return false
    const rec = this.tickets.get(ticket)
    if (!rec) return false
    this.tickets.delete(ticket) // 一次性
    if (rec.address !== owner || rec.expiresAt < Date.now()) return false
    // 换取正式会话（后续请求带 cookie，不再依赖 URL 里的 ticket；管理员代开 1h）
    const token = userSessionStore.create(owner, 60 * 60 * 1000)
    res.setHeader(
      'set-cookie',
      `user_session=${token}; path=/; max-age=43200; httponly; samesite=strict`,
    )
    return true
  }

  /** 对外端口 → 该端口所属租户地址（门禁比对用） */
  ownerOf(publicPort) {
    return this.routes.get(publicPort)?.address ?? null
  }

  /**
   * 门禁：会话地址 === 该端口所属租户地址，或管理员。
   * @returns {boolean}
   */
  authorize(req, publicPort) {
    const owner = this.ownerOf(publicPort)
    if (!owner) return false
    const userAddr = getUserSession(req)
    if (userAddr === owner) return true
    const adminAddr = getAdminSession(req)
    return Boolean(adminAddr && credentialService.isAdmSync(adminAddr))
  }

  /**
   * 该端口所属租户所用镜像的 DSH 版本能力。
   * @returns {{requiresToken: boolean|null, version: string|null}|null}
   *   requiresToken: true=该 DSH 版本要求浏览器认证（平台尚未代做激活）；
   *   false=老版本，网关放行即可进；null=未知（版本读不到，须保守处理）。
   */
  capabilityOf(publicPort) {
    return this.routes.get(publicPort)?.capability ?? null
  }

  /**
   * 取（必要时创建）该租户的 DSH 认证 cookie。
   *
   * 激活用的 authority 取自**这次请求的 Host**——平台原样转发 Host，
   * 所以它就是浏览器看到的 authority，与 DSH 校验的完全一致。
   * 这也意味着激活必须在有真实请求时做（不能在容器创建时凭空造一个）。
   *
   * @returns {Promise<string|null>} "name=value"，失败返回 null
   */
  /**
   * 上游 401 后的自愈重试：丢掉缓存的 cookie，重新代激活一次再转发。
   *
   * 覆盖"缓存里的 cookie 已失效但我们不知道"的所有情况（签名密钥变化、
   * 容器重启、人工改过卷内文件），不依赖我们把每个生命周期点都记得清缓存。
   * 只重试一次（opts.retriedAuth），避免与永远 401 的上游打转。
   */
  async _retryWithFreshAuthCookie(req, res, publicPort, internalPort, opts = {}) {
    console.warn(`[gateway] :${publicPort} 上游 401：丢弃缓存 cookie 并重新激活一次`)
    authCookieCache.clear(publicPort)
    try {
      const fresh = await this._ensureDshAuthCookie(publicPort, internalPort, req)
      if (fresh) {
        this.forward(req, res, internalPort, fresh, { ...opts, retriedAuth: true })
        return
      }
    } catch (err) {
      console.error(`[gateway] :${publicPort} 重新激活失败:`, err?.message || err)
    }
    // 重新激活仍拿不到 cookie → 给明确原因，而不是让用户看 DSH 的英文提示
    if (!res.headersSent) {
      this._rejectTokenAuthRequired(res, this.capabilityOf(publicPort), { activateFailed: true })
    }
  }

  async _ensureDshAuthCookie(publicPort, internalPort, req) {
    const route = this.routes.get(publicPort)
    if (!route?.address) return null
    try {
      return await authCookieCache.get(publicPort, {
        internalPort,
        host: req.headers?.host,
        containerName: swtcContainerName(route.address),
      })
    } catch (err) {
      console.error(`[gateway] :${publicPort} DSH 认证激活异常:`, err.message)
      return null
    }
  }

  /**
   * 一个"进不去"的明确拒绝响应。
   *
   * 现在的策略是：制造 token 认证的版本由平台**代做激活**（见 dsh-auth.service.js）。
   * 走到这里只剩三种情况：
   *   (1) 代激活失败（容器刚重启 token 还没打印、密钥变化…）→ 提示稍后重试
   *   (2) 租户容器落后于平台镜像、而平台镜像是可用的 → 提示重建容器
   *   (3) 平台镜像本身就需要认证 → 提示回退镜像
   *
   * 不区分的话就会出现实测过的那种误导：容器其实跑着可用的 0.1.1-rc.2，
   * 平台却把当前镜像 0.1.5-rc.1 的结论套上来，报"该容器使用的 DSH 0.1.5-rc.1"，
   * 既拦错了容器，报出的版本也是假的。
   *
   * @returns {boolean} 已写响应
   */
  _rejectTokenAuthRequired(res, capability, opts = {}) {
    const version = capability?.version ?? '未知版本'
    const platformVersion = capability?.platformVersion ?? null

    let code = 'DSH_AUTH_REQUIRED'
    let error

    if (opts.activateFailed) {
      code = 'DSH_ACTIVATION_FAILED'
      error =
        `无法进入：平台代 DSH ${version} 做浏览器认证激活失败。` +
        `常见原因是容器刚重启、launch token 还没打印出来。请稍后重试；` +
        `若持续失败，请查看容器日志中是否出现 "dsh web: http://..." 那一行。`
    } else {
      const containerIsStaleButUsable =
        platformVersion !== null &&
        platformVersion !== version &&
        requiresToken(platformVersion) === false

      if (containerIsStaleButUsable) {
        code = 'DSH_CONTAINER_STALE'
        error =
          `该租户容器还在用旧镜像（DSH ${version}），但当前平台镜像 DSH ${platformVersion} 是可用的。` +
          `请重建该租户容器以换用新镜像（数据卷会保留），而不是回退镜像。`
      } else {
        error =
          `无法判定 DSH ${version} 是否需要浏览器认证，平台无法安全地代为激活。` +
          `请在管理端把镜像回退到 ≤ 0.1.1-rc.2（最后一个不需要该认证的版本）后重试。`
      }
    }

    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        error,
        code,
        dshVersion: capability?.version ?? null,
        platformDshVersion: platformVersion,
        tokenAuthSince: capability?.tokenAuthSince ?? null,
      }),
    )
    return true
  }

  /**
   * 为一个租户开放对外端口：0.0.0.0:publicPort → 127.0.0.1:internalPort
   *
   * 返回 Promise：bind 成功 resolve，端口被占/绑定失败 reject。
   * 修复前是"同步返回 + error 只打日志 + 无条件写 routes"，导致调用方
   * （finalizeTenant）以为成功、落盘 running，实际给用户一个没人监听的 URL。
   *
   * @param {number} publicPort 对外端口（网关监听）
   * @param {number} internalPort 容器内部回环端口
   * @param {string} address 租户地址
   * @param {{requiresToken:boolean|null, version:string|null, tokenAuthSince?:string}} [capability]
   *   该租户镜像的 DSH 能力。**由调用方（finalizeTenant）随路由一起传入**，
   *   网关刻意不 import user.service（会形成循环依赖），只在路由表里保存这一份。
   * @returns {Promise<void>}
   */
  listen(publicPort, internalPort, address, capability = null) {
    // 2026-10 全面审计：owner 门。此前无条件先 close 再绑——端口分配一旦竞态
    // （两个租户拿到同一个对外端口），后来者会**静默关掉前一个租户的监听**，
    // 把前者的用户流量转到自己的容器上 = 跨租户数据泄露。同一租户重启/换镜像
    // 的重绑照旧幂等（address 相同才 close）；不同租户一律拒绝。
    const existing = this.routes.get(publicPort)
    if (existing && existing.address !== address) {
      const err = new Error(
        `端口 ${publicPort} 正在为另一租户服务（${String(existing.address).slice(0, 8)}…），拒绝抢占`,
      )
      err.code = 'PORT_TAKEN'
      return Promise.reject(err)
    }
    this.close(publicPort) // 幂等：同租户旧监听（重启/端口重绑场景）

    const server = createServer(async (req, res) => {
      // async 事件回调里抛出的异常不会有人接住 → 会变成 unhandled rejection，
      // 严重时直接让入口进程退出（影响所有租户）。这里统一兜底。
      try {
        await this._handleHttp(req, res, publicPort, internalPort)
      } catch (err) {
        console.error(`[gateway] :${publicPort} handler error:`, err?.message || err)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        }
        try {
          res.end(JSON.stringify({ error: '网关内部错误', code: 'GATEWAY_ERROR' }))
        } catch {
          // 响应已不可写，忽略
        }
      }
    })

    server.on('upgrade', async (req, socket, head) => {
      // 同 HTTP：async 回调必须兜底，否则异常会变成 unhandled rejection
      try {
        if (!this.authorize(req, publicPort)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        // 升级通道同样受 DSH 认证层保护：它需要同一个 cookie，
        // 否则前端会拿到一个"连上又被踢"的长连接，报错比 HTTP 更难排查。
        const capability = this.capabilityOf(publicPort)
        let authCookie = null
        if (capability?.requiresToken === true) {
          authCookie = await this._ensureDshAuthCookie(publicPort, internalPort, req)
          if (!authCookie) {
            const version = capability?.version ?? '未知版本'
            socket.write(
              `HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n` +
                `content-type: text/plain; charset=utf-8\r\n\r\n` +
                `DSH ${version} 需要浏览器认证，平台代激活失败（容器可能刚重启，token 尚未就绪）；请稍后重试。\n`,
            )
            socket.destroy()
            return
          }
        } else if (capability?.requiresToken !== false) {
          const version = capability?.version ?? '未知版本'
          socket.write(
            `HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n` +
              `content-type: text/plain; charset=utf-8\r\n\r\n` +
              `无法判定 DSH ${version} 是否需要浏览器认证；请回退到 ≤ 0.1.1-rc.2。\n`,
          )
          socket.destroy()
          return
        }
        this.forwardUpgrade(req, socket, head, internalPort, authCookie)
      } catch (err) {
        console.error(`[gateway] :${publicPort} upgrade handler error:`, err?.message || err)
        try {
          socket.destroy()
        } catch {
          // ignore
        }
      }
    })

    // 绑定结果可见：成功才写入 routes，失败向调用方抛出（不再静默继续）
    return new Promise((resolvePromise, reject) => {
      const onBindError = (err) => {
        console.error(`[gateway] listen :${publicPort} failed:`, err.message)
        reject(err)
      }
      server.once('error', onBindError)
      server.once('listening', () => {
        server.removeListener('error', onBindError)
        // 绑定后的运行时错误：兜底记录，避免 'error' 事件无监听导致进程崩溃
        server.on('error', (err) => {
          console.error(`[gateway] :${publicPort} runtime error:`, err.message)
        })
        this.routes.set(publicPort, { server, address, internalPort, capability })
        console.log(`[gateway] :${publicPort} -> 127.0.0.1:${internalPort} (${address})`)
        // listen 只发生在"容器就绪"时（新建/重启/换镜像/启动恢复）—— 这正是
        // 丢弃旧代激活 cookie 的时机。DSH 的 cookie 由租户卷 .credentials.yaml
        // 里的签名密钥签发；容器重建、密钥被隔离（凭据自愈）、换镜像都会让它
        // 失效。而旧实现把 cookie 缓存 29 天且**从不清理**（AuthCookieCache.clear
        // 定义了却无人调用）→ 网关持续注入死 cookie，
        // DSH 恒回 "dsh web authentication required"。
        authCookieCache.clear(publicPort)
        resolvePromise()
      })
      try {
        server.listen(publicPort, '0.0.0.0')
      } catch (err) {
        server.removeListener('error', onBindError)
        reject(err)
      }
    })
  }

  /** 关闭一个对外端口（租户销毁/重置时）；stop 场景不要调（重连即恢复） */
  close(publicPort) {
    const route = this.routes.get(publicPort)
    if (!route) return
    try {
      route.server.close()
      // 注：这里刻意**不**调用 closeAllConnections()。它虽然能立刻踢掉挂在旧
      // route 上的 keep-alive 连接（容器重建后 internalPort 可能已变的窗口），
      // 但会一并摧毁**在途**连接：实测在全量测试里把随机失败率从 0 抬到约 50%
      // （多个用例会重复 listen），属未验证的副作用。留作独立课题。
    } catch {
      // ignore
    }
    this.routes.delete(publicPort)
    // 容器已下线：缓存 cookie 与这个容器绑定，不能留给下一个容器用
    authCookieCache.clear(publicPort)
    console.log(`[gateway] :${publicPort} closed`)
  }

  /** 关闭全部（进程退出/测试清理用） */
  closeAll() {
    for (const port of [...this.routes.keys()]) this.close(port)
  }

  /**
   * 确认某公网端口上已有到指定租户的路由。
   * @returns {boolean}
   */
  hasRoute(publicPort, address) {
    const route = this.routes.get(publicPort)
    return Boolean(route && route.address === address)
  }

  // ---------------------------------------------------------------------------
  // 转发（透明代理：不改 Host、不缓存、不加工 body）
  // ---------------------------------------------------------------------------

  /**
   * 处理一个租户网关的 HTTP 请求（从 createServer 回调里抽出，便于统一兜底异常）。
   */
  async _handleHttp(req, res, publicPort, internalPort) {
    // ---- 网关本地 API（校验页专用，绝不转发给容器）----
    let pathname = ''
    try {
      pathname = new URL(req.url, 'http://x').pathname
    } catch {
      pathname = String(req.url || '')
    }
    if (pathname === '/__gw__/session-info' && (req.method || 'GET') === 'GET') {
      const cookie = req.headers.cookie || ''
      const m = cookie.match(/user_session=([^;]+)/)
      const address = m ? getUserSession(req) : null
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, address }))
      return
    }
    if (pathname === '/__gw__/logout' && (req.method || 'POST') === 'POST') {
      const cookie = req.headers.cookie || ''
      const m = cookie.match(/user_session=([^;]+)/)
      if (m) userSessionStore.revoke(decodeURIComponent(m[1]))
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': [
          'user_session=; path=/; max-age=0; httponly; samesite=strict',
          'gw_ok=; path=/; max-age=0',
        ],
      })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (pathname === '/__gw__/challenge' && (req.method || 'GET') === 'GET') {
      // 签名校验页用：为"会话地址"发放一次性挑战（GATEWAY 用途独立分池，
      // 与登录/配置/技能市场的挑战互不通用）
      const cookie = req.headers.cookie || ''
      const m = cookie.match(/user_session=([^;]+)/)
      const address = m ? getUserSession(req) : null
      if (!address) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, address: null }))
        return
      }
      const challenge = tenantConfigService.issueChallenge(address, SIGN_PURPOSE.GATEWAY)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: Boolean(challenge),
          nonce: challenge?.nonce ?? null,
          // message 是交给钱包签的用途绑定内容（hex）；要签的是它，不是 nonce
          message: challenge?.message ?? null,
          address,
        }),
      )
      return
    }
    if (pathname === '/__gw__/verify' && (req.method || 'POST') === 'POST') {
      // 签名证明：**用途绑定消息**由插件私钥签名，公钥推导地址必须 === 会话地址
      ;(async () => {
        let body = {}
        try {
          // parseBody 返回【原文】，需 JSON.parse 成对象
          const raw = (await parseBody(req)) || ''
          body = raw ? JSON.parse(raw) : {}
        } catch {
          body = {}
        }
        const address = String(body.address || '').toLowerCase()
        const nonce = String(body.nonce || '')
        const signature = String(body.signature || '')
        const publicKey = String(body.publicKey || '')
        const cookieM = (req.headers.cookie || '').match(/user_session=([^;]+)/)
        const sessionAddr = cookieM ? getUserSession(req) : null
        const valid =
          Boolean(sessionAddr) &&
          sessionAddr === address &&
          Boolean(nonce) &&
          tenantConfigService.verifySignature(
            address,
            buildSignedMessage(SIGN_PURPOSE.GATEWAY, address, nonce),
            signature,
            publicKey,
          )
        // 一次性消费：必须是为 GATEWAY 用途发放的挑战，且不可重放
        if (valid) tenantConfigService.consumeChallenge(address, nonce, SIGN_PURPOSE.GATEWAY)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, valid, address }))
      })()
      return
    }

    // ---- 顶层导航 ----
    // 优先级：①有会话 → URL 带一次性 ticket（平台「进入」/ 管理员代开）直接放行
    //              → 否则返回签名校验页（外部粘贴 URL：插件实时签名证明身份）
    //         ②无会话 → ticket → 403
    // 放行凭证按 (租户, 端口) 派生：A 的 gw_ok 解不开 B 的门（审计串门绕过）
    const navRoute = this.routes.get(publicPort)
    const gwToken = navRoute ? gwOkToken(navRoute.address, publicPort) : null
    if (isNavigationRequest(req) && !hasGwOk(req, gwToken)) {
      if (this.authorize(req, publicPort)) {
        // 有会话：先消费一次性 ticket（官网「进入」URL 携带），命中即放行
        if (!this.tryTicket(req, res, publicPort)) {
          // 无 ticket → 签名校验页（插件在容器域读到的账户不可靠，
          // 改为"插件对会话地址签名"证明：能签出来 = 身份一致，才放行）
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(buildVerifyPage(req, gwToken))
          return
        }
      } else if (!this.tryTicket(req, res, publicPort)) {
        // 无会话：管理员代开 ticket（一次性换取会话后放行），否则 403
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: '该租户容器需要登录会话才能访问，请回到平台重新连接',
            code: 'FORBIDDEN',
          }),
        )
        return
      }
    } else if (!this.authorize(req, publicPort)) {
      // 非导航请求（子资源/fetch/WS 之外的 HTTP）：维持原始门禁
      if (!this.tryTicket(req, res, publicPort)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: '该租户容器需要登录会话才能访问，请回到平台重新连接',
            code: 'FORBIDDEN',
          }),
        )
        return
      }
    }

    // ---- 按 DSH 版本能力分岔 ----
    // 平台门禁已通过，但"能不能进"还取决于容器内 DSH 自己是否要求浏览器认证：
    //   requiresToken === false → 老版本，无认证层，直接放行（以前的行为）
    //   requiresToken === true  → 该版本要求 launch token 激活；平台**代做激活**
    //                             （读容器日志里的 token → 换 cookie → 注入转发）
    //   requiresToken === null  → 版本未知，**保守拒绝**：把未知当"老版本可直通"
    //                             会让新镜像静默坏掉，那比多拦一次更糟
    const capability = this.capabilityOf(publicPort)
    let authCookie = null
    if (capability?.requiresToken === true) {
      authCookie = await this._ensureDshAuthCookie(publicPort, internalPort, req)
      if (!authCookie) {
        // 激活失败（token 还没打印出来、容器刚重启、密钥变化…）
        // → 明确告知，而不是把用户放进一个注定 401 的页面
        this._rejectTokenAuthRequired(res, capability, { activateFailed: true })
        return
      }
    } else if (capability?.requiresToken !== false) {
      this._rejectTokenAuthRequired(res, capability)
      return
    }

    this.forward(req, res, internalPort, authCookie, { publicPort })

    // WebSocket / SSE 升级通道透传（DSH 的会话流、终端等长连接）
  }

  forward(req, res, internalPort, authCookie = null, opts = {}) {
    const headers = { ...req.headers }
    for (const h of HOP_BY_HOP) delete headers[h]
    headers['x-forwarded-for'] = req.socket?.remoteAddress ?? ''
    headers['x-forwarded-host'] = req.headers.host
    // Cookie 处理（**无条件执行**，不能只在 authCookie 存在时才做）：
    //   ① 平台自身的门禁 cookie（admin_session / user_session / gw_ok）
    //      一律剥离 —— 绝不转发进租户容器（H1 加固）。
    //   ② 剔除浏览器带来的所有 dsh-auth-*（可能是失效的旧 cookie），
    //      只保留平台现换的那一份 —— 否则旧 cookie 会被原样转发，DSH 回
    //      "dsh web authentication required"（实测踩过）。
    headers.cookie = mergeDshAuthCookie(headers.cookie, authCookie)
    if (!headers.cookie) delete headers.cookie

    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: internalPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (ures) => {
        // 上游 401：说明注入的 cookie 被 DSH 拒了（签名密钥变了／容器重启过／
        // 缓存里那份已失效）。丢掉缓存、重新激活一次再转发，而不是把用户扔进
        // 一个注定进不去的页面。只对无副作用的 GET/HEAD 重试 —— POST 等请求体
        // 已经发出去，重放不安全。
        if (
          ures.statusCode === 401 &&
          authCookie &&
          !opts.retriedAuth &&
          opts.publicPort &&
          (req.method === 'GET' || req.method === 'HEAD')
        ) {
          ures.resume() // 丢弃本次响应，释放上游连接
          void this._retryWithFreshAuthCookie(req, res, opts.publicPort, internalPort, opts)
          return
        }
        const outHeaders = { ...ures.headers }
        // set-cookie 是数组，直接展开透传
        const finalHeaders = {}
        for (const [k, v] of Object.entries(outHeaders)) {
          finalHeaders[k] = Array.isArray(v) ? v : String(v)
        }
        res.writeHead(ures.statusCode, finalHeaders)
        ures.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end('gateway: upstream unreachable')
    })
    // 2026-10 审计（流生命周期泄漏，两端各堵）：
    // ① 上游挂起（DSH 卡死/慢读取）时旧实现无超时——浏览器连接与上游 socket
    //    双双永久占用，租户级卡死会拖垮网关连接数。60s 无响应即拆链（502）。
    // ② 浏览器断开（关页/AbortController）时旧实现不碰上游——请求继续发进
    //    容器、响应无人认领直到 DSH 侧超时。res close 即销毁上游请求。
    upstream.setTimeout(60_000, () => {
      upstream.destroy(new Error('gateway: upstream timeout'))
    })
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
    })
    req.pipe(upstream)
  }

  forwardUpgrade(req, socket, head, internalPort, authCookie = null) {
    // 与 forward() 同理：必须**替换**浏览器带来的 dsh-auth-*，不能"有就跳过"。
    // 而且这里要避免 push 出第二行 `cookie:` —— 两行 cookie 会让容器自行挑一个，
    // 挑中失效的那份就又是 "dsh web authentication required"。
    const cookieHeader = mergeDshAuthCookie(req.headers.cookie, authCookie)

    const upstream = netConnect(internalPort, '127.0.0.1', () => {
      // 重发 upgrade 请求（WebSocket 握手必须原样，含 Connection/Upgrade 头）
      const lines = []
      for (const [k, v] of Object.entries(req.headers)) {
        // cookie 单独处理：跳过原始的那一行，改用上面合并后的
        if (k.toLowerCase() === 'cookie') continue
        lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      }
      // 代激活的 dsh-auth cookie 同样要带上（WS 握手也要过 DSH 认证）
      if (cookieHeader) lines.push(`cookie: ${cookieHeader}`)
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (head && head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => {
      socket.destroy()
    })
    socket.on('error', () => {
      upstream.destroy()
    })
  }
}

export const tenantGateway = new TenantGateway()
