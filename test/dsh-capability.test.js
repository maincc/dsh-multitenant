/**
 * DSH 版本能力判定 + 网关按能力分岔
 *
 * 背景：DSH 自 0.1.2-alpha.2 起给 `/` 与 `/api` 加了"绑定 authority 的签名
 * cookie"认证，必须先用**进程级 launch token** 激活。而该 token 只有容器内
 * `dsh web` 启动时打印，激活 URL 指向容器内 127.0.0.1:3080 / 容器内网 IP，
 * 用户浏览器够不着，平台也没有代做激活。于是从该版本起，租户容器进了不去，
 * 用户会撞上一句英文 401。
 *
 * 本文件覆盖为此引入的"能力判定 + 分岔"：
 *   - requiresToken：分界线必须精确（0.1.1-rc.2 不需要 / 0.1.2-alpha.2 需要），
 *     未知版本必须返回 null（调用方保守处理），绝不能猜成 false
 *   - imageCapability：按镜像缓存，命中不产生 docker 开销；显式失效可用
 *   - 网关：老版本→转发；新版本→503 明确说明；未知→保守拒绝（不放行）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'

// imageCapability 的缓存逻辑要在**真实实例**上测（每个实例自带一份缓存），
// 所以只把两个"会真的调 docker"的方法挡掉，其余（构造函数、缓存逻辑）用真的。
vi.mock('../src/services/docker.service.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    dockerService: {
      imageId: vi.fn(),
      imageDshVersion: vi.fn(),
      imageCapability: vi.fn(),
      clearCapabilityCache: vi.fn(),
    },
    VERSION_PROBE_CMD: 'stub',
  }
})

import {
  requiresToken,
  describeTokenRequirement,
  DSH_TOKEN_AUTH_SINCE,
} from '../src/services/dsh-version.service.js'
import { dockerService, DockerService } from '../src/services/docker.service.js'
import {
  tenantGateway,
  _setDshAuthCookieModeForTest,
} from '../src/services/tenant-proxy.service.js'
import { userService } from '../src/services/user.service.js'
import { userSessionStore } from '../src/middleware/user-auth.middleware.js'
// 代激活服务：测试里只 mock readToken（docker logs），其余（激活请求、cookie 解析、
// 并发合并、缓存）走真实实现，端到端覆盖整条激活链路。
import * as dshAuth from '../src/services/dsh-auth.service.js'
import { authCookieCache } from '../src/services/dsh-auth.service.js'

const OWNER = 'jndwretndumoqbt2uauclmfmx7xbqjykva'

// ---------------------------------------------------------------------------
// requiresToken
// ---------------------------------------------------------------------------

describe('requiresToken：版本分界必须精确', () => {
  // 期望值来自"逐版本下载 npm tarball 实际检查认证代码"的实证结果
  const NO_TOKEN = [
    '0.0.1-rc.1',
    '0.0.1-rc.2',
    '0.0.1-rc.5',
    '0.1.0-rc.2',
    '0.1.0-rc.3',
    '0.1.0-rc.6',
    '0.1.0-rc.7',
    '0.1.0-rc.8',
    '0.1.1-rc.1',
    '0.1.1-rc.2',
  ]
  const NEEDS_TOKEN = [
    '0.1.2-alpha.2',
    '0.1.2-alpha.3',
    '0.1.2-alpha.4',
    '0.1.2-alpha.5',
    '0.1.2-rc.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1',
    '0.1.5-alpha.2',
    '0.1.5-rc.1',
    '0.1.5-rc.2',
    '0.1.6-alpha.1',
  ]

  it.each(NO_TOKEN)('%s → 不需要（老版本，网关可直通）', (v) => {
    expect(requiresToken(v)).toBe(false)
  })

  it.each(NEEDS_TOKEN)('%s → 需要（该版本要求浏览器认证）', (v) => {
    expect(requiresToken(v)).toBe(true)
  })

  it('分界常量就是首个需要认证的版本', () => {
    expect(requiresToken(DSH_TOKEN_AUTH_SINCE)).toBe(true)
    expect(DSH_TOKEN_AUTH_SINCE).toBe('0.1.2-alpha.2')
  })

  it('边界紧邻版本判定互不串位（最易写错的地方）', () => {
    expect(requiresToken('0.1.2-alpha.1')).toBe(false)
    expect(requiresToken('0.1.2-alpha.2')).toBe(true)
    expect(requiresToken('0.1.1-rc.2')).toBe(false)
  })

  it('预发布序号按数值比较（alpha.10 不能输给 alpha.2）', () => {
    expect(requiresToken('0.1.2-alpha.10')).toBe(true)
    expect(requiresToken('0.1.2-alpha.2')).toBe(true)
  })

  it('主版本号跨位时按数值比较（0.1.10 > 0.1.2）', () => {
    expect(requiresToken('0.1.10-rc.1')).toBe(true)
    expect(requiresToken('0.10.0-rc.1')).toBe(true)
  })

  it('同段预发布：alpha < rc < 正式', () => {
    expect(requiresToken('0.1.2-alpha.2')).toBe(true)
    expect(requiresToken('0.1.2-rc.1')).toBe(true)
    expect(requiresToken('0.1.2')).toBe(true)
  })

  it('无法判定时必须返回 null，绝不能猜成 false', () => {
    // 猜成 false 会让"新镜像被当成老镜像直通"→ 用户撞英文 401，
    // 而管理员在控制台看不到任何线索
    for (const bad of [null, undefined, '', 'garbage', 'latest', 'x.y.z', 123]) {
      expect(requiresToken(bad)).toBeNull()
    }
  })
})

describe('describeTokenRequirement：能给管理员说清原因', () => {
  it('需要认证 → 说明引入版本与可行做法', () => {
    const msg = describeTokenRequirement('0.1.5-rc.1')
    expect(msg).toMatch(/要求浏览器认证/)
    expect(msg).toMatch(/0\.1\.2-alpha\.2/)
    expect(msg).toMatch(/0\.1\.1-rc\.2/)
  })

  it('不需要认证 → 说明可直通', () => {
    expect(describeTokenRequirement('0.1.1-rc.2')).toMatch(/不需要浏览器认证/)
  })

  it('未知 → 明确说无法判定', () => {
    expect(describeTokenRequirement(null)).toMatch(/无法判定/)
  })
})

// ---------------------------------------------------------------------------
// imageCapability：按镜像缓存
// ---------------------------------------------------------------------------

describe('imageCapability：按镜像缓存，命中不产生 docker 开销', () => {
  let svc
  beforeEach(() => {
    vi.restoreAllMocks()
    svc = new DockerService() // 真实实例：真实构造 + 真实缓存逻辑
    // 只挡掉会真的调 docker 的两步
    vi.spyOn(DockerService.prototype, 'imageId')
    vi.spyOn(DockerService.prototype, 'imageDshVersion')
  })

  it('首次探测：返回版本与能力', async () => {
    svc.imageId.mockResolvedValue('sha256:aaa')
    svc.imageDshVersion.mockResolvedValue('0.1.1-rc.2')

    const cap = await svc.imageCapability()

    expect(cap.version).toBe('0.1.1-rc.2')
    expect(cap.requiresToken).toBe(false)
    expect(cap.imageId).toBe('sha256:aaa')
    expect(cap.cached).toBe(false)
  })

  it('第二次命中缓存：不再执行任何 docker 命令', async () => {
    svc.imageId.mockResolvedValue('sha256:aaa')
    svc.imageDshVersion.mockResolvedValue('0.1.5-rc.1')

    await svc.imageCapability()
    const callsAfterFirst = svc.imageId.mock.calls.length + svc.imageDshVersion.mock.calls.length
    const second = await svc.imageCapability()

    expect(second.cached).toBe(true)
    // 关键：命中缓存必须是零 docker 调用（check-rpc 会高频调用它）
    expect(svc.imageId.mock.calls.length + svc.imageDshVersion.mock.calls.length).toBe(
      callsAfterFirst,
    )
  })

  it('clearCapabilityCache 后重新探测（平台换镜像后必须调用）', async () => {
    svc.imageId.mockResolvedValue('sha256:aaa')
    svc.imageDshVersion.mockResolvedValue('0.1.5-rc.1')

    await svc.imageCapability()
    svc.clearCapabilityCache()
    svc.imageDshVersion.mockResolvedValue('0.1.1-rc.2')
    const after = await svc.imageCapability()

    expect(after.cached).toBe(false)
    expect(after.requiresToken).toBe(false)
  })

  it('读不到版本 → requiresToken 为 null（未知，不可当老版本）', async () => {
    svc.imageId.mockResolvedValue('sha256:aaa')
    svc.imageDshVersion.mockResolvedValue(null)

    const cap = await svc.imageCapability()

    expect(cap.version).toBeNull()
    expect(cap.requiresToken).toBeNull()
  })

  it('按镜像分别缓存：查 A 后查 B，B 不能拿到 A 的结论', async () => {
    // 回归测试：早期实现只存一份缓存，导致"查过 A 再查 B"时 B 直接
    // 复用 A 的结论（实测把 0.1.1-rc.2 的镜像误报成 0.1.5-rc.1），
    // 而且 cached=true 让错误看起来像是正常命中。
    svc.imageId.mockImplementation(async (img) => `sha256:${img}`)
    svc.imageDshVersion.mockImplementation(async (img) =>
      img === 'img-a' ? '0.1.5-rc.1' : '0.1.1-rc.2',
    )

    const a = await svc.imageCapability('img-a')
    const b = await svc.imageCapability('img-b')

    expect(a.version).toBe('0.1.5-rc.1')
    expect(a.requiresToken).toBe(true)
    expect(b.version).toBe('0.1.1-rc.2') // 必须是自己镜像的版本
    expect(b.requiresToken).toBe(false)
    expect(b.cached).toBe(false) // 不是命中 A 的缓存

    // 回头再查 A 仍应命中 A 自己的缓存，且结论不变
    const a2 = await svc.imageCapability('img-a')
    expect(a2.cached).toBe(true)
    expect(a2.version).toBe('0.1.5-rc.1')
  })

  it('同一镜像第二次查询命中缓存（各自的缓存互不干扰）', async () => {
    svc.imageId.mockResolvedValue('sha256:aaa')
    svc.imageDshVersion.mockResolvedValue('0.1.1-rc.2')

    await svc.imageCapability('img-a')
    const again = await svc.imageCapability('img-a')

    expect(again.cached).toBe(true)
    expect(again.version).toBe('0.1.1-rc.2')
  })
})

// ---------------------------------------------------------------------------
// resolveTenantCapability：记录是否还算数，必须靠镜像 ID 验证
// ---------------------------------------------------------------------------

describe('resolveTenantCapability：不盲目沿用过期快照', () => {
  const ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'

  beforeEach(() => {
    vi.restoreAllMocks()
    userService.state.swtcUsers = {}
  })

  it('记录里的镜像 === 当前镜像 → 直接采纳记录，不再探测', async () => {
    userService.state.swtcUsers[ADDR] = {
      requiresToken: true,
      baseImageVersion: '0.1.5-rc.1',
      imageId: 'sha256:aaa',
    }
    vi.spyOn(dockerService, 'imageId').mockResolvedValue('sha256:aaa')
    const capSpy = vi.spyOn(dockerService, 'imageCapability')

    const cap = await userService.resolveTenantCapability(ADDR)

    expect(cap.requiresToken).toBe(true)
    expect(cap.version).toBe('0.1.5-rc.1')
    expect(capSpy).not.toHaveBeenCalled() // 记录有效 → 省掉探测
  })

  it('记录里的镜像 ≠ 当前镜像 → 重新探测，按新镜像回答', async () => {
    // 关键场景：管理员把镜像从"需要认证的 0.1.5-rc.1"换回"可直通的
    // 0.1.1-rc.2"，但租户容器尚未重建。若沿用旧快照，该租户会一直 503，
    // 看起来像"换了镜像没生效"。
    userService.state.swtcUsers[ADDR] = {
      requiresToken: true,
      baseImageVersion: '0.1.5-rc.1',
      imageId: 'sha256:OLD',
    }
    vi.spyOn(dockerService, 'imageId').mockResolvedValue('sha256:NEW')
    vi.spyOn(dockerService, 'imageCapability').mockResolvedValue({
      version: '0.1.1-rc.2',
      requiresToken: false,
      imageId: 'sha256:NEW',
    })

    const cap = await userService.resolveTenantCapability(ADDR)

    expect(cap.requiresToken).toBe(false) // 跟着新镜像走
    expect(cap.version).toBe('0.1.1-rc.2')
  })

  it('没有 imageId 的旧记录 → 重新探测（宁可多查一次也不沿用）', async () => {
    // 本次改动之前创建的租户记录没有 imageId 字段；它的 requiresToken
    // 可能对应任何镜像，无法验证，因此一律重新探测。
    userService.state.swtcUsers[ADDR] = {
      requiresToken: true,
      baseImageVersion: '0.1.5-rc.1',
      // 无 imageId
    }
    // imageId 必须也 mock：否则它抛错会被内部 catch 吞掉、兜底走到探测，
    // 于是"该探测"与"碰巧兜底探测"无法区分 —— 这条测试就抓不到
    // "盲目沿用无 imageId 记录"的退化（实测退化后仍是通过）。
    vi.spyOn(dockerService, 'imageId').mockResolvedValue('sha256:NEW')
    const capSpy = vi.spyOn(dockerService, 'imageCapability').mockResolvedValue({
      version: '0.1.1-rc.2',
      requiresToken: false,
    })

    const cap = await userService.resolveTenantCapability(ADDR)

    expect(capSpy).toHaveBeenCalled()
    expect(cap.requiresToken).toBe(false) // 不是沿用记录里的 true
  })

  it('无记录 → 探测当前镜像', async () => {
    vi.spyOn(dockerService, 'imageCapability').mockResolvedValue({
      version: '0.1.1-rc.2',
      requiresToken: false,
    })

    const cap = await userService.resolveTenantCapability(ADDR)

    expect(cap.requiresToken).toBe(false)
    expect(cap.version).toBe('0.1.1-rc.2')
  })

  it('探测抛错 → 返回未知（null），让网关保守拒绝而不是误放行', async () => {
    vi.spyOn(dockerService, 'imageCapability').mockRejectedValue(new Error('docker 挂了'))

    const cap = await userService.resolveTenantCapability(ADDR)

    expect(cap.requiresToken).toBeNull()
    expect(cap.version).toBeNull()
  })

  it('查当前镜像 ID 失败 → 退回探测路径（不因此报未知）', async () => {
    userService.state.swtcUsers[ADDR] = {
      requiresToken: true,
      baseImageVersion: '0.1.5-rc.1',
      imageId: 'sha256:aaa',
    }
    vi.spyOn(dockerService, 'imageId').mockRejectedValue(new Error('inspect 失败'))
    vi.spyOn(dockerService, 'imageCapability').mockResolvedValue({
      version: '0.1.1-rc.2',
      requiresToken: false,
    })

    const cap = await userService.resolveTenantCapability(ADDR)

    expect(cap.requiresToken).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 网关按能力分岔
// ---------------------------------------------------------------------------

describe('租户网关：按 DSH 版本能力分岔', () => {
  let publicPort
  /** 端口池：同一文件内多个网关用例各自独占，避免 TIME_WAIT 复用 */
  let internalPort = 39800
  const OLD_CAP = { requiresToken: false, version: '0.1.1-rc.2' }
  const NEW_CAP = { requiresToken: true, version: '0.1.5-rc.1', tokenAuthSince: '0.1.2-alpha.2' }

  const sessionCookie = () => {
    const token = userSessionStore.create(OWNER, 3600_000)
    return `user_session=${token}`
  }

  /** 起一个真的在监听的上游，用于"放行 → 转发成功"的用例 */
  async function startUpstream() {
    const up = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('upstream-ok')
    })
    await new Promise((r) => up.listen(internalPort, '127.0.0.1', r))
    return up
  }

  beforeEach(() => {
    publicPort = 39500 + Math.floor(Math.random() * 300)
  })

  afterEach(() => {
    tenantGateway.closeAll()
    vi.restoreAllMocks()
  })

  async function request(cap) {
    await tenantGateway.listen(publicPort, internalPort, OWNER, cap)
    const res = await fetch(`http://127.0.0.1:${publicPort}/`, {
      headers: { cookie: `${sessionCookie()}; gw_ok=1`, accept: 'text/html' },
    })
    const body = await res.text()
    return { status: res.status, body }
  }

  it('老版本（requiresToken:false）→ 放行转发', async () => {
    const up = await startUpstream()
    try {
      const { status, body } = await request(OLD_CAP)
      expect(status).toBe(200)
      expect(body).toBe('upstream-ok')
    } finally {
      up.close()
    }
  })

  it('新版本 → 平台代做激活，并把 dsh-auth cookie 注入转发', async () => {
    // 端到端：假容器端点要求 dsh-auth cookie，没带就 401（和真 DSH 一样）。
    // 网关应当自己激活并注入，用户侧完全无感。
    const TOKEN = 'TOKEN_abc123'
    let sawCookie = null
    const up = createServer((req, res) => {
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/' && url.searchParams.get('token') === TOKEN) {
        // 模拟 DSH 的激活响应：303 + set-cookie，authority 绑定请求的 Host
        res.writeHead(303, {
          location: '/',
          'set-cookie': 'dsh-auth-FAKEHASH=v1.payload.sig; Max-Age=2592000; Path=/; HttpOnly',
        })
        res.end()
        return
      }
      sawCookie = req.headers.cookie || ''
      if (!sawCookie.includes('dsh-auth-')) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('dsh web authentication required; reopen the URL printed by dsh web.')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('upstream-ok-authenticated')
    })
    await new Promise((r) => up.listen(internalPort, '127.0.0.1', r))

    // token 只存在于容器日志里 → mock docker logs 的输出
    dshAuth.setTokenReader(async () => TOKEN)
    authCookieCache.clear()

    try {
      const { status, body } = await request(NEW_CAP)

      expect(status).toBe(200)
      expect(body).toBe('upstream-ok-authenticated')
      // 注入的 cookie 与浏览器原有 cookie 并存
      expect(sawCookie).toMatch(/dsh-auth-FAKEHASH=/)
      expect(sawCookie).toMatch(/gw_ok=1/)
    } finally {
      up.close()
      authCookieCache.clear()
      dshAuth.setTokenReader(null)
    }
  })

  it('激活失败（容器刚重启、token 还没打印）→ 503 提示稍后重试', async () => {
    dshAuth.setTokenReader(async () => null)
    authCookieCache.clear()

    try {
      const { status, body } = await request(NEW_CAP)

      expect(status).toBe(503)
      const parsed = JSON.parse(body)
      expect(parsed.code).toBe('DSH_ACTIVATION_FAILED')
      expect(parsed.error).toMatch(/稍后重试/)
      // 必须说清怎么排查，而不是让管理员干瞪眼
      expect(parsed.error).toMatch(/dsh web: http/)
    } finally {
      authCookieCache.clear()
      dshAuth.setTokenReader(null)
    }
  })

  it('缓存必须按 authority 区分：不同 Host 各自持有一份 cookie，且同 Host 命中缓存', async () => {
    // 实测踩过的坑：缓存曾只按 publicPort 存，而 DSH 的 cookie 把 authority
    // 写进签名、校验时要求与请求 Host 一致。两个 Host（公网 / 回环）轮流访问
    // 时复用了对方的 cookie → 交替 200/401，用户随机看到
    //   "dsh web authentication required; reopen the URL printed by dsh web."
    // 两种 authority 的 cookie 本可共存，缓存必须分开存。
    //
    // 这里直接测缓存（不经网关的导航校验层），把"缓存是否串键"与
    // "网关其它门禁"解耦。
    let activations = 0
    const up = createServer((req, res) => {
      const host = req.headers.host
      const url = new URL(req.url, 'http://x')
      if (url.searchParams.get('token')) {
        activations++
        // 模拟 DSH：签发的 cookie 名字与值都绑定 authority
        res.writeHead(303, {
          location: '/',
          'set-cookie': `dsh-auth-${host}=${host}; Max-Age=2592000; Path=/`,
        })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise((r) => up.listen(internalPort, '127.0.0.1', r))
    dshAuth.setTokenReader(async () => 'TOKEN_multi')
    authCookieCache.clear()

    const opts = (host) => ({ internalPort, host, containerName: `dsh-swtc-${OWNER}` })
    const HOST_A = '192.168.1.9:31016'
    const HOST_B = '127.0.0.1:31016'

    try {
      const a1 = await authCookieCache.get(publicPort, opts(HOST_A))
      const b1 = await authCookieCache.get(publicPort, opts(HOST_B))

      // ① 两份 cookie 必须不同 —— 各自绑定自己的 authority
      expect(a1).toContain(`dsh-auth-${HOST_A}=${HOST_A}`)
      expect(b1).toContain(`dsh-auth-${HOST_B}=${HOST_B}`)
      expect(a1).not.toBe(b1)
      // ② 各激活一次，不能互相顶掉
      expect(activations).toBe(2)

      // ③ 回头再取 A：必须命中缓存（不重复激活），且仍是 A 自己的 cookie
      const a2 = await authCookieCache.get(publicPort, opts(HOST_A))
      expect(a2).toBe(a1)
      expect(activations).toBe(2)

      // ④ peek 也要按 authority 区分（user.service 的空闲检测用它取）
      expect(authCookieCache.peek(publicPort, HOST_A)).toBe(a1)
      expect(authCookieCache.peek(publicPort, HOST_B)).toBe(b1)
      expect(authCookieCache.peek(publicPort, '10.0.0.1:9999')).toBeNull()
    } finally {
      up.close()
      authCookieCache.clear()
      dshAuth.setTokenReader(null)
    }
  })

  it('激活结果被缓存：同一容器只激活一次（cookie 30 天有效）', async () => {
    const TOKEN = 'TOKEN_cache'
    const up = createServer((req, res) => {
      const url = new URL(req.url, 'http://x')
      if (url.searchParams.get('token') === TOKEN) {
        res.writeHead(303, {
          location: '/',
          'set-cookie': 'dsh-auth-CACHED=v1.p.s; Max-Age=2592000; Path=/',
        })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise((r) => up.listen(internalPort, '127.0.0.1', r))
    let reads = 0
    dshAuth.setTokenReader(async () => {
      reads++
      return TOKEN
    })
    authCookieCache.clear()

    try {
      await request(NEW_CAP)
      const afterFirst = reads
      await request(NEW_CAP)
      expect(reads).toBe(afterFirst)
    } finally {
      up.close()
      authCookieCache.clear()
      dshAuth.setTokenReader(null)
    }
  })

  it('能力未知（null）→ 保守拒绝，绝不当作老版本放行', async () => {
    // 这是最关键的一条：把"未知"当"可直通"会让新镜像静默坏掉
    const { status, body } = await request(null)

    expect(status).toBe(503)
    expect(JSON.parse(body).code).toBe('DSH_AUTH_REQUIRED')
  })

  it('新版本 + 激活失败时，WebSocket 升级通道也拒绝（不能只挡 HTTP）', async () => {
    dshAuth.setTokenReader(async () => null)
    authCookieCache.clear()
    await tenantGateway.listen(publicPort, internalPort, OWNER, NEW_CAP)

    const outcome = await new Promise((resolve) => {
      const sock = netConnect(publicPort, '127.0.0.1', () => {
        sock.write(
          'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `cookie: ${sessionCookie()}\r\n\r\n`,
        )
      })
      let data = ''
      sock.on('data', (d) => {
        data += d.toString()
      })
      sock.on('close', () => resolve(data))
      sock.on('error', () => resolve(data))
    })
    authCookieCache.clear()

    // 否则前端会拿到"连上又被踢"的长连接，报错比 HTTP 更难排查
    expect(outcome).toMatch(/503/)
  })

  it('能力快照随 listen 更新（换镜像重建路由后判定随之改变）', async () => {
    await tenantGateway.listen(publicPort, internalPort, OWNER, NEW_CAP)
    expect(tenantGateway.capabilityOf(publicPort)?.requiresToken).toBe(true)

    // 同端口重新 listen（重建容器/换镜像场景）→ 能力必须被替换
    await tenantGateway.listen(publicPort, internalPort, OWNER, OLD_CAP)
    expect(tenantGateway.capabilityOf(publicPort)?.requiresToken).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 拒绝信息必须区分两种"进不去"——它们要完全不同的处置
  // -------------------------------------------------------------------------
  // 拒绝信息的措辞：直接测 _rejectTokenAuthRequired（HTTP 路径上它只在
  // "代激活失败"或"能力未知"时才会走到，措辞本身仍需单独保证正确）
  function rejectBody(cap) {
    let payload = null
    const fakeRes = {
      writeHead: () => {},
      end: (s) => {
        payload = JSON.parse(s)
      },
    }
    tenantGateway._rejectTokenAuthRequired(fakeRes, cap, {})
    return payload
  }

  it('容器落后但平台镜像是可用的 → 提示重建容器，而不是回退镜像', () => {
    // 实测踩过的坑：容器跑着可用的 0.1.1-rc.2，平台镜像已切到 0.1.5-rc.1。
    // 修复前会声称"该容器使用的 DSH 0.1.5-rc.1"并叫人回退镜像 ——
    // 既拦错了本来能进的容器，报出的版本也是假的。
    const parsed = rejectBody({
      requiresToken: true,
      version: '0.1.5-rc.1',
      platformVersion: '0.1.1-rc.2',
    })

    expect(parsed.code).toBe('DSH_CONTAINER_STALE')
    expect(parsed.dshVersion).toBe('0.1.5-rc.1')
    expect(parsed.platformDshVersion).toBe('0.1.1-rc.2')
    expect(parsed.error).toMatch(/重建该租户容器/) // 正确处置
    expect(parsed.error).toMatch(/数据卷会保留/)
  })

  it('平台镜像本身也要认证 → 提示回退镜像', () => {
    const parsed = rejectBody({
      requiresToken: true,
      version: '0.1.5-rc.1',
      platformVersion: '0.1.5-rc.1', // 容器与平台一致，都是要认证的版本
    })
    expect(parsed.code).toBe('DSH_AUTH_REQUIRED')
    expect(parsed.error).toMatch(/回退到 ≤ 0\.1\.1-rc\.2/)
  })

  it('激活失败 → 单独的错误码与排查指引', () => {
    let payload = null
    const fakeRes = {
      writeHead: () => {},
      end: (s) => {
        payload = JSON.parse(s)
      },
    }
    tenantGateway._rejectTokenAuthRequired(
      fakeRes,
      { requiresToken: true, version: '0.1.5-rc.1' },
      { activateFailed: true },
    )
    expect(payload.code).toBe('DSH_ACTIVATION_FAILED')
    expect(payload.error).toMatch(/dsh web: http/)
  })

  it('未知端口 → capabilityOf 返回 null', () => {
    expect(tenantGateway.capabilityOf(49999)).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // 回归：浏览器残留的旧 dsh-auth cookie 不得覆盖平台代激活的新 cookie
  //
  // 现场：用户报 "dsh web authentication required; reopen the URL printed by
  // dsh web."。根因是 forward() 里 `if (authCookie && !hasAuthCookie(...))`
  // 只看前缀 —— 浏览器旧 cookie 在，就跳过注入，把**失效**的那份原样转发，
  // DSH 因签名不匹配回 401（正文正是上面那句）。WS 升级通道同病，且会 push
  // 出第二行 `cookie:` 让容器自行挑选。
  // ---------------------------------------------------------------------------
  describe('dsh-auth cookie 必须以平台为准（回归）', () => {
    // 共享一个上游实例：端口 39800 在同一文件内反复 listen/close 会因 TIME_WAIT
    // 出现"绑得上但不服务"的假象（实测：第二个用例 seen 为空）
    let sharedUp = null
    let sharedSeen = []
    beforeEach(async () => {
      internalPort += 1 // 每次换端口：反复 listen/close 同一端口会"绑得上但不服务"
      // 缓存/挑战是模块级单例，跨用例必须清干净（否则会跳过激活 → 503）
      authCookieCache.clear()
      // 真实 readToken 要跑 `docker logs`，测试里拿不到 → 注入假 token。
      // 上游见到 ?token= 会下发 dsh-auth-HASH=PLATFORM_COOKIE，正好用作平台那份。
      dshAuth.setTokenReader(async () => 'PLATFORM_COOKIE')
      sharedSeen = []
      sharedUp = createServer((req, res) => {
        const url = new URL(req.url, 'http://x')
        if (url.searchParams.has('token')) {
          res.writeHead(303, {
            location: '/',
            'set-cookie': 'dsh-auth-HASH=PLATFORM_COOKIE; Max-Age=2592000; Path=/',
          })
          res.end()
          return
        }
        sharedSeen.push(String(req.headers.cookie || ''))
        const jar = {}
        for (const part of String(req.headers.cookie || '').split(';')) {
          const i = part.indexOf('=')
          if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim()
        }
        const authKey = Object.keys(jar).find((k) => k.startsWith('dsh-auth-'))
        if (authKey && jar[authKey] === 'PLATFORM_COOKIE') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('upstream-ok')
          return
        }
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('dsh web authentication required; reopen the URL printed by dsh web.')
      })
      await new Promise((r) => sharedUp.listen(internalPort, '127.0.0.1', r))
    })
    afterEach(async () => {
      if (sharedUp) await new Promise((r) => sharedUp.close(r))
      sharedUp = null
    })

    it('旧行为（legacy：有 dsh-auth 就跳过注入）会把失效 cookie 转发 → 401', async () => {
      try {
        // 上游既当激活目标（返回 dsh-auth-HASH=PLATFORM_COOKIE）又当转发目标
        await tenantGateway.listen(publicPort, internalPort, OWNER, NEW_CAP)
        _setDshAuthCookieModeForTest('legacy')
        const res = await fetch(`http://127.0.0.1:${publicPort}/`, {
          headers: {
            cookie: `${sessionCookie()}; gw_ok=1; dsh-auth-STALE=v1.broken.sig`,
            accept: 'text/html',
          },
        })
        expect(res.status).toBe(401)
        expect(await res.text()).toMatch(/authentication required/)
      } finally {
        _setDshAuthCookieModeForTest('replace')
        authCookieCache.clear()
        dshAuth.setTokenReader(null)
      }
    })

    it('新行为：失效 cookie 被剔除，平台那份生效 → 200，且平台 cookie 保留', async () => {
      try {
        await tenantGateway.listen(publicPort, internalPort, OWNER, NEW_CAP)
        _setDshAuthCookieModeForTest('replace')
        const res = await fetch(`http://127.0.0.1:${publicPort}/`, {
          headers: {
            cookie: `${sessionCookie()}; gw_ok=1; dsh-auth-STALE=v1.broken.sig`,
            accept: 'text/html',
          },
        })
        expect(res.status).toBe(200)
        const body = await res.text()
        expect(body).toBe('upstream-ok')
        const forwarded = sharedSeen[sharedSeen.length - 1]
        expect(forwarded).toContain('dsh-auth-')
        expect(forwarded).toContain('PLATFORM_COOKIE')
        // 失效的那份必须消失（不能与新的并存）
        expect(forwarded).not.toContain('v1.broken.sig')
        // 平台自己的 cookie 不能被一起清掉
        expect(forwarded).toContain('user_session=')
        expect(forwarded).toContain('gw_ok=1')
      } finally {
        authCookieCache.clear()
        dshAuth.setTokenReader(null)
      }
    })
  })
})
