/**
 * v1.4 凭证体系核心测试（2026-10-19）
 *
 * 全部外部件注入：SDK/平台钥/relay fetch/L1 探测/legacy 名单/存储 backend——
 * 不碰真实网络、私钥文件与工作区 data/。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/services/did.service.js', () => ({
  l1ProfileHit: vi.fn(async () => true),
  getSwtcResolver: vi.fn(() => ({})),
}))
import { l1ProfileHit } from '../src/services/did.service.js'
import {
  credentialService,
  _resetForTest,
  _shelfCredentialForTest,
  _mintVCForTest,
  _isPlatformMintedForTest,
  _isDshCardForTest,
  provisionPlatformProfile,
  profilePath,
  KINDS,
} from '../src/services/credential.service.js'
import { CONFIG } from '../src/config/config.js' // 同源 CONFIG 对象：accessGate 模式切换测试用

const ADDR = 'jtestaddr00000000000000000000000000'
const CANON = 'jTestAddr00000000000000000000000000' // 原始大小写形态

/* 内存 backend（对齐 Mongo/Json 双实现的原语面） */
function fakeBackend() {
  const creds = new Map()
  const apps = []
  return {
    creds,
    apps,
    async get(a) {
      return creds.get(a) || null
    },
    async assignIfAbsent(a, doc) {
      if (creds.get(a)) return { assigned: false, doc: creds.get(a) }
      creds.set(a, { _id: a, ...doc })
      return { assigned: true, doc: creds.get(a) }
    },
    async patch(a, $set) {
      const cur = creds.get(a)
      if (!cur) return null
      creds.set(a, { ...cur, ...$set })
      return creds.get(a)
    },
    async grantCwt(a, doc) {
      creds.set(a, { _id: a, ...doc })
      return creds.get(a)
    },
    async putRow(a, doc) {
      creds.set(a, { _id: a, ...doc })
      return creds.get(a)
    },
    async listAdminAddresses() {
      return [...creds.entries()]
        .filter(([, d]) => d.kind === 'cwt' && (d.roles || []).includes('admin'))
        .map(([a, d]) => ({ _id: a, expiresAt: d.expiresAt || null }))
    },
    async listValidRows() {
      return [...creds.entries()]
        .filter(
          ([, d]) =>
            (d.kind === 'did' || d.kind === 'cwt') && ['assigned', 'claimed'].includes(d.state),
        )
        .map(([a, d]) => ({
          _id: a,
          expiresAt: d.expiresAt || null,
          onChain: d.onChain || null,
        }))
    },
    async hasApprovedApp(a) {
      return apps.some((x) => x.address === a && x.status === 'approved')
    },
    async countByKind() {
      const all = [...creds.values()]
      return {
        did: all.filter((d) => d.kind === 'did').length,
        cwt: all.filter((d) => d.kind === 'cwt').length,
      }
    },
    async insertApp(app) {
      apps.unshift(app)
      return app
    },
    async findApp(id) {
      return apps.find((x) => x._id === id) || null
    },
    async patchApp(id, $set) {
      const i = apps.findIndex((x) => x._id === id)
      if (i < 0) return null
      apps[i] = { ...apps[i], ...$set }
      return apps[i]
    },
    async hasPendingApp(a) {
      return apps.some((x) => x.address === a && x.status === 'pending')
    },
    async listApps({ status = 'all', limit = 10, offset = 0 } = {}) {
      let list = apps
      if (status !== 'all') list = list.filter((x) => x.status === status)
      return { items: list.slice(offset, offset + limit), total: list.length }
    },
    async isCwt(a) {
      const d = creds.get(a)
      return Boolean(d && d.kind === 'cwt')
    },
    async listCwtAddresses() {
      return [...creds.entries()].filter(([, d]) => d.kind === 'cwt').map(([a]) => a)
    },
    async listClaimed() {
      return [...creds.values()]
        .filter((d) => d.state === 'claimed' && d.profileDid)
        .map((d) => d.profileDid)
    },
    async listCreds({ kind = 'all', q = '', limit = 20, offset = 0 } = {}) {
      const isAdminCard = (d) => d.kind === 'cwt' && (d.roles || []).includes('admin')
      const all = [...creds.values()]
        .filter((d) => {
          if (kind === 'did') return d.kind === 'did'
          if (kind === 'admin') return isAdminCard(d)
          if (kind === 'cwt') return d.kind === 'cwt' && !isAdminCard(d)
          return true
        })
        .filter((d) => !q || String(d._id).toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')))
      return { items: all.slice(offset, offset + limit), total: all.length }
    },
  }
}

/* SDK/平台注入：mintVC 与文件签验证的 mock 面 */
let verifyCalls = []
let verifyReturn = true
let verifySdkReturn = true // SDK 卡片验签独立开关（文件签名走 verifyReturn；卡片真签=verified 额外 && 此开关）
function installMocks(backend) {
  verifyCalls = []
  const fakeVC = (kind) => ({
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `did:swtc:jplatform#credential-${kind}-fake`,
    type: ['VerifiableCredential', kind === 'did' ? 'DshMemberCredential' : 'DshCwtCredential'],
    issuer: 'did:swtc:jplatform',
    credentialSubject: { id: `did:swtc:${ADDR}` },
    proof: { type: 'EcdsaSecp256k1Signature2019', jws: 'fake.jws' },
  })
  _resetForTest({
    backend,
    platform: {
      did: 'did:swtc:jplatform',
      priv: 'aa'.repeat(32),
      pubU: '04' + 'bb'.repeat(64),
      profile: { id: 'did:swtc:jplatform' },
      loader: async () => {
        throw new Error('unused')
      },
      keyDoc: () => ({ id: 'did:swtc:jplatform#key-1' }),
    },
    sdk: {
      issueCredential: async (_keyDoc, descriptor) => ({
        ...descriptor,
        proof: { type: 'EcdsaSecp256k1Signature2019', jws: 'a.b.c' },
      }),
      verifyCredential: async () => ({
        verified: verifyReturn && verifySdkReturn,
        errors: verifyReturn ? undefined : ['fake-bad-sig'],
      }),
      Secp256k1Keypair: class {},
      createDocumentLoader: () => async () => {
        throw new Error('unused')
      },
      registerContextUrl: () => {},
      secp256k1: {
        getPublicKey: () => Buffer.from('02'.padEnd(66, 'a'), 'hex'),
        sign: () => ({ toDERRawBytes: () => Buffer.from('30040200', 'hex') }),
        verify: (sig, z, pub) => {
          verifyCalls.push({ sig, z, pub })
          return verifyReturn
        },
      },
      Keypairs: { deriveAddress: (pub) => (pub === 'pub-of-test' ? CANON : 'jotheraddr') },
    },
  })
}

const fetchStub = vi.fn()
beforeEach(() => {
  fetchStub.mockReset()
  vi.stubGlobal('fetch', fetchStub)
  vi.mocked(l1ProfileHit).mockReset().mockResolvedValue(true)
  verifyReturn = true
  verifySdkReturn = true
})

function okRelay(doc) {
  fetchStub.mockImplementation(async (url, opts) => {
    if (String(url).includes('/files/write')) {
      return { ok: true, status: 201, text: async () => '{"code":0}' }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(doc) }
  })
}

describe('进入用户中心的分配判定（enter）', () => {
  it('首进自动分配 DID 普通凭证（assigned），复进幂等且不重发', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    const r1 = await credentialService.enter(ADDR)
    expect(r1.credential.kind).toBe('did')
    expect(r1.credential.state).toBe('assigned')
    expect(r1.popup).toBe(true)
    const r2 = await credentialService.enter(ADDR)
    expect(r2.credential.state).toBe('assigned')
    expect(b.creds.size).toBe(1)
  })

  it('legacy CWT 名单命中 → 直接分配 CWT 解限凭证且即时豁免', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map([[ADDR, { approvedAt: '2026-01-01' }]]) })
    const r = await credentialService.enter(ADDR)
    expect(r.credential.kind).toBe('cwt')
    expect(r.credential.source).toBe('legacy')
    expect(r.legacy.approvedAt).toBe('2026-01-01')
    expect(r.popup).toBe(true) // assigned 未领取→弹窗提醒把卡落档
    expect(credentialService.isExemptSync(ADDR)).toBe(true)
  })

  it('已领取的凭证不再弹窗', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await b.grantCwt(ADDR, { kind: 'did', state: 'claimed', source: 'auto' })
    const r = await credentialService.enter(ADDR)
    expect(r.popup).toBe(false)
  })
})

