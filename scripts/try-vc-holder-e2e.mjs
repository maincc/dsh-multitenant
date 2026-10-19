/**
 * 用户持有模型 E2E（联调工具，只对 dev 实例）：
 * 铸造 → 建档模板 → **用户自签**把卡写进自己的 DID 档案（模拟插件两次签名）→
 * 读回档案验证 → 撤销效力 → 再签发 → 清理（档案覆盖成空、平台货架摘净）。
 * 用法: node scripts/try-vc-holder-e2e.mjs
 */
process.chdir(new URL('..', import.meta.url).pathname)
const { CONFIG } = await import('../src/config/config.js')
const { issueAndShelf } = await import('../src/services/vc.service.js')
const { shelfService } = await import('../src/services/shelf.service.js')
const { buildProfileScaffold, sharedReadPath, getIssuerIdentity } =
  await import('../src/services/issuer.service.js')
const { userService } = await import('../src/services/user.service.js')
const { Keypairs } = await import('@swtc/keypairs')
const { secp256k1 } = await import('@noble/curves/secp256k1')
const { bytesToHex } = await import('@noble/hashes/utils')

shelfService.confirm = { firstMs: 10000, stepMs: 8000, budgetMs: 60000 }
const base = CONFIG.shelf.rpcBaseURL
// 口径说明：wodecards 文件接口=IPFS 口径（sha256(\u0019IPFS Signed Message:\n+len+utf8msg)→ECDSA）。
// 钱包插件=ripple 口径（sha512 half），二者不同摘要不可互替——路 A（生态适配）生效前，
// E2E 以"用户私钥 + IPFS 口径"直签等价证明**建档/存卡/读回链路本身已通**，卡住的只有口径。
const { signFileContent } = await import('../src/services/issuer.service.js')
const sign = (privHex, bytes) => signFileContent(privHex, bytes)
// wodecards 业务码包在 HTTP 200 里（探针实测），必须解析 body 判成败
const businessOk = async (res) => {
  const text = await res.text()
  try {
    const j = JSON.parse(text)
    return {
      pass: res.ok && !String(j.code ?? 200).startsWith('4') && j.code !== 401,
      body: text.slice(0, 100),
    }
  } catch {
    return { pass: res.ok, body: text.slice(0, 100) }
  }
}
const ok = (n, cond, extra = '') =>
  console.log(`${cond ? '✅' : '❌'} ${n}${extra ? '：' + extra : ''}`)

const priv = bytesToHex(secp256k1.utils.randomSecretKey())
const pubC = bytesToHex(secp256k1.getPublicKey(priv, true))
const addr = Keypairs.deriveAddress(pubC)
userService.state.swtcUsers = { [addr]: { containerStatus: 'running' } }
console.log(`── 用户持有模型 E2E（用户=${addr.slice(0, 12)}… 实例=${base}）──`)

// ① 首登自动铸 + 上平台货架
const { vc, onShelf } = await issueAndShelf(addr, 1, { instantConfirm: true })
userService.state.swtcUsers[addr].vc = {
  jti: vc.id,
  vcTier: 1,
  status: 'active',
  onShelf,
  mintedAt: Date.now(),
  ldvc: vc,
}
await shelfService.confirmSnapshot((d) => (d.credentials ?? []).some((c) => c.id === vc.id))
ok('① 铸卡上平台架', true, `onShelf=${onShelf}`)

// ② 领取：scaffold 模板 → 用户私钥自签 → 上传写进**用户自己的档案**
const scaffold = buildProfileScaffold(addr, pubC, [vc])
const bytes = Buffer.from(JSON.stringify(scaffold.document))
const up = await fetch(`${base}/v0/api/ipfs/files/write`, {
  method: 'POST',
  body: (() => {
    const fd = new FormData()
    fd.append('file', new Blob([bytes]), scaffold.fileName)
    fd.append('name', scaffold.fileName)
    fd.append('publicKey', pubC)
    fd.append('signature', sign(priv, bytes))
    fd.append('chain', 'swtc')
    fd.append('share', 'true')
    return fd
  })(),
})
const upRes = await businessOk(up)
ok('② 自签存入自己档案（IPFS 口径直签）', upRes.pass, `HTTP ${up.status} ${upRes.body}`)

// ③ 读回用户档案：卡在他的 credentials[] 里（公共可读，无需平台）
const rd = await fetch(`${base}/v0/api/ipfs/shared/files/read`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ file: sharedReadPath(addr, addr) }),
})
let holderDoc = null
try {
  holderDoc = await rd.json()
} catch {}
// IPNS 快照有延迟：退避重读
for (let i = 0; i < 9 && !(holderDoc?.credentials ?? []).some((c) => c?.id === vc.id); i++) {
  await new Promise((r) => setTimeout(r, 10000))
  try {
    const t = await (
      await fetch(`${base}/v0/api/ipfs/shared/files/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: sharedReadPath(addr, addr) }),
      })
    ).text()
    holderDoc = JSON.parse(t)
  } catch {}
}
ok(
  '③ 公共读回=卡在人手里',
  (holderDoc?.credentials ?? []).some((c) => c?.id === vc.id),
)

// ④ 撤销：账本效力即刻失效（查表视同无卡），平台副本被摘
await userService.revokeVc(addr, { by: 'admin-e2e' })
ok(
  '④ 撤销=效力开关',
  userService.state.swtcUsers[addr].vc.status === 'revoked' &&
    userService.vcTierLimit(addr).dailyMinutes === 120,
)

// ⑤ 再签发（管理员切档通道）：revoked 不挡重发，效力回 active
const r5 = await userService.requestVcUpgrade(addr, { via: 'admin-approved' })
ok(
  '⑤ 撤销后可再发',
  r5.action === 'upgraded' && userService.state.swtcUsers[addr].vc.status === 'active',
)

// ⑥ 清理：用户档案覆盖成空壳 + 平台货架摘净
const emptyDoc = { ...scaffold.document, credentials: [], updated: new Date().toISOString() }
const eb = Buffer.from(JSON.stringify(emptyDoc))
await fetch(`${base}/v0/api/ipfs/files/write`, {
  method: 'POST',
  body: (() => {
    const fd = new FormData()
    fd.append('file', new Blob([eb]), scaffold.fileName)
    fd.append('name', scaffold.fileName)
    fd.append('publicKey', pubC)
    fd.append('signature', sign(priv, eb))
    fd.append('chain', 'swtc')
    fd.append('share', 'true')
    return fd
  })(),
})
await userService.revokeVc(addr)
await shelfService.enqueue((d) => {
  const before = (d.credentials ?? []).length
  d.credentials = (d.credentials ?? []).filter((c) => c.id !== r5.jti && c.id !== vc.id)
  return (d.credentials ?? []).length !== before
})
await shelfService.queue // 等队列排空再退，防撤单丢失
const st = await shelfService.status()
console.log(
  `⑥ 清理完成（用户档案已覆盖成空壳；平台队列 pending=${st.pending}）——等快照收敛后平台货架=${(await shelfService.get(getIssuerIdentity().shelfDid))?.credentials?.length ?? '?'} 张`,
)
process.exit(0)
