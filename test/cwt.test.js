/**
 * CWT 验证服务单元测试
 * 自包含：用 node crypto 生成 secp256k1 / ed25519 密钥并构造 CWT token
 * （签名约定与 cwt-lib 一致：secp256k1 签 SHA-256(signingInput)、ed25519 签原始字节），
 * 不依赖外部 cwt-lib。
 */
import { describe, expect, it } from 'vitest'
import { createHash, createPublicKey, createSign, generateKeyPairSync, sign } from 'node:crypto'
import { Keypairs } from '@swtc/keypairs'
import { cwtService } from '../src/services/cwt.service.js'

const b64url = (v) => Buffer.from(v).toString('base64url')

function compressedHexFromJwk(jwk) {
  const x = Buffer.from(jwk.x, 'base64url')
  const y = Buffer.from(jwk.y, 'base64url')
  return `${y[y.length - 1] % 2 === 0 ? '02' : '03'}${x.toString('hex')}`
}

/** secp256k1 钱包：node crypto 密钥 + @swtc 推导地址 */
function makeSecpWallet() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
  const pem = publicKey.export({ type: 'spki', format: 'pem' })
  const pubHex = compressedHexFromJwk(createPublicKey(pem).export({ format: 'jwk' }))
  return {
    publicPem: pem,
    pubHex,
    address: Keypairs.deriveAddress(pubHex).toLowerCase(),
    sign: (input) => createSign('sha256').update(input).sign(privateKey).toString('base64url'),
  }
}

/** ed25519 钱包 */
function makeEdWallet() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' })
  const rawHex = Buffer.from(
    createPublicKey(pem).export({ format: 'jwk' }).x,
    'base64url',
  ).toString('hex')
  return {
    publicPem: pem,
    rawHex,
    address: Keypairs.deriveAddress(`ED${rawHex.toUpperCase()}`).toLowerCase(),
    sign: (input) => sign(null, Buffer.from(input, 'utf8'), privateKey).toString('base64url'),
  }
}

/** 构造 CWT token（可覆盖 header/payload 字段做负例） */
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

/** 篡改 payload 段但不重新签名（签名与内容不再匹配） */
function tamperPayload(token, patch) {
  const [h, p, s] = token.split('.')
  const parsed = JSON.parse(
    Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
  )
  return `${h}.${b64url(JSON.stringify({ ...parsed, ...patch }))}.${s}`
}

describe('CWT 验证服务（secp256k1）', () => {
  it('合法 token：验签通过并推导出 SWTC 地址', async () => {
    const wallet = makeSecpWallet()
    const r = await cwtService.verify(buildToken(wallet))
    expect(r.valid).toBe(true)
    expect(r.address).toBe(wallet.address)
    expect(r.usr).toBe('alice')
    expect(r.alg).toBe('secp256k1')
  })

  it('与 @swtc/keypairs 的 verifyTx 路径一致（digest = sha256(signingInput)）', async () => {
    const wallet = makeSecpWallet()
    const token = buildToken(wallet)
    const [h, p] = token.split('.')
    const digestHex = createHash('sha256').update(`${h}.${p}`, 'utf8').digest('hex')
    const sigHex = Buffer.from(
      token.split('.')[2].replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('hex')
    expect(Keypairs.verifyTx(digestHex, sigHex, wallet.pubHex)).toBe(true)
  })

  it('expectedAddress 不匹配则拒绝', async () => {
    const wallet = makeSecpWallet()
    const other = makeSecpWallet()
    const r = await cwtService.verify(buildToken(wallet), { expectedAddress: other.address })
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/地址不匹配/)
  })

  it('篡改 payload 则拒绝', async () => {
    const wallet = makeSecpWallet()
    const r = await cwtService.verify(tamperPayload(buildToken(wallet), { usr: 'mallory' }))
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/签名验证失败/)
  })

  it('篡改签名段则拒绝', async () => {
    const wallet = makeSecpWallet()
    const token = buildToken(wallet)
    const [h, p, s] = token.split('.')
    const badSig = `${s.slice(0, -2)}AA`
    const r = await cwtService.verify(`${h}.${p}.${badSig}`)
    expect(r.valid).toBe(false)
  })

  it('time 超出新鲜度窗口（重放）则拒绝', async () => {
    const wallet = makeSecpWallet()
    const r = await cwtService.verify(
      buildToken(wallet, { payload: { time: Math.floor(Date.now() / 1000) - 3600 } }),
    )
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/新鲜度窗口/)
  })

  it('chain 伪装成 ethereum 则拒绝', async () => {
    const wallet = makeSecpWallet()
    const r = await cwtService.verify(buildToken(wallet, { header: { chain: 'ethereum' } }))
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/chain/)
  })

  it('type=CWT_ENT（企业 group）则拒绝', async () => {
    const wallet = makeSecpWallet()
    const r = await cwtService.verify(
      buildToken(wallet, { header: { type: 'CWT_ENT' }, payload: { group: 'acme' } }),
    )
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/CWT（个人）/)
  })

  it('声明 alg=ed25519 但实为 secp256k1 签名则拒绝（算法不可混用）', async () => {
    const wallet = makeSecpWallet()
    wallet.alg = 'ed25519' // buildToken 会用它填 header.alg，但签名仍是 secp256k1
    const r = await cwtService.verify(buildToken(wallet))
    expect(r.valid).toBe(false)
  })

  it('无效不入参则拒绝（格式/missing 字段）', async () => {
    expect((await cwtService.verify('not-a-token')).valid).toBe(false)
    expect((await cwtService.verify('a.b')).valid).toBe(false)
    expect((await cwtService.verify('')).valid).toBe(false)
  })
})

describe('CWT 验证服务（ed25519）', () => {
  it('合法 token：验签通过并推导出 SWTC 地址', async () => {
    const wallet = makeEdWallet()
    wallet.alg = 'ed25519'
    const r = await cwtService.verify(buildToken(wallet))
    expect(r.valid).toBe(true)
    expect(r.address).toBe(wallet.address)
    expect(r.alg).toBe('ed25519')
  })

  it('篡改 payload 则拒绝', async () => {
    const wallet = makeEdWallet()
    wallet.alg = 'ed25519'
    const r = await cwtService.verify(tamperPayload(buildToken(wallet), { usr: 'mallory' }))
    expect(r.valid).toBe(false)
  })

  it('time 过期则拒绝', async () => {
    const wallet = makeEdWallet()
    wallet.alg = 'ed25519'
    const r = await cwtService.verify(
      buildToken(wallet, { payload: { time: Math.floor(Date.now() / 1000) - 3600 } }),
    )
    expect(r.valid).toBe(false)
  })
})

describe('CWT 验证服务（与 cwt-lib 签名互认）', () => {
  it('node crypto 自签的 token 能被 @swtc verifyTx 验证（即服务端验证路径与 cwt-lib 同约定）', async () => {
    // 地面真值：cwt-lib 的签名约定 = sha256(signingInput) 后直接 ECDSA，
    // node crypto createSign('sha256') 内部同样先 sha256 再 ECDSA，二者互认。
    // 这里用 node crypto 签出与 cwt-lib 相同约定的签名，必须能被 @swtc verifyTx 接收。
    const wallet = makeSecpWallet()
    const token = buildToken(wallet)
    const digestHex = createHash('sha256')
      .update(`${token.split('.')[0]}.${token.split('.')[1]}`, 'utf8')
      .digest('hex')
    const sigHex = Buffer.from(
      token.split('.')[2].replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('hex')
    expect(Keypairs.verifyTx(digestHex, sigHex, wallet.pubHex)).toBe(true)
  })
})
