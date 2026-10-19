/**
 * v1.4 凭证体系核心（2026-10-19）
 *
 * 业务口径（用户拍板）：
 *  - 用户进入用户中心 → 后端判定：已有凭证→不管；无凭证→自动分配
 *    （旧版 CWT registry 命中 → 直接分配 CWT 解限凭证；否则分配 DID 普通凭证，待领取）。
 *  - 领取 = 平台签发的 VC 写入**用户自己的 IPFS DID 档案**（relay 读写，用户插件文件签，
 *    服务端只当管道+验签）。档案不存在 → 指引去 app.ccda.ooo 生成 DID，提醒核对地址。
 *  - 想解除限制：必须领取 DID 普通凭证 → 提交 CWT 申请 → 管理员批准 → 签发 CWT 凭证
 *    （批准即解除限制；DID 普通凭证从台账移除——两凭证不可共存）。
 *  - 限制判据 = 是否持有 CWT 凭证（kind==='cwt'），与领取状态无关。
 *  - 暂不做撤销（拍板）。
 *
 * 密码学链路（spike 实证 verified:true 的配方，见 scripts/vc-spike.cjs）：
 *  - VC proof：@jccdex/did SDK issueCredential（EcdsaSecp256k1Signature2019，JCS 规范化）
 *  - 档案文件签：sha256(bytes)→hex utf8→前缀(25 号控制字符+文案+长度)→sha256→ECDSA DER
 *  - 档案路径：sha256hex(原始大小写地址)[0:2]/[2:4]/<addr>/shared/did:swtc:<addr>.json
 *  - 领取上传：前端插件对档案字节签 → 服务端验 DER 签 + deriveAddress(publicKey)===会话地址
 *
 * 存储双轨（与旧 cwt.store 先例同型）：mongodb=credentials+cwt_applications 集合；
 * json=data/credentials.json / data/cwt-applications.json（应急开关下的兜底）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { CONFIG, ROOT } from '../config/config.js'
import { getStore } from './mongo.store.js'
import { normalizeAddress } from '../utils/address.js'
import { l1ProfileHit, getSwtcResolver } from './did.service.js'
import { InternalError, BadRequestError } from '../utils/errors.js'

const require = createRequire(import.meta.url)
const sha256hex = (b) => createHash('sha256').update(b).digest('hex')

export const KINDS = Object.freeze({ DID: 'did', CWT: 'cwt' })
export const VC_TYPES = Object.freeze({ did: 'DshMemberCredential', cwt: 'DshCwtCredential' })

// relay 文件签消息前缀：0x19 控制字符 + 'IPFS Signed Message:' + LF + 消息长度
const MSG_PREFIX_BYTES = Buffer.from([25, ...Buffer.from('IPFS Signed Message:', 'utf8'), 10])

const APP_REJECTED_KEEP = 100 // 已拒绝申请裁剪保留条数（旧 cwt 合同同款）

/* ───────────────────────── 懒加载的密码学件（避开 barrel esm 炸弹） ───────────────────────── */

let _sdk = null
function sdk() {
  if (_sdk) return _sdk
  const D = join(ROOT, 'node_modules', '@jccdex', 'did') + '/'
  const { issueCredential, verifyCredential } = require(D + 'lib/credential-sdk/credentials.js')
  const Secp256k1Keypair = require(D + 'lib/credential-sdk/keypairs/keypair-secp256k1.js').default
  const { createDocumentLoader, registerContextUrl } = require(D + 'lib/context-loader.js')
  const { secp256k1 } = require('@noble/curves/secp256k1')
  const { Keypairs } = require('@swtc/keypairs')
  _sdk = {
    issueCredential,
    verifyCredential,
    Secp256k1Keypair,
    createDocumentLoader,
    registerContextUrl,
    secp256k1,
    Keypairs,
  }
  return _sdk
}

function cfg() {
  return CONFIG.credential || {}
}

/** 平台签发身份：issuer.key（SEC1 PEM）→ priv hex；issuer-profile.json → DID 档案 */
let _platform = null
function platform() {
  if (_platform) return _platform
  const c = cfg()
  const pem = readFileSync(join(ROOT, c.keyFile), 'utf8')
  const k = require('node:crypto').createPrivateKey({ key: pem, format: 'pem' })
  const priv = Buffer.from(k.export({ format: 'jwk' }).d, 'base64url')
    .toString('hex')
    .padStart(64, '0')
  const profile = JSON.parse(readFileSync(join(ROOT, c.profileFile), 'utf8'))
  // 公共档案的 credentials[] 是历史货架遗留——签发只需要 verificationMethod
  const { secp256k1, Secp256k1Keypair } = sdk()
  const pubU = Buffer.from(secp256k1.getPublicKey(priv, false)).toString('hex')
  _platform = {
    priv,
    pubU,
    did: profile.id,
    profile,
    keyDoc: () => {
      const kp = new Secp256k1Keypair(Buffer.from(priv, 'hex'), 'private')
      return {
        id: `${profile.id}#key-1`,
        controller: profile.id,
        type: Secp256k1Keypair.VerKeyType,
        keypair: kp,
      }
    },
  }
  // 注册 secp256k1-2019 签名套件 context（本地副本，防 w3id 拉取失败）
  const loader = createDocLoader()
  _platform.loader = loader
  return _platform
}

let _loader = null
function createDocLoader() {
  if (_loader) return _loader
  const { createDocumentLoader, registerContextUrl } = sdk()
  const c = cfg()
  const ctx = JSON.parse(readFileSync(join(ROOT, c.contextFile), 'utf8'))
  registerContextUrl('https://w3id.org/security/suites/secp256k1-2019/v1', ctx)
  _loader = createDocumentLoader()
  return _loader
}