describe('领取链路（scaffold → upload）', () => {
  beforeEach(() => {
    _resetForTest({ legacy: new Map() })
  })

  it('无 IPFS 档案 → 返回 app.ccda.ooo 生成指引（含核对地址字段）', async () => {
    const b = fakeBackend()
    installMocks(b)
    vi.mocked(l1ProfileHit).mockResolvedValue(false)
    await credentialService.enter(ADDR)
    const scf = await credentialService.buildClaimDocument(ADDR, CANON)
    expect(scf.noProfile).toBe(true)
    expect(scf.didGenUrl).toBe('https://app.ccda.ooo/#/')
    expect(scf.expectedAddress).toBe(CANON)
  })

  it('档案服务网络失败 ≠ 没档案：返回 probeFailed 引导重试，不出误导指引（2026-10-19 误判事故回归位）', async () => {
    const b = fakeBackend()
    installMocks(b)
    vi.mocked(l1ProfileHit).mockResolvedValue(true)
    fetchStub.mockRejectedValue(new Error('socket hang up'))
    await b.grantCwt(ADDR, { kind: 'did', state: 'assigned', source: 'auto' })
    const scf = await credentialService.buildClaimDocument(ADDR, CANON)
    expect(scf.probeFailed).toBe(true)
    expect(scf.noProfile).toBeUndefined()
    expect(credentialService.isExemptSync(ADDR)).toBe(false) // 不改变台账语义
  })

  it('relay 明确 404（l1 判定与档案读不一致时）→ noProfile 指引', async () => {
    const b = fakeBackend()
    installMocks(b)
    vi.mocked(l1ProfileHit).mockResolvedValue(true)
    fetchStub.mockResolvedValue({ ok: false, status: 404, text: async () => '' })
    await b.grantCwt(ADDR, { kind: 'did', state: 'assigned', source: 'auto' })
    const scf = await credentialService.buildClaimDocument(ADDR, CANON)
    expect(scf.noProfile).toBe(true)
    expect(scf.probeFailed).toBeUndefined()
  })

  it('canonical 地址与会话地址不同 → 拒绝（防把卡写进别人档案）', async () => {
    const b = fakeBackend()
    installMocks(b)
    await credentialService.enter(ADDR)
    await expect(
      credentialService.buildClaimDocument(ADDR, 'jEvilOtherAddress000000000000000'),
    ).rejects.toThrow(/不一致/)
  })

  it('有档案 → 目标文档=原档案摘除平台旧 Dsh 卡+追加新签 VC（互斥落档）', async () => {
    const b = fakeBackend()
    installMocks(b)
    await credentialService.enter(ADDR)
    const existing = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: `did:swtc:${CANON}`,
      verificationMethod: [{ id: '#key-1' }],
      authentication: ['#key-1'],
      credentials: [
        {
          id: 'x-own',
          type: ['VerifiableCredential', 'SomeOtherCredential'],
          issuer: 'did:swtc:other',
        },
        {
          id: 'old-dsh',
          type: ['VerifiableCredential', 'DshMemberCredential'],
          issuer: 'did:swtc:jplatform',
        },
      ],
    }
    okRelay(existing)
    const scf = await credentialService.buildClaimDocument(ADDR, CANON)
    expect(scf.document).toBeTruthy()
    const creds = scf.document.credentials
    expect(creds.map((c) => c.id)).toEqual(['x-own', expect.any(String)])
    expect(creds.find((c) => c.id === 'old-dsh')).toBeUndefined()
    expect(creds[1].proof.type).toBe('EcdsaSecp256k1Signature2019')
    expect(scf.fileName).toBe(`did:swtc:${CANON}.json`)
    expect(profilePath(CANON)).toContain(`/shared/did:swtc:${CANON}.json`)
  })

  it('上传验签失败 → BAD_SIGNATURE，不落档不改台账', async () => {
    const b = fakeBackend()
    installMocks(b)
    await credentialService.enter(ADDR)
    verifyReturn = false
    const doc = { id: `did:swtc:${CANON}`, credentials: [] }
    await expect(
      credentialService.claimUpload(ADDR, {
        document: doc,
        fileName: `did:swtc:${CANON}.json`,
        publicKey: 'pub-of-test',
        signature: 'deadbeef',
      }),
    ).rejects.toMatchObject({ code: 'BAD_SIGNATURE' })
    expect(b.creds.get(ADDR).state).toBe('assigned')
    expect(fetchStub.mock.calls.filter((c) => String(c[0]).includes('/files/write'))).toHaveLength(
      0,
    )
  })

  it('领取成功 → relay 写 + 台账 claimed + 返回公开形态', async () => {
    const b = fakeBackend()
    installMocks(b)
    await credentialService.enter(ADDR)
    okRelay({ id: `did:swtc:${CANON}` })
    const doc = {
      id: `did:swtc:${CANON}`,
      credentials: [
        {
          id: 'did:swtc:jplatform#credential-t1',
          type: ['VerifiableCredential', 'DshMemberCredential'],
          issuer: 'did:swtc:jplatform',
          credentialSubject: { id: `did:swtc:${ADDR}` },
        },
      ],
    }
    const out = await credentialService.claimUpload(ADDR, {
      document: doc,
      fileName: `did:swtc:${CANON}.json`,
      publicKey: 'pub-of-test',
      signature: '3044020', // DER hex mock：verify 返回值控制
    })
    expect(out.ok).toBe(true)
    expect(out.credential.state).toBe('claimed')
    expect(out.credential.vcId).toBe('did:swtc:jplatform#credential-t1') // 凭证号回写台账（前端/管理端可展示）
    expect(out.credential.profileDid).toBe(`did:swtc:${CANON}`)
    expect(b.creds.get(ADDR).state).toBe('claimed')
    expect(b.creds.get(ADDR).profileDid).toBe(`did:swtc:${CANON}`) // 领取留档原始大小写
    // 领取成功 = 用户档案写 + 平台档案登记（展示副本，两笔写）
    const writeCalls = fetchStub.mock.calls.filter((c) => String(c[0]).includes('/files/write'))
    expect(writeCalls.length).toBeGreaterThanOrEqual(2)
    // 申请单展示统一：addressDisplay=档案 DID 的原始大小写（匹配键仍是小写 address）
    const r = await credentialService.applyCwt(ADDR)
    const app = await credentialService._findApp(r.id)
    expect(app.address).toBe(ADDR)
    expect(app.addressDisplay).toBe(CANON)
  })

  it('resyncShelf：存量已领取档案的 Dsh 卡补登平台册（幂等可跑）', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, {
      kind: 'did',
      state: 'claimed',
      source: 'auto',
      profileDid: `did:swtc:${CANON}`,
    })
    fetchStub.mockImplementation(async (url) => {
      if (String(url).includes('/files/write'))
        return { ok: true, status: 201, text: async () => '{"code":0}' }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: `did:swtc:${CANON}`,
            credentials: [
              { id: 'own-card', type: ['VerifiableCredential'], issuer: `did:swtc:${CANON}` },
            ],
          }),
      }
    })
    const r = await credentialService.resyncShelf()
    expect(r.total).toBe(1)
    expect(r.shelved).toBe(0) // 档案里没有平台签发的 Dsh 卡 → 不登（不误把别人的卡挂上来）
    expect(r.failed).toBe(0)
  })

  it('getClaimedCredential：按台账 vcId 从档案精确读回凭证本体（60s 缓存）', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, {
      kind: 'did',
      state: 'claimed',
      source: 'auto',
      profileDid: `did:swtc:${CANON}`,
      vcId: 'did:swtc:jplatform#credential-did-x1',
    })
    okRelay({
      id: `did:swtc:${CANON}`,
      credentials: [
        { id: 'foreign-card', type: ['VerifiableCredential'], issuer: `did:swtc:${CANON}` },
        {
          id: 'did:swtc:jplatform#credential-did-x1',
          type: ['VerifiableCredential', 'DshMemberCredential'],
          issuer: 'did:swtc:jplatform',
        },
      ],
    })
    const got = await credentialService.getClaimedCredential(ADDR)
    expect(got.consistent).toBe(true)
    expect(got.credential.id).toBe('did:swtc:jplatform#credential-did-x1') // 别家卡被排除，按 vcId 命中
    const readsBefore = fetchStub.mock.calls.filter(
      (c) => !String(c[0]).includes('/files/write'),
    ).length
    await credentialService.getClaimedCredential(ADDR)
    const readsAfter = fetchStub.mock.calls.filter(
      (c) => !String(c[0]).includes('/files/write'),
    ).length
    expect(readsAfter).toBe(readsBefore) // 缓存命中不重复读档
    await expect(
      credentialService.getClaimedCredential('jnope000000000000000000000000000'),
    ).rejects.toThrow(/尚未领取/)
  })

  it('getClaimedCredential：台账 vcId 与档案不符 → 回档案最新卡且 consistent=false（信息如实）', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, {
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      profileDid: `did:swtc:${CANON}`,
      vcId: 'did:swtc:jplatform#credential-cwt-new',
    })
    okRelay({
      id: `did:swtc:${CANON}`,
      credentials: [
        {
          id: 'did:swtc:jplatform#credential-did-old',
          type: ['VerifiableCredential', 'DshMemberCredential'],
          issuer: 'did:swtc:jplatform',
        },
      ],
    })
    const got = await credentialService.getClaimedCredential(ADDR)
    expect(got.consistent).toBe(false)
    expect(got.credential.id).toBe('did:swtc:jplatform#credential-did-old') // 如实返回档案里那张
  })

  it('resyncShelf：档案含平台卡时补登成功', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, {
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      profileDid: `did:swtc:${CANON}`,
    })
    fetchStub.mockImplementation(async (url, opts) => {
      if (String(url).includes('/files/write'))
        return { ok: true, status: 201, text: async () => '{"code":0}' }
      const body = String(opts?.body || '')
      // 平台册（jplatform 路径）=空架；用户档案=含卡。补登=一写
      if (body.includes('jplatform'))
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 'did:swtc:jplatform', credentials: [] }),
        }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: `did:swtc:${CANON}`,
            credentials: [
              {
                id: 'plat-card',
                type: ['VerifiableCredential', 'DshCwtCredential'],
                issuer: 'did:swtc:jplatform',
              },
            ],
          }),
      }
    })
    const r = await credentialService.resyncShelf()
    expect(r.shelved).toBe(1)
    const w = fetchStub.mock.calls.filter((c) => String(c[0]).includes('/files/write')).length
    expect(w).toBe(1)
  })

  it('已领取再 scaffold → 重铸新卡（reissue 标记）：续发后同步档案的通路', async () => {
    const b = fakeBackend()
    installMocks(b)
    await credentialService.enter(ADDR)
    okRelay({ id: `did:swtc:${CANON}` })
    const first = await credentialService.buildClaimDocument(ADDR, CANON)
    expect(first.reissue).toBe(false) // 首领
    verifyReturn = true
    await credentialService.claimUpload(ADDR, {
      document: first.document,
      fileName: first.fileName,
      publicKey: 'pub-of-test',
      signature: '3044020',
    })
    const again = await credentialService.buildClaimDocument(ADDR, CANON)
    expect(again.reissue).toBe(true) // 已领取：再点=同步
    expect(again.document).toBeTruthy()
    expect(again.vcId).not.toBe(first.vcId) // 重铸的是新卡
    expect(again.document.credentials.at(-1).id).toBe(again.vcId)
  })

  it('文件名/档案 id 与会话地址不匹配 → 拒（防签 A 传 B）', async () => {
    const b = fakeBackend()
    installMocks(b)
    await credentialService.enter(ADDR)
    const doc = { id: 'did:swtc:jevil000000000000000000000000000' }
    await expect(
      credentialService.claimUpload(ADDR, {
        document: doc,
        fileName: 'did:swtc:jevil000000000000000000000000000.json',
        publicKey: 'pub-of-test',
        signature: 'x',
      }),
    ).rejects.toThrow(/与登录地址不匹配/)
    await expect(
      credentialService.claimUpload(ADDR, {
        document: { id: `did:swtc:${CANON}` },
        fileName: 'evil.json',
        publicKey: 'pub-of-test',
        signature: 'x',
      }),
    ).rejects.toThrow(/文件名与登录地址不匹配/)
  })
})

