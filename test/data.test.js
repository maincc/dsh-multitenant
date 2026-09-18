import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
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

  describe('DSH 镜像版本记录', () => {
    it('初始为空（current:null, history:[]）', () => {
      const rec = service.getDshImage()
      expect(rec.current).toBeNull()
      expect(rec.history).toEqual([])
    })

    it('saveDshImage 写入 current 并追加历史', () => {
      service.saveDshImage({ version: '0.1.5-rc.1', imageId: 'sha256:a', by: 'admin' })
      service.saveDshImage({ version: '0.1.6-alpha.1', imageId: 'sha256:b', by: 'admin' })

      const rec = service.getDshImage()
      expect(rec.current.version).toBe('0.1.6-alpha.1')
      expect(rec.current.imageId).toBe('sha256:b')
      expect(rec.current.at).toBeGreaterThan(0)
      expect(rec.history).toHaveLength(2)
      expect(rec.history[0].version).toBe('0.1.5-rc.1')
      expect(rec.history[1].version).toBe('0.1.6-alpha.1')
    })

    it('历史最多保留 50 条（防止无限增长）', () => {
      for (let i = 0; i < 60; i++) {
        service.saveDshImage({ version: `0.0.${i}`, imageId: `sha256:${i}` })
      }

      const rec = service.getDshImage()
      expect(rec.history).toHaveLength(50)
      // 保留的是最近 50 条
      expect(rec.history.at(-1).version).toBe('0.0.59')
      expect(rec.history[0].version).toBe('0.0.10')
    })

    it('落盘文件权限为 0600（暴露平台 DSH 版本属攻击面信息）', () => {
      service.saveDshImage({ version: '0.1.5', imageId: 'sha256:a' })

      const mode = statSync(service.dshImageFile()).mode & 0o777
      expect(mode).toBe(0o600)
    })

    it('文件损坏时降级为空记录，不抛异常', () => {
      writeFileSync(service.dshImageFile(), '这不是 json')
      const rec = service.getDshImage()
      expect(rec.current).toBeNull()
      expect(rec.history).toEqual([])
    })
  })
})
