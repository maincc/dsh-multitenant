/**
 * waitReady 就绪探测测试
 *
 * 探测的是容器**内部回环端口**，即直接打 DSH、不经过租户网关。
 *
 * 这里有两个真实故障，判据必须同时满足，改动前请先读完：
 *
 * ① 「一直卡在正在建立容器连接…」（太严的判据）
 *    早期实现只认 `res.ok`（2xx）。但 DSH 对未认证请求稳定返回 401，
 *    于是一个 1 秒内就健康的容器被判"未就绪"，死等满 startupTimeoutMs(120s)
 *    后回滚销毁。→ 401/403 必须算就绪。
 *
 * ② 「刚启动时第一次点进入没进去，第二三次才进去」（太松的判据）
 *    之后改成 `res.status > 0`（任何状态码都算）。实测冷启动状态序列是
 *      +0.1s 连接被拒 → +32.6s 404 → +33.2s 401
 *    404 是"进程已监听但 web 接口还没挂载"。在 32.6s 放行会让 /connect 立刻
 *    返回 URL，浏览器正好撞进那 0.6s 的 404 窗口。→ 404/5xx 必须继续等。
 *
 * 结论：就绪 = web 接口能服务 = 2xx/3xx 或 401/403；404 与 5xx 不算。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { dockerService } from '../src/services/docker.service.js'

/** 构造一个只返回状态码的 fetch 响应 */
const resp = (status) => ({ status, ok: status >= 200 && status < 300 })

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('waitReady：web 接口就绪的状态码 → true', () => {
  it('401（DSH 认证挑战）→ 就绪 —— "卡 120 秒"故障的核心回归', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(resp(401))

    await expect(dockerService.waitReady(49999, 5000)).resolves.toBe(true)
  })

  it.each([200, 204, 301, 302, 401, 403])('状态码 %i → 就绪', async (status) => {
    globalThis.fetch = vi.fn().mockResolvedValue(resp(status))

    await expect(dockerService.waitReady(49999, 5000)).resolves.toBe(true)
  })

  it('探测的就是内部回环端口 /（不经过网关，所以会拿到 401）', async () => {
    const f = vi.fn().mockResolvedValue(resp(401))
    globalThis.fetch = f

    await dockerService.waitReady(49707, 5000)

    expect(f).toHaveBeenCalledWith('http://127.0.0.1:49707/')
  })
})

describe('waitReady：web 接口还没挂载 → 不算就绪（第一次进不去的回归）', () => {
  it.each([404, 500, 502, 503])(
    '状态码 %i → 继续等，超时后 false（不能放行一个 web 未挂载的容器）',
    async (status) => {
      globalThis.fetch = vi.fn().mockResolvedValue(resp(status))

      await expect(dockerService.waitReady(49999, 1200)).resolves.toBe(false)
    },
  )

  it('真实冷启动序列：拒 → 404 → 401，必须在 401 才放行（而不是 404）', async () => {
    const seq = [
      Promise.reject(new Error('ECONNREFUSED')),
      Promise.resolve(resp(404)), // 端口通了，但 webserver/web-runtime 还没挂载
      Promise.resolve(resp(404)),
      Promise.resolve(resp(401)), // DSH web 真正就绪
    ]
    let i = 0
    const f = vi.fn().mockImplementation(() => seq[Math.min(i++, seq.length - 1)])
    globalThis.fetch = f

    await expect(dockerService.waitReady(49999, 10_000)).resolves.toBe(true)
    // 前三次（拒、404、404）都不能放行，第 4 次 401 才 true
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('若 404 一直不消失 → false（宁可不放行，也不给用户一个 404 页面）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(resp(404))

    await expect(dockerService.waitReady(49999, 1100)).resolves.toBe(false)
  })
})

describe('waitReady：连不上才是未就绪', () => {
  it('一直 connection refused → false（并尊重超时）', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const t0 = Date.now()
    const ok = await dockerService.waitReady(59998, 1200)

    expect(ok).toBe(false)
    // 必须在超时附近返回，不能无限循环
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('先拒后通 → true（容器起来的过程中要能等到）', async () => {
    let n = 0
    globalThis.fetch = vi.fn().mockImplementation(() => {
      n += 1
      return n < 3 ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(resp(401))
    })

    await expect(dockerService.waitReady(49999, 5000)).resolves.toBe(true)
    expect(n).toBeGreaterThanOrEqual(3)
  })

  it('超时为 0 时立即返回 false（不空转）', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(dockerService.waitReady(59998, 0)).resolves.toBe(false)
  })
})
