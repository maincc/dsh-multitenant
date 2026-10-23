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
 *  - 撤销/降权（v1.5 刀5A，推翻旧"暂不做撤销"拍板）：撤=台账重签降格（批准史决定回纯 cwt
 *    还是 did）+ 登记册摘除旧卡（unshelfCredential）；旧卡验签永真但已不是台账当前卡，
 *    判权读结论快照（当秒摘除），重放无门（claim 门禁校验卡型/roles 与台账一致）。
 *  - 管理员（v1.5）：任命=重签 cwt 卡带 roles:['admin']（admin-auto，免申请免自审，
 *    免时限复用 cwt 豁免链天然生效）；判权 isAdmSync 读台账签发结论快照 _admSet，
 *    config∪admin.json 名册只是配发/撤销的策略输入。
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

import { CONFIG, ROOT, getAdminAddresses, isAdmin } from '../config/config.js'
import { getStore } from './mongo.store.js'
import { normalizeAddress } from '../utils/address.js'
import { l1ProfileHit, getSwtcResolver } from './did.service.js'
import { InternalError, BadRequestError } from '../utils/errors.js'

const require = createRequire(import.meta.url)
const sha256hex = (b) => createHash('sha256').update(b).digest('hex')

export const KINDS = Object.freeze({ DID: 'did', CWT: 'cwt' })
export const VC_TYPES = Object.freeze({ did: 'DshMemberCredential', cwt: 'DshCwtCredential' })

// 官网生态词表（2026-10-23 官方 @jccdex/vc-vocabularies brands/*.js 源码定案）：
// SWTC 链品牌=jdid（词汇根 jdid.cn），EVM 链品牌=ccdao（ccda.ooo）。我们发 SWTC 卡。
const ECOSYSTEM_VC_VOCAB = 'https://jdid.cn/vc/v1'
const ECOSYSTEM_DID_VOCAB = 'https://jdid.cn/did/v1'

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
  _rosterOverride = inj.roster === undefined ? null : inj.roster
  if (inj.legacy !== undefined)
    _legacy = inj.legacy instanceof Map ? inj.legacy : new Map(Object.entries(inj.legacy))
  _vcCache.clear()
  credentialService._resetCache()
}

/** 挂架入口（串行包装后）暴露给测试：并发顺序合并语义的回归位用 */
export const _shelfCredentialForTest = shelfCredential
export const _mintVCForTest = mintVC
export const _isPlatformMintedForTest = isPlatformMinted
export const _syncProfileIdentityForTest = syncProfileIdentity

/* ───────────────────────── VC 签发 ───────────────────────── */

/**
 * 平台真签一张 VC（kind: did|cwt）——**生态统一形态**（2026-10-23 官方词表
 * @jccdex/vc-vocabularies 源码 + relay 实卡双重定案）：
 *  - @context = [W3C credentials/v1, jdid 品牌内联术语]。SWTC 链=官方 jdid
 *    品牌：类型 URI `https://jdid.cn/vc/v1#<Type>`，属性 subject 术语归
 *    did/v1（官方 NFTOwnership 先例 chainId/tokenId/owner 同款），声明 version
 *    术语（官方全 profile 惯例，subject 可不用——电话卡即如此）。
 *  - id = 生态模板形（实卡逐字仿写，如 #phone-<ISO>-did:swtc:<issuer>-0）：
 *    `{持有人canonical DID}#dsh-{member|cwt}-{ISO时间}-{平台DID}-{防碰后缀}`
 *    ——卡进持有人命名空间、fragment 内嵌相关方 DID，官网按惯例解析签发方
 *    （旧形态 id=平台命名空间+随机尾巴，官网读不出→弹窗签发方空白）。
 *  - holderDid 传档案实际大小写（台账 profileDid/文件名 canonical），非法或
 *    缺省退回小写形态。subject 值去自创 urn 前缀（'auto-assign'/'approved' 裸词）。
 * 旧代卡（#credential-*）由 isPlatformMinted 双代判据继续认，存量无需迁移。
 */