describe('CWT 申请与审批（互斥签发）', () => {
  beforeEach(() => {
    _resetForTest({ legacy: new Map() })
  })

  it('未领取 DID 凭证不可申请', async () => {
    const b = fakeBackend()
    installMocks(b)
    await credentialService.enter(ADDR)
    await expect(credentialService.applyCwt(ADDR)).rejects.toThrow(/尚未领取/)
  })

  it('领取后申请 → pending；重复申请被拒', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, { kind: 'did', state: 'claimed', source: 'auto' })
    const r = await credentialService.applyCwt(ADDR)
    expect(r.status).toBe('pending')
    await expect(credentialService.applyCwt(ADDR)).rejects.toThrow(/待审批/)
    const mine = await credentialService.myApplication(ADDR)
    expect(mine._id).toBe(r.id)
  })

  it('批准=签发 CWT：did 凭证被整条替换（互斥），豁免即时，申请单 approved', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, { kind: 'did', state: 'claimed', source: 'auto' })
    const { id } = await credentialService.applyCwt(ADDR)
    const out = await credentialService.approveApplication(
      id,
      'jadmin00000000000000000000000000000',
    )
    expect(out.credential.kind).toBe('cwt')
    expect(out.credential.source).toBe('approval')
    const cred = b.creds.get(ADDR)
    expect(cred.kind).toBe('cwt')
    expect(cred.state).toBe('assigned') // 解限已生效；落档等用户领取
    expect(credentialService.isExemptSync(ADDR)).toBe(true)
    const app = await credentialService._findApp(id)
    expect(app.status).toBe('approved')
    expect(app.decidedBy).toBe('jadmin00000000000000000000000000000')
  })

  it('拒绝留痕，可重新申请', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, { kind: 'did', state: 'claimed', source: 'auto' })
    const { id } = await credentialService.applyCwt(ADDR)
    await credentialService.rejectApplication(id, 'jadmin00000000000000000000000000000', '材料不足')
    const app = await credentialService._findApp(id)
    expect(app.status).toBe('rejected')
    await expect(credentialService.applyCwt(ADDR)).resolves.toBeTruthy()
  })

  it('非 pending 单不可重复处理', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, { kind: 'did', state: 'claimed', source: 'auto' })
    const { id } = await credentialService.applyCwt(ADDR)
    await credentialService.approveApplication(id, 'jadmin00000000000000000000000000000')
    await expect(
      credentialService.approveApplication(id, 'jadmin00000000000000000000000000000'),
    ).rejects.toThrow(/已是/)
  })
})

describe('档案优先发现级联（enter 完全形态，2026-10-23 用户拍板"先跑档案 出错跑台账"）', () => {
  // 档案文档 {id, credentials:[…]}：relayRead 缺 id 判 absent——与活验套件同形
  const profileOf = (cards) => ({ id: `did:swtc:${CANON}`, credentials: cards })
  const netDown = () => fetchStub.mockRejectedValue(new Error('net down'))

  it('台账无行+档案有平台 admin 卡 → 恢复 claimed（豁免+热闸+admin 角色，档案判权）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    credentialService._provisioned = true // 线上同构：启动对账已完成，isAdmSync 走热快照
    const card = await _mintVCForTest('cwt', ADDR, ['admin'], `did:swtc:${CANON}`)
    okRelay(profileOf([card]))
    const st = await credentialService.enter(ADDR, { canonical: CANON })
    expect(st.verifiedBy).toBe('archive')
    expect(st.popup).toBe(false)
    expect(st.role).toBe('admin')
    expect(st.credential.state).toBe('claimed')
    expect(st.credential.kind).toBe('cwt')
    expect(st.credential.roles).toEqual(['admin'])
    expect(st.credential.vcId).toBe(card.id)
    expect(st.credential.source).toBe('archive-revive') // 签发来源如实：档案恢复非平台补签
    expect(st.credential.profileDid).toBe(`did:swtc:${CANON}`)
    expect(credentialService.isExemptSync(ADDR)).toBe(true)
    expect(credentialService.isAdmSync(ADDR)).toBe(true)
  })

  it('assigned 行+档案有真 cwt 卡 → 对账翻 claimed，source 不动，豁免即补', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    netDown()
    await credentialService.enter(ADDR) // 首进：档案不通→台账自动发 assigned
    const card = await _mintVCForTest('cwt', ADDR, [], `did:swtc:${CANON}`)
    okRelay(profileOf([card]))
    const st = await credentialService.enter(ADDR, { canonical: CANON })
    expect(st.credential.state).toBe('claimed')
    expect(st.credential.kind).toBe('cwt')
    expect(st.credential.source).toBe('auto') // 恢复=记录对齐，不改写签发来源
    expect(st.popup).toBe(false)
    expect(credentialService.isExemptSync(ADDR)).toBe(true)
  })

  it('claimed 行+档案确凿无卡 → 既有降级对账链原样（assigned+弹窗重领+豁免即摘）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await b.putRow(ADDR, {
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      roles: [],
      vcId: `did:swtc:${CANON}#dsh-cwt-deleted`,
      claimedAt: '2026-01-01T00:00:00.000Z',
      profileDid: `did:swtc:${CANON}`,
      expiresAt: new Date(Date.now() + 864e5).toISOString(),
      onChain: { status: 'ok', at: '2025-01-01T00:00:00.000Z' },
    })
    credentialService._markExempt(ADDR) // 前置：运行时豁免在集
    okRelay(profileOf([])) // 档案确凿可读、卡已被持有人删除
    const st = await credentialService.enter(ADDR, { canonical: CANON })
    expect(st.verifiedBy).toBe('archive')
    expect(st.credential.state).toBe('assigned')
    expect(st.popup).toBe(true)
    expect(credentialService.isExemptSync(ADDR)).toBe(false)
  })

  it('档案不通（网络抖动）→ 台账级联照走：新用户照常自动签发，绝不上锁', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    netDown()
    const st = await credentialService.enter(ADDR, { canonical: CANON })
    expect(st.credential.state).toBe('assigned')
    expect(st.credential.kind).toBe('did')
    expect(st.popup).toBe(true)
    expect(st.verifiedBy).toBe('ledger')
  })

  it('过期卡≠已领取事实：发现层不认', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    const card = await _mintVCForTest('cwt', ADDR, [], `did:swtc:${CANON}`)
    card.expirationDate = new Date(Date.now() - 60000).toISOString()
    okRelay(profileOf([card]))
    const st = await credentialService.enter(ADDR, { canonical: CANON })
    expect(st.credential.state).toBe('assigned')
    expect(st.credential.kind).toBe('did')
    expect(st.popup).toBe(true)
  })

  it('他人卡（subject 不同址）与非生态形卡（id 无 dsh- 起头）都不算发现命中', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    // 手摆真·他人卡（mintVC 会把 holderDid 归一校验成同址，伪造不了别人）
    const alien = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: 'did:swtc:jotheruser00000000000000000000#dsh-cwt-2026-did:swtc:jplatform-0000',
      type: ['VerifiableCredential', 'DshCwtCredential'],
      issuer: 'did:swtc:jplatform',
      credentialSubject: { id: 'did:swtc:jotheruser00000000000000000000' },
      issuanceDate: new Date().toISOString(),
      expirationDate: new Date(Date.now() + 864e5).toISOString(),
      proof: { type: 'EcdsaSecp256k1Signature2019', jws: 'a.b.c' },
    }
    const noSlug = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: `did:swtc:${ADDR}#random-legacy-1`,
      type: ['VerifiableCredential', 'DshMemberCredential'],
      issuer: 'did:swtc:jplatform',
      credentialSubject: { id: `did:swtc:${ADDR}` },
      expirationDate: new Date(Date.now() + 864e5).toISOString(),
      proof: { type: 'EcdsaSecp256k1Signature2019', jws: 'a.b.c' },
    }
    okRelay(profileOf([alien, noSlug]))
    const st = await credentialService.enter(ADDR, { canonical: CANON })
    expect(st.credential.state).toBe('assigned') // 两都不认：视同"档案无卡"落台账
    expect(st.popup).toBe(true)
  })

  it('canonical 传路径注入形态被归一校验弃用；实际读的文件名不含 "../"', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    okRelay(profileOf([]))
    const st = await credentialService.enter(ADDR, { canonical: '../../etc/passwd' })
    expect(st.credential.state).toBe('assigned')
    const bodies = fetchStub.mock.calls.map((c) => String((c[1] && c[1].body) || ''))
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.every((s) => !s.includes('..'))).toBe(true)
  })

  it('读压纪律：assigned 行无 canonical 完全不劳 relay（新用户轮询零档案读）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    netDown()
    await credentialService.enter(ADDR) // 首进发 assigned（无行态的发现尝试一次）
    fetchStub.mockClear()
    fetchStub.mockRejectedValue(new Error('must-not-be-called'))
    const st = await credentialService.enter(ADDR)
    expect(st.credential.state).toBe('assigned')
    expect(st.verifiedBy).toBe('ledger')
    expect(fetchStub).not.toHaveBeenCalled()
  })
})

describe('平台档案自取（provisionPlatformProfile——用户定式"没有就访问官网获取"）', () => {
  const TMP_REL = 'data/keys/.test-provision-profile.json'
  const TMP_ABS = `${process.cwd()}/${TMP_REL}`
  const DID = 'did:swtc:jTestPlat00000000000000000000x'
  const saved = {}
  beforeEach(() => {
    saved.profileFile = CONFIG.credential.profileFile
    saved.platformDid = CONFIG.credential.platformDid
    CONFIG.credential.profileFile = TMP_REL
    CONFIG.credential.platformDid = DID
    fetchStub.mockReset()
  })
  afterEach(async () => {
    CONFIG.credential.profileFile = saved.profileFile
    CONFIG.credential.platformDid = saved.platformDid
    const fs = await import('node:fs')
    fs.rmSync(TMP_ABS, { force: true })
  })

  it('线上有档且 id 严格一致 → 落成本地镜像（只读线上，不动线上）', async () => {
    const doc = { id: DID, verificationMethod: [{ id: `${DID}#key-1` }], service: [] }
    okRelay(doc)
    const got = await provisionPlatformProfile()
    expect(got).toEqual({ ok: true, did: DID })
    const fs = await import('node:fs')
    expect(JSON.parse(fs.readFileSync(TMP_ABS, 'utf8'))).toEqual(doc)
  })

  it('线上档案 id 与声明不符 → 宁拒不写（镜像一旦落地即成身份事实来源）', async () => {
    okRelay({ id: 'did:swtc:jimpostor0000000000000000000x', verificationMethod: [] })
    const got = await provisionPlatformProfile()
    expect(got.ok).toBe(false)
    expect(got.reason).toMatch(/不符/)
    const fs = await import('node:fs')
    expect(fs.existsSync(TMP_ABS)).toBe(false)
  })

  it('读档抖动/无档（probe-fail 语义）→ 不写镜像不崩溃（缺档引导注册脚本）', async () => {
    fetchStub.mockImplementation(async () => {
      return { ok: false, status: 500, text: async () => 'gateway down' }
    })
    const got = await provisionPlatformProfile()
    expect(got.ok).toBe(false)
    expect(got.reason).toMatch(/未注册|status/)
    const fs = await import('node:fs')
    expect(fs.existsSync(TMP_ABS)).toBe(false)
  })

  it('platformDid 未声明 → 直接未果（自取是显式 opt-in，默认零动作）', async () => {
    CONFIG.credential.platformDid = ''
    const got = await provisionPlatformProfile()
    expect(got.ok).toBe(false)
    expect(fetchStub).not.toHaveBeenCalled()
  })
})

