/**
 * CWT 数据存储（data/cwt/）
 *
 * 存储位置（与 data/ 其他业务数据统一，不再塞进根目录 state.json）：
 *   data/cwt/registry.json      —— 审批注册表（原子写，常读）
 *   data/cwt/applications.json  —— 申请队列（原子写）
 *   data/cwt/records.log        —— 审计记录（append-only 追加日志，与 operations.log 同体系）
 *
 * 记录策略：
 *   - pending / approved 申请永久保留（授权来源证据）
 *   - rejected 仅保留最近 REJECTED_KEEP 条（自动裁剪）
 *
 * 兼容迁移：首次启动发现旧 state.json 里的 cwt 块时，搬移到 data/cwt/ 并清理。
 * 模块级单例，user.service 与 cwt-admin.service 共用同一内存缓存（豁免判定高频读）。
 */

import { dataService } from './data.service.js'

const REJECTED_KEEP = 100 // 已拒绝申请保留条数

class CwtStore {
  constructor() {
    this.registry = dataService.loadCwtRegistry() || {}
    this.applications = dataService.loadCwtApplications() || []
    this.migrateLegacy()
  }

  /**
   * 旧数据迁移（幂等）：state.json 里的 cwtRegistry / cwtApplications / cwtRecords
   * 首次启动时搬移到 data/cwt/，随后清理 state.json 中的旧块。
   */
  migrateLegacy() {
    const legacy = dataService.readStateFile()
    if (!legacy) return
    const hasRegistry = legacy.cwtRegistry && Object.keys(legacy.cwtRegistry).length > 0
    const hasApplications =
      Array.isArray(legacy.cwtApplications) && legacy.cwtApplications.length > 0
    const hasRecords = Array.isArray(legacy.cwtRecords) && legacy.cwtRecords.length > 0
    if (!hasRegistry && !hasApplications && !hasRecords) {
      // 旧块可能只是空数组，也一并清掉
      dataService.stripLegacyCwt()
      return
    }

    let migrated = 0
    if (hasRegistry && Object.keys(this.registry).length === 0) {
      this.registry = legacy.cwtRegistry
      dataService.saveCwtRegistry(this.registry)
      migrated += Object.keys(this.registry).length
    }
    if (hasApplications && this.applications.length === 0) {
      this.applications = legacy.cwtApplications
      dataService.saveCwtApplications(this.applications)
      migrated += this.applications.length
    }
    if (hasRecords) {
      legacy.cwtRecords.forEach((r) => dataService.appendCwtRecord(r))
      migrated += legacy.cwtRecords.length
    }
    dataService.stripLegacyCwt()
    if (migrated > 0) {
      console.log(`[cwt] migrated ${migrated} legacy records from state.json to data/cwt/`)
    }
  }

  // ---------- registry ----------

  getRegistry() {
    return this.registry
  }

  setRegistryEntry(address, entry) {
    this.registry[address] = entry
    dataService.saveCwtRegistry(this.registry)
  }

  // ---------- applications ----------

  getApplications() {
    return this.applications
  }

  /**
   * 申请入队；保存时裁剪（仅 rejected 裁剪，pending/approved 永久保留）
   */
  addApplication(app) {
    this.applications.push(app)
    this.saveApplications()
  }

  /**
   * 已处理申请（approve/reject 改了 status）后落盘 + 裁剪
   */
  saveApplications() {
    const kept = []
    let rejectedSeen = 0
    for (let i = this.applications.length - 1; i >= 0; i--) {
      const app = this.applications[i]
      if (app.status === 'rejected') {
        if (rejectedSeen >= REJECTED_KEEP) continue
        rejectedSeen += 1
      }
      kept.unshift(app)
    }
    this.applications = kept
    dataService.saveCwtApplications(this.applications)
  }

  // ---------- records（审计日志） ----------

  appendRecord(record) {
    dataService.appendCwtRecord(record)
  }

  listRecords(limit = 200) {
    return dataService.readCwtRecords(limit)
  }
}

export const cwtStore = new CwtStore()
