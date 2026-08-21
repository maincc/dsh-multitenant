import { describe, it, expect } from 'vitest'
import { loadConfig, isAdmin, getTierLimits, getAdminAddresses } from '../src/config/config.js'

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