describe('跨平台档案共存（2026-10-23 用户定调"不同 key=不同平台"，isOurIssuedCard 窄化）', () => {
  const profileOf = (cards) => ({ id: `did:swtc:${CANON}`, credentials: cards })
  // 他平台生态形卡：类型名 DshCwtCredential 与我们**同名**（全局常量），issuer/id
  // 只含别家 DID——旧的 isDshCard 条款会把它误当自家卡摘除/误报 stale
  const alien = () => ({
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `did:swtc:${CANON}#dsh-cwt-2026-01-01-did:swtc:jothereco-aaaa`,
    type: ['VerifiableCredential', 'DshCwtCredential'],
    issuer: 'did:swtc:jothereco',
    credentialSubject: { id: `did:swtc:${ADDR}` },
    issuanceDate: '2026-01-01T00:00:00.000Z',
    expirationDate: new Date(Date.now() + 864e5).toISOString(),
    proof: { type: 'EcdsaSecp256k1Signature2019', jws: 'a.b.c' },
  })

  it('领取换卡只摘自家旧卡：他平台同名类型卡原样共存，自家旧卡确实让位', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    const oursOld = await _mintVCForTest('cwt', ADDR, [], `did:swtc:${CANON}`)
    const other = alien()
    okRelay(profileOf([other, oursOld]))
    await credentialService.enter(ADDR, { canonical: CANON }) // 发现命中自家旧卡→claimed
    const out = await credentialService.buildClaimDocument(ADDR, CANON)
    const list = out.document.credentials
    expect(list.some((c) => c.id === other.id)).toBe(true) // 他平台卡活着
    expect(list.some((c) => c.id === oursOld.id)).toBe(false) // 自家旧卡被摘
    expect(list[list.length - 1].issuer).toBe('did:swtc:jplatform') // 尾位=新签自家卡
  })

  it('stale 检测不被他平台卡冒领：档案只剩别家卡=确凿无我方卡→missing 对账', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await b.putRow(ADDR, {
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      roles: [],
      vcId: `did:swtc:${CANON}#dsh-cwt-ours-deleted`,
      claimedAt: '2026-01-01T00:00:00.000Z',
      profileDid: `did:swtc:${CANON}`,
      expiresAt: new Date(Date.now() + 864e5).toISOString(),
      onChain: { status: 'ok', at: '2025-01-01T00:00:00.000Z' },
    })
    okRelay(profileOf([alien()])) // 我方卡被删，别家卡还在
    const v = await credentialService.onChainVerify(ADDR, { force: true })
    expect(v.status).toBe('missing') // 旧代码会误报 stale（"您档案里还是旧版本"）
    expect((await b.get(ADDR)).state).toBe('assigned')
  })

  it('凭证本体展示绝不显示他平台卡', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await b.putRow(ADDR, {
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      roles: [],
      vcId: 'vc-not-in-archive',
      claimedAt: '2026-01-01T00:00:00.000Z',
      profileDid: `did:swtc:${CANON}`,
    })
    okRelay(profileOf([alien()]))
    await expect(credentialService.getClaimedCredential(ADDR)).rejects.toThrow(/找不到/)
  })

  it('发现引擎天然共存：别家同名类型卡不过真签闸，不触发恢复', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    okRelay(profileOf([alien()]))
    const st = await credentialService.enter(ADDR, { canonical: CANON })
    expect(st.credential.state).toBe('assigned') // 别家卡不算"档案有真卡"
    expect(st.verifiedBy).toBe('ledger')
  })
})

describe('批量挂架单写（shelfMany——2026-10-26 实弹 lost-update 缺陷回归）', () => {
  // 事故回放：resyncShelf 逐张 shelfCredential 连发，relay 快照 10-60s debounce 内
  // 第二张读到的 base 还没有第一张 → 整篇覆写互抹，三轮连跑货架恒剩最后一张。
  // 修复=一轮收集全部卡→一次读一次写。用 fetch 写计数钉死该语义。
  // stub 分家判据：平台册路径含注入平台 DID 'jplatform'；用户档案按行 profileDid 尾串寻址
  // （listClaimed 吐出的是 profileDid——resyncShelf 正是按它去读"该用户档案"，勿用 ADDR 当 key）
  const OTHER = 'jotherholder00000000000x'
  const OCANON = 'jOtherHolder00000000000000000000x'
  function shelfStub(shelfDoc, userCards) {
    fetchStub.mockImplementation(async (url, opts) => {
      if (String(url).includes('/files/write'))
        return { ok: true, status: 201, text: async () => '{"code":0}' }
      const body = String(opts?.body || '')
      if (body.includes('jplatform'))
        return { ok: true, status: 200, text: async () => JSON.stringify(shelfDoc) }
      const hit = Object.keys(userCards).find((a) => body.includes(a))
      const cards = hit ? userCards[hit] : []
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: `did:swtc:${hit || 'x'}`, credentials: cards }),
      }
    })
  }
  const claimedRow = async (b, addr, kind, card, canon = CANON) =>
    b.putRow(addr, {
      kind,
      state: 'claimed',
      source: 'approval',
      roles: [],
      vcId: card.id,
      claimedAt: '2026-01-01T00:00:00.000Z',
      profileDid: `did:swtc:${canon}`,
    })

  it('resyncShelf 多卡一轮：平台册只写一次，两张全收集', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    const A = await _mintVCForTest('cwt', ADDR, [], `did:swtc:${CANON}`)
    const C = await _mintVCForTest('did', OTHER, [], `did:swtc:${OCANON}`)
    await claimedRow(b, ADDR, 'cwt', A)
    await claimedRow(b, OTHER, 'did', C, OCANON)
    shelfStub(
      { id: 'did:swtc:jplatform', credentials: [] },
      {
        [CANON]: [{ credential: A }],
        [OCANON]: [{ credential: C }],
      },
    )
    const r = await credentialService.resyncShelf()
    const writes = fetchStub.mock.calls.filter(([u]) => String(u).includes('/files/write'))
    expect(r.shelved).toBe(2)
    expect(writes.length).toBe(1) // ★核心断言：一轮一写（逐张版=两写互抹）
  })

  it('全部在册且 id 一致 → 幂等零写', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    const A = await _mintVCForTest('cwt', ADDR, [], `did:swtc:${CANON}`)
    await claimedRow(b, ADDR, 'cwt', A)
    shelfStub({ id: 'did:swtc:jplatform', credentials: [A] }, { [CANON]: [{ credential: A }] })
    await credentialService.resyncShelf()
    expect(fetchStub.mock.calls.filter(([u]) => String(u).includes('/files/write')).length).toBe(0)
  })

  it('平台册读档抖动（probe-fail）→ 绝不写册（铁律），shelved 归零', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    const A = await _mintVCForTest('cwt', ADDR, [], `did:swtc:${CANON}`)
    await claimedRow(b, ADDR, 'cwt', A)
    fetchStub.mockImplementation(async (url, opts) => {
      if (String(url).includes('/files/write'))
        return { ok: true, status: 201, text: async () => '{}' }
      const body = String(opts?.body || '')
      if (body.includes('jplatform')) throw new Error('network jitter')
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: `did:swtc:${ADDR}`, credentials: [{ credential: A }] }),
      }
    })
    const r = await credentialService.resyncShelf()
    expect(r.shelved).toBe(0)
    expect(fetchStub.mock.calls.filter(([u]) => String(u).includes('/files/write')).length).toBe(0)
  })
})

