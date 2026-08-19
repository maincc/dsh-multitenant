import { describe, it, expect } from 'vitest'
import { isValidSwtcAddress, normalizeAddress, swtcContainerName, swtcVolumeName } from '../src/utils/address.js'

describe('SWTC 地址工具', () => {
  describe('isValidSwtcAddress', () => {
    it('应该验证有效的 SWTC 地址', () => {
      expect(isValidSwtcAddress('jGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or')).toBe(true)
      expect(isValidSwtcAddress('jNDwRetndumoqBT2UAuCLmFMx7XBQjYKvA')).toBe(true)
    })

    it('应该验证小写地址（含 l）', () => {
      expect(isValidSwtcAddress('jndwretndumoqbt2uauclmfmx7xbqjykva')).toBe(true)
    })

    it('应该拒绝无效地址', () => {
      expect(isValidSwtcAddress('')).toBe(false)
      expect(isValidSwtcAddress(null)).toBe(false)
      expect(isValidSwtcAddress(undefined)).toBe(false)
      expect(isValidSwtcAddress('j123')).toBe(false)
      expect(isValidSwtcAddress('xGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or')).toBe(false)
    })

    it('应该拒绝含 0OIl 的地址', () => {
      expect(isValidSwtcAddress('j0a9J9TkqtBcUoHe2zqhVFFbgUVED6o9or')).toBe(false)
      expect(isValidSwtcAddress('jOa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or')).toBe(false)
      expect(isValidSwtcAddress('jIa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or')).toBe(false)
    })
  })

  describe('normalizeAddress', () => {
    it('应该转小写', () => {
      expect(normalizeAddress('jGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or')).toBe('jga9j9tkqtbcuohe2zqhvffbguved6o9or')
    })
  })

  describe('swtcContainerName', () => {
    it('应该生成容器名', () => {
      expect(swtcContainerName('jGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or')).toBe('dsh-swtc-jga9j9tkqtbcuohe2zqhvffbguved6o9or')
    })
  })

  describe('swtcVolumeName', () => {
    it('应该生成卷名', () => {
      expect(swtcVolumeName('jGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or')).toBe('dsh-data-swtc-jga9j9tkqtbcuohe2zqhvffbguved6o9or')
    })
  })
})
