/**
 * CWT（Jingtum Web Token）验证服务
 *
 * 用途：验证 CCDAO 插件 `cwt_sign` 产出的令牌（header.payload.Signature），
 * 并把令牌持有者映射到 SWTC 地址（身份 = x5c 公钥推导的地址）。
 *
 * 验签约定（与 cwt-lib 逐一对齐，实测交叉验证通过，见 docs/cwt-verify-test.md）：
 *   - signingInput = base64url(JSON(header)) + '.' + base64url(JSON(payload))
 *   - secp256k1：ECDSA 直接对 digest = SHA-256(UTF8(signingInput)) 签名
 *     → 用 Keypairs.verifyTx(digestHex, sig, pubkey) 验证
 *     （注意不是 verify()：verify 内部会多做一步 sha512 前 32 字节变换，
 *       那是交易消息专用，verify 的参数名 messageHex 拐了不少人）
 *   - ed25519：EdDSA 直接对 signingInput 的原始 UTF-8 字节签名
 *     → 用 Keypairs.verify(msgHex, sig, 'ED' + pubkey) 验证
 *
 * 服务端必须补的策略检查（cwt-lib 自带 verify 不检查，必须由本服务把关）：
 *   - chain === 'jingtum'（本项目只接受井通链）
 *   - type === 'CWT'（个人）；CWT_ENT（企业 group）暂不放开
 *   - payload 必须携带 usr 且不能同时携带 group
 *   - time 新鲜度（默认 ±5 分钟，防重放）
 *   - alg ∈ { secp256k1, ed25519 }
 */

import { createHash, createPublicKey, createVerify, verify as verifyOneShot } from 'node:crypto'
import { Keypairs } from '@swtc/keypairs'

/** 默认防重放窗口：±5 分钟（与 /api/user/config-challenge 的挑战 TTL 一致） */
const DEFAULT_TTL_MS = 5 * 60 * 1000

export function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

export function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/**
 * 从 x5c SPKI PEM 提取公钥点 hex：
 *   - secp256k1：33 字节压缩点（02/03 + X），直接喂 @swtc deriveAddress / verifyTx
 *   - ed25519：32 字节原始点；@swtc 的 ed25519 路径要求 'ED' 前缀，由调用方按算法补
 * @throws TypeError PEM 无法解析 / 不是 EC 公钥
 */
export function pubkeyHexFromPem(pem) {
  const jwk = createPublicKey(pem).export({ format: 'jwk' })
  // EC（secp256k1，kty=EC 有 x/y）与 OKP（ed25519，kty=OKP 只有 x）都接受
  if ((jwk.kty !== 'EC' && jwk.kty !== 'OKP') || typeof jwk.x !== 'string') {
    throw new TypeError('x5c 公钥不是 EC/Ed25519 公钥')
  }
  const x = Buffer.from(jwk.x, 'base64url')
  if (!jwk.y) return x.toString('hex') // ed25519：只有 x
  const y = Buffer.from(jwk.y, 'base64url')
  const prefix = y[y.length - 1] % 2 === 0 ? '02' : '03'
  return prefix + x.toString('hex') // secp256k1：压缩点
}