async function mintVC(kind, subjectAddrLower, roles = [], holderDid = null) {
  const p = platform()
  const typeName = VC_TYPES[kind]
  if (!typeName) throw new BadRequestError(`未知凭证类型: ${kind}`)
  const now = new Date()
  let holder = `did:swtc:${subjectAddrLower}`
  if (
    typeof holderDid === 'string' &&
    /^did:swtc:/i.test(holderDid) &&
    normalizeAddress(holderDid.replace(/^did:swtc:/i, '')) === subjectAddrLower
  ) {
    holder = holderDid // 保留档案实际大小写（生态卡 id 均如此）
  }
  const slug = kind === 'did' ? 'member' : 'cwt'
  const descriptor = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      {
        [typeName]: `${ECOSYSTEM_VC_VOCAB}#${typeName}`,
        version: ECOSYSTEM_DID_VOCAB,
        tier: `${ECOSYSTEM_DID_VOCAB}#tier`,
        dailyMinutes: `${ECOSYSTEM_DID_VOCAB}#dailyMinutes`,
        verifiedVia: `${ECOSYSTEM_DID_VOCAB}#verifiedVia`,
        cwtGrant: `${ECOSYSTEM_DID_VOCAB}#cwtGrant`,
        roles: `${ECOSYSTEM_DID_VOCAB}#roles`,
      },
    ],
    id: `${holder}#dsh-${slug}-${now.toISOString()}-${p.did}-${Math.random().toString(36).slice(2, 6)}`,
    type: ['VerifiableCredential', typeName],
    // issuer 必须是【纯 DID 字符串】——2026-10-23 实测教训：VC v1 上下文对 issuer 有
    // @protected + @type:@id 强制，{id,name} 节点形态在 jsonld safe canonize 必抛
    // "Safe mode validation error."（invalid property: name），签发直接炸（存入 500）。
    // 生态实卡同款：全部 issuer=纯字符串；显示名走 issuer DID 档案 Profile 端点。
    issuer: p.did,
    issuanceDate: now.toISOString(),
    expirationDate: new Date(now.getTime() + 365 * 864e5).toISOString(),
    credentialSubject:
      kind === 'did'
        ? {
            id: `did:swtc:${subjectAddrLower}`,
            tier: 1,
            dailyMinutes: cfgDailyMinutes(),
            verifiedVia: 'auto-assign',
          }
        : {
            id: `did:swtc:${subjectAddrLower}`,
            tier: 1,
            cwtGrant: 'approved',
            verifiedVia: 'cwt',
            ...(Array.isArray(roles) && roles.length ? { roles } : {}),
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

/**
 * claimUpload 的防假卡判据：末项卡必须 ①id 是平台 DID 签发格式 ②subject=本地址
 * ③平台真签（SDK 验签走 DID 解析的 secp256k1 公钥）。
 * 任何异常（含 context 拉取失败）返回 false——对"无法确认"写操作必须关门
 * （探测失败铁律：拒绝可重试的上传，绝不让假卡进台账）。
 */
async function isPlatformMinted(vc, subjectAddrLower) {
  const p = platform()
  if (!vc || typeof vc !== 'object') return false
  // id 判据双代（2026-10-23 生态统一）：
  //  · 新代=生态形：卡进持有人命名空间（大小写不限）+ fragment `dsh-<类型>-` 起头
  //    + 内嵌平台 DID 字符串（官网按此惯例解析"签发方"）；
  //  · 旧代兼容：`<平台DID>#credential-*`（存量卡不迁移）。
  // 两代都只是**辅助闸门**，主闸门永远是下面的 SDK 平台真签验签。
  const idStr = String(vc.id || '')
  const hashAt = idStr.indexOf('#')
  const idOk = idStr.startsWith(`${p.did}#credential-`)
    ? true
    : hashAt > 0 &&
      idStr.slice(0, hashAt).toLowerCase() === `did:swtc:${subjectAddrLower}` &&
      /^dsh-(member|cwt)-/.test(idStr.slice(hashAt + 1)) &&
      idStr
        .slice(hashAt + 1)
        .toLowerCase()
        .includes(p.did.toLowerCase())
  if (!idOk) return false
  if (
    normalizeAddress(String(vc.credentialSubject?.id || '').replace(/^did:swtc:/, '')) !==
    subjectAddrLower
  )
    return false
  try {
    const { verifyCredential, createDocumentLoader } = sdk()
    createDocLoader() // secp256k1-2019 context 注册（与 onChainVerify 同一条路）
    const loader = createDocumentLoader({ resolver: getSwtcResolver() })
    const v = await verifyCredential(vc, { documentLoader: loader, compactProof: true })
    return v?.verified === true
  } catch {
    return false
  }
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
  // ⚠️ 事故复盘（2026-10 审计）：此前把所有非 2xx 都归 absent——relay/反代 500/502/429
  // 被当成"档案不存在"，验真落假 missing、scaffold 误导用户去重新生成 DID。
  // 语义按 :198 文档对齐：absent=relay 明确说没有；服务端故障/未知状态=probe-fail，
  // 消费方（onChainVerify/buildClaimDocument/getClaimedCredential）已有保守分支接住。
  if (!r.ok) return { status: r.status === 404 ? 'absent' : 'probe-fail', doc: null }
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
  // ⚠️ 事故复盘（2026-10 审计）：此前 `if (body && body.code !== 0)`——body 解析
  // 失败（网关 200+HTML/空体）时 body=null，直接放行=假成功：台账置 claimed
  // 而档案里根本没有卡，用户永远读不到本体。成功唯一形态=可解析 JSON 且 code===0。
  if (!body || body.code !== 0) {
    const err = new InternalError(
      `档案写入 relay 未确认成功（${text ? String(body?.message ?? body?.code) : '响应体不可解析'}）: ${text.slice(0, 120)}`,
    )
    if (body) err.relayBodyCode = body.code
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
// 挂架是"读档→改→写档"的复合动作，两个 await 之间可被并发插队：两张卡同时
// 挂架会交叉丢更新（后写覆盖前写）。平台登记册只有本进程一个写者，
// 进程级 Promise 队列就是精确解（2026-10 审计）。
let _shelfChain = Promise.resolve()
function shelfCredential(vc) {
  const step = () => _shelfStep(vc)
  const result = _shelfChain.then(step, step)
  // 链条永不 reject（失败语义已在 _shelfStep 内吞成 false），防断链
  _shelfChain = result.then(
    () => {},
    () => {},
  )
  return result
}
async function _shelfStep(vc) {
  try {
    const p = platform()
    if (!p.priv) throw new Error('平台私钥未加载')
    const canonical = normalizeToCanonical(
      p.did.replace(/^did:swtc:/, ''),
      `did:swtc:${p.did.replace(/^did:swtc:/, '')}.json`,
    )
    const read = await relayRead(canonical)
    // ⚠️ 事故复盘（2026-10 审计）：此前 absent 与 probe-fail 合并兜底到本地快照
    // p.profile——一次读档抖动就会用"快照+这张新卡"整篇覆写线上平台登记册，
    // 抹掉其他所有已签发卡的登记。铁律：读失败绝不写。probe-fail 直接放弃本次
    // 挂架（fire-and-forget 语义天然容忍：下次登录/resyncShelf 自然补登）；
    // 只有"档案确实不存在"（absent，首次建档）才允许用本地快照起步。
    if (read.status === 'probe-fail') {
      console.warn(
        `[shelf] 平台档案读档失败（网络/relay 故障），本次挂架放弃：${String(vc?.id).slice(-24)} 待下次补登`,
      )
      return false
    }
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
    return true
  } catch (err) {
    console.warn(
      `[credential-shelf] 平台档案登记失败（台账已生效，不影响凭证）: ${String(err?.message || err).slice(0, 140)}`,
    )
    return false
  }
}

/**
 * 从平台登记册摘除某地址的 Dsh 卡（v1.5 撤销链）。读档失败绝不写（probe-fail 铁律，
 * 同 _shelfStep）；确属缺席/网络失败返回 false 不炸调用方（降格路径里这是尽力轨：
 * 判权即时性由台账+_unmark 保证，摘册是对外一致性复核）。
 */
function unshelfCredential(addrLower) {
  const step = () => _unshelfStep(addrLower)
  const result = _shelfChain.then(step, step)
  _shelfChain = result.then(
    () => {},
    () => {},
  )
  return result
}
async function _unshelfStep(addrLower) {
  try {
    const p = platform()
    if (!p.priv) throw new Error('平台私钥未加载')
    const canonical = normalizeToCanonical(
      p.did.replace(/^did:swtc:/, ''),
      `did:swtc:${p.did.replace(/^did:swtc:/, '')}.json`,
    )
    const read = await relayRead(canonical)
    if (read.status === 'probe-fail') return false // 读不到绝不动册（防把整篇登记册写没）
    if (read.status !== 'ok' || !read.doc) return true // 本就没有登记册=无需摘
    const before = (read.doc.credentials || []).length
    const list = (read.doc.credentials || []).filter(
      (c) => !isDshCard(c) || cardSubject(c) !== `did:swtc:${addrLower}`,
    )
    if (list.length === before) return true // 该地址在册无卡：幂等
    const doc = { ...read.doc, credentials: list, updated: new Date().toISOString() }
    const signature = signWithPlatformKey(Buffer.from(JSON.stringify(doc), 'utf8'))
    await relayWrite({
      document: doc,
      fileName: `did:swtc:${canonical}.json`,
      publicKeyHex: platformSignKey(),
      signatureDerHex: signature,
      chain: cfg().chain,
    })
    return true
  } catch (err) {
    console.warn(
      `[credential-unshelf] 登记册摘除失败（台账判权已即时生效，不影响撤销）: ${String(err?.message || err).slice(0, 140)}`,
    )
    return false
  }
}

/**
 * 同步平台档案的签发方展示字段（2026-10-23）。背景：W3C LDP 卡体的 issuer 物理上
 * 存不了名字（VC v1 上下文 @protected + @type:@id，issuer.name 使 safe canonize 必炸
 * ——"存入 500"实测教训），官网弹窗"签发方"的读取来源是【issuer DID 解析出的档案
 * 文档】。本函数把 name 写进平台档案并同步本地镜像。读-改-写：远端字段全量优先，
 * 只覆盖 name/updated；probe-fail 绝不写（与挂架同款铁律）；已是目标值=幂等跳过。
 * 与 _shelfChain 同链串行——防与并发挂架互相整篇覆写。
 */
function syncProfileIdentity(name) {
  const step = () => _syncProfileIdentityStep(name)
  const result = _shelfChain.then(step, step)
  _shelfChain = result.then(
    () => {},
    () => {},
  )
  return result
}
async function _syncProfileIdentityStep(name) {
  try {
    const p = platform()
    if (!p.priv) throw new Error('平台私钥未加载')
    if (!name || typeof name !== 'string') throw new Error('签发方展示名不能为空')
    const canonical = normalizeToCanonical(
      p.did.replace(/^did:swtc:/, ''),
      `did:swtc:${p.did.replace(/^did:swtc:/, '')}.json`,
    )
    const read = await relayRead(canonical)
    if (read.status === 'probe-fail')
      return { written: false, reason: 'probe-fail（读不到绝不动档）' }
    const base = read.status === 'ok' && read.doc ? read.doc : p.profile
    // ═══ 签发方显示名——逐字节对齐生态模板（2026-10-23 relay 实读解剖定案）═══
    // 生态卡 issuer 也是纯 DID 字符串（与我们同款）；官网弹窗"签发方"显示的
    // 【不是卡上的名字】，而是 issuer DID 档案里 Profile 服务端点的 nickname——
    // 实读生态"有签发方"的两例：上海光元JDID井证 {"id":did#profile,"type":
    // "Profile","serviceEndpoint":{"nickname":"…","preferredAvatar":""}}、
    // Team SWTC 同款。我们此前差两点：条目缺 preferredAvatar 键（模板恒有此
    // 键，空串亦然，UI 可能严格判形）+ 顶层多发自创 name 字段（生态档案全部
    // 没有，自创口径=疑点面）。现在：只写 Profile 条目、键序与模板一致、
    // 顶层 name 移除（含本地镜像）。
    const services = Array.isArray(base.service) ? [...base.service] : []
    const pi = services.findIndex((s) => s?.type === 'Profile')
    const endpoint = { nickname: name, preferredAvatar: '' }
    const entry = { id: `${p.did}#profile`, type: 'Profile', serviceEndpoint: endpoint }
    const already =
      pi >= 0 && JSON.stringify(services[pi]) === JSON.stringify(entry) && !('name' in base)
    if (already) return { written: false, reason: 'already' }
    if (pi >= 0) services[pi] = entry
    else services.push(entry)
    const { name: _drop, ...baseRest } = base // 顶层自创 name 下线，形态归一生态模板
    const doc = { ...baseRest, service: services, updated: new Date().toISOString() }
    const signature = signWithPlatformKey(Buffer.from(JSON.stringify(doc), 'utf8'))
    await relayWrite({
      document: doc,
      fileName: `did:swtc:${canonical}.json`,
      publicKeyHex: platformSignKey(),
      signatureDerHex: signature,
      chain: cfg().chain,
    })
    try {
      writeFileSync(join(ROOT, cfg().profileFile), JSON.stringify(doc, null, 2)) // 本地镜像同步
    } catch {
      /* 镜像写失败不影响线上结论 */
    }
    return { written: true, name }
  } catch (err) {
    console.warn(
      `[credential-identity] 平台档案展示字段同步失败: ${String(err?.message || err).slice(0, 140)}`,
    )
    return { written: false, reason: String(err?.message || err).slice(0, 120) }
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

/* ───────────────────────── 管理员名册（配发/撤销的策略输入，v1.5） ───────────────────────── */

let _rosterOverride = null // 测试注入缝；生产=null → getAdminAddresses()（config ∪ admin.json/meta）
function rosterAddresses() {
  if (!_rosterOverride) return getAdminAddresses()
  return new Set([..._rosterOverride].map((a) => String(a).toLowerCase()))
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
    return this.putRow(addrLower, doc)
  }
  /** v1.5 通用整条替换（admin-auto 升签/降权重签都走它——互斥台账语义不变） */
  async putRow(addrLower, doc) {
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
  /** v1.5 管理员快照源：kind=cwt ∧ roles 含 admin 的行（带 expiresAt 供过期过滤） */
  async listAdminAddresses() {
    return (
      await this._col()
        .find({ kind: 'cwt', roles: 'admin' }, { projection: { _id: 1, expiresAt: 1 } })
        .toArray()
    ).map((d) => ({ _id: d._id, expiresAt: d.expiresAt || null }))
  }
  /** 批准史查询（撤销降格判定依据）：存在本人获批工单 */
  async hasApprovedApp(addrLower) {
    return Boolean(await this._apps().findOne({ address: addrLower, status: 'approved' }))
  }
  /** v1.5 准入快照源：kind∈{did,cwt} ∧ state∈{assigned,claimed} 的行（expiresAt 过滤在调用侧，与 listAdminAddresses 同构） */
  async listValidRows() {
    return (
      await this._col()
        .find(
          { kind: { $in: ['did', 'cwt'] }, state: { $in: ['assigned', 'claimed'] } },
          { projection: { _id: 1, expiresAt: 1 } },
        )
        .toArray()
    ).map((d) => ({ _id: d._id, expiresAt: d.expiresAt || null }))
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
    return this.putRow(addrLower, doc)
  }
  /** v1.5 通用整条替换（admin-auto 升签/降权重签都走它——互斥台账语义不变） */
  async putRow(addrLower, doc) {
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
  /** v1.5 管理员快照源：kind=cwt ∧ roles 含 admin */
  async listAdminAddresses() {
    const all = this._load(this._fileCred) || {}
    return Object.entries(all)
      .filter(([, d]) => d && d.kind === 'cwt' && (d.roles || []).includes('admin'))
      .map(([a, d]) => ({ _id: a, expiresAt: d.expiresAt || null }))
  }
  /** 批准史查询（撤销降格判定依据）：存在本人获批工单 */
  async hasApprovedApp(addrLower) {
    return (this._load(this._fileApps) || []).some(
      (a) => a.address === addrLower && a.status === 'approved',
    )
  }
  /** v1.5 准入快照源：kind∈{did,cwt} ∧ state∈{assigned,claimed} 的行 */
  async listValidRows() {
    const all = this._load(this._fileCred) || {}
    return Object.entries(all)
      .filter(
        ([, d]) =>
          d &&
          (d.kind === 'did' || d.kind === 'cwt') &&
          (d.state === 'assigned' || d.state === 'claimed'),
      )
      .map(([a, d]) => ({ _id: a, expiresAt: d.expiresAt || null }))
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
    this._cwtPending = new Set() // 刷新 fetch 窗口内的即时豁免（replace 时并入，防被旧快照吞掉）
    this._cwtUnmark = new Set() // v1.5 fetch 窗口内的即时收回（replace 时剔除，防被旧快照复活）
    this._admSet = new Set() // v1.5 管理员判权快照（kind=cwt ∧ roles∋admin ∧ 未过期的台账结论）
    this._admPending = new Set() // 同上：admin 即时授予/摘除的窗口保护对
    this._admUnmark = new Set()
    this._validSet = new Set() // v1.5 刀5B 准入快照：持有效台账行（did|cwt 任一，未过期）
    this._validPending = new Set() // 同上窗口保护对（刚建行的地址在 fetch 中不被旧快照吞）
    this._validUnmark = new Set()
    this._validHydrated = false // 首次准入快照水合未成功前，闸门放行（升级期绝不误伤）
    this._hydrateAt = 0
    this._refreshTimer = null
    this._provisioned = false // 首次配发对账完成前，isAdmSync 走名册兜底（绝不上锁）
  }
  _resetCache() {
    this._cwtSet.clear()
    this._cwtPending.clear()
    this._cwtUnmark.clear()
    this._admSet.clear()
    this._admPending.clear()
    this._admUnmark.clear()
    this._validSet.clear()
    this._validPending.clear()
    this._validUnmark.clear()
    this._validHydrated = false
    this._hydrateAt = 0
    this._provisioned = false // 判权门面回到名册兜底态（与 _admSet 清空保持一致，测试/重启同构）
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
    // v1.5：名册→凭证双向对账（纯本地台账写；挂册异步尽力）。失败不抛——
    // _provisioned 保持 false，isAdmSync 落名册兜底，管理面绝不因对账抖动上锁
    await this.syncAdminProvisioning().catch((err) => {
      console.warn(
        `[credential] 管理员配发对账失败（走名册兜底）: ${String(err?.message || err).slice(0, 140)}`,
      )
    })
    if (!this._refreshTimer) {
      // 5 分钟兜底水合（外部直改库/多写入窗口）；unref 绝不误拖测试进程
      this._refreshTimer = setInterval(() => {
        this.refreshExemptSet().catch(() => {})
        this.syncAdminProvisioning().catch(() => {})
      }, 300000)
      this._refreshTimer.unref()
    }
  }

  get enabled() {
    return cfg().enabled !== false
  }

  /** 水合/刷新豁免+管理员+准入三快照（v1.5）。approve/签发/任命路径也会即时补集，撤销即时摘 */
  async refreshExemptSet() {
    try {
      const b = backend()
      const [addrs, adminRows, validRows] = await Promise.all([
        b.listCwtAddresses(),
        typeof b.listAdminAddresses === 'function'
          ? b.listAdminAddresses().catch(() => null)
          : Promise.resolve(null),
        typeof b.listValidRows === 'function'
          ? b.listValidRows().catch(() => null)
          : Promise.resolve(null),
      ])
      const next = new Set(addrs)
      // 2026-10 审计：fetch 窗口内的即时增/减都要在原子替换时保全
      // （刀3 修的是"新批被旧快照吞"；v1.5 撤销引入对称面"刚撤被旧快照复活"）
      for (const a of this._cwtPending) next.add(a)
      for (const a of this._cwtUnmark) next.delete(a)
      this._cwtSet = next
      if (adminRows) {
        // v1.5 判权快照=台账签发结论 ∧ 未过期（过期行等登录续发重铸，先出集——fail-safe）
        const adm = new Set(
          adminRows
            .filter((r) => !r.expiresAt || new Date(r.expiresAt).getTime() > Date.now())
            .map((r) => r._id),
        )
        for (const a of this._admPending) adm.add(a)
        for (const a of this._admUnmark) adm.delete(a)
        this._admSet = adm
      }
      if (validRows) {
        // v1.5 刀5B 准入快照：三证皆进（did|cwt|admin 同集），过期先行出集（重连被拦、
        // 登录续发自然归队——_renewIfExpired 是恢复通道）
        const valid = new Set(
          validRows
            .filter((r) => !r.expiresAt || new Date(r.expiresAt).getTime() > Date.now())
            .map((r) => r._id),
        )
        for (const a of this._validPending) valid.add(a)
        for (const a of this._validUnmark) valid.delete(a)
        this._validSet = valid
        this._validHydrated = true
      }
      this._cwtPending.clear()
      this._cwtUnmark.clear()
      this._admPending.clear()
      this._admUnmark.clear()
      this._validPending.clear()
      this._validUnmark.clear()
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
    // 若有一轮刷新正在 fetch 途中，本地址必须在该轮 replace 时保留（见 refreshExemptSet）
    this._cwtUnmark.delete(addrLower) // 后到者胜：先撤销后重新签发=豁免
    this._cwtPending.add(addrLower)
    this._hydrateAt = Date.now()
  }

  /** v1.5 收回免时限即时摘除（撤销/降格 did 时调用；fetch 窗口内的对称保护） */
  _unmarkExempt(addrLower) {
    this._cwtSet.delete(addrLower)
    this._cwtPending.delete(addrLower)
    this._cwtUnmark.add(addrLower)
  }

  /**
   * v1.5 管理员判权热路径（同步零 I/O）：读台账签发结论快照。
   * 兜底铁律：凭证体系停用 或 首次对账未完成 → 落 config∪admin.json 名册
   * （升级/异常期绝不上锁管理员门面）；对账完成后快照即名册的凭证化投影。
   */
  isAdmSync(address) {
    if (!this.enabled || !this._provisioned) return isAdmin(address)
    return this._admSet.has(normalizeAddress(address))
  }

  _markAdmin(addrLower) {
    this._admSet.add(addrLower)
    this._admUnmark.delete(addrLower) // 后到者胜：撤销后重新任命=管理员
    this._admPending.add(addrLower)
    this._hydrateAt = Date.now()
  }

  /** v1.5 撤 admin 当秒摘除判权（官网摘册/重签由 demoteAdmin 编排） */
  _unmarkAdmin(addrLower) {
    this._admSet.delete(addrLower)
    this._admPending.delete(addrLower)
    this._admUnmark.add(addrLower)
  }

  /** v1.5 刀5B 准入快照即时补位（建行/换卡路径调用；窗口保护对与豁免同构） */
  _markValid(addrLower) {
    this._validSet.add(addrLower)
    this._validUnmark.delete(addrLower) // 后到者胜：先摘后建行=准入
    this._validPending.add(addrLower)
    this._hydrateAt = Date.now()
  }

  /** v1.5 刀5B 收回准入即时摘（现网无删除态调用方——L2 作废；原语留给撤销面/测试） */
  _unmarkValid(addrLower) {
    this._validSet.delete(addrLower)
    this._validPending.delete(addrLower)
    this._validUnmark.add(addrLower)
  }

  /**
   * v1.5 刀5B 准入判定（同步零 I/O，网关导航用；/connect 走 gateConnect 实时读台账）：
   * 停用/off 模式=闸门不存在；首次水合未成功=fail-open（升级/存储故障期绝不误锁全体）；
   * license 备用模式=仅 cwt∪admin（did 拒，V3 定式运营可拧）。
   */
  isEntryValidSync(address) {
    if (!this.enabled) return true
    const mode = CONFIG.accessGate?.mode || 'credential'
    if (mode === 'off') return true
    if (!this._validHydrated) return true
    const a = normalizeAddress(address)
    if (mode === 'license') return this._cwtSet.has(a) || this._admSet.has(a)
    return this._validSet.has(a)
  }

  /**
   * v1.5 刀5B · /connect 准入闸（台账=判据，实时读+自愈，铁律三态）：
   * 无行=从没进过用户中心的插件直连者 → 与首次登录同款自动配发 did 卡（"正常用户
   * 永不触发 403"的底线，教义§1①）；有行过期 → 拒并引导登录（登录续发是恢复通道，
   * 不在建容器路径上铸卡）；台账读失败 → 放行（故障≠缺失≠撤销）。
   */
  async gateConnect(address) {
    if (!this.enabled) return { allowed: true, mode: 'off' }
    const mode = CONFIG.accessGate?.mode || 'credential'
    if (mode === 'off') return { allowed: true, mode }
    const addrLower = normalizeAddress(address)
    let cred
    try {
      const b = backend()
      cred = await b.get(addrLower)
      if (!cred) {
        const r = await b.assignIfAbsent(addrLower, this._didDoc(addrLower, 'connect'))
        cred = r?.doc || (await b.get(addrLower))
      }
    } catch (err) {
      console.warn(
        `[credential] 准入闸台账读失败（放行不误伤）: ${String(err?.message || err).slice(0, 120)}`,
      )
      return { allowed: true, mode, probeFailed: true }
    }
    const expired = Boolean(cred?.expiresAt) && new Date(cred.expiresAt).getTime() <= Date.now()
    if (expired) return { allowed: false, code: 'CREDENTIAL_EXPIRED' }
    this._markValid(addrLower) // 有效行即时在册（含刚自动配发的；过期行不入）
    if (mode === 'license' && cred?.kind !== KINDS.CWT) {
      return { allowed: false, code: 'NO_VALID_CREDENTIAL' }
    }
    return { allowed: true, mode, kind: cred?.kind || null }
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
        this._markValid(addrLower)
        // 名册地址（v1.5）：legacy 直发之上再升 admin-auto 卡——任命生效免申请免自审
        if (this.enabled && rosterAddresses().has(addrLower)) {
          await this.provisionAdmin(addrLower, 'enter')
          cred = (await b.get(addrLower)) || cred
        }
        return {
          credential: this._public(cred),
          popup: true,
          role: this.roleFor(addrLower),
          legacy: { approvedAt: lg.approvedAt || null },
        }
      }
      const r = await b.assignIfAbsent(addrLower, this._didDoc(addrLower, 'auto'))
      cred = r.doc
    }
    // v1.5：名册在册但台账无有效 admin 卡 → admin-auto 补签（下次弹窗自然引导领新卡；
    // 幂等：已是 cwt+admin 的行原样保留）
    if (
      this.enabled &&
      !(cred?.roles || []).includes('admin') &&
      rosterAddresses().has(addrLower)
    ) {
      await this.provisionAdmin(addrLower, 'enter')
      cred = (await b.get(addrLower)) || cred
    }
    // 登录即续发：已领取卡到期 → 当场重铸新卡换台账+异步换平台册（豁免无缝衔接）
    const renewed = await this._renewIfExpired(cred, addrLower)
    this._markValid(addrLower) // 台账有行即在册（准入自愈：登录过的地址闸不咬）
    // ═══ 判权顺序（2026-10-23 用户定式："先跑档案，出错跑台账"）═══
    // claimed 卡登录：同步等档案活验结论（预算 enterVerifyBudgetMs 封顶，常态
    // 0.2~2.7s；节流保鲜期内秒回）。档案出确凿结论 → 本轮判权即按其行动
    // （missing=删卡对账回未领取、invalid=伪造即摘热闸、ok/stale=按台账继续）；
    // 出错/超预算 → 落回台账结论放行（"绝不上锁"：官网断≠撤销），后台那条
    // 核验仍跑完落库，下轮自动升级为档案结论。verifiedBy 标出本轮依据来源。
    let verifiedBy = 'ledger'
    if (renewed.cred.state === 'claimed' && renewed.cred.vcId && renewed.cred.profileDid) {
      const raw = Number(cfg().enterVerifyBudgetMs)
      const budgetMs = Number.isFinite(raw) && raw > 0 ? raw : 5000
      const TIMEOUT = Symbol('verify-timeout')
      const verify = this.onChainVerify(addrLower).catch(() => undefined)
      const verdict = await Promise.race([
        verify,
        new Promise((r) => setTimeout(() => r(TIMEOUT), budgetMs)),
      ])
      const after = await b.get(addrLower) // missing 对账可能已把行降级，重取为准
      if (after) renewed.cred = after
      if (verdict !== TIMEOUT && verdict?.status) verifiedBy = 'archive'
    }
    return {
      credential: this._public(renewed.cred),
      popup: renewed.cred.state === 'assigned',
      role: this.roleFor(addrLower),
      legacy: null,
      renewed: renewed.renewed,
      verifiedBy,
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
    const vc = await mintVC(cred.kind, addrLower, cred.roles || [], cred.profileDid || null)
    // claimedAt 随重铸刷新=新卡换发时刻：档案里此刻还是旧卡（新卡待用户再领/同步），
    // 60s 副本传播宽限由此自动覆盖续发窗口——onChainVerify 不会拿旧档案对新 vcId
    // 误判 missing 而错剥"已领取"（2026-10-23 官网删卡对账引入的时序补全）。
    const patched = await backend().patch(addrLower, {
      vcId: vc.id,
      expiresAt: vc.expirationDate || null,
      renewedAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
    })
    if (cred.kind === KINDS.CWT) this._markExempt(addrLower)
    this._markValid(addrLower) // 过期出集的续发回归（准入跟着台账走）
    _vcCache.delete(addrLower) // 续发换卡：本体缓存随之作废（同 claimUpload，审计 #7）
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
    // 副本传播宽限：刚落档 60s 内 relay 读副本可能没追上，此时验真会误报 stale
    // （2026-10-19 实测：同步成功 3 秒后被误判）——结论推迟到下次登录
    if (!opts.force && cred.claimedAt && Date.now() - new Date(cred.claimedAt).getTime() < 60000)
      return prev
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
          reason: `您档案里还是旧版本（…${String(stale.id).slice(-12)}），点「更新我的档案」即可换成最新`,
        }
      } else if (!vc) {
        next = {
          status: 'missing',
          at: new Date().toISOString(),
          reason: '档案里找不到这张凭证（可能被删除，点「存入我的数字档案」找回）',
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
    // v1.5 官网删卡对账（2026-10-23 用户实测"官网删了平台没反应，还显示已存入"）：
    // missing 的全部来源都是【确凿读】——档案不存在（relay 明确 absent）或读档成功但
    // 平台卡不在其中；probe-fail（网络抖动）在上游已 return prev 绝不落这里。
    // 语义：档案=卡本体的存放地，本体被持有人删除 ⇒ "已领取"事实不再成立 ⇒ 台账
    // 回未领取（assigned），下次 enter 自然重新弹窗引导领取。卡型/roles/source 一律
    // 不动——判权在台账不在档案：cwt 持卡人删了档案卡依旧豁免，admin 依旧在岗。
    if (next?.status === 'missing') {
      await b.patch(addrLower, { state: 'assigned', vcId: null, claimedAt: null, onChain: next })
      return next
    }
    await b.patch(addrLower, { onChain: next })
    // v1.5 判权联动：档案实卡验签【确凿】失效（invalid=被伪造/覆盖）→ 当秒摘 admin 热闸。
    // 只认 invalid——stale/missing 是"未领取/换了新卡"的常态形态，误伤在岗管理员
    if (next?.status === 'invalid' && Array.isArray(cred.roles) && cred.roles.includes('admin'))
      this._unmarkAdmin(addrLower)
    return next
  }

  _didDoc(addrLower, source) {
    const now = new Date().toISOString()
    return {
      kind: KINDS.DID,
      state: 'assigned',
      source,
      roles: [],
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
      roles: Array.isArray(extra.roles) ? extra.roles : [],
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
      roles: doc.roles || [],
      isAdmin: (doc.roles || []).includes('admin'),
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
    const vc = await mintVC(cred.kind, addrLower, cred.roles || [], `did:swtc:${canonicalAddr}`)
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

    // 防假卡（2026-10 全面审计）：document 的"末项卡"是客户端组装的，文件签名
    // 只证明"这只钱包签了这份文件"，**不证明里面有平台真签的卡**——不校验的话，
    // 自制一张假 DshMemberCredential 追加上传，台账就会 scaffold 假卡的 id/expiresAt，
    // 后续 onChain 验真全对假卡做。判据：末项必须是平台 DID 真签（SDK 验签）、
    // subject=本地址、id 为平台签发格式。验签本身失败（context 拉取等）按探测失败
    // 处理：拒绝本次上传（可重试），绝不让"无法确认"折叠成"确认合法"。
    const lastCard = Array.isArray(document.credentials)
      ? document.credentials[document.credentials.length - 1]
      : null
    if (!(await isPlatformMinted(lastCard, addrLower))) {
      throw new BadRequestError(
        '档案末项不是平台为本地址签发的有效凭证（请点击「存入我的数字档案」获取最新档案后原样上传；如反复失败请稍后重试）',
      )
    }
    // v1.5 卡型/roles 必须与台账当前态一致：撤销/任命都重签了降格/升格卡，
    // 拿旧态的真卡（验签永远真）回存档案=展示误导——拒，引导重领当前新卡
    const expectType = VC_TYPES[cred.kind]
    const cardAdmin = (lastCard?.credentialSubject?.roles || []).includes('admin')
    const rowAdmin = (cred.roles || []).includes('admin')
    if (!expectType || !(lastCard?.type || []).includes(expectType) || cardAdmin !== rowAdmin) {
      throw new BadRequestError(
        '凭证与台账当前状态不一致（任命/撤销后已换发新卡），请重新点「存入我的数字档案」领取',
      )
    }

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
    // 台账换了新卡：凭证本体缓存立即失效（否则「同步」后 60s 内展开查看仍是旧卡，
    // 2026-10 审计 #7；此前 _vcCache.delete 全项目零调用点）
    _vcCache.delete(addrLower)
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
    // v1.5：保留既有 roles（名册管理员的申请通道批准不得悄悄摘掉 admin 标记——
    // 摘除只走 demote 链；这里互斥替换仍成立）
    const cur = await b.get(app.address)
    const doc = this._cwtDoc(app.address, 'approval', {
      approvedAt: lg.approvedAt,
      roles: cur?.roles || [],
    })
    const cred = await b.grantCwt(app.address, doc)
    await b.patchApp(appId, {
      status: 'approved',
      decidedAt: new Date().toISOString(),
      decidedBy: normalizeAddress(adminAddress),
    })
    this._markExempt(app.address)
    this._markValid(app.address)
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

  /* ---- v1.5 管理员凭证编排（任命/撤销/对账） ---- */

  /**
   * 任命生效=台账升签 cwt + roles:['admin']（admin-auto：免申请免自审——管理员不自己批自己，
   * 任命权在名册操作门禁）。免时限复用 cwt 豁免链天然生效，无特例代码。
   * 换卡重置 state=assigned：新 admin 卡需本人领取（弹窗闭环），vcId 领取时才落。
   * 幂等：已是 cwt+admin 的行原样保留（重复任命/重启对账都不重签）。
   */
  async provisionAdmin(address, operator = 'system') {
    const addrLower = normalizeAddress(address)
    const b = backend()
    const row = await b.get(addrLower)
    if (row && row.kind === KINDS.CWT && (row.roles || []).includes('admin')) {
      this._markAdmin(addrLower)
      this._markExempt(addrLower)
      this._markValid(addrLower)
      return { ok: true, already: true, credential: this._public(row) }
    }
    const lg = legacyHit(addrLower) || {}
    const doc = this._cwtDoc(addrLower, 'admin-auto', {
      roles: ['admin'],
      approvedAt: lg.approvedAt,
    })
    const cred = await b.putRow(addrLower, doc)
    this._markAdmin(addrLower)
    this._markExempt(addrLower)
    this._markValid(addrLower)
    return { ok: true, issued: true, credential: this._public(cred) }
  }

  /**
   * 撤销=没收管理凭证并重签降格（卡不可编辑，"没收"只能换卡）。去向按批准史：
   *  本人有独立 cwt 批准史（获批工单/legacy 白名单）→ 重签纯 cwt 卡（不限时凭自己的本权）；
   *  admin 卡是解限唯一来源 → 重签 did 卡（回限时普通持牌人）。
   * 即时性：台账替换 + 快照当秒摘除；登记册摘除旧卡为尽力轨（异步串行链，
   * 判权不依赖其完成——旧卡即便仍在册，台账 vcId 已换代，claim 门禁校验卡型/roles 一致）。
   */
  async demoteAdmin(address, operator = 'system') {
    const addrLower = normalizeAddress(address)
    const b = backend()
    const row = await b.get(addrLower)
    if (!row || !(row.roles || []).includes('admin')) return { ok: true, noop: true }
    const hasOwn =
      (typeof b.hasApprovedApp === 'function' && (await b.hasApprovedApp(addrLower))) ||
      Boolean(legacyHit(addrLower))
    const lg = legacyHit(addrLower) || {}
    const target = hasOwn
      ? this._cwtDoc(addrLower, legacyHit(addrLower) ? 'legacy' : 'approval', {
          approvedAt: lg.approvedAt,
        })
      : this._didDoc(addrLower, 'demoted')
    const cred = await b.putRow(addrLower, target)
    this._unmarkAdmin(addrLower)
    this._markValid(addrLower) // 降格后仍是持牌人（did 或纯 cwt），准入不受影响
    if (target.kind === KINDS.DID) this._unmarkExempt(addrLower)
    unshelfCredential(addrLower).catch(() => {})
    return { ok: true, to: target.kind, credential: this._public(cred) }
  }

  /**
   * 双向对账（启动+5 分钟周期，幂等）：名册→缺卡补签/有卡保集；名册外→悬空 admin 结论降格。
   * 纯台账+内存操作（挂册异步尽力），完成置 _provisioned（isAdmSync 从名册兜底切到快照）。
   */
  async syncAdminProvisioning() {
    if (!this.enabled) return { promoted: [], demoted: [] }
    const b = backend()
    const roster = rosterAddresses()
    const promoted = []
    const demoted = []
    const adminRows =
      typeof b.listAdminAddresses === 'function' ? await b.listAdminAddresses().catch(() => []) : []
    const byId = new Map(adminRows.map((r) => [r._id, r]))
    for (const a of roster) {
      const r = byId.get(a)
      const expired = r && r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now()
      if (!r || expired) {
        await this.provisionAdmin(a, 'sync') // 内部再查行判 already（幂等）
        promoted.push(a)
      } else {
        this._markAdmin(a)
        this._markExempt(a)
        this._markValid(a)
      }
    }
    for (const r of adminRows) {
      if (!roster.has(r._id)) {
        await this.demoteAdmin(r._id, 'sync')
        demoted.push(r._id)
      }
    }
    this._provisioned = true
    return { promoted, demoted }
  }

  /** tab 判权字段（credential-status 的 role）：读结论快照；徽章面另见 onChain 字段 */
  roleFor(address) {
    return this.isAdmSync(address) ? 'admin' : 'user'
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
        this._markValid(addrLower)
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