describe('链上验真（onChainVerify）', () => {
  const claimed = () => {
    const b = fakeBackend()
    installMocks(b)
    b.creds.set(ADDR, {
      _id: ADDR,
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      profileDid: `did:swtc:${CANON}`,
      vcId: 'vc-live',
      expiresAt: new Date(Date.now() + 864e5).toISOString(),
    })
    return b
  }
  const docWith = (cards) => ({ id: `did:swtc:${CANON}`, credentials: cards })

  it('档案有卡+验签通过 → onChain.status=ok 落台账', async () => {
    const b = claimed()
    okRelay(
      docWith([
        {
          id: 'vc-live',
          type: ['VerifiableCredential', 'DshCwtCredential'],
          issuer: 'did:swtc:jplatform',
        },
      ]),
    )
    const r = await credentialService.onChainVerify(ADDR)
    expect(r.status).toBe('ok')
    expect(b.creds.get(ADDR).onChain.status).toBe('ok')
  })
  it('验签失败 → invalid 且带原因', async () => {
    claimed()
    verifyReturn = false
    okRelay(
      docWith([
        {
          id: 'vc-live',
          type: ['VerifiableCredential', 'DshCwtCredential'],
          issuer: 'did:swtc:jplatform',
        },
      ]),
    )
    const r = await credentialService.onChainVerify(ADDR)
    expect(r.status).toBe('invalid')
    expect(r.reason).toContain('bad-sig')
    verifyReturn = true
  })
  it('档案是另一张平台卡（续发后未同步）→ stale（不调验签，reason 带旧卡尾号）', async () => {
    claimed()
    okRelay(
      docWith([{ id: 'vc-other', type: ['VerifiableCredential'], issuer: 'did:swtc:jplatform' }]),
    )
    const r = await credentialService.onChainVerify(ADDR)
    expect(r.status).toBe('stale')
    expect(r.reason).toContain('vc-other')
  })
  it('档案彻底没有平台卡 → missing 且台账回未领取（官网删卡对账）', async () => {
    const b = claimed()
    okRelay(
      docWith([{ id: 'vc-own', type: ['VerifiableCredential'], issuer: `did:swtc:${CANON}` }]),
    )
    const r = await credentialService.onChainVerify(ADDR)
    expect(r.status).toBe('missing')
    // v1.5 对账：确凿 missing → state 回 assigned、vcId/claimedAt 清空——
    // 但 kind/roles/source 一律不动（判权在台账不在档案：删档案卡不夺豁免）
    const row = b.creds.get(ADDR)
    expect(row.state).toBe('assigned')
    expect(row.vcId).toBeNull()
    expect(row.claimedAt).toBeNull()
    expect(row.kind).toBe('cwt')
    expect(row.onChain.status).toBe('missing')
  })
  it('读档网络失败 → 保留上次结论不写台账（probe-fail 不误判）', async () => {
    const b = claimed()
    b.creds.get(ADDR).onChain = { status: 'ok', at: new Date(Date.now() - 400000).toISOString() } // 过期保鲜期
    fetchStub.mockImplementation(async () => {
      throw new Error('network down')
    })
    const r = await credentialService.onChainVerify(ADDR)
    expect(r.status).toBe('ok') // 上次结论原样返回
    expect(b.creds.get(ADDR).onChain.at).not.toBe(new Date().toISOString()) // 未被改写
  })
  it('刚落档 60s 内不验真（副本传播宽限，防 stale 误报）', async () => {
    const b = claimed() // claimedAt 未设 → 补设成现在
    b.creds.get(ADDR).claimedAt = new Date().toISOString()
    okRelay(
      docWith([
        {
          id: 'vc-live',
          type: ['VerifiableCredential', 'DshCwtCredential'],
          issuer: 'did:swtc:jplatform',
        },
      ]),
    )
    const r = await credentialService.onChainVerify(ADDR)
    expect(r).toEqual({}) // 没读档没结论
    expect(fetchStub.mock.calls.length).toBe(0)
    const f = await credentialService.onChainVerify(ADDR, { force: true })
    expect(f.status).toBe('ok') // force 绕过宽限
  })
  it('60 秒保鲜期内不重复读档（节流）；保鲜过期必重读——官网删卡 1~2 次访问内对账', async () => {
    const b = claimed()
    okRelay(
      docWith([
        {
          id: 'vc-live',
          type: ['VerifiableCredential', 'DshCwtCredential'],
          issuer: 'did:swtc:jplatform',
        },
      ]),
    )
    await credentialService.onChainVerify(ADDR)
    const n1 = fetchStub.mock.calls.length
    const r = await credentialService.onChainVerify(ADDR)
    expect(r.status).toBe('ok')
    expect(fetchStub.mock.calls.length).toBe(n1) // 60s 窗内无新请求
    // 保鲜过期（ok at=90s 前）→ 必须重读：删卡对账的触发保证（2026-10-23 整改核心）
    b.creds.get(ADDR).onChain = { status: 'ok', at: new Date(Date.now() - 90000).toISOString() }
    await credentialService.onChainVerify(ADDR)
    expect(fetchStub.mock.calls.length).toBe(n1 + 1)
  })
  it('未领取/无卡 → 直接跳过返回 null', async () => {
    const b = fakeBackend()
    installMocks(b)
    b.creds.set(ADDR, { _id: ADDR, kind: 'did', state: 'assigned', source: 'auto' })
    expect(await credentialService.onChainVerify(ADDR)).toBeNull()
  })

  it('enter 当轮对账：已领取但档案卡已被官网删除 → 本轮即回未领取+重新引导领取弹窗', async () => {
    const b = claimed()
    okRelay(docWith([])) // 档案确凿可读、里面没有任何平台卡（持有人删卡后的常态）
    const r = await credentialService.enter(ADDR)
    expect(r.credential.state).toBe('assigned') // 不再是慢一拍显示"已存入"
    expect(r.popup).toBe(true) // 本轮就重新弹窗引导再领
    expect(r.verifiedBy).toBe('archive') // 判权顺序：本轮结论出自档案活验（"先跑档案"）
    const row = b.creds.get(ADDR)
    expect(row.vcId).toBeNull()
    expect(row.kind).toBe('cwt') // 判权面纹丝不动：删的是出示层，不是授予
  })

  it('enter 先跑档案：活验通过 → verifiedBy=archive，放行有链上背书', async () => {
    claimed()
    okRelay(
      docWith([
        {
          id: 'vc-live',
          type: ['VerifiableCredential', 'DshCwtCredential'],
          issuer: 'did:swtc:jplatform',
        },
      ]),
    )
    const r = await credentialService.enter(ADDR)
    expect(r.verifiedBy).toBe('archive')
    expect(r.credential.state).toBe('claimed')
  })

  it('enter 档案出错 → 落回台账放行：verifiedBy=ledger 且 state 不动（绝不上锁）', async () => {
    const b = claimed()
    fetchStub.mockImplementation(async () => {
      throw new Error('relay down')
    })
    const r = await credentialService.enter(ADDR)
    expect(r.verifiedBy).toBe('ledger') // probe-fail 不下档案结论
    expect(r.credential.state).toBe('claimed') // 官网抖动≠撤销
  })

  it('enter 核验超预算 → 本轮台账放行，后台结论落库不丢（先档案后台账是顺序不是二选一）', async () => {
    const b = claimed()
    const orig = CONFIG.credential.enterVerifyBudgetMs
    CONFIG.credential.enterVerifyBudgetMs = 1 // 预算 1ms：fetch 永远来不及 → 必超时
    let resolveFetch
    fetchStub.mockImplementation(() => new Promise((res) => (resolveFetch = res)))
    try {
      const r = await credentialService.enter(ADDR)
      expect(r.verifiedBy).toBe('ledger')
      expect(r.credential.state).toBe('claimed') // 本轮未被（迟到的）档案结论改写
    } finally {
      CONFIG.credential.enterVerifyBudgetMs = orig
    }
    resolveFetch({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          docWith([
            {
              id: 'vc-live',
              type: ['VerifiableCredential', 'DshCwtCredential'],
              issuer: 'did:swtc:jplatform',
            },
          ]),
        ),
    })
    await vi.waitFor(() => expect(b.creds.get(ADDR).onChain?.status).toBe('ok'), { timeout: 2000 })
  })

  it('mintVC 生态统一形态：issuer=纯DID字符串 + id=持有人命名空间内嵌平台DID + jdid 品牌词表', async () => {
    installMocks(fakeBackend())
    const vc = await _mintVCForTest('did', ADDR, [])
    expect(vc.issuer).toBe('did:swtc:jplatform')
    expect(typeof vc.issuer).toBe('string') // 形态铁律：非字符串=签发管线必炸
    // 生态 id 模板（仿官网实卡 #phone-<ISO>-did:swtc:<issuer>-<后缀>）：
    expect(String(vc.id).startsWith(`did:swtc:${ADDR}#dsh-member-`)).toBe(true)
    expect(String(vc.id)).toContain('-did:swtc:jplatform-')
    // jdid 品牌词表（官方 @jccdex/vc-vocabularies brands/jdid.js 同款 URL）
    expect(vc['@context'][0]).toBe('https://www.w3.org/2018/credentials/v1')
    expect(vc['@context'][1].DshMemberCredential).toBe('https://jdid.cn/vc/v1#DshMemberCredential')
    expect(vc['@context'][1].tier).toBe('https://jdid.cn/did/v1#tier')
    expect(vc['@context'][1].version).toBe('https://jdid.cn/did/v1')
    // subject 值去自创 urn：裸词形态 + 生态通用惯例 status 恒有（官网实卡核对）
    expect(vc.credentialSubject.verifiedVia).toBe('auto-assign')
    // 官网"按官网侧设置"类型栈：[基型, 官网模板型(渲染入口), 我方标记型(判卡)]
    expect(vc.type).toEqual([
      'VerifiableCredential',
      'PhoneVerificationCredential',
      'DshMemberCredential',
    ])
    expect(vc.credentialSubject.status).toBe('verified')
    expect(vc.credentialSubject.verificationMethod).toBe('dsh-siwe')
    expect(vc.credentialSubject.verificationProcess.verifierId).toBe('did:swtc:jplatform')
    expect(vc['@context'][1].PhoneVerificationCredential).toBe(
      'https://jdid.cn/vc/v1#PhoneVerificationCredential',
    )
    expect(vc['@context'][1].verificationProcess['@id']).toBe(
      'https://jdid.cn/did/v1#verificationProcess',
    )
    // 隔离铁律：生态真 phone 卡（他人签发、无 Dsh 标记）绝不被认成我方卡
    expect(
      _isDshCardForTest({
        type: ['VerifiableCredential', 'PhoneVerificationCredential'],
        issuer: 'did:swtc:j3xhos5osubqmfaekq3rxufrzbbucghwrv',
        credentialSubject: { id: `did:swtc:${ADDR}` },
      }),
    ).toBe(false)
    expect(_isDshCardForTest(vc)).toBe(true)
    const cwt = await _mintVCForTest('cwt', ADDR, ['admin'])
    expect(cwt.issuer).toBe('did:swtc:jplatform')
    // 角色化 fragment：cwt+admin 角色=admin 段（用户要求 vcId 自辨角色）
    expect(String(cwt.id).startsWith(`did:swtc:${ADDR}#dsh-admin-`)).toBe(true)
    expect(cwt.credentialSubject.cwtGrant).toBe('approved')
    const plainCwt = await _mintVCForTest('cwt', ADDR, [])
    expect(String(plainCwt.id).startsWith(`did:swtc:${ADDR}#dsh-cwt-`)).toBe(true)
    // holderDid 传档案实际大小写 → id 保留混合大小写（生态卡同款）
    const mixed = await _mintVCForTest('did', ADDR, [], `did:swtc:${CANON}`)
    expect(String(mixed.id).startsWith(`did:swtc:${CANON}#dsh-member-`)).toBe(true)
    // 非法 holderDid（别的地址）→ 退回小写规范形态，不移花接木
    const wrong = await _mintVCForTest(
      'did',
      ADDR,
      [],
      'did:swtc:jOTHERaddr9999999999999999999999x',
    )
    expect(String(wrong.id).startsWith(`did:swtc:${ADDR}#`)).toBe(true)
  })

  it('mintVC ownership 皮：徽章所有权形态（tokenName/owner/standard=dshBadge 防链上核验）', async () => {
    installMocks(fakeBackend())
    const vc = await _mintVCForTest('did', ADDR, [], null, { interop: 'ownership' })
    expect(vc.type).toEqual(['VerifiableCredential', 'NFTOwnership', 'DshMemberCredential'])
    const s = vc.credentialSubject
    expect(s.standard).toBe('dshBadge') // 自声明：绝不冒充 jingtumNFT
    expect(s.owner).toBe(`did:swtc:${ADDR}`)
    expect(s.tokenName).toBe('DSH 平台成员徽章')
    expect(s.status).toBe('Active')
    expect(vc['@context'][1].NFTOwnership).toBe('https://jdid.cn/vc/v1#NFTOwnership')
    // 判卡仍以 Dsh 标记为准，皮不参与；生态真所有权卡（他人签发）不误认
    expect(_isDshCardForTest(vc)).toBe(true)
    expect(
      _isDshCardForTest({
        type: ['VerifiableCredential', 'NFTOwnership'],
        issuer: 'did:swtc:jsomeoneelse000000000000000000000',
        credentialSubject: { id: `did:swtc:${ADDR}` },
      }),
    ).toBe(false)
  })
  it('isPlatformMinted id 判据双代：新代生态形接受、旧代兼容、畸形拒绝', async () => {
    const b = fakeBackend()
    installMocks(b)
    const mkCard = (id) => ({
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id,
      type: ['VerifiableCredential', 'DshMemberCredential'],
      issuer: 'did:swtc:jplatform',
      credentialSubject: { id: `did:swtc:${ADDR}` },
      proof: { type: 'EcdsaSecp256k1Signature2019', jws: 'a.b.c' },
    })
    // 新代：持有人命名空间 + dsh- 前缀 + 内嵌平台 DID（大小写不敏感）
    await expect(
      _isPlatformMintedForTest(
        mkCard(`did:swtc:${CANON}#dsh-member-2026-10-23T00:00:00.000Z-did:swtc:jplatform-abcd`),
        ADDR,
      ),
    ).resolves.toBe(true)
    // 角色段三档：member/cwt/admin 均过 id 判据；未知角色段拒绝（防伪角色）
    await expect(
      _isPlatformMintedForTest(
        mkCard(`did:swtc:${CANON}#dsh-cwt-2026-10-23T00:00:00.000Z-did:swtc:jplatform-1`),
        ADDR,
      ),
    ).resolves.toBe(true)
    await expect(
      _isPlatformMintedForTest(
        mkCard(`did:swtc:${CANON}#dsh-admin-2026-10-23T00:00:00.000Z-did:swtc:jplatform-1`),
        ADDR,
      ),
    ).resolves.toBe(true)
    await expect(
      _isPlatformMintedForTest(
        mkCard(`did:swtc:${CANON}#dsh-root-2026-10-23T00:00:00.000Z-did:swtc:jplatform-1`),
        ADDR,
      ),
    ).resolves.toBe(false)
    // 旧代：平台命名空间 #credential-*（存量兼容）
    await expect(
      _isPlatformMintedForTest(mkCard('did:swtc:jplatform#credential-t1-old'), ADDR),
    ).resolves.toBe(true)
    // 畸形①：他人命名空间且 fragment 不含平台 DID（他人自签仿冒形态）
    await expect(
      _isPlatformMintedForTest(
        mkCard(`did:swtc:jhacker0000000000000000000000000#dsh-member-x-did:swtc:jhacker-1`),
        ADDR,
      ),
    ).resolves.toBe(false)
    // 畸形②：持有人命名空间但 fragment 无平台 DID 锚（无法证明平台签发关联）
    await expect(
      _isPlatformMintedForTest(mkCard(`did:swtc:${CANON}#dsh-member-2026-random-only`), ADDR),
    ).resolves.toBe(false)
    // 畸形③：subject 不是本地址
    const other = mkCard(`did:swtc:${CANON}#dsh-member-x-did:swtc:jplatform-1`)
    other.credentialSubject = { id: 'did:swtc:jsomeoneelse0000000000000000000' }
    await expect(_isPlatformMintedForTest(other, ADDR)).resolves.toBe(false)
  })
})

