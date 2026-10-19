/**
 * M1 迁移器测试（storage-design §6）
 * A 组：纯逻辑形状合同——【不依赖 mongod，任何环境全跑】。迁移写侧与 M2
 *        服务层读侧共用 migration.js，这组断言就是"两边形状一致"的锁。
 * B 组：三态幂等 + 事务回滚 + 校验拦截——需 27018 专用副本集；
 *        不可达优雅跳过（同 mongo-store.test.js 模式），库隔离 dsh_m1_test。
 */
import { mongoTestUri } from './mongo-test-env.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readSources,
  buildCollections,
  expectedCounts,
  emptySources,
} from '../src/services/migration.js'
import { MongoStore } from '../src/services/mongo.store.js'
import { CONFIG } from '../src/config/config.js'

// —— 测试夹具（形状取自本机实测源文件的浓缩版）——
const fx = () => ({
  ...emptySources(),
  state: {
    swtcUsers: {
      jaaa: {
        port: 31001,
        internalPort: 40001,
        tier: 1,
        containerStatus: 'running',
        pinnedImage: 'img:1',
        createdAt: 1,
      },
      jbbb: { port: 31002, containerStatus: 'destroyed' },
    },
    nextPort: 31003,
    availablePorts: [],
    cleanupPolicy: { stopTimeoutMs: 900000, checkIntervalMs: 300000 },
    usages: { jaaa: { date: '2026-10-10', minutes: 5 } },
  },
  sessions: { h1: { address: 'jaaa', expiresAt: 111 } },
  userSessions: {
    h2: { address: 'jbbb', expiresAt: 222 },
    h3: { address: 'jaaa', expiresAt: 333 },
  },
  admin: { addresses: ['jaaa'], history: [{ action: 'add', address: 'jaaa' }], updatedAt: 9 },
  opsLog: [{ timestamp: 666, operation: 'admin_login', details: { address: 'jaaa' } }],
  skillsIndex: { entries: [{ name: 'sk1', version: 2 }] },
  installs: { jaaa: [{ name: 'sk1', source: 'market', contentHash: 'x'.repeat(64) }] },
  dshImage: { current: { version: 'v1', tag: 't1' }, history: [{ version: 'v0' }] },
  userData: { jaaa: { nickname: 'me' } },
})

