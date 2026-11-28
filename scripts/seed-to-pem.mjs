#!/usr/bin/env node
/**
 * ss seed / s secret 字符串密钥 → SEC1 PEM（issuer.key 装配辅助）。
 * 背景：credential.service 的 platform() 硬编码 createPrivateKey({format:'pem'})，
 * 只认 SEC1 PEM；而钱包/插件导出的常是 SWTC 生态的 ss 开头 seed（或 s 开头 secret）
 * 字符串。本脚本做这条唯一需要的转换，并顺带打印派生地址供与 issuer-profile.json
 * 的 id 核对——**两者必须同一密钥对**，DID 不符则签出的卡官网验真必失败。
 *
 * 用法（服务器上项目根目录，生产依赖 @swtc/keypairs + @noble/curves 已在场）：
 *   node scripts/seed-to-pem.mjs 'ssXXXXXXXX…'          # 打印 PEM（不落盘）
 *   node scripts/seed-to-pem.mjs 'ss…' > data/keys/issuer.key && chmod 600 data/keys/issuer.key
 * 私钥纪律：只在服务器现场跑；输出别贴聊天/别入库；本脚本不读不写任何日志。
 */
import { Keypairs } from '@swtc/keypairs'
import { secp256k1 } from '@noble/curves/secp256k1.js'

const secret = process.argv[2]
if (!secret || !/^[sd][0-9A-Za-z]+$/.test(secret)) {
  console.error('用法: node scripts/seed-to-pem.mjs <ss开头seed 或 s开头secret>')
  process.exit(1)
}

// deriveKeypair 同时吃 ss seed 与 s secret；字段名 privateKey，66 hex 时为首字节 00 补位
const rawHex = String(Keypairs.deriveKeypair(secret).privateKey || '').toLowerCase()
const privHex = rawHex.length === 66 && rawHex.startsWith('00') ? rawHex.slice(2) : rawHex
if (!/^[0-9a-f]{64}$/.test(privHex)) throw new Error('派生私钥形态异常（非 64/66 hex）')
// ★地址口径（2026-10-26 事故修正）：deriveAddress 的输入是**公钥 hex**，不是 seed 字符串——
// 曾把 seed 直传，base58 字符被按 hex 有损解码，静默打出假地址（fixlog#35 同族教训）。
// 生态口径 = 压缩公钥（02/03 前缀 66 hex）；与库自己返回的 publicKey 双源互证，不一致即炸。
// noble 返回 Uint8Array，须转 hex 再与库的 publicKey hex 互证
const pubCHex = Buffer.from(secp256k1.getPublicKey(privHex, true)).toString('hex')
const kpPubHex = String(Keypairs.deriveKeypair(secret).publicKey || '').toLowerCase()
if (kpPubHex && kpPubHex !== pubCHex)
  throw new Error(
    `公钥双源不一致（库 ${kpPubHex.slice(0, 8)}… vs noble ${pubCHex.slice(0, 8)}…），中止`,
  )
const address = Keypairs.deriveAddress(pubCHex)

// SEC1 EC 私钥 DER 手工封装：SEQUENCE{ ver=1, OCTET priv, [0]{OID secp256k1}, [1]{BITSTRING pub} }
// 曲线参数必须显式带——node 的 PEM 解析没有 OID 就不知道是哪条曲线
const priv = Buffer.from(privHex, 'hex')
const pub = Buffer.from(secp256k1.getPublicKey(privHex, false)) // 未压缩 0x04||X||Y（65B）
const der = Buffer.concat([
  Buffer.from('30740201010420', 'hex'),
  priv,
  Buffer.from('a00706052b8104000a', 'hex'), // [0] OID 1.3.132.0.10 = secp256k1
  Buffer.from('a144034200', 'hex'), // [1] BITSTRING（前置 0x00 无填充位）
  pub,
])
const b64 = der
  .toString('base64')
  .replace(/(.{64})/g, '$1\n')
  .trim()
const pem = `-----BEGIN EC PRIVATE KEY-----\n${b64}\n-----END EC PRIVATE KEY-----\n`

// 自证闭环：node 能按 pem 解回来（platform() 走的就是这条 API）
const crypto = await import('node:crypto')
const rt = crypto.createPrivateKey({ key: pem, format: 'pem' })
const rtPriv = Buffer.from(rt.export({ format: 'jwk' }).d, 'base64url')
  .toString('hex')
  .padStart(64, '0')
if (rtPriv !== privHex) throw new Error('往返校验失败：PEM 解析出的私钥与派生不符')

console.error(
  `派生地址: ${address}  ←→ 必须等于 issuer-profile.json 的 id 尾部 did:swtc:${address}`,
)
if (!Keypairs.isValidAddress?.(address))
  console.error('!! 地址校验未通过，请确认输入是完整 seed/secret')
process.stdout.write(pem)