describe('运行时豁免档案优先贯通（_reconcileExemptWithArchive，2026-10-23 用户拍板 VC-as-authority 端到端）', () => {
  const claimedRow = () => {
    const b = fakeBackend()
    installMocks(b)
    b.creds.set(ADDR, {
      _id: ADDR,
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      profileDid: `did:swtc:${CANON}`,
      vcId: 'vc-live',
      expiresAt: new Date(Date.now() + 864e5).toISOString(),
    })
    return b
  }
  const docW = (cards) => ({ id: `did:swtc:${CANON}`, credentials: cards })
  it('删卡确凿 → 对账当秒摘豁免；台账照常降级；水合不复活（missing 戳防线）', async () => {
    const b = claimedRow()
    await credentialService.refreshExemptSet()
    expect(credentialService.isExemptSync(ADDR)).toBe(true) // 前置：台账授予在集
    okRelay(docW([])) // 档案确凿可读、卡已被持有人删除
    await credentialService._reconcileExemptWithArchive()
    expect(credentialService.isExemptSync(ADDR)).toBe(false) // 即时摘，不等登录
    expect(b.creds.get(ADDR).state).toBe('assigned') // 台账侧对账照旧
    await credentialService.refreshExemptSet() // 5 分钟水合不得复活确凿负结论行
    expect(credentialService.isExemptSync(ADDR)).toBe(false)
  })
  it('验签不过（invalid=伪造覆盖）→ 豁免即摘', async () => {
    claimedRow()
    await credentialService.refreshExemptSet()
    okRelay(
      docW([
        {
          id: 'vc-live',
          type: ['VerifiableCredential', 'DshCwtCredential'],
          issuer: 'did:swtc:jplatform',
        },
      ]),
    )
    verifyReturn = false // 假 SDK：verified:false
    await credentialService._reconcileExemptWithArchive()
    expect(credentialService.isExemptSync(ADDR)).toBe(false)
  })
  it('probe-fail 绝不摘豁免（绝不上锁）：网络失败保台账结论', async () => {
    claimedRow()
    await credentialService.refreshExemptSet()
    fetchStub.mockRejectedValue(new Error('socket hang up'))
    await credentialService._reconcileExemptWithArchive()
    expect(credentialService.isExemptSync(ADDR)).toBe(true)
  })
  it('legacy 配发未领取（null 结论）不受扰；重新领取 _markExempt 后翻案复活', async () => {
    const b = fakeBackend()
    installMocks(b)
    b.creds.set(ADDR, { _id: ADDR, kind: 'cwt', state: 'assigned', source: 'legacy', roles: [] })
    await credentialService.refreshExemptSet()
    await credentialService._reconcileExemptWithArchive()
    expect(fetchStub).not.toHaveBeenCalled() // 未领取根本不该读档
    expect(credentialService.isExemptSync(ADDR)).toBe(true)
    // 删卡对账摘除后重领（claimUpload 成功路径 _markExempt 的等价模拟）→ 后到者胜
    b.creds.get(ADDR).onChain = { status: 'missing', at: new Date().toISOString() }
    credentialService._unmarkExempt(ADDR)
    credentialService._markExempt(ADDR)
    await credentialService.refreshExemptSet()
    expect(credentialService.isExemptSync(ADDR)).toBe(true)
  })
})

describe('登录续发（到期自动换卡）', () => {
  it('enter：已领取且过期 → 当场重铸新卡（新 vcId + 未来到期日 + renewed 标记）', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, {
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      profileDid: `did:swtc:${CANON}`,
      vcId: 'did:swtc:jplatform#credential-cwt-old',
      expiresAt: new Date(Date.now() - 864e5).toISOString(), // 昨天已到期
    })
    okRelay({ id: `did:swtc:${CANON}` })
    const r = await credentialService.enter(ADDR)
    expect(r.renewed).toBe(true)
    expect(r.credential.vcId).not.toBe('did:swtc:jplatform#credential-cwt-old')
    expect(new Date(r.credential.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(r.credential.state).toBe('claimed')
    // 未过期不重复续（幂等防风暴：一次登录周期内只按到期日判断）
    const r2 = await credentialService.enter(ADDR)
    expect(r2.renewed).toBe(false)
    expect(r2.credential.vcId).toBe(r.credential.vcId)
  })
  it('enter：无 vcId/expiresAt 的存量记录不误续（legacy 未落卡等）', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, {
      kind: 'cwt',
      state: 'assigned',
      source: 'legacy',
      issuedAt: new Date(Date.now() - 400 * 864e5).toISOString(),
    })
    const r = await credentialService.enter(ADDR)
    expect(r.renewed).toBeFalsy()
    expect(r.credential.vcId).toBeNull()
  })
})

describe('凭证台账浏览（管理端）', () => {
  it('listCredentials：kind 筛选 + 地址模糊 + addressDisplay 原始大小写', async () => {
    const b = fakeBackend()
    installMocks(b)
    await credentialService.enter(ADDR) // did/assigned
    await b.grantCwt('jotheruser0000000000000000000000', {
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      profileDid: 'did:swtc:JOtherUserMixedCaseForm00000000000',
      vcId: 'did:swtc:jplatform#credential-cwt-x1',
    })
    const all = await credentialService.listCredentials({})
    expect(all.total).toBe(2)
    expect(all.items.find((i) => i.address === ADDR).kind).toBe('did')
    const cwtOnly = await credentialService.listCredentials({ kind: 'cwt' })
    expect(cwtOnly.total).toBe(1)
    expect(cwtOnly.items[0].addressDisplay).toBe('JOtherUserMixedCaseForm00000000000') // 展示=档案原始大小写
    expect(cwtOnly.items[0].vcId).toBe('did:swtc:jplatform#credential-cwt-x1')
    const hit = await credentialService.listCredentials({ q: 'OTHERUSER' }) // 大小写不敏感搜索
    expect(hit.total).toBe(1) // 粘原始大小写地址也能查到（台账键小写，匹配两侧归一）
    const hit2 = await credentialService.listCredentials({ q: 'other' })
    expect(hit2.total).toBe(1)
    // ── 三类卡制式：管理凭证独立档，不并入 CWT（2026-10-23 用户拍板） ──
    await b.putRow('jadminone000000000000000000000000', {
      kind: 'cwt',
      state: 'assigned',
      source: 'admin-auto',
      roles: ['admin'],
      issuedAt: new Date().toISOString(),
    })
    expect((await credentialService.listCredentials({})).total).toBe(3)
    const adm = await credentialService.listCredentials({ kind: 'admin' })
    expect(adm.total).toBe(1)
    expect(adm.items[0].address).toBe('jadminone000000000000000000000000')
    expect(adm.items[0].isAdmin).toBe(true) // _public 暴露角色事实，前端据此渲染第三卡种
    const pureCwt = await credentialService.listCredentials({ kind: 'cwt' })
    expect(pureCwt.total).toBe(1) // 纯解限 CWT 档剔除 admin 行（其他user），admin 不混入
    expect(pureCwt.items[0].address).toBe('jotheruser0000000000000000000000')
  })
})

describe('豁免快照（usage 热路径同步判据）', () => {
  it('refreshExemptSet 水合 + isExemptSync 大小写不敏感', async () => {
    const b = fakeBackend()
    installMocks(b)
    await b.grantCwt(ADDR, { kind: 'cwt', state: 'claimed', source: 'approval' })
    await credentialService.refreshExemptSet()
    expect(credentialService.isExemptSync(ADDR.toUpperCase())).toBe(true)
    expect(credentialService.isExemptSync('jwhoever')).toBe(false)
  })

  it('CWT 凭证领取与否不影响豁免（判据=持有哪些凭证）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map([[ADDR, { approvedAt: 'x' }]]) })
    const r = await credentialService.enter(ADDR)
    expect(r.credential.state).toBe('assigned')
    expect(credentialService.isExemptSync(ADDR)).toBe(true)
  })

  it('backfillLegacy：名单地址无凭证即发 cwt；已有凭证不覆盖（幂等）', async () => {
    const b = fakeBackend()
    installMocks(b)
    const OTHER = 'jother000000000000000000000000000'
    _resetForTest({
      legacy: new Map([
        [ADDR, { approvedAt: 'a' }],
        [OTHER, {}],
      ]),
    })
    await b.grantCwt(ADDR, { kind: 'did', state: 'claimed', source: 'auto' })
    const r = await credentialService.backfillLegacy()
    expect(r.total).toBe(2)
    expect(r.created).toBe(1) // 只有 OTHER 新签
    expect(b.creds.get(ADDR).kind).toBe('did') // 已有凭证不被覆盖
    expect(b.creds.get(OTHER).kind).toBe('cwt')
    expect(credentialService.isExemptSync(OTHER)).toBe(true)
  })
})

