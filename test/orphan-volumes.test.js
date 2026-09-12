/**
 * 管理端"清理孤儿卷"功能测试
 *
 * 孤儿卷判定：dsh-data-swtc-* 前缀 + 不属于任何 state 用户 + 无任何容器挂载引用。
 * 本测试 mock dockerService，不触碰真实 Docker；mock userService 提供 state 用户。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { adminSessionStore } from '../src/middleware/auth.middleware.js'

const ADMIN_TOKEN = '11'.repeat(32) // 64 位 hex
const sha256 = (v) => createHash('sha256').update(v).digest('hex')

// state 中存在的用户（其卷必须被保护，绝不列为孤儿）
const STATE_ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'
const STATE_VOLUME = `dsh-data-swtc-${STATE_ADDR}`

// vi.hoisted：mock 工厂在文件最顶部执行，普通顶层 const 会晚于它初始化，
// 必须用 vi.hoisted 提供 mock 对象（含 vi.fn 引用）
const { dockerServiceMock } = vi.hoisted(() => ({
  dockerServiceMock: {
    listVolumes: vi.fn(),
    listReferencedVolumes: vi.fn(),
    removeVolume: vi.fn(),
  },
}))

vi.mock('../src/services/docker.service.js', () => ({ dockerService: dockerServiceMock }))

vi.mock('../src/services/user.service.js', () => ({
  userService: {
    state: {
      // 注意：mock 工厂会被提升执行，不能引用文件级常量的运行时值；
      // 这里使用与 STATE_ADDR 相同的字面量
      swtcUsers: { jndwretndumoqbt2uauclmfmx7xbqjykva: { containerStatus: 'running' } },
    },
  },
}))

vi.mock('../src/services/cwt-admin.service.js', () => ({ cwtAdminService: {} }))
vi.mock('../src/services/tenant-config.service.js', () => ({ tenantConfigService: {} }))
vi.mock('../src/services/tenant-proxy.service.js', () => ({
  tenantGateway: { listen: vi.fn(), close: vi.fn() },
}))
vi.mock('../src/config/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAdmin: vi.fn(() => true),
}))
vi.mock('../src/services/data.service.js', async (importOriginal) => {
  const mod = await importOriginal()
  const empty = {
    loadSessions: vi.fn(() => ({})),
    saveSessions: vi.fn(() => {}),
    loadUserSessions: vi.fn(() => ({})),
    saveUserSessions: vi.fn(() => {}),
    loadCwtRegistry: vi.fn(() => ({})),
    loadCwtApplications: vi.fn(() => []),
    readStateFile: vi.fn(() => null),
    saveState: vi.fn(() => {}),
  }
  return { dataService: { ...mod.dataService, ...empty } }
})

import { handleAdminRoutes } from '../src/routes/admin.routes.js'
import { dockerService } from '../src/services/docker.service.js'
import { normalizeAddress } from '../src/utils/address.js'

function makeReq({ method = 'GET', url = '/', cookie = '' } = {}) {
  return {
    method,
    url: url + (url.includes('?') ? '' : ''),
    headers: { host: '127.0.0.1:8090', cookie },
    on() {
      return this
    },
  }
}

function makeRes() {
  return {
    headersSent: false,
    status: 0,
    body: '',
    writeHead(code) {
      this.status = code
      this.headersSent = true
    },
    end(payload) {
      this.body = payload || ''
      if (typeof payload === 'string' && payload.startsWith('{')) {
        this.json = JSON.parse(payload)
      }
    },
  }
}

const ROUTES = {
  orphanList: '/api/admin/orphan-volumes',
  orphanCleanup: '/api/admin/cleanup-orphan-volumes',
}

/** 典型卷清单：州用户卷 + 被引用卷 + 真孤儿 + 非租户卷 */
const TYPICAL_VOLUMES = [
  STATE_VOLUME,
  'dsh-data-swtc-referencedvol',
  'dsh-data-swtc-orphan1',
  'dsh-data-swtc-orphan2',
  'dsh-other-volume',
]

