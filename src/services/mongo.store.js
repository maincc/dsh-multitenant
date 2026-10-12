/**
 * MongoDB 存储层（M0 地基）
 * 见 docs/storage-design.md —— 9 集合合同 + 单成员副本集事务。
 *
 * 设计要点：
 * - **惰性**：provider='json'（默认）时，本模块 import 不产生任何连接；只有
 *   显式 getStore()/connect() 才连库。切换介质不影响现有文件路径。
 * - **白名单集合**：只暴露设计定稿的 9 个集合，杜绝散落 db.anything()。
 * - **事务前提**：withTransaction 要求副本集；connect() 主动探拓扑，
 *   standalone 会给出明确告警（裸单机下事务直接报错是 R1 硬约束）。
 * - **M1 接缝**：runMigration() 只留签名，导入逻辑在 M1 填充。
 *
 * Node 18 兼容：全局 crypto 未默认导出时补齐（驱动运行时才用到）。
 */
if (!globalThis.crypto) {
  const { webcrypto } = await import('node:crypto')
  globalThis.crypto = webcrypto
}

import { MongoClient } from 'mongodb'
import { CONFIG } from '../config/config.js'
import { InternalError } from '../utils/errors.js'
import { readSources, buildCollections, expectedCounts } from './migration.js'

/** 设计 §4.1 定稿的 9 集合；访问器与索引初始化都以此为准，越界即拒 */
const COLLECTIONS = Object.freeze([
  'users',
  'meta',
  'sessions',
  'cwt_registry',
  'cwt_applications',
  'audit',
  'usage',
  'skills',
  'skill_installs',
])

/** 索引合同（storage-design §4.1）。TTL 秒数按拍板：audit 90 天(P4)。 */
const INDEX_SPECS = Object.freeze({
  sessions: [
    { key: { expiresAt: 1 }, options: { name: 'ttl', expireAfterSeconds: 0 } },
    { key: { scope: 1, address: 1 }, options: { name: 'by_scope_addr' } },
  ],
  audit: [
    { key: { at: -1 }, options: { name: 'by_time' } },
    { key: { kind: 1, address: 1, at: -1 }, options: { name: 'by_kind_addr_time' } },
    // P4：审计 90 天 TTL。expireAfterSeconds 单位是秒（相对 at 字段值）。
    { key: { at: 1 }, options: { name: 'ttl_90d', expireAfterSeconds: 90 * 24 * 3600 } },
  ],
  cwt_applications: [
    { key: { status: 1 }, options: { name: 'by_status' } },
    { key: { 'parsed.address': 1 }, options: { name: 'by_address' } },
  ],
  users: [{ key: { containerStatus: 1 }, options: { name: 'by_status' } }],
})

export class MongoStore {
  /** @param {object} [opts] 覆盖 CONFIG.storage（测试注入用：dbName/uri 隔离） */
  constructor(opts = {}) {
    const s = CONFIG.storage
    this.uri = opts.mongodbUri || s.mongodbUri
    // dbName 优先级：显式 opts（测试）> URI 路径里的库名（演练/部署注入）> config.dbName。
    // 否则 mongodb://host:port/drill?… 会被默认 dbName 悄悄改写（M1 演练实测踩中）。
    this.dbName = opts.dbName || dbNameFromUri(this.uri) || s.dbName
    this.txnRetries = opts.txnRetries ?? s.txnRetries ?? 3
    this.connectTimeoutMs = opts.connectTimeoutMs ?? s.connectTimeoutMs ?? 5000
    this._client = null
    this._db = null
    this._topology = null // 'replset' | 'standalone' | null
  }

  get isConfigured() {
    return CONFIG.storage?.provider === 'mongodb'
  }

  /** 惰性连接；幂等。连上后探一次拓扑（副本集=事务可用）。 */
  async connect() {
    if (this._client) return this._client
    const client = new MongoClient(this.uri, {
      serverSelectionTimeoutMS: this.connectTimeoutMs,
      retryWrites: true,
    })
    await client.connect()
    this._client = client
    this._db = client.db(this.dbName)
    this._topology = await this._probeTopology()
    if (this._topology !== 'replset') {
      // 不抛——读写仍可用；只是事务不可用。由 withTransaction 处守门。
      console.warn(
        `[mongo.store] 拓扑=${this._topology}（非副本集）：多文档事务将不可用，见 storage-design §5.2 R1`,
      )
    }
    return client
  }

  async _probeTopology() {
    try {
      const h = await this._db.admin().command({ hello: 1 })
      return h.setName ? 'replset' : 'standalone'
    } catch {
      return null
    }
  }

  /** 供健康检查/迁移门禁：{configured, connected, topology, dbName} */
  async health() {
    return {
      configured: this.isConfigured,
      connected: Boolean(this._client),
      topology: this._topology,
      dbName: this.dbName,
    }
  }

  /** 白名单集合访问器（不含事务会话参数时用于常规读写） */
  col(name) {
    if (!COLLECTIONS.includes(name)) {
      throw new InternalError(`未知集合 "${name}"（不在 9 集合合同内）`)
    }
    if (!this._db) throw new InternalError('MongoStore 未连接，先 await connect()')
    return this._db.collection(name)
  }

  /**
   * 事务执行器（副本集前提）。fn 收到 session，内部所有操作须带 {session}。
   * TransientTransactionError 自动重试（txnRetries 上限）；其余错误上抛。
   */
  async withTransaction(fn) {
    if (!this._client) await this.connect()
    if (this._topology !== 'replset') {
      throw new InternalError(
        '事务需副本集拓扑，当前为 ' + this._topology + '（见 storage-design §5.2）',
      )
    }
    const session = this._client.startSession()
    try {
      let attempt = 0
      // driver 的 withTransaction 自带重试，这里再包一层以显式控制次数上限与日志
      while (true) {
        try {
          let result
          await session.withTransaction(async () => {
            result = await fn(session)
          })
          return result
        } catch (err) {
          attempt++
          if (attempt > this.txnRetries || !isTransient(err)) {
            throw err
          }
        }
      }
    } finally {
      await session.endSession()
    }
  }

