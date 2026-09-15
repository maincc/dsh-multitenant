/**
 * CWT 申请-审批-出示（M0）单元测试
 *
 * 覆盖：申请（预验签/查重）→ 审批（复核验签/注册表/豁免标记）→ 撤销（回到受限）
 *       + 出示验证 verifyForAccess（注册表判定/撤销/时效）
 * 生成 token 的 helper 与 cwt.test.js 同源（node crypto 自签，不依赖外部 cwt-lib）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createHash, createPublicKey, createSign, generateKeyPairSync, sign } from 'node:crypto'
import { Keypairs } from '@swtc/keypairs'
import { cwtService } from '../src/services/cwt.service.js'
import { cwtAdminService } from '../src/services/cwt-admin.service.js'
import { userService } from '../src/services/user.service.js'
import { dataService } from '../src/services/data.service.js'
import { cwtStore } from '../src/services/cwt.store.js'

const b64url = (v) => Buffer.from(v).toString('base64url')

function compressedHexFromJwk(jwk) {
  const x = Buffer.from(jwk.x, 'base64url')
  const y = Buffer.from(jwk.y, 'base64url')
  return `${y[y.length - 1] % 2 === 0 ? '02' : '03'}${x.toString('hex')}`
}

function makeSecpWallet() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
  const pem = publicKey.export({ type: 'spki', format: 'pem' })
  const pubHex = compressedHexFromJwk(createPublicKey(pem).export({ format: 'jwk' }))
  return {
    publicPem: pem,
    pubHex,
    address: Keypairs.deriveAddress(pubHex).toLowerCase(),
    alg: 'secp256k1',
    sign: (input) => createSign('sha256').update(input).sign(privateKey).toString('base64url'),
  }
}

function buildToken(wallet, overrides = {}) {
  const { header = {}, payload = {}, sig } = overrides
  const h = {
    x5c: [wallet.publicPem],
    type: 'CWT',
    chain: 'jingtum',
    alg: wallet.alg ?? 'secp256k1',
    ...header,
  }
  const p = { usr: 'alice', time: Math.floor(Date.now() / 1000), ...payload }
  const h64 = b64url(JSON.stringify(h))
  const p64 = b64url(JSON.stringify(p))
  const signature = sig ?? wallet.sign(`${h64}.${p64}`)
  return `${h64}.${p64}.${signature}`
}

function tamperPayload(token) {
  const [h, p, s] = token.split('.')
  const parsed = JSON.parse(
    Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
  )
  return `${h}.${b64url(JSON.stringify({ ...parsed, usr: 'mallory' }))}.${s}`
}

const ADMIN = 'jndwretndumoqbt2uauclmfmx7xbqjykva'

describe('CWT 申请-审批-出示（M0）', () => {
  // 审计记录走内存链（mock 掉落盘，避免污染真实 data/cwt/records.log）
  let recLog = []

  beforeEach(() => {
    cwtStore.registry = {}
    cwtStore.applications = []
    recLog = []
    vi.spyOn(dataService, 'saveState').mockImplementation(() => {})
    vi.spyOn(dataService, 'saveCwtRegistry').mockImplementation(() => {})
    vi.spyOn(dataService, 'saveCwtApplications').mockImplementation(() => {})
    vi.spyOn(dataService, 'appendCwtRecord').mockImplementation((r) => recLog.push(r))
    // 与 readCwtRecords 新契约一致：{ records, hasMore }（新 → 旧，支持 offset 分页）
    vi.spyOn(dataService, 'readCwtRecords').mockImplementation((limit = 10, offset = 0) => {
      const newestFirst = recLog.slice().reverse()
      return {
        records: newestFirst.slice(offset, offset + limit),
        hasMore: newestFirst.length > offset + limit,
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cwtStore.registry = {}
    cwtStore.applications = []
    delete userService.state.swtcUsers?.['jndwretndumoqbt2uauclmfmx7xbqjykva']
  })

  it('完整闭环：申请 → 待审批 → 批准 → 注册表/豁免 → 撤销 → 恢复受限', async () => {
    const wallet = makeSecpWallet()
    const token = buildToken(wallet)

    // ① 申请
    const applied = await cwtAdminService.submitApplication(token)
    expect(applied.ok).toBe(true)
    expect(applied.parsed.address).toBe(wallet.address)
    expect(applied.parsed.alg).toBe('secp256k1')
    expect(applied.parsed.usr).toBe('alice')

    // 队列：pending + sigOk
    const apps = cwtAdminService.listApplications()
    expect(apps).toHaveLength(1)
    expect(apps[0].status).toBe('pending')
    expect(apps[0].sigOk).toBe(true)
    expect(apps[0].parsed.address).toBe(wallet.address)

    // 申请后尚未豁免
    expect(userService.isUsageExempt(wallet.address)).toBe(false)

    // ② 批准（复核验签）
    const approved = await cwtAdminService.approveApplication(applied.applicationId, ADMIN)
    expect(approved.address).toBe(wallet.address)

    // 注册表入库 + 已授权
    const entry = cwtStore.getRegistry()[wallet.address]
    expect(entry.status).toBe('approved')
    expect(entry.usr).toBe('alice')
    expect(entry.wallet).toBe(wallet.address)
    expect(entry.approvedBy).toBe(ADMIN)
    expect(userService.isUsageExempt(wallet.address)).toBe(true)

    // 状态查询
    const status = cwtAdminService.getStatus(wallet.address)
    expect(status.authorized).toBe(true)
    expect(status.exempt).toBe(true)
    expect(status.registry.status).toBe('approved')

    // ③ 出示验证通过
    const verify = await cwtService.verifyForAccess(token, {
      registry: cwtStore.getRegistry(),
    })
    expect(verify.valid).toBe(true)
    expect(verify.authorized).toBe(true)

    // ④ 撤销 → 恢复受限
    await cwtAdminService.revokeRegistry(wallet.address, ADMIN)
    expect(cwtStore.getRegistry()[wallet.address].status).toBe('revoked')
    expect(userService.isUsageExempt(wallet.address)).toBe(false)
    const statusAfter = cwtAdminService.getStatus(wallet.address)
    expect(statusAfter.authorized).toBe(false)
    expect(statusAfter.exempt).toBe(false)

    // 撤销后出示验证拒绝
    const verifyAfter = await cwtService.verifyForAccess(token, {
      registry: cwtStore.getRegistry(),
    })
    expect(verifyAfter.valid).toBe(false)

    // 审计链：approve + revoke
    const { records } = cwtAdminService.listRecords()
    expect(records.map((r) => r.action)).toEqual(['revoke', 'approve'])
    expect(records[1].token).toBe(token) // token 原文存档
    expect(records[1].by).toBe(ADMIN)
  })

  it('申请：无效 token（篡改 payload）被拒绝，不进队列', async () => {
    const wallet = makeSecpWallet()
    const bad = tamperPayload(buildToken(wallet))
    await expect(cwtAdminService.submitApplication(bad)).rejects.toThrow(/token 无效/)
    expect(cwtAdminService.listApplications()).toHaveLength(0)
  })

  it('申请：缺少 token 被拒绝', async () => {
    await expect(cwtAdminService.submitApplication('not-a-token')).rejects.toThrow(/token/)
  })

  it('申请：已授权地址重复申请 → 冲突', async () => {
    const wallet = makeSecpWallet()
    const token = buildToken(wallet)
    await cwtAdminService.submitApplication(token)
    await cwtAdminService.approveApplication(cwtAdminService.listApplications()[0].id, ADMIN)
    await expect(cwtAdminService.submitApplication(buildToken(wallet))).rejects.toThrow(
      /已通过 CWT 授权/,
    )
  })

  it('申请：已存在待审批 → 冲突（不重复入队）', async () => {
    const wallet = makeSecpWallet()
    await cwtAdminService.submitApplication(buildToken(wallet))
    await expect(cwtAdminService.submitApplication(buildToken(wallet))).rejects.toThrow(/待审批/)
    expect(cwtAdminService.listApplications()).toHaveLength(1)
  })

  it('批准：不存在的申请 → 404', async () => {
    await expect(cwtAdminService.approveApplication('nope', ADMIN)).rejects.toThrow(/申请不存在/)
  })

  it('批准：非 pending 状态不可重复批准', async () => {
    const wallet = makeSecpWallet()
    const token = buildToken(wallet)
    const applied = await cwtAdminService.submitApplication(token)
    await cwtAdminService.approveApplication(applied.applicationId, ADMIN)
    await expect(cwtAdminService.approveApplication(applied.applicationId, ADMIN)).rejects.toThrow(
      /不能批准/,
    )
  })

  it('提交申请：token 已过期（超 5 分钟窗口）→ 预验签拒绝', async () => {
    const wallet = makeSecpWallet()
    // 构造 time 已过期的 token（±5 分钟窗口外）
    const token = buildToken(wallet, {
      payload: { time: Math.floor(Date.now() / 1000) - 3600 },
    })
    // 过期 token 进不了待审批队列（申请环节仍校验新鲜度）
    await expect(cwtAdminService.submitApplication(token)).rejects.toThrow(/token 无效/)
  })

  it('批准：申请时有效、审批时已过期 → 仍可批准（审批不校验时效）', async () => {
    // 只伪造 Date，不影响 setTimeout/Promise 调度
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const wallet = makeSecpWallet()
      const t0 = Date.now()
      vi.setSystemTime(t0)

      // 申请：time = t0，处于新鲜度窗口内 → 入队成功
      const applied = await cwtAdminService.submitApplication(buildToken(wallet))

      // 时间前进 1 小时（远超 5 分钟 TTL）——人工审批延迟不应导致失败
      vi.setSystemTime(t0 + 3600_000)
      const res = await cwtAdminService.approveApplication(applied.applicationId, ADMIN)

      expect(res.ok).toBe(true)
      expect(res.address).toBe(wallet.address)
      // 批准即豁免（注册表无时效）
      expect(userService.isUsageExempt(wallet.address)).toBe(true)
      expect(cwtAdminService.listRecords().records[0].action).toBe('approve')
    } finally {
      vi.useRealTimers()
    }
  })

  it('批准：token 被篡改（签名无效）→ 复核失败，不写注册表', async () => {
    const wallet = makeSecpWallet()
    const applied = await cwtAdminService.submitApplication(buildToken(wallet))

    // 直接篡改队列中的 token（模拟 applications.json 被改动）：
    // 审批跳过时效但必须仍校验签名
    const app = cwtStore.getApplications().find((a) => a.id === applied.applicationId)
    app.token = tamperPayload(app.token)

    await expect(cwtAdminService.approveApplication(applied.applicationId, ADMIN)).rejects.toThrow(
      /复核验签失败/,
    )
    expect(cwtAdminService.getStatus(wallet.address).authorized).toBe(false)
  })

  it('拒绝：拒绝后状态 rejected + 审计记录', async () => {
    const wallet = makeSecpWallet()
    const applied = await cwtAdminService.submitApplication(buildToken(wallet))
    await cwtAdminService.rejectApplication(applied.applicationId, ADMIN)
    expect(cwtAdminService.listApplications()[0].status).toBe('rejected')
    expect(userService.isUsageExempt(wallet.address)).toBe(false)
    expect(cwtAdminService.listRecords().records[0].action).toBe('reject')
  })

  it('出示验证：未注册地址 → 拒绝', async () => {
    const wallet = makeSecpWallet()
    const r = await cwtService.verifyForAccess(buildToken(wallet), {
      registry: cwtStore.getRegistry(),
    })
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/注册表/)
  })

  it('出示验证：expectedAddress 不匹配 → 拒验', async () => {
    const wallet = makeSecpWallet()
    const token = buildToken(wallet)
    cwtStore.getRegistry()[wallet.address] = {
      usr: 'alice',
      wallet: wallet.address,
      status: 'approved',
    }
    const r = await cwtService.verifyForAccess(token, {
      registry: cwtStore.getRegistry(),
      expectedAddress: 'jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj',
    })
    expect(r.valid).toBe(false)
  })
})

describe('CWT 申请列表：后端分页与状态筛选', () => {
  const mkApp = (id, status) => ({ id, status, submittedAt: Number(id), parsed: { usr: 'u' } })

  beforeEach(() => {
    cwtStore.applications = []
    vi.spyOn(dataService, 'saveCwtApplications').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cwtStore.applications = []
  })

  it('默认返回全部（limit 默认 50、offset 0），倒序排列', () => {
    cwtStore.applications = [mkApp('1', 'pending'), mkApp('2', 'approved'), mkApp('3', 'rejected')]
    const { items, total } = cwtAdminService.queryApplications()
    expect(total).toBe(3)
    expect(items.map((a) => a.id)).toEqual(['3', '2', '1']) // 最新在前
  })

  it('limit/offset 切片正确，total 为筛选后的总数', () => {
    cwtStore.applications = ['1', '2', '3', '4', '5'].map((i) => mkApp(i, 'pending'))

    const page1 = cwtAdminService.queryApplications({ limit: 2, offset: 0 })
    expect(page1.items.map((a) => a.id)).toEqual(['5', '4'])
    expect(page1.total).toBe(5)

    const page2 = cwtAdminService.queryApplications({ limit: 2, offset: 2 })
    expect(page2.items.map((a) => a.id)).toEqual(['3', '2'])

    const page3 = cwtAdminService.queryApplications({ limit: 2, offset: 4 })
    expect(page3.items.map((a) => a.id)).toEqual(['1'])
    expect(page3.total).toBe(5)
  })

  it('offset 超出范围 → 空数组（前端据此回退上一页）', () => {
    cwtStore.applications = [mkApp('1', 'pending')]
    const { items, total } = cwtAdminService.queryApplications({ limit: 10, offset: 50 })
    expect(items).toEqual([])
    expect(total).toBe(1)
  })

  it('status 筛选：只返回该状态，total 同步收敛', () => {
    cwtStore.applications = [
      mkApp('1', 'pending'),
      mkApp('2', 'approved'),
      mkApp('3', 'pending'),
      mkApp('4', 'rejected'),
    ]

    const pending = cwtAdminService.queryApplications({ status: 'pending' })
    expect(pending.total).toBe(2)
    expect(pending.items.map((a) => a.id)).toEqual(['3', '1'])

    const approved = cwtAdminService.queryApplications({ status: 'approved' })
    expect(approved.total).toBe(1)
    expect(approved.items[0].id).toBe('2')

    // 'all' 与 null 等价（不筛选）
    expect(cwtAdminService.queryApplications({ status: 'all' }).total).toBe(4)
    expect(cwtAdminService.queryApplications({ status: null }).total).toBe(4)
  })

  it('筛选 + 分页组合：pending 的第 2 页', () => {
    cwtStore.applications = [
      mkApp('1', 'pending'),
      mkApp('2', 'approved'),
      mkApp('3', 'pending'),
      mkApp('4', 'pending'),
    ]
    const { items, total } = cwtAdminService.queryApplications({
      status: 'pending',
      limit: 2,
      offset: 2,
    })
    expect(total).toBe(3) // pending 共 3 条
    expect(items.map((a) => a.id)).toEqual(['1'])
  })

  it('空队列 → items 空、total 0', () => {
    const { items, total } = cwtAdminService.queryApplications({ limit: 10 })
    expect(items).toEqual([])
    expect(total).toBe(0)
  })
})

describe('CWT 授权注册表：后端分页', () => {
  const mkEntry = (addr, approvedAt) => ({
    addr,
    entry: { usr: 'u', wallet: addr, status: 'approved', approvedAt },
  })

  beforeEach(() => {
    cwtStore.registry = {}
    vi.spyOn(dataService, 'saveCwtRegistry').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cwtStore.registry = {}
  })

  it('空注册表 → items 空、total 0', () => {
    const { items, total } = cwtAdminService.queryRegistry({ limit: 10 })
    expect(items).toEqual([])
    expect(total).toBe(0)
  })

  it('按批准时间倒序（最新在前），address 字段被展开', () => {
    for (const [addr, at] of [
      ['jaddr1', 1000],
      ['jaddr2', 3000],
      ['jaddr3', 2000],
    ]) {
      const { addr: a, entry } = mkEntry(addr, at)
      cwtStore.registry[a] = entry
    }

    const { items, total } = cwtAdminService.queryRegistry({ limit: 10 })
    expect(total).toBe(3)
    expect(items.map((e) => e.address)).toEqual(['jaddr2', 'jaddr3', 'jaddr1'])
    expect(items[0].status).toBe('approved')
  })

  it('limit/offset 切片正确，total 为注册表总数', () => {
    for (let i = 1; i <= 5; i++) {
      const { addr, entry } = mkEntry(`jaddr${i}`, i * 100)
      cwtStore.registry[addr] = entry
    }

    const p1 = cwtAdminService.queryRegistry({ limit: 2, offset: 0 })
    expect(p1.items.map((e) => e.address)).toEqual(['jaddr5', 'jaddr4'])
    expect(p1.total).toBe(5)

    const p3 = cwtAdminService.queryRegistry({ limit: 2, offset: 4 })
    expect(p3.items.map((e) => e.address)).toEqual(['jaddr1'])
    expect(p3.total).toBe(5)
  })

  it('offset 超出范围 → 空数组（前端据此回退上一页）', () => {
    const { addr, entry } = mkEntry('jaddr1', 1000)
    cwtStore.registry[addr] = entry
    const { items, total } = cwtAdminService.queryRegistry({ limit: 10, offset: 50 })
    expect(items).toEqual([])
    expect(total).toBe(1)
  })

  it('无 approvedAt 的条目排在最后（不破坏排序）', () => {
    cwtStore.registry['jold'] = { usr: 'u', wallet: 'jold', status: 'approved' }
    cwtStore.registry['jnew'] = {
      usr: 'u',
      wallet: 'jnew',
      status: 'approved',
      approvedAt: 5000,
    }

    const { items } = cwtAdminService.queryRegistry({ limit: 10 })
    expect(items.map((e) => e.address)).toEqual(['jnew', 'jold'])
  })

  it('撤销后的条目仍出现在列表中（status 反映当前状态）', () => {
    cwtStore.registry['jrevoked'] = {
      usr: 'u',
      wallet: 'jrevoked',
      status: 'revoked',
      approvedAt: 1000,
      revokedAt: 2000,
    }
    const { items, total } = cwtAdminService.queryRegistry({ limit: 10 })
    expect(total).toBe(1)
    expect(items[0].status).toBe('revoked')
    expect(items[0].revokedAt).toBe(2000)
  })
})
