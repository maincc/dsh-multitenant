import { afterEach, describe, expect, it, vi } from 'vitest'
import { Keypairs } from '@swtc/keypairs'
import { tenantConfigService } from '../src/services/tenant-config.service.js'

/** 生成一个模拟"用户钱包"的密钥对（与 CCDAO 插件同库） */
function makeWallet() {
  const seed = Keypairs.generateSeed({ algorithm: 'ed25519' })
  const kp = Keypairs.deriveKeypair(seed)
  return {
    address: Keypairs.deriveAddress(kp.publicKey).toLowerCase(),
    publicKey: kp.publicKey,
    sign: (msg) => Keypairs.sign(msg, kp.privateKey),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('租户密钥配置（钱包签名验证）', () => {
  it('挑战是一次性的（用后即焚）', () => {
    const { address } = makeWallet()
    const nonce = tenantConfigService.issueChallenge(address)
    expect(typeof nonce).toBe('string')
    expect(nonce.length).toBe(64) // 32 字节 hex
    expect(tenantConfigService.consumeChallenge(address, nonce)).toBe(true)
    expect(tenantConfigService.consumeChallenge(address, nonce)).toBe(false) // 重放被拒
  })

  it('挑战 5 分钟后过期', () => {
    vi.useFakeTimers()
    const { address } = makeWallet()
    const nonce = tenantConfigService.issueChallenge(address)
    vi.setSystemTime(Date.now() + 6 * 60 * 1000) // 拨快 6 分钟
    expect(tenantConfigService.consumeChallenge(address, nonce)).toBe(false)
  })

  it('验签：合法签名 + 公钥推导地址匹配则通过', () => {
    const wallet = makeWallet()
    const nonce = tenantConfigService.issueChallenge(wallet.address)
    const signature = wallet.sign(nonce)
    expect(
      tenantConfigService.verifySignature(wallet.address, nonce, signature, wallet.publicKey),
    ).toBe(true)
  })

  it('验签：地址不匹配则拒绝', () => {
    const wallet = makeWallet()
    const other = makeWallet()
    const nonce = tenantConfigService.issueChallenge(wallet.address)
    const signature = wallet.sign(nonce)
    expect(
      tenantConfigService.verifySignature(other.address, nonce, signature, wallet.publicKey),
    ).toBe(false)
  })

  it('验签：签名被篡改则拒绝', () => {
    const wallet = makeWallet()
    const nonce = tenantConfigService.issueChallenge(wallet.address)
    const signature = wallet.sign(nonce)
    const tampered = signature.slice(0, -2) + (signature.endsWith('00') ? '01' : '00')
    expect(
      tenantConfigService.verifySignature(wallet.address, nonce, tampered, wallet.publicKey),
    ).toBe(false)
  })

  it('验签：公钥非法格式则拒绝（不抛异常）', () => {
    const wallet = makeWallet()
    const nonce = tenantConfigService.issueChallenge(wallet.address)
    const signature = wallet.sign(nonce)
    expect(tenantConfigService.verifySignature(wallet.address, nonce, signature, 'not-a-key')).toBe(
      false,
    )
  })

  it('configure 拒绝未领取/已消费的挑战', async () => {
    const wallet = makeWallet()
    await expect(
      tenantConfigService.configure(wallet.address, {
        nonce: 'deadbeef'.repeat(8),
        signature: '',
        publicKey: wallet.publicKey,
        apiKey: 'sk-test',
      }),
    ).rejects.toThrow(/挑战/)
  })
})
