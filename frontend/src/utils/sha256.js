/**
 * SHA-256（hex）——非安全上下文的 crypto.subtle 兜底。
 * 背景（2026-10-26 服务器实弹）：crypto.subtle 只在安全上下文存在（https /
 * localhost / 127.0.0.1）。局域网 IP 走 http 访问平台时 `crypto.subtle` 为
 * undefined，领取凭证的文件签前置哈希直接抛
 * "Cannot read properties of undefined (reading 'digest')"——本地 127.0.0.1
 * 永远复现不出来（fixlog #5/#27 同族）。与 docs/crypto-randomuuid.md 是同一个
 * 非安全上下文缺口，那次死的是 randomUUID，这次是 subtle。
 *
 * 实现取舍：手写 FIPS 实现调试中在常数表/端序/结构多处反复出偏，密码原语
 * 不自造——直接复用生产依赖里被广泛审计的 @noble/hashes（与 root
 * package.json "@noble/hashes" 同源，服务器 vite 构建向父级解析 node_modules
 * 即可拿到）。输出与 crypto.subtle.digest('SHA-256') 逐字节一致
 * （test/sha256.test.js 对拍 node 原生钉死）。被哈希的是地址/档案字节
 * （KB 级），体积与性能均无感。
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'

/** @param {Uint8Array} bytes @returns {string} 64 位小写 hex */
export function sha256Hex(bytes) {
  return bytesToHex(nobleSha256(bytes))
}
