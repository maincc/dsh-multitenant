// 纯 JS SHA-256 兜底的正确性对拍（frontend/src/utils/sha256.js）
// 为什么进后端测试套件：领取凭证的文件签哈希在浏览器非安全上下文（http+局域网 IP）
// 走这条兜底（2026-10-26 服务器实弹）；对拍对象=node 原生 crypto（与 subtle 同源实现），
// 任何一格 hex 不一致=签出的文件签官网必验不过，属判权级缺陷。
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { sha256Hex } from '../frontend/src/utils/sha256.js'

const native = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex')
const of = (str) => new TextEncoder().encode(str)

describe('sha256Hex 纯 JS 兜底（对拍 node 原生）', () => {
  it('FIPS 标准向量', () => {
    expect(sha256Hex(of(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex(of('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('长度分块/填充边界逐格一致（55/56/63/64/65/119/120/512 字节）', () => {
    for (const n of [0, 1, 54, 55, 56, 63, 64, 65, 111, 119, 120, 127, 128, 511, 512, 513]) {
      const bytes = new Uint8Array(n)
      for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) & 0xff
      expect(sha256Hex(bytes)).toBe(native(bytes))
    }
  })

  it('真实使用面：SWTC 地址与档案 JSON 字节', () => {
    const addr = of('jndwretndumoqbt2uauclmfmx7xbqjykva')
    expect(sha256Hex(addr)).toBe(native(addr))
    const doc = of(
      JSON.stringify({ id: 'did:swtc:jX', credentials: [{ type: ['VerifiableCredential'] }] }),
    )
    expect(sha256Hex(doc)).toBe(native(doc))
  })

  it('随机 200 组（含多块与高字节）', () => {
    for (let i = 0; i < 200; i++) {
      const n = Math.floor(Math.random() * 3000)
      const bytes = new Uint8Array(n)
      for (let j = 0; j < n; j++) bytes[j] = Math.floor(Math.random() * 256)
      expect(sha256Hex(bytes)).toBe(native(bytes))
    }
  })
})