/** 测试注入缝隙（vitest 里 mock SDK/relay/钥/存储，不碰真实网络、私钥与工作区文件） */
export function _resetForTest(inj = {}) {
  if (inj.sdk !== undefined) _sdk = inj.sdk
  if (inj.platform !== undefined) _platform = inj.platform
  if (inj.loader !== undefined) _loader = inj.loader
  if (inj.backend !== undefined) _injectedBackend = inj.backend
  if (inj.legacy !== undefined)
    _legacy = inj.legacy instanceof Map ? inj.legacy : new Map(Object.entries(inj.legacy))
  _vcCache.clear()
  credentialService._resetCache()
}

/* ───────────────────────── VC 签发 ───────────────────────── */

/** 平台真签一张 VC（kind: did|cwt），subject = 用户 DID（小写规范形态） */
async function mintVC(kind, subjectAddrLower) {
  const p = platform()
  const c = cfg()
  const ns = c.vcNamespace || 'urn:dshm-test:credential'
  const typeName = VC_TYPES[kind]
  if (!typeName) throw new BadRequestError(`未知凭证类型: ${kind}`)
  const now = new Date()
  const descriptor = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      {
        [typeName]: `${ns}:${typeName}`,
        tier: `${ns}#tier`,
        verifiedVia: `${ns}#verifiedVia`,
        dailyMinutes: `${ns}#dailyMinutes`,
        cwtGrant: `${ns}#cwtGrant`,
      },
    ],
    id: `${p.did}#credential-${kind === 'did' ? 't1' : 'cwt'}-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    type: ['VerifiableCredential', typeName],
    issuer: p.did,
    issuanceDate: now.toISOString(),
    expirationDate: new Date(now.getTime() + 365 * 864e5).toISOString(),
    credentialSubject:
      kind === 'did'
        ? {
            id: `did:swtc:${subjectAddrLower}`,
            tier: 1,
            dailyMinutes: cfgDailyMinutes(),
            verifiedVia: `${ns}:auto-assign`,
          }
        : {
            id: `did:swtc:${subjectAddrLower}`,
            tier: 1,
            cwtGrant: `${ns}:approved`,
            verifiedVia: `${ns}:cwt`,
          },
  }
  const vc = await sdk().issueCredential(
    p.keyDoc(),
    descriptor,
    true,
    p.loader,
    null,
    undefined,
    null,
    true,
    'jsonld',
  )
  return vc
}

function cfgDailyMinutes() {
  const u = CONFIG.usageLimit || {}
  return Number.isFinite(u.dailyMinutes) && u.dailyMinutes > 0 ? u.dailyMinutes : 120
}

/* ───────────────────────── relay 档案读写 ───────────────────────── */

export function profilePath(canonicalAddr) {
  const h = sha256hex(Buffer.from(canonicalAddr, 'utf8'))
  return `/${h.slice(0, 2)}/${h.slice(2, 4)}/${canonicalAddr}/shared/did:swtc:${canonicalAddr}.json`
}

/** 三态读档：ok=拿到文档；absent=relay 明确说没有（4xx/空返回）；probe-fail=网络/解析失败（不可下"没档案"结论） */
async function relayRead(canonicalAddr) {
  const c = cfg()
  const url = `${c.relayBaseURL}${c.apiBase || '/v0/api/ipfs'}/shared/files/read`
  let r
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: profilePath(canonicalAddr) }),
      signal: AbortSignal.timeout((c.profileProbeTimeoutMs || 8000) + 2000),
    })
  } catch {
    return { status: 'probe-fail', doc: null }
  }
  if (!r.ok) return { status: 'absent', doc: null }
  try {
    const doc = JSON.parse(await r.text())
    return doc && doc.id ? { status: 'ok', doc } : { status: 'absent', doc: null }
  } catch {
    return { status: 'probe-fail', doc: null }
  }
}

async function relayWrite({ document, fileName, publicKeyHex, signatureDerHex, chain }) {
  const c = cfg()
  const url = `${c.relayBaseURL}${c.apiBase || '/v0/api/ipfs'}/files/write`
  const fd = new FormData()
  fd.append('file', new Blob([JSON.stringify(document)]), fileName)
  fd.append('name', fileName)
  fd.append('publicKey', publicKeyHex)
  fd.append('signature', signatureDerHex)
  fd.append('share', 'true')
  fd.append('chain', chain || c.chain || 'swtc')
  const r = await fetch(url, { method: 'POST', body: fd, signal: AbortSignal.timeout(15000) })
  const text = (await r.text().catch(() => '')).slice(0, 300)
  if (!(r.status === 200 || r.status === 201)) {
    const err = new InternalError(`档案写入 relay 失败（HTTP ${r.status}）: ${text}`)
    err.relayStatus = r.status
    throw err
  }
  // 致命细节：relay 业务失败也回 HTTP 200/201，真错在 body 的 code/message
  // （实例：公钥格式被拒 HTTP=200 + body={"code":500,…}——只看状态=假成功）
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  if (body && body.code !== 0) {
    const err = new InternalError(
      `档案写入被 relay 拒绝: ${String(body.message || body.code).slice(0, 200)}`,
    )
    err.relayBodyCode = body.code
    throw err
  }
  return true
}

/** 文件签验证（relay 口径）：z = sha256(prefix+len+sha256hex(bytes) 的 utf8) */
function verifyFileSignature(document, signatureDerHex, publicKeyHex, expectedAddrLower) {
  const { secp256k1, Keypairs } = sdk()
  const bytes = Buffer.from(JSON.stringify(document), 'utf8')
  const msg = Buffer.from(sha256hex(bytes), 'utf8')
  const z = createHash('sha256')
    .update(Buffer.concat([MSG_PREFIX_BYTES, Buffer.from(String(msg.length), 'utf8'), msg]))
    .digest()
  let sig
  try {
    sig = Buffer.from(signatureDerHex, 'hex')
  } catch {
    return false
  }
  if (!secp256k1.verify(sig, z, publicKeyHex)) return false
  try {
    // 公钥推导地址必须与会话地址同源（防移花接木：签名有效但不是你的档案）
    const derived = normalizeAddress(Keypairs.deriveAddress(publicKeyHex))
    return derived === expectedAddrLower
  } catch {
    return false
  }
}

/* ───────────────────────── 平台档案挂架（公开登记册） ─────────────────────────
 * 签发中的 VC 同步登记进平台自己的 DID 档案 credentials[]（app.ccda.ooo
 * 查询页按 issuer DID 即可见签发记录）。同 subject 只留当前一张：签发新卡
 * =撤旧卡——与台账互斥同构。登记是**展示副本**：失败只告警，绝不回滚领取/
 * 批准（台账才是真源；用户自己档案里的卡不受此处影响）。
 */
let _platformShelfAt = 0
const _vcCache = new Map() // addrLower → {at, vc}：凭证本体读回缓存（60s）
function isDshCard(c) {
  const vc = c?.credential || c
  const issuer = typeof vc?.issuer === 'string' ? vc.issuer : vc?.issuer?.id
  return (
    issuer === platform().did || (vc?.type || []).some((t) => Object.values(VC_TYPES).includes(t))
  )
}
function cardSubject(c) {
  const vc = c?.credential || c
  return String(vc?.credentialSubject?.id || '').toLowerCase()
}
/** 挂架写入的公钥形态 = wodecards 官方口径：swtc 族一律**压缩 hex（无 0x）**（relay 按此验文件签） */
function platformSignKey() {
  const { secp256k1 } = sdk()
  const priv = platform().priv
  try {
    return Buffer.from(secp256k1.getPublicKey(priv, true)).toString('hex')
  } catch {
    const vm = (platform().profile?.verificationMethod || [])[0] || {}
    return String(vm.publicKeyHex || '').replace(/^0x/, '') || platform().pubU
  }
}
function signWithPlatformKey(bytes) {
  const { secp256k1 } = sdk()
  const msg = Buffer.from(sha256hex(bytes), 'utf8')
  const z = createHash('sha256')
    .update(Buffer.concat([MSG_PREFIX_BYTES, Buffer.from(String(msg.length), 'utf8'), msg]))
    .digest()
  const s = secp256k1.sign(z, platform().priv)
  // 陷阱：toDERRawBytes() 返回 Uint8Array，它的 toString('hex') 会忽略参数
  // 产出"1,2,3"逗号串（relay 报 non-hex character）——必须走显式 hex 出口
  if (typeof s.toDERHex === 'function') return s.toDERHex()
  if (typeof s.toHex === 'function') return s.toHex('der')
  const b = typeof s.toDERRawBytes === 'function' ? s.toDERRawBytes() : s.toDER()
  return Buffer.from(b).toString('hex')
}
async function shelfCredential(vc) {
  try {
    const p = platform()
    if (!p.priv) throw new Error('平台私钥未加载')
    const canonical = normalizeToCanonical(
      p.did.replace(/^did:swtc:/, ''),
      `did:swtc:${p.did.replace(/^did:swtc:/, '')}.json`,
    )
    const read = await relayRead(canonical)
    const base = read.status === 'ok' && read.doc ? read.doc : p.profile
    const subj = cardSubject({ credential: vc })
    const list = (base.credentials || [])
      .filter((c) => !isDshCard(c) || cardSubject(c) !== subj)
      .map((c) => c.credential || c)
    list.push(vc)
    const doc = { ...base, credentials: list, updated: new Date().toISOString() }
    const signature = signWithPlatformKey(Buffer.from(JSON.stringify(doc), 'utf8'))
    await relayWrite({
      document: doc,
      fileName: `did:swtc:${canonical}.json`,
      publicKeyHex: platformSignKey(),
      signatureDerHex: signature,
      chain: cfg().chain,
    })
    _platformShelfAt = Date.now()
    return true
  } catch (err) {
    console.warn(
      `[credential-shelf] 平台档案登记失败（台账已生效，不影响凭证）: ${String(err?.message || err).slice(0, 140)}`,
    )
    return false
  }
}

/* ───────────────────────── legacy CWT 白名单 ───────────────────────── */

let _legacy = null
function legacySet() {
  if (_legacy) return _legacy
  const c = cfg()
  const map = new Map()
  try {
    const f = join(ROOT, c.legacyFile || 'data/legacy-cwt.json')
    if (!existsSync(f)) {
      _legacy = map
      return _legacy
    }
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    // 兼容两种形态：旧 registry 对象 {addr:{approvedAt,...}} 或数组 [{address,...}]
    if (Array.isArray(raw)) {
      for (const it of raw) {
        const a = normalizeAddress(String(it.address || it.addr || ''))
        if (a) map.set(a, it)
      }
    } else {
      for (const [a, entry] of Object.entries(raw)) {
        map.set(normalizeAddress(a), entry || {})
      }
    }
  } catch {
    /* 坏文件=空名单（不误发解限凭证） */
  }
  _legacy = map
  return _legacy
}
export function legacyHit(address) {
  return legacySet().get(normalizeAddress(address)) || null
}

/* ───────────────────────── 存储适配器（mongo/json 双轨） ───────────────────────── */

class MongoCredentialBackend {
  get provider() {
    return 'mongodb'
  }
  _col() {
    return getStore().col('credentials')
  }
  _apps() {
    return getStore().col('cwt_applications')
  }
  async get(addrLower) {
    return this._col().findOne({ _id: addrLower })
  }
  /** 管理端台账浏览：kind/状态筛选 + 地址模糊 + 签发时间倒序分页 */
  async listCreds({ kind = 'all', q = '', limit = 20, offset = 0 } = {}) {
    const flt = {}
    if (kind === 'did' || kind === 'cwt') flt.kind = kind
    if (q) flt._id = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    const total = await this._col().countDocuments(flt)
    const items = await this._col()
      .find(flt)
      .sort({ issuedAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray()
    return { items, total }
  }
  /** 幂等分配：已有返回既有（互斥天然由 _id 保证） */
  async assignIfAbsent(addrLower, doc) {
    try {
      const r = await this._col().insertOne({ _id: addrLower, ...doc })
      return { assigned: true, doc: { _id: addrLower, ...doc } }
    } catch (err) {
      if (err?.code === 11000) return { assigned: false, doc: await this.get(addrLower) }
      throw err
    }
  }
  async patch(addrLower, $set) {
    await this._col().updateOne({ _id: addrLower }, { $set })
    return this.get(addrLower)
  }
  /** 批准签发：整条替换为 cwt（did 凭证不复存在——两凭证不共存的台账侧强制） */
  async grantCwt(addrLower, doc) {
    await this._col().replaceOne({ _id: addrLower }, { _id: addrLower, ...doc }, { upsert: true })
    return this.get(addrLower)
  }
  async countByKind() {
    const out = { did: 0, cwt: 0 }
    for (const k of Object.keys(out)) out[k] = await this._col().countDocuments({ kind: k })
    return out
  }
  async insertApp(app) {
    await this._apps().insertOne(app)
    return app
  }
  async findApp(id) {
    return this._apps().findOne({ _id: id })
  }
  async patchApp(id, $set) {
    await this._apps().updateOne({ _id: id }, { $set })
    return this.findApp(id)
  }
  async hasPendingApp(addrLower) {
    return Boolean(await this._apps().findOne({ address: addrLower, status: 'pending' }))
  }
  async listApps({ status = 'all', limit = 10, offset = 0 } = {}) {
    const q = status === 'all' ? {} : { status }
    const total = await this._apps().countDocuments(q)
    const items = await this._apps()
      .find(q)
      .sort({ submittedAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray()
    // 越界回退由前端处理；rejected 裁剪保留最近 100 条（旧合同）
    if (status === 'rejected') {
      const stale = await this._apps()
        .find({ status: 'rejected' })
        .sort({ submittedAt: -1 })
        .skip(APP_REJECTED_KEEP)
        .limit(1000)
        .project({ _id: 1 })
        .toArray()
      if (stale.length) await this._apps().deleteMany({ _id: { $in: stale.map((d) => d._id) } })
    }
    return { items, total }
  }
  /** 进入用户中心的豁免缓存刷新源：全量 cwt 地址集合不大，直接查 */
  async isCwt(addrLower) {
    return Boolean(
      await this._col().findOne({ _id: addrLower, kind: 'cwt' }, { projection: { _id: 1 } }),
    )
  }
  async listCwtAddresses() {
    return (
      await this._col()
        .find({ kind: 'cwt' }, { projection: { _id: 1 } })
        .toArray()
    ).map((d) => d._id)
  }
  async listClaimed() {
    return (
      await this._col()
        .find(
          { state: 'claimed', profileDid: { $nin: [null, undefined] } },
          { projection: { profileDid: 1 } },
        )
        .toArray()
    ).map((d) => d.profileDid)
  }
}

class JsonCredentialBackend {
  /** dir 注入为测试留缝（vitest 绝不写真实 data/） */
  constructor(dir = join(ROOT, 'data')) {
    this._fileCred = join(dir, 'credentials.json')
    this._fileApps = join(dir, 'cwt-applications.json')
    this._dir = dir
  }
  get provider() {
    return 'json'
  }
  _load(f) {
    try {
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
    } catch {
      return null
    }
  }
  _save(f, obj) {
    const { mkdirSync } = require('node:fs')
    mkdirSync(this._dir, { recursive: true })
    writeFileSync(f, JSON.stringify(obj, null, 2))
  }
  async get(addrLower) {
    return (this._load(this._fileCred) || {})[addrLower] || null
  }
  async assignIfAbsent(addrLower, doc) {
    const all = this._load(this._fileCred) || {}
    if (all[addrLower]) return { assigned: false, doc: all[addrLower] }
    all[addrLower] = { _id: addrLower, ...doc }
    this._save(this._fileCred, all)
    return { assigned: true, doc: all[addrLower] }
  }
  async listCreds({ kind = 'all', q = '', limit = 20, offset = 0 } = {}) {
    const all = Object.values(this._load(this._fileCred) || {})
      .filter((d) => (kind === 'did' || kind === 'cwt' ? d.kind === kind : true))
      .filter((d) => !q || String(d._id).toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')))
    return { items: all.slice(offset, offset + limit), total: all.length }
  }
  async patch(addrLower, $set) {
    const all = this._load(this._fileCred) || {}
    if (!all[addrLower]) return null
    all[addrLower] = { ...all[addrLower], ...$set }
    this._save(this._fileCred, all)
    return all[addrLower]
  }
  async grantCwt(addrLower, doc) {
    const all = this._load(this._fileCred) || {}
    all[addrLower] = { _id: addrLower, ...doc }
    this._save(this._fileCred, all)
    return all[addrLower]
  }
  async countByKind() {
    const all = Object.values(this._load(this._fileCred) || {})
    return {
      did: all.filter((d) => d.kind === 'did').length,
      cwt: all.filter((d) => d.kind === 'cwt').length,
    }
  }
  async insertApp(app) {
    const apps = this._load(this._fileApps) || []
    apps.unshift(app)
    this._save(this._fileApps, apps)
    return app
  }
  async findApp(id) {
    return (this._load(this._fileApps) || []).find((a) => a._id === id) || null
  }
  async patchApp(id, $set) {
    const apps = this._load(this._fileApps) || []
    const i = apps.findIndex((a) => a._id === id)
    if (i < 0) return null
    apps[i] = { ...apps[i], ...$set }
    this._save(this._fileApps, apps)
    return apps[i]
  }
  async hasPendingApp(addrLower) {
    return (this._load(this._fileApps) || []).some(
      (a) => a.address === addrLower && a.status === 'pending',
    )
  }
  async listApps({ status = 'all', limit = 10, offset = 0 } = {}) {
    let apps = this._load(this._fileApps) || []
    if (status !== 'all') apps = apps.filter((a) => a.status === status)
    if (status === 'rejected' && apps.length > APP_REJECTED_KEEP) {
      apps = apps.slice(0, APP_REJECTED_KEEP)
      this._save(
        this._fileApps,
        (this._load(this._fileApps) || []).filter((a) => a.status !== 'rejected').concat(apps),
      )
    }
    return { items: apps.slice(offset, offset + limit), total: apps.length }
  }
  async isCwt(addrLower) {
    const d = (this._load(this._fileCred) || {})[addrLower]
    return Boolean(d && d.kind === 'cwt')
  }
  async listCwtAddresses() {
    const all = this._load(this._fileCred) || {}
    return Object.entries(all)
      .filter(([, d]) => d && d.kind === 'cwt')
      .map(([a]) => a)
  }
  async listClaimed() {
    const all = this._load(this._fileCred) || {}
    return Object.values(all)
      .filter((d) => d && d.state === 'claimed' && d.profileDid)
      .map((d) => d.profileDid)
  }
}

function backend() {
  if (_injectedBackend) return _injectedBackend
  if (CONFIG.storage?.provider === 'mongodb') return _mongoBackend
  return _jsonBackend
}
let _mongoBackend = null
let _jsonBackend = null
let _injectedBackend = null

/* ───────────────────────── 门面 ───────────────────────── */

class CredentialService {
  constructor() {
    this._cwtSet = new Set() // 解除限制地址快照（usage 热路径同步查，init 水合+周期刷新）
    this._hydrateAt = 0
    this._refreshTimer = null
  }
  _resetCache() {
    this._cwtSet.clear()
    this._hydrateAt = 0
  }
  async init() {
    _mongoBackend = _mongoBackend || new MongoCredentialBackend()
    _jsonBackend = _jsonBackend || new JsonCredentialBackend()
    if (CONFIG.storage?.provider === 'mongodb') {
      await getStore().connect()
      await getStore()
        .ensureIndexes()
        .catch(() => {})
    }
    await this.refreshExemptSet()
    if (!this._refreshTimer) {
      // 5 分钟兜底水合（外部直改库/多写入窗口）；unref 绝不误拖测试进程
      this._refreshTimer = setInterval(() => this.refreshExemptSet().catch(() => {}), 300000)
      this._refreshTimer.unref()
    }
  }

  get enabled() {
    return cfg().enabled !== false
  }

  /** 水合/刷新解除限制快照（mongo 全量 cwt 地址；json 直读文件）。approve/签发路径也会即时补集 */
  async refreshExemptSet() {
    try {
      const addrs = await backend().listCwtAddresses()
      this._cwtSet = new Set(addrs)
      this._hydrateAt = Date.now()
    } catch {
      /* 存储抖动保旧集（上活错误方向：保豁免=可能多豁免 vs 清集=全体误限时；取保旧） */
    }
  }

  /** usage 热路径同步判据：是否持有 CWT 解限凭证（与领取状态无关） */
  isExemptSync(address) {
    if (!this.enabled) return false
    return this._cwtSet.has(normalizeAddress(address))
  }

  _markExempt(addrLower) {
    this._cwtSet.add(addrLower)
    this._hydrateAt = Date.now()
  }

  /**
   * 进入用户中心（核心钩子）：已有凭证→原样返回；无→分配。
   * 返回 { credential, popup, legacy }；popup=true 表示有 assigned 未领取→前端弹窗。
   */
  async enter(address) {
    const addrLower = normalizeAddress(address)
    const b = backend()
    let cred = await b.get(addrLower)
    if (!cred) {
      const lg = legacyHit(addrLower)
      if (lg) {
        await b.grantCwt(addrLower, this._cwtDoc(addrLower, 'legacy', lg))
        cred = await b.get(addrLower)
        this._markExempt(addrLower)
        return {
          credential: this._public(cred),
          popup: true,
          legacy: { approvedAt: lg.approvedAt || null },
        }
      }
      const r = await b.assignIfAbsent(addrLower, this._didDoc(addrLower, 'auto'))
      cred = r.doc
    }
    // 登录即续发：已领取卡到期 → 当场重铸新卡换台账+异步换平台册（豁免无缝衔接）
    const renewed = await this._renewIfExpired(cred, addrLower)
    // 链上验真：异步跑（resolve 冷启动秒级，不拖登录响应），结果下次 status 可见
    if (renewed.cred.state === 'claimed') this.onChainVerify(addrLower).catch(() => {})
    return {
      credential: this._public(renewed.cred),
      popup: renewed.cred.state === 'assigned',
      legacy: null,
      renewed: renewed.renewed,
    }
  }

  /**
   * 到期续发（登录触发，无后台定时器）：豁免只在用户使用容器时需要，
   * 使用必先登录——enter 就是唯一需要有效凭证的时刻，当场检查当场续。
   * 已领取卡过期 → 本地重铸新 1 年卡 → 台账记新 vcId/expiresAt
   * → 平台册异步换卡（链上分发记录跟上，失败仅告警）→ 豁免即时保持。
   * 用户自己档案里的旧卡属展示副本：下次点领取自然换发，不在此处强刷。
   */
  async _renewIfExpired(cred, addrLower) {
    if (!cred?.vcId || !cred.expiresAt) return { cred, renewed: false }
    if (new Date(cred.expiresAt).getTime() > Date.now()) return { cred, renewed: false }
    const vc = await mintVC(cred.kind, addrLower)
    const patched = await backend().patch(addrLower, {
      vcId: vc.id,
      expiresAt: vc.expirationDate || null,
      renewedAt: new Date().toISOString(),
    })
    if (cred.kind === KINDS.CWT) this._markExempt(addrLower)
    // 平台册换卡异步：不拖慢登录响应；失败不影响台账（下次登录会再试）
    shelfCredential(vc).catch(() => {})
    return {
      cred: patched || { ...cred, vcId: vc.id, expiresAt: vc.expirationDate },
      renewed: true,
    }
  }

  /**
   * 链上验真（登录触发、异步执行、结果落台账）：
   * 身份在门上验（钱包签名）→ 资格从台账续（_renewIfExpired）→ 真伪从链上查（这里）。
   * 用官方 SDK verifyCredential 走 wodecards 同一条路：resolver 取签发公钥，
   * proof 签名/有效期/结构全由 SDK 判。读档网络失败≠卡有问题（保留上次结论）。
   */
  async onChainVerify(addrLower, opts = {}) {
    const b = backend()
    const cred = await b.get(addrLower)
    if (!cred || cred.state !== 'claimed' || !cred.vcId || !cred.profileDid) return null
    const prev = cred.onChain || {}
    // 节流：ok 结论保鲜 5 分钟；失效结论 1 分钟内不重复锤（用户刷新页面别轰炸 relay）
    const ttl = prev.status === 'ok' ? 300000 : 60000
    if (!opts.force && prev.at && Date.now() - new Date(prev.at).getTime() < ttl) return prev
    const read = await relayRead(cred.profileDid.replace(/^did:swtc:/, ''))
    if (read.status === 'probe-fail') return prev // 网络抖动不下"失效"结论
    let next
    if (read.status !== 'ok') {
      next = {
        status: 'missing',
        at: new Date().toISOString(),
        reason: '档案读不到（可能已被删除）',
      }
    } else {
      const cards = (read.doc.credentials || []).map((c) => c.credential || c)
      const vc = cards.find((c) => c.id === cred.vcId)
      const stale = vc ? null : cards.filter(isDshCard).pop()
      if (stale) {
        // 档案有平台签发的卡但编号对不上 = 续发后未同步的旧卡（可见、可修复）
        next = {
          status: 'stale',
          at: new Date().toISOString(),
          reason: `档案里还是旧卡（…${String(stale.id).slice(-12)}），点领取同步新卡`,
        }
      } else if (!vc) {
        next = {
          status: 'missing',
          at: new Date().toISOString(),
          reason: '档案里没有这张凭证（可能被删除，重新领取可找回）',
        }
      } else {
        try {
          const { verifyCredential, createDocumentLoader } = sdk()
          createDocLoader() // 确保 secp256k1-2019 context 已注册（验签 loader 共享全局注册表）
          const loader = createDocumentLoader({ resolver: getSwtcResolver() })
          const v = await verifyCredential(vc, { documentLoader: loader, compactProof: true })
          next = v.verified
            ? { status: 'ok', at: new Date().toISOString() }
            : {
                status: 'invalid',
                at: new Date().toISOString(),
                reason: String((v.errors && v.errors[0]) || '验签未通过').slice(0, 160),
              }
        } catch (err) {
          // SDK 自身失败（context 拉取等）归为探测失败：不动已有结论
          next = { ...prev, reason: String(err?.message || err).slice(0, 140) }
        }
      }
    }
    await b.patch(addrLower, { onChain: next })
    return next
  }

  _didDoc(addrLower, source) {
    const now = new Date().toISOString()
    return {
      kind: KINDS.DID,
      state: 'assigned',
      source,
      vcId: null,
      expiresAt: null,
      issuedAt: now,
      claimedAt: null,
    }
  }
  _cwtDoc(addrLower, source, extra = {}) {
    const now = new Date().toISOString()
    return {
      kind: KINDS.CWT,
      state: 'assigned',
      source,
      vcId: extra.vcId || null,
      expiresAt: extra.expiresAt || null,
      issuedAt: now,
      claimedAt: null,
      legacyApprovedAt: extra.approvedAt || null,
    }
  }

  _public(doc) {
    if (!doc) return null
    return {
      kind: doc.kind,
      state: doc.state,
      source: doc.source,
      issuedAt: doc.issuedAt,
      claimedAt: doc.claimedAt || null,
      vcId: doc.vcId || null,
      expiresAt: doc.expiresAt || null,
      profileDid: doc.profileDid || null,
      onChain: doc.onChain || null,
    }
  }

  /**
   * 领取第一步：组装要写进用户档案的文档（含平台真签 VC）。
   * 前置：ledger 有该凭证且 assigned；用户 IPFS 档案存在（否则 NO_PROFILE→前端指引）。
   * canonicalAddr：用户插件提供的原始大小写地址（前端已 getPublicKey 同址），服务端校验小写同会话。
   */
  async buildClaimDocument(address, canonicalAddr) {
    const addrLower = normalizeAddress(address)
    if (normalizeAddress(canonicalAddr) !== addrLower) {
      throw new BadRequestError('档案地址与登录地址不一致，请核对钱包账户')
    }
    const cred = await backend().get(addrLower)
    if (!cred) throw new BadRequestError('尚未分配凭证')
    // 已领取也允许再次"领取"=同步：续发后台账/平台册是新卡而档案还是旧卡，
    // 用户签名重落档让三方（台账/平台册/个人档案）信息归一（链上一致原则）
    const reissue = cred.state === 'claimed'
    // 用户主动点领取 → bust 实探（不吃 60s 负缓存：网络抖一次不能固化成"你没 DID"）
    const hasProfile = await l1ProfileHit(canonicalAddr, { bust: true })
    if (!hasProfile) {
      return {
        noProfile: true,
        didGenUrl: cfg().didGenUrl || 'https://app.ccda.ooo/#/',
        expectedAddress: canonicalAddr,
      }
    }
    const read = await relayRead(canonicalAddr)
    if (read.status === 'probe-fail') {
      // 连不上≠没有：绝不误导用户去重新生成 DID（那会签错地址的真风险）
      return {
        probeFailed: true,
        hint: '档案服务暂时连不上，请稍后重试领取（您的档案不会被误判缺失）',
      }
    }
    if (read.status === 'absent' || !read.doc) {
      return {
        noProfile: true,
        didGenUrl: cfg().didGenUrl || 'https://app.ccda.ooo/#/',
        expectedAddress: canonicalAddr,
      }
    }
    const vc = await mintVC(cred.kind, addrLower)
    // 互斥在档案侧的落实：先摘掉平台签发的 Dsh 凭证（含历史信封形态），再放当前这张
    const doc = {
      ...read.doc,
      credentials: [...(read.doc.credentials || []).filter((c) => !isDshCard(c)), vc],
    }
    doc.updated = new Date().toISOString()
    return {
      document: doc,
      fileName: `did:swtc:${canonicalAddr}.json`,
      profileAddress: canonicalAddr,
      chain: cfg().chain || 'swtc',
      vcId: vc.id,
      reissue,
    }
  }

  /**
   * 凭证本体读回（用户端"查看凭证"）：真源=用户档案里那张平台签发的卡。
   * 按台账 vcId 精确匹配（防档案里混入的别家卡误显示）；60s 进程缓存抗刷新。
   */
  async getClaimedCredential(address) {
    const addrLower = normalizeAddress(address)
    const cred = await backend().get(addrLower)
    if (!cred || cred.state !== 'claimed' || !cred.profileDid)
      throw new BadRequestError('凭证尚未领取，无法查看凭证本体')
    const ck = _vcCache.get(addrLower)
    if (ck && Date.now() - ck.at < 60000) return ck.out
    const read = await relayRead(cred.profileDid.replace(/^did:swtc:/, ''))
    if (read.status !== 'ok') throw new BadRequestError('档案暂时读不到（网络抖动），请稍后再试')
    const cards = (read.doc.credentials || []).filter(isDshCard).map((c) => c.credential || c)
    const vc = cards.find((c) => c.id === cred.vcId)
    const consistent = !!vc
    const shown = vc || cards[cards.length - 1]
    if (!shown) throw new BadRequestError('档案里找不到这张凭证（可能已被换卡，请重新打开页面）')
    const out = { credential: shown, consistent }
    _vcCache.set(addrLower, { at: Date.now(), out })
    return out
  }

  /**
   * 领取第二步：验用户文件签 → relay 写 → 台账置 claimed。
   * 注意：relay 快照有 10-60s debounce，写后不阻塞读回确认（旧版实证：写 201 即受理）。
   */
  async claimUpload(address, { document, fileName, publicKey, signature }) {
    const addrLower = normalizeAddress(address)
    if (!document || typeof document !== 'object' || !fileName || !publicKey || !signature) {
      throw new BadRequestError('缺少 document/fileName/publicKey/signature')
    }
    // 文件名必须承载本地址的 DID（did:swtc:<canonical>.json，canonical 大小写不限但小写化须同会话地址），
    // 且档案 id 与文件名一致——防签 A 传 B
    const canon = normalizeToCanonical(address, fileName)
    if (fileName !== `did:swtc:${canon}.json` || normalizeAddress(canon) !== addrLower) {
      throw new BadRequestError('档案文件名与登录地址不匹配')
    }
    if (
      document.id &&
      normalizeAddress(String(document.id).replace(/^did:swtc:/, '')) !== addrLower
    ) {
      throw new BadRequestError('档案 id 与登录地址不匹配')
    }
    if (!verifyFileSignature(document, signature, publicKey, addrLower)) {
      const err = new BadRequestError('文件签名校验失败（请用领取时提示的钱包账户签名）')
      err.code = 'BAD_SIGNATURE'
      throw err
    }
    const cred = await backend().get(addrLower)
    if (!cred) throw new BadRequestError('尚未分配凭证')
    await relayWrite({
      document,
      fileName,
      publicKeyHex: publicKey,
      signatureDerHex: signature,
      chain: cfg().chain,
    })
    // 签名覆盖了字节，末项必是平台签发的 VC
    const last = (document.credentials || [])[document.credentials?.length - 1]
    const patched = await backend().patch(addrLower, {
      state: 'claimed',
      claimedAt: new Date().toISOString(),
      profileDid: document.id || null,
      vcId: last?.id || null,
      expiresAt: last?.expirationDate || null,
      onChain: null, // 新卡刚落档：链上验真状态重开（登录链路会异步补验）
    })
    if (last && isDshCard(last)) await shelfCredential(last)
    return { ok: true, credential: this._public(patched) }
  }

  /** CWT 申请：必须已领取 DID 普通凭证；一人一 pending */
  async applyCwt(address, meta = {}) {
    const addrLower = normalizeAddress(address)
    const cred = await backend().get(addrLower)
    if (!cred || cred.kind !== KINDS.DID) throw new BadRequestError('需先持有并领取 DID 普通凭证')
    if (cred.state !== 'claimed')
      throw new BadRequestError('凭证尚未领取，请先在账户详情领取后再申请')
    if (await backend().hasPendingApp(addrLower))
      throw new BadRequestError('已有待审批申请，请等待管理员处理')
    const app = {
      _id: `app_${addrLower.slice(0, 8)}_${Date.now().toString(36)}`,
      address: addrLower,
      // 展示统一为原始大小写（来自领取时记录的用户档案 DID；匹配仍以 address 为准）
      addressDisplay: (cred.profileDid || '').replace(/^did:swtc:/, '') || addrLower,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      usr: meta.usr || 'dsh-usr',
      note: String(meta.note || '').slice(0, 500),
      decidedAt: null,
      decidedBy: null,
    }
    await backend().insertApp(app)
    return { ok: true, id: app._id, status: app.status }
  }

  /** 本人申请状态（账户详情展示） */
  async myApplication(address) {
    const { items } = await backend().listApps({ status: 'all', limit: 50, offset: 0 })
    const mine = items.filter((a) => a.address === normalizeAddress(address))
    return (
      mine.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)))[0] || null
    )
  }

  /* ---- 管理端 ---- */
  async listApplications(opts) {
    return backend().listApps(opts)
  }

  /** 凭证台账浏览（谁持有什么卡/状态/来源/时间） */
  async listCredentials(opts) {
    const { items, total } = await backend().listCreds(opts)
    return {
      items: items.map((d) => ({
        address: d._id,
        addressDisplay: (d.profileDid || '').replace(/^did:swtc:/, '') || d._id,
        ...this._public(d),
      })),
      total,
    }
  }

  /** 路由层查单（批准/拒绝前先拿申请人地址做签名绑定） */
  async _findApp(id) {
    return backend().findApp(id)
  }

  /** 批准 = 签发 CWT 凭证：台账整条替换（did 凭证移除=互斥强制），豁免即时生效 */
  async approveApplication(appId, adminAddress) {
    const b = backend()
    const app = await b.findApp(appId)
    if (!app) throw new BadRequestError('申请不存在')
    if (app.status !== 'pending') throw new BadRequestError(`申请已是 ${app.status} 状态`)
    const lg = legacyHit(app.address) || {}
    const doc = this._cwtDoc(app.address, 'approval', { approvedAt: lg.approvedAt })
    const cred = await b.grantCwt(app.address, doc)
    await b.patchApp(appId, {
      status: 'approved',
      decidedAt: new Date().toISOString(),
      decidedBy: normalizeAddress(adminAddress),
    })
    this._markExempt(app.address)
    return { ok: true, credential: this._public(cred) }
  }

  async rejectApplication(appId, adminAddress, reason) {
    const b = backend()
    const app = await b.findApp(appId)
    if (!app) throw new BadRequestError('申请不存在')
    if (app.status !== 'pending') throw new BadRequestError(`申请已是 ${app.status} 状态`)
    await b.patchApp(appId, {
      status: 'rejected',
      decidedAt: new Date().toISOString(),
      decidedBy: normalizeAddress(adminAddress),
      reason: String(reason || '').slice(0, 300),
    })
    return { ok: true }
  }

  /* ---- 豁免判定（usage 限制接线）：内存快照 + 周期水合，热路径零 I/O ---- */
  async isExempt(address) {
    if (!this.enabled) return false
    const addrLower = normalizeAddress(address)
    if (this._cwtSet.has(addrLower)) return true
    // 快照未含（新批准竞态/冷缓存）→ 实查一次库并回填
    try {
      const now = await backend().isCwt(addrLower)
      if (now) this._markExempt(addrLower)
      return now
    } catch {
      return false // 存储抖动不误豁免（保守=宁可限时）
    }
  }

  /** 平台档案补登：把已领取用户档案里的实卡同步上平台登记册（幂等，可反复跑） */
  async resyncShelf() {
    const dids = await backend().listClaimed()
    let shelved = 0
    let failed = 0
    for (const did of dids) {
      const addr = String(did).replace(/^did:swtc:/, '')
      const read = await relayRead(addr)
      if (read.status !== 'ok') {
        failed++
        continue
      }
      const cards = (read.doc.credentials || []).filter(isDshCard)
      const last = cards[cards.length - 1]
      if (!last) continue
      // 顺带回填存量台账缺的凭证号（vcId 字段上线前领取的用户）
      const row = await backend().get(addr.toLowerCase())
      if (row && !row.vcId && last.id) await backend().patch(addr.toLowerCase(), { vcId: last.id })
      if (await shelfCredential(last.credential || last)) shelved++
      else failed++
    }
    return { total: dids.length, shelved, failed }
  }

  async stats() {
    return backend().countByKind()
  }

  /** legacy 名单的地址列表（回填脚本 dry 模式与巡检用） */
  _legacyAddrs() {
    return [...legacySet().keys()].filter(Boolean)
  }

  /** legacy 名单变更后的重放：已登记的 legacy 地址若无凭证 → 直接分配 CWT（回填脚本用） */
  async backfillLegacy() {
    let created = 0
    const b = backend()
    for (const addrLower of legacySet().keys()) {
      if (!addrLower) continue
      const r = await b.assignIfAbsent(
        addrLower,
        this._cwtDoc(addrLower, 'legacy', { approvedAt: legacySet().get(addrLower)?.approvedAt }),
      )
      if (r.assigned) {
        created++
        this._markExempt(addrLower)
      }
    }
    return { created, total: legacySet().size }
  }
}

function normalizeToCanonical(addr, fileName) {
  // 文件名即 did:swtc:<canonical>.json；从 fileName 取回 canonical 再比对
  const m = /did:swtc:([A-Za-z0-9]+)\.json/.exec(fileName || '')
  return m ? m[1] : addr
}

export const credentialService = new CredentialService()