export class CwtService {
  /**
   * @param {object} [opts]
   * @param {typeof Keypairs} [opts.keypairs] 可注入的 @swtc/keypairs（测试 mock 用）
   * @param {number} [opts.ttlMs] 防重放窗口
   */
  constructor({ keypairs = Keypairs, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.keypairs = keypairs
    this.ttlMs = ttlMs
  }

  /**
   * 验证 CWT 令牌。不抛错，一律返回结果对象。
   * @param {string} token 插件 cwt_sign 输出（header.payload.Signature）
   * @param {object} [opts]
   * @param {string} [opts.expectedAddress] 期望绑定的 SWTC 地址（不匹配则拒）
   * @param {number} [opts.ttlMs] 覆盖构造时的防重放窗口
   * @param {number} [opts.now] 当前时间（毫秒，测试用）
   * @returns {{ ok: boolean, valid: boolean, address?: string, usr?: string,
   *             time?: number, chain?: string, alg?: string, error?: string }}
   */
  async verify(token, { expectedAddress = null, ttlMs = this.ttlMs, now = Date.now() } = {}) {
    const fail = (error) => ({ ok: true, valid: false, error })
    try {
      const parts = String(token).split('.')
      if (parts.length !== 3) throw new Error('token 必须是 header.payload.Signature 三段式')

      const header = JSON.parse(b64urlDecode(parts[0]))
      const payload = JSON.parse(b64urlDecode(parts[1]))
      const signingInput = `${parts[0]}.${parts[1]}`

      // ---- 策略检查 ----
      if (header.chain !== 'jingtum') {
        throw new Error(`chain 必须为 jingtum，实际 ${header.chain}`)
      }
      if (header.type !== 'CWT') {
        throw new Error(`type 必须为 CWT（个人），实际 ${header.type ?? '(缺失)'}`)
      }
      if (!payload.usr || payload.group) {
        throw new Error('payload 必须携带 usr 且不能同时携带 group')
      }
      const issued = Number(payload.time)
      // 单向新鲜度窗口（security-hardening-plan P2-6）：拒绝"未来"签发，只接受
      // 0 ≤ now - issued*1000 ≤ ttlMs（防把未来时间也纳入窗口导致重放窗口翻倍）
      const skewMs = now - issued * 1000
      if (!Number.isFinite(issued) || skewMs < 0 || skewMs > ttlMs) {
        throw new Error(`time 超出新鲜度窗口（0 ~ ${ttlMs / 60000}min）：${payload.time}`)
      }
      const pem = header.x5c?.[0]
      if (typeof pem !== 'string' || !pem.includes('BEGIN PUBLIC KEY')) {
        throw new Error('x5c[0] 必须是 SPKI PEM 公钥')
      }

      const derSigHex = b64urlToBuf(parts[2]).toString('hex')
      const pubHex = pubkeyHexFromPem(pem)

      // ---- 按算法验签（双路径：@swtc 为主，node crypto 独立交叉） ----
      if (header.alg === 'secp256k1') {
        const digestHex = createHash('sha256').update(signingInput, 'utf8').digest('hex')
        const swtcOk = this.keypairs.verifyTx(digestHex, derSigHex, pubHex)
        const verifier = createVerify('sha256')
        verifier.update(signingInput)
        verifier.end()
        const cryptoOk = verifier.verify(pem, b64urlToBuf(parts[2]))
        if (!swtcOk || !cryptoOk) {
          throw new Error(`secp256k1 签名验证失败（@swtc:${swtcOk} node:crypto:${cryptoOk}）`)
        }
      } else if (header.alg === 'ed25519') {
        const msgHex = Buffer.from(signingInput, 'utf8').toString('hex')
        const edPub = `ED${pubHex.toUpperCase()}`
        const swtcOk = this.keypairs.verify(msgHex, derSigHex, edPub)
        const cryptoOk = verifyOneShot(
          null,
          Buffer.from(signingInput, 'utf8'),
          pem,
          b64urlToBuf(parts[2]),
        )
        if (!swtcOk || !cryptoOk) {
          throw new Error(`ed25519 签名验证失败（@swtc:${swtcOk} node:crypto:${cryptoOk}）`)
        }
      } else {
        throw new Error(`alg 必须是 secp256k1 或 ed25519，实际 ${header.alg}`)
      }

      // ---- 身份：x5c 公钥 → SWTC 地址 ----
      const address =
        header.alg === 'ed25519'
          ? this.keypairs.deriveAddress(`ED${pubHex.toUpperCase()}`)
          : this.keypairs.deriveAddress(pubHex)
      if (expectedAddress && expectedAddress.toLowerCase() !== address.toLowerCase()) {
        throw new Error(`地址不匹配：声称 ${expectedAddress}，公钥推导 ${address}`)
      }

      return {
        ok: true,
        valid: true,
        address: address.toLowerCase(),
        usr: payload.usr,
        time: issued,
        chain: header.chain,
        alg: header.alg,
      }
    } catch (err) {
      return fail(err.message)
    }
  }

  /**
   * 出示验证（申请-批准-出示 的"出示"环节）：验签 + 授权注册表判定。
   * 薄封装：内部复用 verify，补注册表状态判定，不写任何状态（纯函数便于测试）。
   * 时效模型：无注册时效——CWT 只确定"该地址是已验证用户"，
   * 批准（approved）即豁免，撤销（revoked/不存在）即受限。
   * registry: 调用方传入的注册表（cwtStore.getRegistry()），键 = SWTC 地址。
   * @returns {Promise<{ok:true, valid:boolean, address?, usr?, time?, chain?, alg?, authorized?, error?}>}
   */
  async verifyForAccess(token, { registry = {}, expectedAddress = null, now = Date.now() } = {}) {
    const result = await this.verify(token, { expectedAddress, now })
    if (!result.valid) return result

    const entry = registry[result.address]
    if (!entry || entry.status !== 'approved') {
      return {
        ok: true,
        valid: false,
        address: result.address,
        error: '地址未在授权注册表或已被撤销',
      }
    }
    return { ...result, authorized: true }
  }
}

export const cwtService = new CwtService()
