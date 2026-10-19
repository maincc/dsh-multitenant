/**
 * M0 存储层地基测试（storage-design §8 M0 / §9）
 * 连本机专用副本集 27018，库隔离 dsh_test。
 *
 * 关键：mongod 不可达时【优雅跳过】而非失败——本机 27018 是 fork 起的临时实例，
 * 重启不自起；pre-commit 跑全量不能被它拖红。连得上则真测事务/回滚/索引/白名单。
 */
import { mongoTestUri } from './mongo-test-env.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoStore, COLLECTIONS } from '../src/services/mongo.store.js'
import { CONFIG } from '../src/config/config.js'

let store = null
let available = false
const skip = (ctx) => (available ? true : (ctx.skip(), false))

beforeAll(async () => {
  store = new MongoStore({ dbName: 'dsh_test', mongodbUri: CONFIG.storage.mongodbUri })
  try {
    await store.connect()
    available = true
  } catch {
    available = false
  }
}, 15000)

afterAll(async () => {
  if (available && store) {
    try {
      await store._db.dropDatabase()
    } catch {}
    await store.close()
  }
})

describe('mongo.store 地基', () => {
  it('集合合同锁定为 9 个（大拆除后 7 + v1.4 凭证体系 credentials/cwt_applications）', () => {
    expect(COLLECTIONS).toHaveLength(9)
    expect([...COLLECTIONS].sort()).toEqual(
      [
        'audit',
        'credentials',
        'cwt_applications',
        'meta',
        'sessions',
        'skill_installs',
        'skills',
        'usage',
        'users',
      ].sort(),
    )
    expect(COLLECTIONS).not.toContain('admin') // 已并入 meta
    expect(COLLECTIONS).not.toContain('user_sessions') // 已并入 sessions
    expect(COLLECTIONS).not.toContain('ops_log') // 已并入 audit
    expect(COLLECTIONS).not.toContain('cwt_registry') // 大拆除：旧 CWT 注册表退役（legacy 走只读文件导入）
  })

  it('未知集合访问被拒（白名单护栏）', async (ctx) => {
    if (!skip(ctx)) return
    expect(() => store.col('secrets')).toThrow(/不在 9 集合合同/)
  })

  it('未连接时 col() 明确报错', async () => {
    const cold = new MongoStore({ dbName: 'dsh_test_never' })
    expect(() => cold.col('users')).toThrow(/未连接/)
  })

  it('dbName 优先级：opts > URI 路径库名 > config.dbName（演练隔离回归锁）', () => {
    // 踩过的坑：MONGODB_URI=.../dsh_m1_drill 但 config.dbName='dsh' 把演练数据写进了 dsh
    const a = new MongoStore({ mongodbUri: mongoTestUri('drill_x') })
    expect(a.dbName).toBe('drill_x')
    const b = new MongoStore({
      dbName: 'explicit',
      mongodbUri: 'mongodb://127.0.0.1:27018/drill_x',
    })
    expect(b.dbName).toBe('explicit')
    const c = new MongoStore({ mongodbUri: 'mongodb://127.0.0.1:27018/?replicaSet=dsh-rs' })
    expect(c.dbName).toBe(CONFIG.storage.dbName) // 无路径库名才回退 config
  })

  it('health() 报告拓扑与库名', async (ctx) => {
    if (!skip(ctx)) return
    const h = await store.health()
    expect(h.dbName).toBe('dsh_test')
    expect(h.connected).toBe(true)
    expect(['replset', 'standalone']).toContain(h.topology)
  })

  it('ensureIndexes() 建齐合同索引且幂等', async (ctx) => {
    if (!skip(ctx)) return
    await store.ensureIndexes()
    await store.ensureIndexes() // 第二次 no-op 不报错
    const idx = await store.col('sessions').indexes()
    expect(idx.map((i) => i.name)).toContain('ttl')
    const auditIdx = await store.col('audit').indexes()
    const ttl90 = auditIdx.find((i) => i.name === 'ttl_90d')
    expect(ttl90?.expireAfterSeconds).toBe(90 * 24 * 3600) // P4
  })

  it('upsert/findOne/count 基本读写', async (ctx) => {
    if (!skip(ctx)) return
    await store.upsert('users', 'jtest_addr_0000000000000000000000', {
      containerStatus: 'running',
      port: 31999,
    })
    const u = await store.findOne('users', { _id: 'jtest_addr_0000000000000000000000' })
    expect(u.port).toBe(31999)
    expect(await store.count('users', {})).toBe(1)
  })

  it('usage 复合 _id {address,date} 防同日重复（P5）', async (ctx) => {
    if (!skip(ctx)) return
    const id = { address: 'jA', date: '2026-10-10' }
    await store.upsert('usage', id, { minutes: 10 })
    await store.upsert('usage', id, { minutes: 25 }) // 同键覆盖非新增
    expect(await store.count('usage', {})).toBe(1)
    expect((await store.findOne('usage', { _id: id })).minutes).toBe(25)
  })

  it('事务提交：多文档原子落库', async (ctx) => {
    if (!skip(ctx)) return
    if ((await store.health()).topology !== 'replset') return ctx.skip()
    await store.withTransaction(async (session) => {
      await store.col('audit').insertOne({ _id: 'jtx', kind: 'ops', at: new Date() }, { session })
      await store
        .col('users')
        .updateOne({ _id: 'jtx' }, { $set: { tier: 9 } }, { upsert: true, session })
    })
    expect(await store.count('audit', { _id: 'jtx' })).toBe(1)
    expect(await store.count('users', { _id: 'jtx' })).toBe(1)
  })

  it('事务回滚：中途抛错则前一文档不留痕', async (ctx) => {
    if (!skip(ctx)) return
    if ((await store.health()).topology !== 'replset') return ctx.skip()
    await store.col('meta').deleteMany({ _id: 'txprobe' })
    let threw = false
    try {
      await store.withTransaction(async (session) => {
        await store.col('meta').insertOne({ _id: 'txprobe', v: 1 }, { session })
        throw new Error('故意失败')
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(await store.count('meta', { _id: 'txprobe' })).toBe(0) // 原子撤销
  })

  // runMigration 的三态/校验/回滚合同见 test/migration.test.js（M1）
})
