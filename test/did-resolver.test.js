/**
 * L1 档案判定件单测（did-vc-runbook 步骤5 验收：mock 三态）
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { l1ProfileHit, isL1ProfileDoc, _clearL1Cache } from '../src/services/did.service.js'

const ADDR = 'jL1testUserAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const goodDoc = {
  id: `did:swtc:${ADDR}`,
  verificationMethod: [
    { id: `#key-1`, type: 'EcdsaSecp256k1VerificationKey2019', publicKeyBase58: 'x' },
  ],
  authentication: ['#key-1'],
}
const stub = (doc) => ({ resolve: async () => doc })

beforeEach(() => _clearL1Cache())

describe('档案形状判定', () => {
  it('有键有认证=命中；空壳/缺认证/无文档=不算', () => {
    expect(isL1ProfileDoc(goodDoc)).toBe(true)
    expect(isL1ProfileDoc({ id: 'x' })).toBe(false)
    expect(isL1ProfileDoc({ ...goodDoc, authentication: [] })).toBe(false)
    expect(isL1ProfileDoc(null)).toBe(false)
  })
})

describe('l1ProfileHit 三态', () => {
  it('① 命中：真档案（含 {didDocument} 包装兼容）', async () => {
    expect(await l1ProfileHit(ADDR, { resolver: stub(goodDoc) })).toBe(true)
    _clearL1Cache()
    expect(await l1ProfileHit(ADDR, { resolver: stub({ didDocument: goodDoc }) })).toBe(true)
  })

  it('② 缺席：resolve 抛（文档不存在）→ false 静默', async () => {
    const boom = {
      resolve: async () => {
        throw new Error('not found')
      },
    }
    expect(await l1ProfileHit(ADDR, { resolver: boom })).toBe(false)
  })

  it('③ 超时：慢 resolver → timeoutMs 内静默 false', async () => {
    const slow = { resolve: () => new Promise((r) => setTimeout(() => r(goodDoc), 200)) }
    const t0 = Date.now()
    expect(await l1ProfileHit(ADDR, { resolver: slow, timeoutMs: 50 })).toBe(false)
    expect(Date.now() - t0).toBeLessThan(150)
  })

  it('③b 一次超时不下缺席结论：重试成功=hit（2026-10-19 档案误判事故回归位）', async () => {
    let n = 0
    const flaky = {
      resolve: async () => {
        n++
        // 第一次冷启动慢（超时），第二次立刻返回——真实 relay 的常见抖动形态
        if (n === 1) return new Promise((r) => setTimeout(() => r(goodDoc), 100))
        return goodDoc
      },
    }
    expect(await l1ProfileHit(ADDR, { resolver: flaky, timeoutMs: 30 })).toBe(true)
    expect(n).toBe(2)
  })

  it('③c bust：不吃缓存窗（用户主动领取必实探）', async () => {
    let n = 0
    const counting = {
      resolve: async () => {
        n++
        return goodDoc
      },
    }
    await l1ProfileHit(ADDR, { resolver: counting })
    expect(n).toBe(1)
    await l1ProfileHit(ADDR, { resolver: counting }) // 缓存命中，不打 resolver
    expect(n).toBe(1)
    await l1ProfileHit(ADDR, { resolver: counting, bust: true }) // bust 实探
    expect(n).toBe(2)
  })

  it('缓存：15min 窗口内第二次不再打 resolver', async () => {
    let calls = 0
    const counting = {
      resolve: async () => {
        calls++
        return goodDoc
      },
    }
    await l1ProfileHit(ADDR, { resolver: counting })
    await l1ProfileHit(ADDR, { resolver: counting })
    expect(calls).toBe(1)
    // 窗口过期（ttlMs 极小）→ 重查
    await l1ProfileHit(ADDR, { resolver: counting, ttlMs: 0, now: Date.now() + 10 })
    expect(calls).toBe(2)
  })

  it('EVM 地址也接受（族选择走 ethr resolver；单 resolver 注入下同路）', async () => {
    expect(
      await l1ProfileHit('0xAbC0000000000000000000000000000000000001', { resolver: stub(goodDoc) }),
    ).toBe(true)
  })

  it('垃圾入参静默 false', async () => {
    expect(await l1ProfileHit('')).toBe(false)
    expect(await l1ProfileHit(null)).toBe(false)
  })
})
