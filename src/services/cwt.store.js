/**
 * CWT 数据存储（json：data/cwt/；mongodb：cwt_registry + cwt_applications + audit 集合）
 *
 * 架构与 user.service 同型（M2-1 先例）：内存缓存权威 + 同步读；写经本模块，
 * provider 分流。CWT 写常是【多方写】（批准=registry+applications+audit+用户
 * 冗余标记四方，§5.2 边界①）——所以每个写原语都收 opts.session：调用方
 * （cwt-admin）开一个事务把所有原语串进去，await 返回即四方全部落库。
 *
 * 集合映射：
 *   registry[addr]     → cwt_registry._id=addr（整文档替换，字段=现行 entry）
 *   applications       → cwt_applications._id=app.id（rejected 裁剪保留最近 100 条）
 *   records.log 追加    → audit.{kind:'cwt', at}（分页读同源）
 *
 * json 分支行为与旧实现逐调用一致（74 个存量 cwt 测试零感知）。
 */

import { dataService } from './data.service.js'
import { CONFIG } from '../config/config.js'
import { getStore } from './mongo.store.js'

const REJECTED_KEEP = 100 // 已拒绝申请保留条数

class CwtStore {
  constructor() {
    this.registry = dataService.loadCwtRegistry() || {}
    this.applications = dataService.loadCwtApplications() || []
    this.migrateLegacy()
  }

  get provider() {
    return CONFIG.storage?.provider || 'json'
  }
  _store() {
    return getStore()
  }

  /** 旧数据迁移（幂等）：state.json 里的 cwtRegistry / cwtApplications / cwtRecords
   *  首次启动时搬移到 data/cwt/，随后清理 state.json 中的旧块。mongodb 形态由
   *  M1 迁移器负责，这里跳过（避免文件双轨）。*/
  migrateLegacy() {
    if (this.provider !== 'json') return
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

  /**
   * provider='mongodb' 时启动水合（server 在 userService.init 之后调）：
   * registry/applications 从库重建缓存；records.log 文件体系退役（读走 audit）。
   * 失败拦启动（带旧缓存上活=后续写覆盖库里真数，与 M2-1 同理）。
   */
  async init() {
    if (this.provider === 'json') return
    const store = this._store()
    await store.connect()
    const regs = await store.find('cwt_registry', {})
    this.registry = {}
    for (const d of regs) {
      const { _id, ...entry } = d
      this.registry[_id] = entry
    }
    const apps = await store.col('cwt_applications').find({}).sort({ submittedAt: -1 }).toArray()
    this.applications = apps.map(({ _id, ...rest }) => ({ id: _id, ...rest }))
    console.log(
      `[cwt] 已从 MongoDB 水合：注册表 ${Object.keys(this.registry).length} 条，申请 ${this.applications.length} 条`,
    )
  }

  // ---------- registry ----------

  getRegistry() {
    return this.registry
  }

  setRegistryEntry(address, entry, opts = {}) {
    this.registry[address] = entry
    if (this.provider === 'json') return dataService.saveCwtRegistry(this.registry)
    return this._withOrJoin(opts.session, (session) =>
      this._store()
        .col('cwt_registry')
        .updateOne({ _id: address }, { $set: { ...entry } }, { upsert: true, session }),
    )
  }

  // ---------- applications ----------

  getApplications() {
    return this.applications
  }

  /**
   * 申请入队；保存时裁剪（仅 rejected 裁剪，pending/approved 永久保留）
   */
  addApplication(app, opts = {}) {
    this.applications.push(app)
    return this.saveApplications(opts)
  }

  /**
   * 已处理申请（approve/reject 改了 status）后落盘 + 裁剪。
   * mongodb 形态【整表替换】：缓存里裁剪后的集合=权威（deleteMany+insertMany
   * 与文件整写同语义；rejected 裁剪的"多余行"在库里同样消失）。
   */
  saveApplications(opts = {}) {
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
    if (this.provider === 'json') return dataService.saveCwtApplications(this.applications)
    return this._withOrJoin(opts.session, async (session) => {
      const c = this._store().col('cwt_applications')
      await c.deleteMany({}, { session })
      if (this.applications.length) {
        await c.insertMany(
          this.applications.map(({ id, ...rest }) => ({ _id: id, ...rest })),
          { session },
        )
      }
    })
  }

  // ---------- records（审计） ----------

  appendRecord(record, opts = {}) {
    if (this.provider === 'json') return dataService.appendCwtRecord(record)
    return this._withOrJoin(
      opts.session,
      (session) =>
        this._store()
          .col('audit')
          .insertOne({ ...record, kind: 'cwt', at: new Date(Number(record.at) || 0) }, { session }), // TTL 只认 Date,
    )
  }

  /**
   * 分页读取审计记录（新 → 旧）。
   * json：【同步】返回（与旧实现逐调用一致，消费方不 await 也正确）；
   * mongo：返回 Promise（该路径消费方需 await）。故意不加 async——保 json 同步。
   */
  listRecords(limit = 10, offset = 0) {
    if (this.provider === 'json') return dataService.readCwtRecords(limit, offset)
    return this._store()
      .col('audit')
      .find({ kind: 'cwt' })
      .sort({ at: -1 })
      .skip(offset)
      .limit(limit + 1)
      .toArray()
      .then((docs) => {
        const hasMore = docs.length > limit
        return {
          records: docs
            .slice(0, limit)
            .map(({ kind, _id, ...r }) => ({
              ...r,
              at: r.at instanceof Date ? Number(r.at) : r.at,
            })), // 回读归一 number，与文件版形状一致
          hasMore,
        }
      })
  }

  /** 有外部 session 就直接用（审批四方同事务）；没有就自开短事务。 */
  async _withOrJoin(session, ops) {
    if (session) return ops(session)
    return this._store().withTransaction(ops)
  }

  /**
   * 多方写的事务边界（§5.2 边界①：批准=registry+applications+audit+用户冗余四方）。
   * json：fn(null) 直跑（各原语同步落各自文件，与旧行为一致）；
   * mongo：store.withTransaction(fn)，fn 收到的 session 透传给每个写原语，
   *        要么四方全成、要么全不动（await 返回即全部落库）。
   */
  async runTxn(fn) {
    if (this.provider === 'json') return fn(null)
    const store = this._store()
    await store.connect()
    return store.withTransaction(fn)
  }
}

export const cwtStore = new CwtStore()