describe('失败三态化（2026-10 全面审计回归位）', () => {
  // 钉死三条契约：①读故障绝不折叠成"档案不存在"；②读失败绝不写平台登记册；
  // ③relay 响应不可解析=写失败（假成功曾把台账置 claimed 而档案无卡）；
  // ④换卡后凭证本体缓存立即作废（_vcCache.delete 此前全项目零调用点）。
  const mkDoc = (id) => ({
    id: `did:swtc:${CANON}`,
    credentials: [
      {
        id,
        type: ['VerifiableCredential', 'DshMemberCredential'],
        issuer: 'did:swtc:jplatform',
        credentialSubject: { id: `did:swtc:${ADDR}` },
      },
    ],
  })
  const uploadArgs = (id) => ({
    document: mkDoc(id),
    fileName: `did:swtc:${CANON}.json`,
    publicKey: 'pub-of-test',
    signature: '3044020',
  })

  it('relay 读 500/502 → probe-fail：验真保留上次结论，不写假 missing', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    b.creds.set(ADDR, {
      _id: ADDR,
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      profileDid: `did:swtc:${CANON}`,
      vcId: 'vc-live',
      expiresAt: new Date(Date.now() + 864e5).toISOString(),
      onChain: { status: 'ok', checkedAt: '2026-10-01T00:00:00Z' },
    })
    fetchStub.mockResolvedValue({ ok: false, status: 502, text: async () => 'bad gateway' })
    const r = await credentialService.onChainVerify(ADDR, { force: true })
    expect(r.status).toBe('ok')
    expect(b.creds.get(ADDR).onChain.status).toBe('ok')
  })

  it('relay 读 404 → 仍判 absent → missing 落台账（明确没有=可下结论）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    b.creds.set(ADDR, {
      _id: ADDR,
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      profileDid: `did:swtc:${CANON}`,
      vcId: 'vc-live',
      expiresAt: new Date(Date.now() + 864e5).toISOString(),
      onChain: { status: 'ok', checkedAt: '2026-10-01T00:00:00Z' },
    })
    fetchStub.mockResolvedValue({ ok: false, status: 404, text: async () => '' })
    const r = await credentialService.onChainVerify(ADDR, { force: true })
    expect(r.status).toBe('missing')
    expect(b.creds.get(ADDR).onChain.status).toBe('missing')
  })

  it('领取时用户档案写入 200+HTML（不可解析）→ 抛错且台账保持 assigned（假成功回归位）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.enter(ADDR)
    fetchStub.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>502</html>' })
    await expect(
      credentialService.claimUpload(ADDR, uploadArgs('did:swtc:jplatform#credential-t1')),
    ).rejects.toThrow(/未确认成功/)
    expect(b.creds.get(ADDR).state).toBe('assigned')
  })

  it('假卡上传（自制"平台凭证"）→ 拒绝：relay 一笔不写、台账保持 assigned（防假卡审计回归位）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.enter(ADDR)
    // 文档整体由攻击者钱包签（文件签名门拦不住"内容造假"——真签名+假卡片）
    const forgedDoc = {
      id: `did:swtc:${CANON}`,
      credentials: [
        {
          id: 'did:swtc:attacker#credential-t1-forged', // 门①：id 非平台签发形态
          type: ['VerifiableCredential', 'DshMemberCredential'],
          issuer: 'did:swtc:jplatform',
          credentialSubject: { id: `did:swtc:${ADDR}` },
        },
      ],
    }
    await expect(
      credentialService.claimUpload(ADDR, {
        document: forgedDoc,
        fileName: `did:swtc:${CANON}.json`,
        publicKey: 'pub-of-test',
        signature: '3044020',
      }),
    ).rejects.toThrow(/平台为本地址签发的有效凭证/)
    const writes = fetchStub.mock.calls.filter((c) => String(c[0]).includes('/files/write'))
    expect(writes).toHaveLength(0) // 验卡门在 relayWrite 之前：假卡连 relay 都碰不到
    expect(b.creds.get(ADDR).state).toBe('assigned')
  })

  it('平台形态 id 但 SDK 验签不过（无法确认真签）→ 同样拒绝（fail-closed）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.enter(ADDR)
    verifySdkReturn = false // 仅 SDK 卡片验签失败（文件签名仍通过——两道门要分开演）
    await expect(
      credentialService.claimUpload(ADDR, uploadArgs('did:swtc:jplatform#credential-t1-x')),
    ).rejects.toThrow(/平台为本地址签发的有效凭证/)
    expect(b.creds.get(ADDR).state).toBe('assigned')
  })

  it('领取成功但平台册读档 500 → 挂架放弃不写（此前用本地快照整篇覆写登记册）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.enter(ADDR)
    fetchStub.mockImplementation(async (url) => {
      if (String(url).includes('/files/write'))
        return { ok: true, status: 201, text: async () => '{"code":0}' }
      return { ok: false, status: 500, text: async () => 'gateway down' } // 读=故障
    })
    const out = await credentialService.claimUpload(
      ADDR,
      uploadArgs('did:swtc:jplatform#credential-t1-1'),
    )
    expect(out.ok).toBe(true) // 用户档案写成功，领取本身不受平台册故障拖累
    expect(b.creds.get(ADDR).state).toBe('claimed')
    const writes = fetchStub.mock.calls.filter((c) => String(c[0]).includes('/files/write'))
    expect(writes).toHaveLength(1) // 仅用户档案一笔；平台册 probe-fail 未写
  })

  it('同步（再次领取）成功 → getClaimedCredential 不吃 60s 旧缓存（审计 #7）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.enter(ADDR)
    okRelay(mkDoc('did:swtc:jplatform#credential-t1-1'))
    await credentialService.claimUpload(ADDR, uploadArgs('did:swtc:jplatform#credential-t1-1'))
    const readCount = () =>
      fetchStub.mock.calls.filter((c) => String(c[0]).includes('/files/read')).length
    const v1 = await credentialService.getClaimedCredential(ADDR)
    expect(v1.credential.id).toBe('did:swtc:jplatform#credential-t1-1')
    const n = readCount()
    await credentialService.getClaimedCredential(ADDR)
    expect(readCount()).toBe(n) // 60s 内命中缓存，不再读档
    okRelay(mkDoc('did:swtc:jplatform#credential-t1-2'))
    await credentialService.claimUpload(ADDR, uploadArgs('did:swtc:jplatform#credential-t1-2')) // 同步换新卡
    const v2 = await credentialService.getClaimedCredential(ADDR)
    expect(v2.credential.id).toBe('did:swtc:jplatform#credential-t1-2') // 缓存未失效则返回 plat-vc-1
  })
})

// ---------------------------------------------------------------------------
// 并发语义（2026-10 全面审计回归位）：
// ① 挂架"读档→改→写档"必须串行——否则两张卡交叉丢更新（后写覆盖前写）。
// ② 豁免集刷新在 fetch 窗口被 _markExempt 插入——整替不得吞掉刚批的地址。
// ---------------------------------------------------------------------------
describe('并发语义（挂架串行 / 豁免刷新窗口）', () => {
  it('并发挂两张卡 → 平台登记册两张都在（串行读改写，丢更新回归位）', async () => {
    const b = fakeBackend()
    installMocks(b)
    // relay 状态机：read 返回当前档案；write 以 FormData 的 file 字段整体提交
    let doc = { id: 'did:swtc:jplatform', credentials: [] }
    fetchStub.mockImplementation(async (url, opts) => {
      const u = String(url)
      if (u.includes('/files/write')) {
        const raw = opts.body.get('file')
        doc = JSON.parse(await raw.text())
        return { ok: true, status: 201, text: async () => '{"code":0}' }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(doc) }
    })
    const mkVc = (tag) => ({
      id: `did:swtc:jplatform#credential-t1-${tag}`,
      type: ['VerifiableCredential', 'DshMemberCredential'],
      issuer: 'did:swtc:jplatform',
      credentialSubject: { id: `did:swtc:jtag${tag}000000000000000000000000000` },
    })
    const vcA = mkVc('aa')
    const vcB = mkVc('bb')

    const rs = await Promise.all([_shelfCredentialForTest(vcA), _shelfCredentialForTest(vcB)])

    expect(rs.every((r) => r === true)).toBe(true)
    const ids = doc.credentials.map((c) => c.credential?.id ?? c.id)
    expect(ids).toEqual(expect.arrayContaining([vcA.id, vcB.id])) // 两张都在：串行合并而非互相覆盖
  })

  it('刷新的 fetch 窗口内 _markExempt → 旧快照整替后仍保留（刚批准不被误限时）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    let release
    b.listCwtAddresses = () => new Promise((r) => (release = () => r([]))) // 空快照=不含 ADDR 的"旧"结果
    const p = credentialService.refreshExemptSet() // 刷新在途
    credentialService._markExempt(ADDR) // 批准/签发即时豁免插队
    release()
    await p
    expect(credentialService.isExemptSync(ADDR)).toBe(true)
  })

  it('刷新的 fetch 窗口内 _unmarkExempt → 旧快照整替后仍剔除（刚撤销不被复活，v1.5 对称保护）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await b.grantCwt(ADDR, { kind: 'cwt', state: 'claimed', source: 'approval', roles: [] })
    await credentialService.refreshExemptSet()
    expect(credentialService.isExemptSync(ADDR)).toBe(true)
    let release
    b.listCwtAddresses = () => new Promise((r) => (release = () => r([ADDR]))) // "旧"快照仍含 ADDR
    const p = credentialService.refreshExemptSet()
    credentialService._unmarkExempt(ADDR) // 撤销在 fetch 窗口内插队
    release()
    await p
    expect(credentialService.isExemptSync(ADDR)).toBe(false)
  })
})

