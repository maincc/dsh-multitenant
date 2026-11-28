/**
 * 平台装配/开业脚本（一次性，人工触发——did-vc-runbook §3.5 + 2026-10-23 现代化）
 *
 * 形态 B（新测试平台）的一条命令装配：
 *   node scripts/shelf-open.mjs --seed '<ss-seed>' --nickname 'DSH 测试平台'      # dry-run 全量预览
 *   node scripts/shelf-open.mjs --seed '<ss-seed>' --nickname 'DSH 测试平台' --yes
 * 做四件事：seed 派生密钥对 → 落 data/keys/issuer.key（0600，仅当文件不存在）→
 * 构造生态模板 DID 档案 → 上传官网并读回确认 → 落 data/keys/issuer-profile.json 镜像。
 * 此后 config 里 credential.platformDid 可不写（本地镜像已含 DID）；形态 A（沿用现有
 * 平台身份）不用本脚本——config 声明 platformDid，服务首启自动从官网取档（provisionPlatformProfile）。
 *
 * 注册=永久身份钉链（DID 不可换，换 key=已发档案卡全失效），所以必须 --yes 显式确认；
 * 线上该 DID 已有档案时**拒写**（防整篇覆灭别人/历史的家）。
 * 口径来源：预验证两轮全绿实证（~/.dshWorkspace/vc-preflight/preflight-swtc.cjs，
 * v1.1.2 压缩形态勘误后）。原 2026-08 版依赖 CONFIG.shelf/issuer 段，该段已随
 * credential v1.4 重构下线——2026-10-23 对齐 CONFIG.credential 现行段。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash, createPrivateKey } from 'node:crypto'
import { CONFIG, ROOT } from '../src/config/config.js'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { secp256k1 } = require('@noble/curves/secp256k1')
const { bytesToHex } = require('@noble/hashes/utils')
const { Keypairs } = require('@swtc/keypairs')
const bs58 = require('bs58')

const PREFIX = '\u0019IPFS Signed Message:\n'
const sha256hex = (b) => createHash('sha256').update(b).digest('hex')

// issuer.key 三格式通吃（SWTC 生态钥形态族）：
//   ① secp256k1 PEM（openssl/服务器惯例）  ② 64 位 hex 私钥（插件导出同款）
//   ③ ripple seed `ss…`/`s…` base58（SWTC 钱包存储本体，HD 派生）
function loadPrivHex(raw) {
  const t = raw.trim()
  if (t.startsWith('-----BEGIN')) {
    const k = createPrivateKey({ key: t, format: 'pem' })
    if (k.asymmetricKeyType !== 'ec') throw new Error('非 EC 私钥')
    const buf = Buffer.from(k.export({ format: 'jwk' }).d, 'base64url')
    if (buf.length !== 32) throw new Error('私钥长度异常(疑似曲线不符 secp256k1): ' + buf.length)
    return bytesToHex(buf)
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return t.replace(/^0x/i, '').toLowerCase()
  if (/^s[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(t)) {
    const kp = Keypairs.deriveKeypair(t) // ripple seed → HD 派生
    return kp.privateKey.slice(-64).toLowerCase() // 66 位带前导 00 填充，取真 32B
  }
  throw new Error('私钥格式不认识（支持：secp256k1 PEM / 64 位 hex 私钥 / ss·s 开头 ripple seed）')
}

// SEC1 PEM 封装（与 scripts/seed-to-pem.mjs 同款：显式曲线 OID，node 才解得回）
function privHexToPem(privHex) {
  const priv = Buffer.from(privHex, 'hex')
  const pub = Buffer.from(secp256k1.getPublicKey(privHex, false))
  const der = Buffer.concat([
    Buffer.from('30740201010420', 'hex'),
    priv,
    Buffer.from('a00706052b8104000a', 'hex'),
    Buffer.from('a144034200', 'hex'),
    pub,
  ])
  const b64 = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()
  return `-----BEGIN EC PRIVATE KEY-----\n${b64}\n-----END EC PRIVATE KEY-----\n`
}

// runbook §5.1 实证口径：sha256(bytes) hex→utf8→前缀消息→sha256→ECDSA DER hex
function signFileContent(bytes, privHex) {
  const msg = Buffer.from(sha256hex(bytes), 'utf8')
  const pre = Buffer.from(PREFIX + msg.length, 'utf8')
  const z = createHash('sha256')
    .update(Buffer.concat([pre, msg]))
    .digest()
  return secp256k1.sign(z, privHex).toHex('der')
}

const sharedPath = (address, name) => {
  const h = sha256hex(Buffer.from(address, 'utf8'))
  return `/${h.slice(0, 2)}/${h.slice(2, 4)}/${address}/shared/${name}`
}

const args = process.argv.slice(2)
const DO_IT = args.includes('--yes')
const argOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : ''
}
const cred = CONFIG.credential || {}
const BASE_URL = (argOf('--base') || cred.relayBaseURL).replace(/\/+$/, '')
const API = cred.apiBase || '/v0/api/ipfs'
const CHAIN = cred.chain || 'swtc'
// --keyfile/--profile：装配演练与多平台并存演练的逃生口（默认现场 credential 段路径）
const keyRel = argOf('--keyfile') || cred.keyFile || 'data/keys/issuer.key'
const profRel = argOf('--profile') || cred.profileFile || 'data/keys/issuer-profile.json'
const keyPath = keyRel.startsWith('/') ? keyRel : join(ROOT, keyRel)
const profilePath = profRel.startsWith('/') ? profRel : join(ROOT, profRel)
const nickname = argOf('--nickname') || 'DSH 平台'
const seed = argOf('--seed')

// 1) 密钥来源：--seed 新装配（仅当 keyFile 不在场）；否则读现场 keyFile
let priv
if (seed) {
  priv = loadPrivHex(seed)
  if (existsSync(keyPath)) {
    const old = loadPrivHex(readFileSync(keyPath, 'utf8'))
    if (old !== priv)
      throw new Error(
        `${cred.keyFile} 已存在且与 --seed 派生不是同一把钥——绝不覆盖现场钥；` +
          '请核对 seed，或去掉 --seed 用现场钥',
      )
  }
} else {
  if (!existsSync(keyPath))
    throw new Error(`${cred.keyFile} 不存在——新平台装配请带 --seed '<ss-seed>'`)
  priv = loadPrivHex(readFileSync(keyPath, 'utf8'))
}

// 2) 身份：★SWTC 标准地址=ripemd160(sha256(压缩公钥))，表单与推导同一形态
//    （v1.1.2 勘误：未压缩形态自洽会产出非常规地址）
const pubC = secp256k1.getPublicKey(priv, true)
const pubCHex = bytesToHex(pubC)
const address = Keypairs.deriveAddress(pubCHex)
const did = `did:${CHAIN === 'swtc' ? 'swtc' : 'ethr'}:${address}`
const fileName = `${did}.json`
const now = new Date().toISOString()

const doc = {
  '@context': [
    'https://www.w3.org/ns/did/v1',
    'https://w3id.org/security/suites/secp256k1-2019/v1',
    { version: 'https://ccda.ooo/did/v1' },
  ],
  id: did,
  created: now, // 查询页渲染文档头时间，缺了整页 nan——prod 实测教训（runbook §3.5）
  updated: now,
  version: '1.0.0',
  verificationMethod: [
    {
      id: `${did}#key-1`,
      type: 'EcdsaSecp256k1VerificationKey2019',
      controller: did,
      publicKeyHex: '0x' + pubCHex,
      publicKeyBase58: (bs58.default || bs58).encode(pubC), // 验签链只认 base58/base64
    },
  ],
  authentication: [`${did}#key-1`],
  assertionMethod: [`${did}#key-1`],
  service: [
    {
      id: `${did}#profile`,
      type: 'Profile',
      serviceEndpoint: { nickname, preferredAvatar: '' },
    },
  ],
  credentials: [],
}

console.log('[装配] 实例      :', BASE_URL)
console.log('[装配] 平台 DID  :', did)
console.log('[装配] 展示名    :', nickname)
console.log(
  '[装配] key 落盘  :',
  seed ? (existsSync(keyPath) ? '已有同钥，跳过' : keyPath + ' (新建 0600)') : '沿用现场钥',
)
console.log('[装配] 读路径    :', sharedPath(address, fileName))

// 3) 链上已有档=拒写（身份是钉死物，重跑只该走 platformDid 自取/挂架维护路径）。
//    ★"读不到"≠"没有"：网络/5xx（probe-fail）与确凿 404（absent）严格分家——
//    抖动时上传=用空 credentials[] 整篇覆灭已注册档案的货架（铁律同款于读档侧）。
let rd = null
let rdProbeFail = null
try {
  const r0 = await fetch(`${BASE_URL}${API}/shared/files/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: sharedPath(address, fileName) }),
  })
  // 官网 relay 实测定调（2026-10-23 演练）：命中档案=**201**，档案不存在=**400 +
  // "no link named…"**（IPFS sharding 无目录），404 基本不出现。absent 判定收窄到
  // "404 或 400+no link 字样"——其余 400（网关/参数异常）一律 probe-fail 保守侧。
  if (r0.ok) rd = await r0.json()
  else {
    const t0 = await r0.text().catch(() => '')
    if (r0.status !== 404 && !(r0.status === 400 && t0.includes('no link')))
      rdProbeFail = `HTTP ${r0.status} ${t0.slice(0, 60)}`
  }
} catch (e) {
  rdProbeFail = e.message
}
if (rd && rd.id === did) {
  console.log(
    `[中止] 链上该 DID 已有档案（created=${rd.created}）——本脚本只做首次开业；\n` +
      '         后续维护走服务内挂架（shelfCredential/syncProfileIdentity）或 config.platformDid 自取。',
  )
  process.exit(1)
}
if (rdProbeFail && !args.includes('--force')) {
  console.log(
    `[中止] 档案服务读档不稳（${rdProbeFail}）——无法确证"该 DID 尚无档案"就绝不注册。稍后重试（--force 仅在你确知此 DID 全新时用）`,
  )
  process.exit(1)
}

if (!DO_IT) {
  console.log('[dry-run] 文档:\n' + JSON.stringify(doc, null, 2))
  console.log(
    '[dry-run] 未上传未落盘。确认 DID 与昵称无误后加 --yes（注册=永久身份，写公开可见）。',
  )
  process.exit(0)
}

// 4) 上传 → 读回确认 → 落镜像（+ --seed 新建时落 key）
const bytes = Buffer.from(JSON.stringify(doc))
const fd = new FormData()
fd.append('file', new Blob([bytes]), fileName)
fd.append('name', fileName)
fd.append('publicKey', pubCHex)
fd.append('signature', signFileContent(bytes, priv))
fd.append('share', 'true')
fd.append('chain', CHAIN)
const up = await fetch(`${BASE_URL}${API}/files/write`, { method: 'POST', body: fd })
const upText = (await up.text()).slice(0, 160)
console.log('[装配] 上传 →', up.status, upText)
if (!up.ok) throw new Error(`上传被拒（${up.status}）：未落任何本地文件`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let confirmed = false
for (let i = 0, wait = 15000; i < 6; i++) {
  // IPNS 快照 10-60s debounce：退避轮询（runbook §2 时序）。不等确认也照样落镜像——
  // 线上写已 201 受理，快照只是显示节奏
  try {
    const got = await fetch(`${BASE_URL}${API}/shared/files/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: sharedPath(address, fileName) }),
    }).then((r) => r.json())
    if (got && got.id === did) {
      confirmed = true
      break
    }
  } catch {
    /* 快照未更新，继续轮询 */
  }
  await sleep(wait)
  wait = Math.min(wait + 15000, 60000)
}

if (seed && !existsSync(keyPath)) {
  writeFileSync(keyPath, privHexToPem(priv), { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  console.log('[装配] issuer.key 已落盘（SEC1 PEM，0600）')
}
writeFileSync(profilePath, JSON.stringify(doc, null, 2))
console.log('[装配] issuer-profile.json 镜像已落盘')
console.log(
  confirmed
    ? '[装配] ✅ 快照读回确认，平台身份就绪——启动服务即可走"自动签发→领取"链路。'
    : '[装配] ⚠ 上传已受理但 90s+ 快照未确认——IPNS 发布节奏问题，稍后官网 query 回读即可（不影响数据已写入）。',
)
