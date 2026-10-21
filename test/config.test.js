import { describe, it, expect } from 'vitest'
import {
  loadConfig,
  isAdmin,
  getTierLimits,
  getAdminAddresses,
  _deepMergeForTest as deepMerge,
} from '../src/config/config.js'

describe('配置模块', () => {
  describe('loadConfig', () => {
    it('应该加载默认配置', () => {
      const config = loadConfig()
      expect(config.server.port).toBe(8090)
      expect(config.docker.basePort).toBe(31000)
      expect(config.tiers[1].memory).toBe('512m')
    })

    it('应该有 3 个配额层级', () => {
      const config = loadConfig()
      expect(Object.keys(config.tiers)).toHaveLength(3)
      expect(config.tiers[1].label).toBe('基础')
      expect(config.tiers[2].label).toBe('增强')
      expect(config.tiers[3].label).toBe('高性能')
    })
  })

  describe('isAdmin', () => {
    it('应该识别管理员地址', () => {
      expect(isAdmin('jndwretndumoqbt2uauclmfmx7xbqjykva')).toBe(true)
    })

    it('应该识别非管理员地址', () => {
      // 使用合成地址（格式合法但不会被提权），避免依赖本地运行时数据
      // data/config/admin.json（该文件里的地址会被 isAdmin 合并判定）
      expect(isAdmin('j1111111111111111111111111111111111')).toBe(false)
    })

    it('应该大小写不敏感', () => {
      expect(isAdmin('jNDwRetndumoqBT2UAuCLmFMx7XBQjYKvA')).toBe(true)
    })
  })

  describe('getTierLimits', () => {
    it('应该返回指定层级的配额', () => {
      const limits = getTierLimits(1)
      expect(limits.memory).toBe('512m')
      expect(limits.cpus).toBe('1.0')
    })

    it('应该返回默认层级当层级无效', () => {
      const limits = getTierLimits(99)
      expect(limits.memory).toBe('512m')
    })
  })
})

// ── 测试存储护盾（globalSetup 钉 env；config.json 写 mongodb 也不带偏测试）──
describe('测试环境存储护盾', () => {
  it('worker env 被 globalSetup 钉死：provider=json、URI 无库名基串', () => {
    expect(process.env.DSH_STORAGE_PROVIDER).toBe('json')
    expect(process.env.MONGODB_URI).toBe('mongodb://127.0.0.1:27018/?replicaSet=dsh-rs')
  })
})

// 2026-10 审计：loadConfig 此前是浅合并——config.json 写半个 section
// （如 usageLimit:{enabled:true}）会整段替换默认对象，未写的子键（dailyMinutes）
// 蒸发，功能随"半个配置"悄悄失灵。深合并让部分覆盖回归直觉。
describe('config 深合并', () => {
  it('部分子键覆盖且保留默认兄弟键', () => {
    const base = { usageLimit: { enabled: true, dailyMinutes: 120, checkIntervalMs: 60000 } }
    expect(deepMerge(base, { usageLimit: { enabled: false } }).usageLimit).toEqual({
      enabled: false,
      dailyMinutes: 120,
      checkIntervalMs: 60000,
    })
  })

  it('新增键合并；数组整体替换；标量与对象同名互斥直接覆盖', () => {
    expect(deepMerge({ a: { b: 1 } }, { a: { c: 2 }, list: [1] })).toEqual({
      a: { b: 1, c: 2 },
      list: [1],
    })
    expect(deepMerge({ list: [1, 2] }, { list: [3] }).list).toEqual([3])
    expect(deepMerge({ x: { y: 1 } }, { x: 5 }).x).toBe(5)
    expect(deepMerge({ x: 5 }, { x: { y: 1 } }).x).toEqual({ y: 1 })
  })
})