describe('A 组·迁移形状合同（无 DB 恒跑）', () => {
  it('users：profile 并入 + pinnedImage 保留 + 缺字段归 null', () => {
    const { users } = buildCollections(fx())
    expect(users).toHaveLength(2)
    const a = users.find((u) => u._id === 'jaaa')
    expect(a.profile).toEqual({ nickname: 'me' })
    expect(a.pinnedImage).toBe('img:1')
    const b = users.find((u) => u._id === 'jbbb')
    expect(b.tier).toBe(null) // 源缺字段 → null，不留 undefined
  })

  it('sessions：双文件合并带 scope，_id 原样，expiresAt 转 Date（TTL 只认 Date）', () => {
    const { sessions } = buildCollections(fx())
    expect(sessions).toHaveLength(3)
    expect(sessions.filter((s) => s.scope === 'admin')).toHaveLength(1)
    expect(sessions.filter((s) => s.scope === 'user')).toHaveLength(2)
    const h1 = sessions.find((s) => s._id === 'h1')
    expect(h1.expiresAt).toBeInstanceOf(Date)
    expect(Number(h1.expiresAt)).toBe(111)
  })

  it('audit：ops 日志入表，时间归 at（Date，ttl_90d 生效前提），拉平 actor（P6）', () => {
    const { audit } = buildCollections(fx())
    expect(audit).toHaveLength(1)
    const ops = audit.find((a) => a.kind === 'ops')
    expect(Number(ops.at)).toBe(666)
    expect(ops.at).toBeInstanceOf(Date)
    expect(ops.action).toBe('admin_login')
    expect(ops.actor).toBe('jaaa')
  })

  it('usage：复合主键 {address,date}（P5）', () => {
    const { usage } = buildCollections(fx())
    expect(usage).toEqual([{ _id: { address: 'jaaa', date: '2026-10-10' }, minutes: 5 }])
  })

  it('meta：恰四单例文档，schema 不在此处（由 runMigration 校验后写）', () => {
    const { meta } = buildCollections(fx())
    expect(meta.map((m) => m._id).sort()).toEqual(['admin', 'cleanup', 'dsh_image', 'ports'])
    expect(meta.find((m) => m._id === 'admin').addresses).toEqual(['jaaa'])
  })

  it('expectedCounts 覆盖 7 集合并求和', () => {
    const counts = expectedCounts(buildCollections(fx()))
    expect(Object.keys(counts)).toHaveLength(7)
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(2 + 4 + 3 + 1 + 1 + 1 + 1)
  })

  it('readSources：空目录全部缺省为空态，不炸（仅 meta 恒有 4 单例）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-empty-'))
    try {
      const counts = expectedCounts(buildCollections(readSources(dir)))
      expect(counts).toEqual({
        users: 0,
        meta: 4,
        sessions: 0,
        audit: 0,
        usage: 0,
        skills: 0,
        skill_installs: 0,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readSources：真实文件按形状读入', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-fx-'))
    try {
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({ swtcUsers: { ja1: { port: 1 } }, nextPort: 2 }),
      )
      const c = buildCollections(readSources(dir))
      expect(c.users[0]._id).toBe('ja1')
      expect(c.audit).toHaveLength(0)
      expect(c.meta.find((m) => m._id === 'ports').nextPort).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— B 组：真库三态（27018 不可达优雅跳过）——
let store = null
let available = false
const skip = (ctx) => (available ? true : (ctx.skip(), false))
const resetDb = async () => {
  await store._db.dropDatabase()
}

beforeAll(async () => {
  store = new MongoStore({ dbName: 'dsh_m1_test', mongodbUri: mongoTestUri('dsh_m1_test') })
  try {
    await store.connect()
    if ((await store.health()).topology !== 'replset') {
      available = false // 事务回滚用例需副本集
    } else {
      available = true
    }
  } catch {
    available = false
  }
}, 15000)

afterAll(async () => {
  if (store) {
    if (available) {
      try {
        await store._db.dropDatabase()
      } catch {}
    }
    await store.close()
  }
})

describe('B 组·三态幂等与原子性', () => {
  it('态A：空库+有数据 → migrated，逐域行数与源一致，schema 落库', async (ctx) => {
    if (!skip(ctx)) return
    await resetDb()
    const r = await store.runMigration({ sources: fx() })
    expect(r.status).toBe('migrated')
    expect(r.stats.users).toBe(2)
    expect(r.stats.sessions).toBe(3)
    expect(r.stats.audit).toBe(1)
    const schema = await store.col('meta').findOne({ _id: 'schema' })
    expect(schema.version).toBe(1)
    // 落库形状抽查（合同在库里的实体）
    const a = await store.col('users').findOne({ _id: 'jaaa' })
    expect(a.profile).toEqual({ nickname: 'me' })
    expect((await store.col('audit').findOne({ kind: 'ops' })).actor).toBe('jaaa')
    // 索引随迁移就位
    const idx = await store.col('sessions').indexes()
    expect(idx.map((i) => i.name)).toContain('ttl')
  })

  it('重跑：schema 存在 → skipped，数据零变动（幂等）', async (ctx) => {
    if (!skip(ctx)) return
    const before = await store.col('users').countDocuments({})
    const r = await store.runMigration({ sources: fx() })
    expect(r.status).toBe('skipped')
    expect(r.version).toBe(1)
    expect(await store.col('users').countDocuments({})).toBe(before)
  })

  it('故障原子性：重复 _id 触发插入失败 → 库内零残留，schema 未写；修好后重跑成功', async (ctx) => {
    if (!skip(ctx)) return
    await resetDb()
    const broken = fx()
    broken.skillsIndex = {
      entries: [
        { name: 'dup', version: 1 },
        { name: 'dup', version: 2 },
      ],
    }
    await expect(store.runMigration({ sources: broken })).rejects.toThrow()
    // 全部或无：任何集合都不该留有痕迹
    for (const name of ['users', 'sessions', 'audit', 'skills', 'meta']) {
      expect(await store.col(name).countDocuments({})).toBe(0)
    }
    const r = await store.runMigration({ sources: fx() })
    expect(r.status).toBe('migrated')
  })

  it('校验拦截：源快照在构建后被"改口"也能抓住（计数不符→回滚）', async (ctx) => {
    if (!skip(ctx)) return
    await resetDb()
    // 注入：构建后往库里先塞一条野数据，模拟"迁移期间集合被别处写入"
    await store.col('skills').insertOne({ _id: 'stray', note: '野数据' })
    await expect(store.runMigration({ sources: fx() })).rejects.toThrow(/校验失败 skills/)
    expect(await store.col('meta').findOne({ _id: 'schema' })).toBe(null)
    expect(await store.col('users').countDocuments({})).toBe(0)
  })

  it('态C：空盘 → emptyInit schema，meta 单例齐（4+schema=5），重跑 skipped', async (ctx) => {
    if (!skip(ctx)) return
    await resetDb()
    const r = await store.runMigration({ sources: emptySources() })
    expect(r.status).toBe('empty')
    const schema = await store.col('meta').findOne({ _id: 'schema' })
    expect(schema.emptyInit).toBe(true)
    expect(await store.col('meta').countDocuments({})).toBe(5)
    expect((await store.runMigration({ sources: fx() })).status).toBe('skipped')
  })
})