describe('v1.5 管理员凭证编排（任命/撤销/对账/判权）', () => {
  const A2 = 'jadmin2000000000000000000000000000'

  it('provisionAdmin：新签 cwt+roles[admin]，即时豁免+admin 标记，幂等', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    const r = await credentialService.provisionAdmin(ADDR)
    expect(r.issued).toBe(true)
    const row = b.creds.get(ADDR)
    expect(row.kind).toBe('cwt')
    expect(row.roles).toEqual(['admin'])
    expect(row.source).toBe('admin-auto')
    expect(credentialService.isExemptSync(ADDR)).toBe(true) // 免时限随 cwt 链天然生效
    const r2 = await credentialService.provisionAdmin(ADDR)
    expect(r2.already).toBe(true) // 重复任命不重签
  })

  it('demoteAdmin：有批准史 → 重签纯 cwt（保豁免、摘 admin、卡无 roles）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.provisionAdmin(ADDR)
    b.apps.push({ _id: 'app1', address: ADDR, status: 'approved' })
    const r = await credentialService.demoteAdmin(ADDR)
    expect(r.to).toBe('cwt')
    const row = b.creds.get(ADDR)
    expect(row.kind).toBe('cwt')
    expect(row.roles || []).not.toContain('admin') // 独立本权保留但不再是管理员
    expect(credentialService.isExemptSync(ADDR)).toBe(true) // 回"是 cwt"：不限时保住的
    expect(credentialService._admSet.has(ADDR)).toBe(false) // admin 当秒摘
  })

  it('demoteAdmin：cwt 仅源自任命（无批准史）→ 重签 did（回限时）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.provisionAdmin(ADDR)
    const r = await credentialService.demoteAdmin(ADDR)
    expect(r.to).toBe('did')
    expect(b.creds.get(ADDR).kind).toBe('did')
    expect(credentialService.isExemptSync(ADDR)).toBe(false) // 收回免时限
    expect(credentialService._admSet.has(ADDR)).toBe(false)
  })

  it('demoteAdmin：非管理员行 noop（幂等，绝不误降普通人）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await b.grantCwt(ADDR, { kind: 'cwt', state: 'claimed', source: 'approval', roles: [] })
    await credentialService.refreshExemptSet() // 独立 cwt 行进豁免快照（grantCwt 直写不经审批同步路径，水合是合同内步调）
    const r = await credentialService.demoteAdmin(ADDR)
    expect(r.noop).toBe(true)
    expect(b.creds.get(ADDR).roles).toEqual([]) // 原样未动
    expect(credentialService.isExemptSync(ADDR)).toBe(true) // 独立 cwt 未被误伤
  })

  it('enter：名册在册地址自动升签 admin 卡（免申请免自审）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map(), roster: [ADDR] })
    const r = await credentialService.enter(ADDR)
    expect(r.credential.kind).toBe('cwt')
    expect(r.credential.roles).toContain('admin')
    expect(r.popup).toBe(true) // 新 admin 卡待领取 → 弹窗闭环
    expect(r.role).toBe('user') // 对账前判权落名册兜底（config 空）——升级期不误显 tab
    await credentialService.syncAdminProvisioning()
    expect((await credentialService.enter(ADDR)).role).toBe('admin') // 对账后=凭证化快照投影
  })

  it('scaffold：admin 行领取铸造的卡本体带 roles（对外出示面自证）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.provisionAdmin(ADDR)
    okRelay({ id: `did:swtc:${CANON}` })
    const scf = await credentialService.buildClaimDocument(ADDR, CANON)
    const card = scf.document.credentials.at(-1)
    expect(card.type).toContain('DshCwtCredential')
    expect(card.credentialSubject.roles).toEqual(['admin'])
  })

  it('isAdmSync：对账前落名册兜底（绝不上锁），对账后读凭证快照', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map(), roster: [ADDR] })
    expect(credentialService.isAdmSync(ADDR)).toBe(false) // 未 _provisioned 且 config 空 → 名册兜底=roster 但走 isAdmin 分支=false
    credentialService._markAdmin(ADDR)
    expect(credentialService.isAdmSync(ADDR)).toBe(false) // 快照有值但 _provisioned=false → 仍走名册兜底
    await credentialService.syncAdminProvisioning() // 置 _provisioned=true
    expect(credentialService.isAdmSync(ADDR)).toBe(true) // 现在读凭证结论快照
    credentialService._unmarkAdmin(ADDR)
    expect(credentialService.isAdmSync(ADDR)).toBe(false) // 撤销当秒摘除
  })

  it('syncAdminProvisioning：名册缺卡补签 + 名册外悬空 admin 降格（双向对账）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map(), roster: [ADDR] })
    await b.grantCwt(A2, { kind: 'cwt', state: 'claimed', source: 'admin-auto', roles: ['admin'] })
    const r = await credentialService.syncAdminProvisioning()
    expect(r.promoted).toContain(ADDR) // 名册在册无卡 → 补签
    expect(r.demoted).toContain(A2) // 名册外的 admin 结论 → 降格（A2 无批准史 → 回 did）
    expect(b.creds.get(ADDR).roles).toContain('admin')
    expect(b.creds.get(A2).kind).toBe('did')
    expect(credentialService._provisioned).toBe(true)
  })

  it('claimUpload：任命后台账 cwt+admin，传旧 did 卡 → 卡型不符拒（防越级领取）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.provisionAdmin(ADDR) // 台账=cwt+admin
    okRelay({ id: `did:swtc:${CANON}` })
    const didDoc = {
      id: `did:swtc:${CANON}`,
      credentials: [
        {
          id: 'did:swtc:jplatform#credential-t1',
          type: ['VerifiableCredential', 'DshMemberCredential'], // 旧 did 卡
          issuer: 'did:swtc:jplatform',
          credentialSubject: { id: `did:swtc:${ADDR}` },
        },
      ],
    }
    await expect(
      credentialService.claimUpload(ADDR, {
        document: didDoc,
        fileName: `did:swtc:${CANON}.json`,
        publicKey: 'pub-of-test',
        signature: '3044020',
      }),
    ).rejects.toThrow(/不一致/)
    expect(b.creds.get(ADDR).state).toBe('assigned') // 未被假卡落档
  })

  it('onChainVerify 确凿 invalid + admin 行 → 当秒摘 admin 热闸（stale/missing 不误伤）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.provisionAdmin(ADDR)
    await b.patch(ADDR, {
      state: 'claimed',
      profileDid: `did:swtc:${CANON}`,
      vcId: 'did:swtc:jplatform#credential-cwt-admin',
      claimedAt: '2000-01-01',
    })
    credentialService._provisioned = true
    expect(credentialService.isAdmSync(ADDR)).toBe(true)
    // 档案里确有这张卡（id 匹配），但 SDK 验签失败 = 确凿 invalid（伪造/被覆盖）
    okRelay({
      id: `did:swtc:${CANON}`,
      credentials: [
        {
          id: 'did:swtc:jplatform#credential-cwt-admin',
          type: ['VerifiableCredential', 'DshCwtCredential'],
          issuer: 'did:swtc:jplatform',
          credentialSubject: { id: `did:swtc:${ADDR}`, roles: ['admin'] },
        },
      ],
    })
    verifySdkReturn = false // 实卡验签失败=伪造/被覆盖
    await credentialService.onChainVerify(ADDR, { force: true })
    expect(credentialService.isAdmSync(ADDR)).toBe(false) // invalid 才摘
  })
})

describe('v1.5 刀5B 准入闸（凭证即准入：did|cwt|admin 三证皆进）', () => {
  it('gateConnect：从未来过用户中心的插件直连者 → 自动配发 did 卡放行（正常用户永不触发）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    const r = await credentialService.gateConnect(ADDR)
    expect(r).toMatchObject({ allowed: true, kind: 'did' })
    expect(b.creds.get(ADDR).kind).toBe('did')
    expect(b.creds.get(ADDR).source).toBe('connect')
    expect(credentialService.isEntryValidSync(ADDR)).toBe(true)
    expect(credentialService.isExemptSync(ADDR)).toBe(false) // did 准入但不解限——分级原样
  })

  it('gateConnect：过期行拒绝 → 登录续发后恢复放行（自愈闭环）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await b.grantCwt(ADDR, {
      kind: 'cwt',
      state: 'claimed',
      source: 'approval',
      roles: [],
      vcId: 'did:swtc:jplatform#credential-old',
      expiresAt: '2000-01-01',
    })
    const r = await credentialService.gateConnect(ADDR)
    expect(r.allowed).toBe(false)
    expect(r.code).toBe('CREDENTIAL_EXPIRED')
    const e = await credentialService.enter(ADDR) // 登录续发：当场重铸一年卡
    expect(e.renewed).toBe(true)
    const r2 = await credentialService.gateConnect(ADDR)
    expect(r2.allowed).toBe(true) // 恢复通道走通
  })

  it('license 备用模式：did 拒、cwt/admin 进；off 模式全放行（恢复现场）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await b.grantCwt(ADDR, { kind: 'did', state: 'claimed', source: 'auto', roles: [] })
    const saved = CONFIG.accessGate
    try {
      CONFIG.accessGate = { mode: 'license' }
      const r = await credentialService.gateConnect(ADDR)
      expect(r.allowed).toBe(false)
      expect(r.code).toBe('NO_VALID_CREDENTIAL')
      CONFIG.accessGate = { mode: 'off' }
      expect((await credentialService.gateConnect(ADDR)).allowed).toBe(true)
      expect(credentialService.isEntryValidSync('jwhoever')).toBe(true) // off=闸不存在
    } finally {
      CONFIG.accessGate = saved
    }
  })

  it('isEntryValidSync：首次水合前 fail-open（升级期绝不误锁），水合后陌生地址拒', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    expect(credentialService._validHydrated).toBe(false)
    expect(credentialService.isEntryValidSync('jstranger000000000000000000000000')).toBe(true) // 未水合放行
    await b.grantCwt(ADDR, { kind: 'did', state: 'claimed', source: 'auto', roles: [] })
    await credentialService.refreshExemptSet()
    expect(credentialService._validHydrated).toBe(true)
    expect(credentialService.isEntryValidSync(ADDR)).toBe(true)
    expect(credentialService.isEntryValidSync('jstranger000000000000000000000000')).toBe(false)
  })

  it('刷新窗口竞态：_unmarkValid 在旧快照整替后仍生效（对称刀3保护）', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await b.grantCwt(ADDR, { kind: 'did', state: 'claimed', source: 'auto', roles: [] })
    await credentialService.refreshExemptSet()
    expect(credentialService.isEntryValidSync(ADDR)).toBe(true)
    let release
    b.listValidRows = () =>
      new Promise((r) => (release = () => r([{ _id: ADDR, expiresAt: null }])))
    const p = credentialService.refreshExemptSet() // fetch 在途（旧结果=仍在册）
    credentialService._unmarkValid(ADDR) // 窗口内收回
    release()
    await p
    expect(credentialService.isEntryValidSync(ADDR)).toBe(false)
  })

  it('降格不踢准入：provisionAdmin→demoteAdmin 全程 isEntryValidSync 恒真', async () => {
    const b = fakeBackend()
    installMocks(b)
    _resetForTest({ legacy: new Map() })
    await credentialService.provisionAdmin(ADDR)
    await credentialService.refreshExemptSet()
    expect(credentialService.isEntryValidSync(ADDR)).toBe(true)
    await credentialService.demoteAdmin(ADDR) // 无批准史 → 回 did（限时但可进）
    expect(credentialService.isEntryValidSync(ADDR)).toBe(true)
    expect(b.creds.get(ADDR).kind).toBe('did')
  })
})
