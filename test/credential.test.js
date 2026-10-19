/**
 * v1.4 凭证体系核心测试（2026-10-19）
 *
 * 全部外部件注入：SDK/平台钥/relay fetch/L1 探测/legacy 名单/存储 backend——
 * 不碰真实网络、私钥文件与工作区 data/。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../src/services/did.service.js', () => ({
  l1ProfileHit: vi.fn(async () => true),
  getSwtcResolver: vi.fn(() => ({})),
}))
import { l1ProfileHit } from '../src/services/did.service.js'
import {
  credentialService,
  _resetForTest,
  profilePath,
  KINDS,
} from '../src/services/credential.service.js'

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
      const all = [...creds.values()]
        .filter((d) => (kind === 'did' || kind === 'cwt' ? d.kind === kind : true))
        .filter((d) => !q || String(d._id).toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')))
      return { items: all.slice(offset, offset + limit), total: all.length }
    },
  }
}

/* SDK/平台注入：mintVC 与文件签验证的 mock 面 */
let verifyCalls = []
let verifyReturn = true
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
        verified: verifyReturn,
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
          id: 'plat-vc',
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
    expect(out.credential.vcId).toBe('plat-vc') // 凭证号回写台账（前端/管理端可展示）
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
  it('档案彻底没有平台卡 → missing', async () => {
    claimed()
    okRelay(
      docWith([{ id: 'vc-own', type: ['VerifiableCredential'], issuer: `did:swtc:${CANON}` }]),
    )
    const r = await credentialService.onChainVerify(ADDR)
    expect(r.status).toBe('missing')
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
  it('5 分钟保鲜期内不重复读档（节流）', async () => {
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
    await credentialService.onChainVerify(ADDR)
    const n1 = fetchStub.mock.calls.length
    const r = await credentialService.onChainVerify(ADDR)
    expect(r.status).toBe('ok')
    expect(fetchStub.mock.calls.length).toBe(n1) // 无新请求
  })
  it('未领取/无卡 → 直接跳过返回 null', async () => {
    const b = fakeBackend()
    installMocks(b)
    b.creds.set(ADDR, { _id: ADDR, kind: 'did', state: 'assigned', source: 'auto' })
    expect(await credentialService.onChainVerify(ADDR)).toBeNull()
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
