/**
 * CWT 存储层（data/cwt/，cwtStore）单元测试
 *
 * 覆盖：
 *   - 旧 state.json 数据迁移（有数据 / 空块只清理）
 *   - 申请队列裁剪策略：pending / approved 永久保留，rejected 保留最近 100 条
 *   - 审计记录追加 / 尾部读取
 * 存储落盘全部 mock（dataService），不触碰真实 data/cwt/ 文件。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { dataService } from '../src/services/data.service.js'
import { cwtStore } from '../src/services/cwt.store.js'

describe('CWT 存储（cwtStore）', () => {
  beforeEach(() => {
    cwtStore.registry = {}
    cwtStore.applications = []
    vi.spyOn(dataService, 'readStateFile').mockReturnValue(null)
    vi.spyOn(dataService, 'saveCwtRegistry').mockImplementation(() => {})
    vi.spyOn(dataService, 'saveCwtApplications').mockImplementation(() => {})
    vi.spyOn(dataService, 'appendCwtRecord').mockImplementation(() => {})
    vi.spyOn(dataService, 'stripLegacyCwt').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cwtStore.registry = {}
    cwtStore.applications = []
  })

  it('迁移：旧 state.json 有 CWT 数据 → 搬移到 data/cwt/ 并清理旧块', () => {
    const legacyRegistry = {
      jndwretndumoqbt2uauclmfmx7xbqjykva: {
        usr: 'dsh-usr',
        wallet: 'jndwretndumoqbt2uauclmfmx7xbqjykva',
        status: 'approved',
        approvedAt: 1700000000000,
        approvedBy: 'admin1',
      },
    }
    const legacyApplications = [
      { id: 'a1', token: 'tok-1', parsed: { address: 'abc' }, status: 'pending', submittedAt: 1 },
    ]
    const legacyRecords = [
      { action: 'approve', at: 1 },
      { action: 'revoke', at: 2 },
    ]
    vi.spyOn(dataService, 'readStateFile').mockReturnValue({
      cwtRegistry: legacyRegistry,
      cwtApplications: legacyApplications,
      cwtRecords: legacyRecords,
    })

    cwtStore.migrateLegacy()

    // 注册表迁入内存缓存 + 落盘新文件
    expect(cwtStore.getRegistry()).toEqual(legacyRegistry)
    expect(dataService.saveCwtRegistry).toHaveBeenCalledWith(legacyRegistry)
    // 申请迁入 + 落盘
    expect(cwtStore.getApplications()).toEqual(legacyApplications)
    expect(dataService.saveCwtApplications).toHaveBeenCalled()
    // 审计逐条追加
    expect(dataService.appendCwtRecord).toHaveBeenCalledTimes(2)
    // 清理旧块
    expect(dataService.stripLegacyCwt).toHaveBeenCalled()
  })

  it('迁移：旧块为空 → 只清理不搬移', () => {
    vi.spyOn(dataService, 'readStateFile').mockReturnValue({
      cwtRegistry: {},
      cwtApplications: [],
      cwtRecords: [],
    })
    const saveRegistry = vi.spyOn(dataService, 'saveCwtRegistry')
    const saveApps = vi.spyOn(dataService, 'saveCwtApplications')

    cwtStore.migrateLegacy()

    expect(saveRegistry).not.toHaveBeenCalled()
    expect(saveApps).not.toHaveBeenCalled()
    expect(dataService.stripLegacyCwt).toHaveBeenCalled()
    expect(cwtStore.getRegistry()).toEqual({})
    expect(cwtStore.getApplications()).toEqual([])
  })

  it('裁剪：pending / approved 永久保留，rejected 只留最近 100 条', () => {
    // 105 条：1 pending + 1 approved + 103 rejected
    cwtStore.applications = [
      { id: 'p1', status: 'pending' },
      { id: 'a1', status: 'approved' },
      ...Array.from({ length: 103 }, (_, i) => ({ id: `r${i}`, status: 'rejected' })),
    ]

    cwtStore.saveApplications()

    const apps = cwtStore.getApplications()
    // 103 条 rejected 裁到最近 100 条
    const rejected = apps.filter((a) => a.status === 'rejected')
    expect(rejected).toHaveLength(100)
    // pending + approved 一条不丢
    expect(apps.some((a) => a.id === 'p1' && a.status === 'pending')).toBe(true)
    expect(apps.some((a) => a.id === 'a1' && a.status === 'approved')).toBe(true)
    // 被裁掉的必然是最早的 rejected
    expect(apps.some((a) => a.id === 'r0')).toBe(false)
    expect(apps.some((a) => a.id === 'r2')).toBe(false)
    expect(apps.some((a) => a.id === 'r102')).toBe(true)
    expect(dataService.saveCwtApplications).toHaveBeenCalled()
  })

  it('审计：appendRecord 追加、listRecords 读尾部（新→旧）', () => {
    const log = []
    vi.spyOn(dataService, 'appendCwtRecord').mockImplementation((r) => log.push(r))
    vi.spyOn(dataService, 'readCwtRecords').mockImplementation((limit = 200) =>
      log.slice(-limit).reverse(),
    )

    cwtStore.appendRecord({ action: 'approve', at: 1 })
    cwtStore.appendRecord({ action: 'revoke', at: 2 })
    cwtStore.appendRecord({ action: 'approve', at: 3 })

    expect(cwtStore.listRecords().map((r) => r.at)).toEqual([3, 2, 1])
    expect(cwtStore.listRecords(2).map((r) => r.at)).toEqual([3, 2])
    expect(dataService.appendCwtRecord).toHaveBeenCalledTimes(3)
  })
})
