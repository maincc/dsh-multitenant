/**
 * 平台货架开业脚本（did-vc-runbook §3.5，一次性）
 * 部署者钥 → did:swtc:j1U… → 锚文档（created/updated 必填·publicKeyBase58 必填）→ 上传 share 路径。
 * 默认 dry-run 只打印计划；--yes 才写入。--base 覆盖实例（联调用 dev）。
 * 用法：node scripts/shelf-open.mjs [--yes] [--base https://wodecards.wh.jccdex.cn:8550]
 * 口径来源：预验证两轮全绿实证（~/.dshWorkspace/vc-preflight/preflight-swtc.cjs）。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { CONFIG, ROOT } from '../src/config/config.js'

const require = createRequire(import.meta.url)
const { secp256k1 } = require('@noble/curves/secp256k1')
const { bytesToHex } = require('@noble/hashes/utils')
const { Keypairs } = require('@swtc/keypairs')
const bs58 = require('bs58')

const PREFIX = '\u0019IPFS Signed Message:\n'
const sha256hex = (b) => createHash('sha256').update(b).digest('hex')

// issuer.key 三格式通吃（SWTC 生态钥形态族）：
//   ① secp256k1 PEM（openssl/服务器惯例）  ② 64 位 hex 私钥（插件导出同款）
//   ③ ripple seed `s…` base58（SWTC 钱包存储本体，HD 派生）——均为同一 secp256k1 曲线 32B 私钥
function loadPrivHex(raw) {
  const t = raw.trim()
  if (t.startsWith('-----BEGIN')) {
    const k = require('node:crypto').createPrivateKey({ key: t, format: 'pem' })
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
  throw new Error(
    'issuer.key 格式不认识（支持：secp256k1 PEM / 64 位 hex 私钥 / s 开头 ripple seed）',
  )
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
const baseIdx = args.indexOf('--base')
const BASE_URL = (baseIdx >= 0 ? args[baseIdx + 1] : CONFIG.shelf.rpcBaseURL).replace(/\/+$/, '')
const CHAIN = CONFIG.shelf.chain || 'swtc'
const keyPath = `${ROOT}/${CONFIG.issuer.keyPath}`.replace('//', '/')

const priv = loadPrivHex(readFileSync(keyPath, 'utf8'))
const pubC = secp256k1.getPublicKey(priv, true)
const pubCHex = bytesToHex(pubC)
// ★SWTC 标准地址=ripemd160(sha256(压缩公钥))——与插件钱包/ripple 生态同源。
//   表单 publicKey 与地址推导必须同一形态：swtc 族一律压缩（v1.1.2 勘误，
//   此前预验证误用未压缩形态自洽通吃，产出非常规地址）。
const address = Keypairs.deriveAddress(pubCHex)
const did = `did:${CHAIN === 'swtc' ? 'swtc' : 'ethr'}:${address}`
const name = `${did}.json`
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
      publicKeyHex: '0x' + bytesToHex(pubC),
      publicKeyBase58: (bs58.default || bs58).encode(pubC), // 验签链只认 base58/base64
    },
  ],
  authentication: [`${did}#key-1`],
  assertionMethod: [`${did}#key-1`],
  service: [
    {
      id: `${did}#profile`,
      type: 'Profile',
      serviceEndpoint: { nickname: 'dsh-platform-shelf', preferredAvatar: '' },
    },
  ],
  credentials: [],
}

console.log('[开业] 实例      :', BASE_URL)
console.log('[开业] 平台 DID  :', did)
console.log('[开业] name      :', name)
console.log('[开业] 读路径    :', sharedPath(address, name))
if (!DO_IT) {
  console.log('[dry-run] 文档:\n' + JSON.stringify(doc, null, 2))
  console.log('[dry-run] 未上传。确认无误后加 --yes 执行（prod 写入=公开可见）。')
  process.exit(0)
}

const bytes = Buffer.from(JSON.stringify(doc))
const fd = new FormData()
fd.append('file', new Blob([bytes]), name)
fd.append('name', name)
fd.append('publicKey', pubCHex)
fd.append('signature', signFileContent(bytes, priv))
fd.append('share', 'true')
fd.append('chain', CHAIN)
const up = await fetch(`${BASE_URL}/v0/api/ipfs/files/write`, { method: 'POST', body: fd })
console.log('[开业] 上传 →', up.status, (await up.text()).slice(0, 120))

// IPNS 快照 10-60s debounce：退避轮询确认（runbook §2 时序）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0, wait = 15000; i < 6; i++) {
  await sleep(wait)
  wait = Math.min(wait + 15000, 60000)
  try {
    const rd = await fetch(`${BASE_URL}/v0/api/ipfs/shared/files/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: sharedPath(address, name) }),
    })
    const got = JSON.parse(await rd.text())
    if (got.id === did) {
      console.log('[开业] ✅ 快照读回确认，货架就绪。app 查询页可查（若为 prod 实例）。')
      process.exit(0)
    }
  } catch {
    /* 快照未更新，继续轮询 */
  }
}
console.log(
  '[开业] ⚠ 上传已 201 但 90s+ 内快照未确认——IPNS 发布节奏问题，稍后用 query 脚本回读（不影响数据已写入）',
)
process.exit(2)