  /** 按 §4.1 索引合同建索引（幂等，createIndex 同名同键为 no-op） */
  async ensureIndexes() {
    if (!this._db) await this.connect()
    for (const [name, specs] of Object.entries(INDEX_SPECS)) {
      const c = this.col(name)
      for (const { key, options } of specs) {
        await c.createIndex(key, options)
      }
    }
  }

  // —— 便捷读写（域无关的通用原语，服务层在其上组语义）——
  async findOne(collName, filter, projection) {
    return this.col(collName).findOne(filter, projection ? { projection } : undefined)
  }
  async find(collName, filter = {}, opts = {}) {
    return this.col(collName).find(filter, opts).toArray()
  }
  async upsert(collName, id, set, setOnInsert) {
    return this.col(collName).updateOne(
      { _id: id },
      { $set: set, ...(setOnInsert ? { $setOnInsert: setOnInsert } : {}) },
      { upsert: true },
    )
  }
  async insertMany(collName, docs) {
    if (!docs.length) return { insertedCount: 0 }
    return this.col(collName).insertMany(docs)
  }
  async count(collName, filter = {}) {
    return this.col(collName).countDocuments(filter)
  }

  /**
   * JSON→Mongo 迁移（storage-design §6 三态幂等 + §5.2 事务原子）。
   * 全有或全无：九集合导入 + 逐域计数校验 + meta.schema 写在【同一个事务】——
   * 不存在"标了版本但数据缺一角"的半迁移态；失败=库内零残留，修好重跑即可。
   * 幂等标志：meta.schema 存在即已迁移（emptyInit 的空库初始化也算）。
   *
   * @param {{ sources?: object }} [opts] sources=注入源快照（测试/演练用；
   *                 缺省 readSources() 读真实仓库文件——只读）
   * @returns {Promise<{status:'migrated'|'skipped'|'empty', stats?:object,
   *                    version?:number|null, migratedAt?:number|null}>}
   */
  async runMigration({ sources } = {}) {
    await this.connect()
    const existing = await this.col('meta').findOne({ _id: 'schema' })
    if (existing) {
      return {
        status: 'skipped',
        version: existing.version ?? null,
        migratedAt: existing.migratedAt ?? null,
      }
    }
    const s = sources ?? readSources()
    const collections = buildCollections(s)
    const counts = expectedCounts(collections)
    // meta 恒生成 4 个单例文档（空盘上线也要有它们可读）——"空盘"判定只看非 meta 域
    const dataTotal = Object.entries(counts).reduce(
      (a, [name, n]) => (name === 'meta' ? a : a + n),
      0,
    )
    if (dataTotal === 0) {
      // 空盘初始化（拍板 Q1）：meta 单例 + schema 一并写好，重启不再扫描
      await this.withTransaction(async (session) => {
        await this.col('meta').insertMany(collections.meta, { session })
        await this.col('meta').insertOne(
          {
            _id: 'schema',
            version: 1,
            emptyInit: true,
            migratedAt: Date.now(),
            migratedBy: 'src/services/migration.js',
          },
          { session },
        )
      })
      return { status: 'empty', stats: { meta: collections.meta.length } }
    }
    // 索引是 DDL，不可入事务；放事务前——ensureIndexes 本身幂等（同名同键 no-op）
    await this.ensureIndexes()
    const stats = await this.withTransaction(async (session) => {
      for (const [name, docs] of Object.entries(collections)) {
        if (docs.length) await this.col(name).insertMany(docs, { session })
      }
      // 事务内 read-your-writes：逐域计数 == 源快照应有行数，缺一即整体回滚
      const checked = {}
      for (const [name, expected] of Object.entries(counts)) {
        const n = await this.col(name).countDocuments({}, { session })
        if (n !== expected) {
          throw new InternalError(`迁移校验失败 ${name}：期望 ${expected}，实得 ${n}`)
        }
        checked[name] = n
      }
      await this.col('meta').insertOne(
        {
          _id: 'schema',
          version: 1,
          migratedAt: Date.now(),
          migratedBy: 'src/services/migration.js',
          sourceStats: checked,
        },
        { session },
      )
      return checked
    })
    return { status: 'migrated', stats }
  }

  async close() {
    if (this._client) {
      await this._client.close()
      this._client = null
      this._db = null
      this._topology = null
    }
  }
}

/**
 * 从 mongodb:// 连接串取路径库名：mongodb://host:27018/mydb?opts → 'mydb'。
 * 无路径或仅 '/' 返回 null（由调用方回退 config.dbName）。
 */
function dbNameFromUri(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^?#]+)/i.exec(String(uri || ''))
  return m && m[1] ? m[1] : null
}

/** 事务瞬时错误判定（可安全重试），参照 MongoDB TransientTransactionError 约定 */ function isTransient(
  err,
) {
  const code = err.code
  const label = err.hasErrorLabels?.('TransientTransactionError')
  return (
    Boolean(label) ||
    code === 251 ||
    code === 20 ||
    code === 112 ||
    code === 13435 ||
    code === 13436
  )
}

// 模块级单例（provider=json 时不连接；服务层经 deps 组装点按需取用）
let _instance = null
export function getStore() {
  if (!_instance) _instance = new MongoStore()
  return _instance
}

export { COLLECTIONS, INDEX_SPECS }
