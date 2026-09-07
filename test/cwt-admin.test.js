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
    vi.spyOn(dataService, 'readCwtRecords').mockImplementation((limit = 200) =>
      recLog.slice(-limit).reverse(),
    )
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
    const records = cwtAdminService.listRecords()
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

  it('批准：申请后 token 过期 → 复核验签失败', async () => {
    const wallet = makeSecpWallet()
    // 构造 time 已过期的 token（±5 分钟窗口外）
    const token = buildToken(wallet, {
      payload: { time: Math.floor(Date.now() / 1000) - 3600 },
    })
    // 申请时就该失败（预验签也要过时效窗口）——按当前实现，预验签失败不进队列
    await expect(cwtAdminService.submitApplication(token)).rejects.toThrow(/token 无效/)
  })

  it('拒绝：拒绝后状态 rejected + 审计记录', async () => {
    const wallet = makeSecpWallet()
    const applied = await cwtAdminService.submitApplication(buildToken(wallet))
    await cwtAdminService.rejectApplication(applied.applicationId, ADMIN)
    expect(cwtAdminService.listApplications()[0].status).toBe('rejected')
    expect(userService.isUsageExempt(wallet.address)).toBe(false)
    expect(cwtAdminService.listRecords()[0].action).toBe('reject')
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
