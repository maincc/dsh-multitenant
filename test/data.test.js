import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DataService } from '../src/services/data.service.js'

describe('DataService', () => {
  let service
  const testDir = join(process.cwd(), 'test-data')

  beforeEach(() => {
    // 创建测试目录
    mkdirSync(testDir, { recursive: true })
    mkdirSync(join(testDir, 'users'), { recursive: true })
    mkdirSync(join(testDir, 'config'), { recursive: true })
    mkdirSync(join(testDir, 'stats'), { recursive: true })
    
    service = new DataService()
    service.dataDir = testDir
  })

  afterEach(() => {
    // 清理测试目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true })
    }
  })

  describe('writeWithLock', () => {
    it('应该写入 JSON 文件', () => {
      const filePath = join(testDir, 'test.json')
      service.writeWithLock(filePath, { name: 'test', value: 42 })
      
      const content = JSON.parse(readFileSync(filePath, 'utf8'))
      expect(content.name).toBe('test')
      expect(content.value).toBe(42)
    })
  })

  describe('readJson', () => {
    it('应该读取 JSON 文件', () => {
      const filePath = join(testDir, 'test.json')
      writeFileSync(filePath, JSON.stringify({ name: 'test' }))
      
      const content = service.readJson(filePath)
      expect(content.name).toBe('test')
    })

    it('应该返回 null 当文件不存在', () => {
      const content = service.readJson(join(testDir, 'nonexistent.json'))
      expect(content).toBeNull()
    })
  })

  describe('saveUser / getUser', () => {
    it('应该保存和读取用户数据', () => {
      const address = 'testaddress123'
      const userData = {
        address,
        port: 31000,
        tier: 1,
        containerStatus: 'running',
      }
      
      service.saveUser(address, userData)
      const retrieved = service.getUser(address)
      
      expect(retrieved.address).toBe(address)
      expect(retrieved.port).toBe(31000)
    })
  })

  describe('addAdmin', () => {
    it('应该添加管理员', () => {
      const address = 'testadmin123'
      const added = service.addAdmin(address, 'test')
      
      expect(added).toBe(true)
      
      const config = service.getAdminConfig()
      expect(config.addresses).toContain(address)
    })

    it('不应该重复添加管理员', () => {
      const address = 'testadmin123'
      service.addAdmin(address, 'test')
      const added = service.addAdmin(address, 'test')
      
      expect(added).toBe(false)
    })
  })
})
