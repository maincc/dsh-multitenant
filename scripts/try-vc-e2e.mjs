
const { CONFIG } = await import('../src/config/config.js')
const { issueAndShelf, verifyVc } = await import('../src/services/vc.service.js')
const { shelfService } = await import('../src/services/shelf.service.js')
shelfService.confirm = { firstMs: 10000, stepMs: 8000, budgetMs: 60000 } // 压缩真实时钟
const { userService } = await import('../src/services/user.service.js')
const { l1ProfileHit } = await import('../src/services/did.service.js')
const { tenantConfigService, SIGN_PURPOSE, buildSignedMessage } = await import('../src/services/tenant-config.service.js')
const { Keypairs } = await import('@swtc/keypairs')
const { secp256k1 } = await import('@noble/curves/secp256k1')
const { bytesToHex } = await import('@noble/hashes/utils')

const userPriv = bytesToHex(secp256k1.utils.randomSecretKey())
const userAddr = Keypairs.deriveAddress(bytesToHex(secp256k1.getPublicKey(userPriv, true)))
userService.state.swtcUsers = { [userAddr]: { containerStatus: 'running' } }

console.log('── E2E 开始（dev 实例真实链路）──')
// ① 首登哑铸
CONFIG.vc.autoMint = true
await userService._maybeMintVc(userAddr)
for (let i = 0; i < 12 && !userService.state.swtcUsers[userAddr].vc; i++) await new Promise(r => setTimeout(r, 5000))
const entry = userService.state.swtcUsers[userAddr].vc
console.log('① 首登哑铸:', entry ? entry.jti.slice(-16) + ' onShelf=' + entry.onShelf : 'FAIL 未落库')
// ② 外部验签
console.log('② verifyCredential:', entry ? (await verifyVc(entry.ldvc)).verified : 'skip')
// ③ 出示三问（真签）
const ch = tenantConfigService.issueChallenge(userAddr, SIGN_PURPOSE.VC_PRESENT)
const msg = buildSignedMessage(SIGN_PURPOSE.VC_PRESENT, userAddr, ch.nonce, entry.jti)
const sig = Keypairs.sign(msg, userPriv)
const consumed = tenantConfigService.consumeChallenge(userAddr, ch.nonce, SIGN_PURPOSE.VC_PRESENT)
const signed = tenantConfigService.verifySignature(userAddr, msg, sig, bytesToHex(secp256k1.getPublicKey(userPriv, true)))
console.log('③ 挑战消费:', consumed, '验签:', signed)
// ④ L1 判定（真网络）
console.log('④ L1 新用户(应false):', await l1ProfileHit(userAddr), '| L1 dev有档案(应true):', await l1ProfileHit('j4DqiyyZCunyKJRFwC496QnsiUFqmWVmJR'))
// ⑤ reconcile：无主摘 + 缺补
await shelfService.addVC({ id: 'urn:dsh:credential:orphan-e2e', expirationDate: new Date(Date.now() + 864e5).toISOString() })
entry.onShelf = false
await shelfService.removeVC(entry.jti) // 人工制造"架上缺失"
await new Promise(r => setTimeout(r, 3000))
console.log('⑤ reconcile:', JSON.stringify(await userService.reconcileVcShelf()))
// ⑥ 清理撤净
CONFIG.vc.autoMint = false
userService.state.swtcUsers[userAddr].vc = null // registry 判死→下轮 reconcile 摘净；这里直接撤
await shelfService.removeVC(entry.jti)
await shelfService.removeVC('urn:dsh:credential:orphan-e2e')
console.log('⑥ 撤架指令已发（快照收敛后货架=空）')
process.exit(0)