beforeEach(() => {
  vi.clearAllMocks()
  adminSessionStore.sessions[sha256(ADMIN_TOKEN)] = {
    address: STATE_ADDR,
    expiresAt: Date.now() + 3600e3,
  }
  dockerServiceMock.listVolumes.mockResolvedValue([...TYPICAL_VOLUMES])
  dockerServiceMock.listReferencedVolumes.mockResolvedValue(
    new Set(['dsh-data-swtc-referencedvol']),
  )
  dockerServiceMock.removeVolume.mockResolvedValue(undefined)
})

describe('管理端孤儿卷管理', () => {
  it('无管理员会话 → 拒绝（非 200）', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: ROUTES.orphanList }),
      res,
      ROUTES.orphanList,
      new URL(`http://x${ROUTES.orphanList}`),
    )
    expect(res.status).not.toBe(200)
    expect(dockerServiceMock.listVolumes).not.toHaveBeenCalled()
  })

  it('GET 列出孤儿卷：只包含「非 state 用户 + 无引用」的 dsh-data-swtc-* 卷', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: ROUTES.orphanList, cookie: `admin_session=${ADMIN_TOKEN}` }),
      res,
      ROUTES.orphanList,
      new URL(`http://x${ROUTES.orphanList}`),
    )
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(res.json.orphanVolumes).toEqual(['dsh-data-swtc-orphan1', 'dsh-data-swtc-orphan2'])
    expect(res.json.total).toBe(2)
    // state 用户卷不在孤儿列表
    expect(res.json.orphanVolumes).not.toContain(STATE_VOLUME)
  })

  it('state 地址大小写归一化后再比对，大写卷名同样受保护', async () => {
    dockerServiceMock.listVolumes.mockResolvedValue([
      `dsh-data-swtc-${normalizeAddress(STATE_ADDR).toUpperCase()}`,
      'dsh-data-swtc-orphan9',
    ])
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({ url: ROUTES.orphanList, cookie: `admin_session=${ADMIN_TOKEN}` }),
      res,
      ROUTES.orphanList,
      new URL(`http://x${ROUTES.orphanList}`),
    )
    expect(res.json.orphanVolumes).toEqual(['dsh-data-swtc-orphan9'])
  })

  it('POST 清理：只删除孤儿卷，state 用户卷与被引用卷不受影响', async () => {
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        url: ROUTES.orphanCleanup,
        method: 'POST',
        cookie: `admin_session=${ADMIN_TOKEN}`,
      }),
      res,
      ROUTES.orphanCleanup,
      new URL(`http://x${ROUTES.orphanCleanup}`),
    )
    expect(res.status).toBe(200)
    expect(res.json.removed).toEqual(['dsh-data-swtc-orphan1', 'dsh-data-swtc-orphan2'])
    expect(res.json.failed).toEqual([])
    // removeVolume 只对孤儿调用
    const removedCalls = dockerServiceMock.removeVolume.mock.calls.map((c) => c[0])
    expect(removedCalls).toEqual(['dsh-data-swtc-orphan1', 'dsh-data-swtc-orphan2'])
    expect(removedCalls).not.toContain(STATE_VOLUME)
    expect(removedCalls).not.toContain('dsh-data-swtc-referencedvol')
  })

  it('POST 清理：删除失败逐个记录，不影响其他卷', async () => {
    dockerServiceMock.removeVolume.mockImplementation((v) => {
      if (v.includes('orphan2')) return Promise.reject(new Error('volume in use'))
      return Promise.resolve()
    })
    const res = makeRes()
    await handleAdminRoutes(
      makeReq({
        url: ROUTES.orphanCleanup,
        method: 'POST',
        cookie: `admin_session=${ADMIN_TOKEN}`,
      }),
      res,
      ROUTES.orphanCleanup,
      new URL(`http://x${ROUTES.orphanCleanup}`),
    )
    expect(res.json.removed).toEqual(['dsh-data-swtc-orphan1'])
    expect(res.json.failed).toEqual([{ name: 'dsh-data-swtc-orphan2', error: 'volume in use' }])
  })
})
