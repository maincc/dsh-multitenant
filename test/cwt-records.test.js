/**
 * CWT 审计日志（records.log）：尾部读取 + 日志轮转 测试
 *
 * 背景：日志为 append-only，随运行时间无限增长。原实现每次 readFileSync 全量读取
 * 并解析所有行（只返回尾部 200 条），而前端每 10 秒轮询一次 —— 文件越大开销越大，
 * 同步 I/O 会阻塞事件循环。本测试覆盖：
 *   - 尾部读取：只读文件尾部窗口，行数不足时窗口翻倍，结果倒序、截断正确
 *   - 大文件：文件远大于读取窗口时仍返回正确尾部（含半行/多字节截断处理）
 *   - 轮转：超过阈值时归档为 records.log.1 并新建日志（磁盘占用有界）
 *
 * 隔离：注入 test-data 临时目录，不触碰真实 data/。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DataService } from '../src/services/data.service.js'

describe('CWT 审计日志：尾部读取与轮转', () => {
  let service
  const testDir = join(process.cwd(), 'test-data-cwt-records')

  beforeEach(() => {
    mkdirSync(join(testDir, 'cwt'), { recursive: true })
    service = new DataService()
    service.dataDir = testDir
  })

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
  })

  const recordsPath = () => join(testDir, 'cwt', 'records.log')
  const writeLines = (records) =>
    writeFileSync(recordsPath(), records.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8')
  const rec = (i, action = 'approve') => ({ address: `addr${i}`, action, at: 1000 + i })
  /** 只取本页记录（新 → 旧）；分页元数据另用 readPage */
  const recsOf = (limit, offset = 0) => service.readCwtRecords(limit, offset).records
  const readPage = (limit, offset = 0) => service.readCwtRecords(limit, offset)

  describe('尾部读取', () => {
    it('文件不存在 → 空数组', () => {
      expect(recsOf(10)).toEqual([])
    })

    it('空文件 → 空数组', () => {
      writeFileSync(recordsPath(), '', 'utf8')
      expect(recsOf(10)).toEqual([])
    })

    it('返回尾部 N 条并按新→旧排列', () => {
      writeLines([rec(1), rec(2), rec(3), rec(4), rec(5)])
      const out = recsOf(2)
      expect(out.map((r) => r.at)).toEqual([1005, 1004])
    })

    it('limit 大于总条数 → 返回全部（仍为新→旧）', () => {
      writeLines([rec(1), rec(2), rec(3)])
      const out = recsOf(100)
      expect(out).toHaveLength(3)
      expect(out.map((r) => r.at)).toEqual([1003, 1002, 1001])
    })

    it('损坏行被跳过，不影响其余记录', () => {
      writeFileSync(
        recordsPath(),
        `${JSON.stringify(rec(1))}\n{ 坏行\n${JSON.stringify(rec(2))}\n`,
        'utf8',
      )
      const out = recsOf(10)
      expect(out.map((r) => r.at)).toEqual([1002, 1001])
    })

    it('大文件（远超读取窗口）→ 只取尾部，结果正确', () => {
      // 每条约 100 字节 × 2000 条 ≈ 200KB > 64KB 初始窗口
      const many = Array.from({ length: 2000 }, (_, i) => ({
        address: 'j'.repeat(60),
        action: 'approve',
        at: i,
      }))
      writeLines(many)
      expect(readFileSync(recordsPath(), 'utf8').length).toBeGreaterThan(64 * 1024)

      const out = recsOf(5)
      expect(out).toHaveLength(5)
      expect(out.map((r) => r.at)).toEqual([1999, 1998, 1997, 1996, 1995])
    })

    it('大文件 + 大 limit（窗口需前置扩展）→ 结果完整且顺序正确', () => {
      const many = Array.from({ length: 1500 }, (_, i) => ({
        address: 'j'.repeat(60),
        action: 'reject',
        at: i,
      }))
      writeLines(many)

      const out = recsOf(1200) // 约 120KB > 64KB 初始窗口
      expect(out).toHaveLength(1200)
      expect(out[0].at).toBe(1499) // 最新
      expect(out[1199].at).toBe(300) // 第 1200 条
    })

    it('多字节字符（中文 usr）在窗口边界不被破坏', () => {
      const many = Array.from({ length: 1200 }, (_, i) => ({
        usr: `用户-${i}-中文测试`,
        action: 'approve',
        at: i,
      }))
      writeLines(many)

      const out = recsOf(3)
      expect(out.map((r) => r.at)).toEqual([1199, 1198, 1197])
      // 不应出现 UTF-8 截断替换字符
      expect(out.every((r) => !r.usr.includes('\uFFFD'))).toBe(true)
    })
  })

  describe('分页（offset + hasMore）', () => {
    it('offset 分页：第 2 页为次新的记录', () => {
      writeLines([rec(1), rec(2), rec(3), rec(4), rec(5)])

      const p1 = readPage(2, 0)
      expect(p1.records.map((r) => r.at)).toEqual([1005, 1004])
      expect(p1.hasMore).toBe(true)

      const p2 = readPage(2, 2)
      expect(p2.records.map((r) => r.at)).toEqual([1003, 1002])
      expect(p2.hasMore).toBe(true)

      const p3 = readPage(2, 4)
      expect(p3.records.map((r) => r.at)).toEqual([1001])
      expect(p3.hasMore).toBe(false) // 已到最旧
    })

    it('恰好整页时 hasMore=false；多一条则 true', () => {
      writeLines([rec(1), rec(2), rec(3), rec(4)])

      const exact = readPage(2, 2) // 取最后 2 条
      expect(exact.records.map((r) => r.at)).toEqual([1002, 1001])
      expect(exact.hasMore).toBe(false)

      const more = readPage(2, 1)
      expect(more.records.map((r) => r.at)).toEqual([1003, 1002])
      expect(more.hasMore).toBe(true)
    })

    it('offset 超出总数 → 空页且 hasMore=false', () => {
      writeLines([rec(1), rec(2)])
      const p = readPage(10, 50)
      expect(p.records).toEqual([])
      expect(p.hasMore).toBe(false)
    })

    it('大文件 + offset 分页（窗口需前置扩展）结果正确', () => {
      const many = Array.from({ length: 1500 }, (_, i) => ({
        address: 'j'.repeat(60),
        action: 'approve',
        at: i,
      }))
      writeLines(many)

      // 第 101~110 条（按新→旧）：at 应为 1399..1390
      const p = readPage(10, 100)
      expect(p.records.map((r) => r.at)).toEqual([
        1399, 1398, 1397, 1396, 1395, 1394, 1393, 1392, 1391, 1390,
      ])
      expect(p.hasMore).toBe(true)
    })

    it('空文件 / 不存在 → { records: [], hasMore: false }', () => {
      expect(readPage(10)).toEqual({ records: [], hasMore: false })
      writeFileSync(recordsPath(), '', 'utf8')
      expect(readPage(10)).toEqual({ records: [], hasMore: false })
    })
  })

  describe('日志轮转', () => {
    it('未达阈值 → 不轮转，继续追加', () => {
      service.recordsMaxBytes = 10 * 1024
      service.appendCwtRecord(rec(1))
      service.appendCwtRecord(rec(2))

      expect(existsSync(`${recordsPath()}.1`)).toBe(false)
      expect(recsOf(10)).toHaveLength(2)
    })

    it('达到阈值 → 当前日志归档为 records.log.1，新日志只含新记录', () => {
      service.recordsMaxBytes = 120 // 极小阈值：约 3 条即触发
      service.appendCwtRecord(rec(1))
      service.appendCwtRecord(rec(2))
      service.appendCwtRecord(rec(3))
      service.appendCwtRecord(rec(4)) // 追加前检查：3 条已超阈值 → 先轮转再写

      const archive = `${recordsPath()}.1`
      expect(existsSync(archive)).toBe(true)

      // 归档包含轮转前的记录，当前日志只保留轮转后的新记录
      const archived = readFileSync(archive, 'utf8').trim().split('\n').map(JSON.parse)
      expect(archived.map((r) => r.at)).toEqual([1001, 1002, 1003])
      expect(recsOf(10).map((r) => r.at)).toEqual([1004])
    })

    it('多次轮转 → 只保留一份归档（覆盖旧的），磁盘占用有界', () => {
      service.recordsMaxBytes = 120
      for (let i = 1; i <= 4; i++) service.appendCwtRecord(rec(i)) // 第 4 条前触发首次轮转
      const archivedFirst = readFileSync(`${recordsPath()}.1`, 'utf8')
      expect(archivedFirst).toContain('"at":1001')

      // 继续写入至再次触发轮转（当前日志含 4,5,6 → 第 7 条前触发）
      for (let i = 5; i <= 7; i++) service.appendCwtRecord(rec(i))

      // 第二份归档覆盖第一份，不产生 .2 / .3
      expect(existsSync(`${recordsPath()}.2`)).toBe(false)
      const archivedSecond = readFileSync(`${recordsPath()}.1`, 'utf8')
      expect(archivedSecond).not.toBe(archivedFirst)
      expect(archivedSecond).toContain('"at":1004')
      expect(recsOf(10).map((r) => r.at)).toEqual([1007])
    })

    it('轮转后日志文件仍为 0600 权限', () => {
      service.recordsMaxBytes = 120
      for (let i = 1; i <= 4; i++) service.appendCwtRecord(rec(i))

      const mode = (statSync(recordsPath()).mode & 0o777).toString(8)
      expect(mode).toBe('600')
      const archiveMode = (statSync(`${recordsPath()}.1`).mode & 0o777).toString(8)
      expect(archiveMode).toBe('600')
    })
  })
})
