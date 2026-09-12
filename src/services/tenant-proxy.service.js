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
import { randomBytes } from 'node:crypto'
import { getUserSession, userSessionStore } from '../middleware/user-auth.middleware.js'
import { getAdminSession } from '../middleware/auth.middleware.js'
import { isAdmin } from '../config/config.js'
import { tenantConfigService } from './tenant-config.service.js'
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
    // 签名证明：让插件用"会话地址"的私钥对 nonce 签名（弹窗确认，用户可见签的是谁）。
    // 能签出来 = 当前持有该身份；签不了（已切走/非本人）= 拒绝。
    show('请在 CCDAO 插件中确认签名', '正在请求 ' + cookieAddr.slice(0, 12) + '… 对本次访问签名确认…', false, false)
    var nonce = null
    try {
      var cr = await fetch('/__gw__/challenge', { credentials: 'same-origin' })
      nonce = (await cr.json()).nonce
    } catch (e) { nonce = null }
    if (!nonce) {
      show('签名挑战获取失败', '请刷新本页重试；若持续失败请联系平台。', false, true)
      return
    }
    var signature = null
    var publicKey = null
    try {
      if (window.ccdao && window.ccdao.request) {
        signature = await withTimeout(window.ccdao.request({ method: 'swtc_signMessage', params: [rawAddr, nonce] }), 8000)
        publicKey = await withTimeout(window.ccdao.request({ method: 'swtc_getPublicKey', params: [rawAddr] }), 5000)
      } else if (window.ethereum && window.ethereum.request) {
        signature = await withTimeout(window.ethereum.request({ method: 'swtc_signMessage', params: [rawAddr, nonce] }), 8000)
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
      document.cookie = 'gw_ok=1; path=/; max-age=300'
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

/** 校验放行 cookie：5 秒窗口（校验页跳回后的本次页面加载），不足则重新校验 */
function hasGwOk(req) {
  return /(^|;\s*)gw_ok=1(;|$)/.test(req.headers.cookie || '')
}

/** 组装校验页（平台 URL 跟随请求 Host 推导：310xx → :8090/user） */
function buildVerifyPage(req) {
  const hostname = (req.headers.host || '').replace(/:\d+$/, '')
  const platformUrl = `http://${hostname}:8090/user`
  return VERIFY_PAGE_TEMPLATE.replaceAll('__PLATFORM_URL__', platformUrl)
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
    const token = randomBytes(24).toString('hex')
    this.tickets.set(token, { address, expiresAt: Date.now() + 60_000 })
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
    return Boolean(adminAddr && isAdmin(adminAddr))
  }

  /**
   * 为一个租户开放对外端口：0.0.0.0:publicPort → 127.0.0.1:internalPort
   */
  listen(publicPort, internalPort, address) {
    this.close(publicPort) // 幂等：先关旧监听（重启/端口重绑场景）

    const server = createServer((req, res) => {
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
        // 签名校验页用：为"会话地址"发放一次性 nonce（复用平台配置签名挑战）
        const cookie = req.headers.cookie || ''
        const m = cookie.match(/user_session=([^;]+)/)
        const address = m ? getUserSession(req) : null
        if (!address) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, address: null }))
          return
        }
        const nonce = tenantConfigService.issueChallenge(address)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: Boolean(nonce), nonce, address }))
        return
      }
      if (pathname === '/__gw__/verify' && (req.method || 'POST') === 'POST') {
        // 签名证明：nonce 由插件私钥签名，公钥推导地址必须 === 会话地址 才算本人
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
            tenantConfigService.verifySignature(address, nonce, signature, publicKey)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, valid, address }))
        })()
        return
      }

      // ---- 顶层导航 ----
      // 优先级：①有会话 → URL 带一次性 ticket（平台「进入」/ 管理员代开）直接放行
      //              → 否则返回签名校验页（外部粘贴 URL：插件实时签名证明身份）
      //         ②无会话 → ticket → 403
      if (isNavigationRequest(req) && !hasGwOk(req)) {
        if (this.authorize(req, publicPort)) {
          // 有会话：先消费一次性 ticket（官网「进入」URL 携带），命中即放行
          if (!this.tryTicket(req, res, publicPort)) {
            // 无 ticket → 签名校验页（插件在容器域读到的账户不可靠，
            // 改为"插件对会话地址签名"证明：能签出来 = 身份一致，才放行）
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(buildVerifyPage(req))
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
      this.forward(req, res, internalPort)
    })

    // WebSocket / SSE 升级通道透传（DSH 的会话流、终端等长连接）
    server.on('upgrade', (req, socket, head) => {
      if (!this.authorize(req, publicPort)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.forwardUpgrade(req, socket, head, internalPort)
    })

    server.on('error', (err) => {
      // 端口占用/绑定失败：打日志即可，不抛（网关不该拖垮入口进程）
      console.error(`[gateway] listen :${publicPort} failed:`, err.message)
    })

    server.listen(publicPort, '0.0.0.0')
    this.routes.set(publicPort, { server, address, internalPort })
    console.log(`[gateway] :${publicPort} -> 127.0.0.1:${internalPort} (${address})`)
  }

  /** 关闭一个对外端口（租户销毁/重置时）；stop 场景不要调（重连即恢复） */
  close(publicPort) {
    const route = this.routes.get(publicPort)
    if (!route) return
    try {
      route.server.close()
    } catch {
      // ignore
    }
    this.routes.delete(publicPort)
    console.log(`[gateway] :${publicPort} closed`)
  }

  /** 关闭全部（进程退出/测试清理用） */
  closeAll() {
    for (const port of [...this.routes.keys()]) this.close(port)
  }

  // ---------------------------------------------------------------------------
  // 转发（透明代理：不改 Host、不缓存、不加工 body）
  // ---------------------------------------------------------------------------

  forward(req, res, internalPort) {
    const headers = { ...req.headers }
    for (const h of HOP_BY_HOP) delete headers[h]
    headers['x-forwarded-for'] = req.socket?.remoteAddress ?? ''
    headers['x-forwarded-host'] = req.headers.host

    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: internalPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (ures) => {
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
    req.pipe(upstream)
  }

  forwardUpgrade(req, socket, head, internalPort) {
    const upstream = netConnect(internalPort, '127.0.0.1', () => {
      // 重发 upgrade 请求（WebSocket 握手必须原样，含 Connection/Upgrade 头）
      const lines = []
      for (const [k, v] of Object.entries(req.headers)) {
        lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      }
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
