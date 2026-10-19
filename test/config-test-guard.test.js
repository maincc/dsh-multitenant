/**
 * 存储护栏（2026-10-16 事故回归盾）：vitest 进程内 CONFIG.storage 必须已脱离 mongodb——
 * 事故复盘：全量测试曾以 fixture 内存权威 fanout 生产库，凭证账本被 $unset、架上真卡被
 * "自愈"误摘。护栏单点在 config 出口（provider 消费方有 6 处，逐个 mock 必有漏网）。
 */
import { describe, it, expect } from 'vitest'
import { CONFIG } from '../src/config/config.js'

describe('测试进程存储护栏', () => {
  it('vitest 环境下 provider 绝不可能是 mongodb', () => {
    expect(CONFIG.storage?.provider).not.toBe('mongodb')
  })
  it('降档不破坏其他 config 域（usageLimit/tiers 仍在）', () => {
    expect(CONFIG.usageLimit).toBeTruthy()
    expect(CONFIG.tiers).toBeTruthy()
  })
})
