/**
 * M2-1 状态仓库测试（storage-design D1/D5/§5.2）
 * A 组：json 透传合同（provider 缺省下与 dataService 逐调用一致，现网零变化的锁）
 * B 组：mongodb 扇出（round-trip / 字段所有权 / 删除传播 / usage 历史保全 / 原子性）
 *       ——需 27018 副本集，不可达优雅跳过；隔离库 dsh_m2_test
 */
import { mongoTestUri } from './mongo-test-env.js'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { StateStore, USER_OWNED_FIELDS } from '../src/services/state.store.js'
import { MongoStore } from '../src/services/mongo.store.js'
import { dataService } from '../src/services/data.service.js'
import { CONFIG } from '../src/config/config.js'

const fixtureState = () => ({
  swtcUsers: {
    ja: {
      port: 31001,
      containerStatus: 'running',
      tier: 1,
      usageStartedAt: 123,
      pinnedImage: 'img:1',
    },
    jb: { port: 31002, containerStatus: 'stopped', pinnedImage: 'img:jb' },
  },
  nextPort: 31003,
  availablePorts: [31009],
  cleanupPolicy: { stopTimeoutMs: 111, destroyTimeoutMs: 222, checkIntervalMs: 333 },
  usages: { ja: { date: '2026-01-02', minutes: 7 } },
})

describe('A 组·json 透传合同（无 DB 恒跑）', () => {
  afterEach(() => vi.restoreAllMocks())

  it('save：原样转 dataService.saveState，且同步完成（不等微任务）', async () => {
    const calls = []
    vi.spyOn(dataService, 'saveState').mockImplementation((s) => calls.push(s))
    const repo = new StateStore({ provider: 'json' })
    const p = repo.save({ v: 1 }) // 未 await——json 分支必须已写完（现网语义）
    expect(calls).toEqual([{ v: 1 }])
    await p
  })

  it('load：原样转 dataService.loadState', async () => {
    vi.spyOn(dataService, 'loadState').mockReturnValue({ swtcUsers: { zz: {} } })
    const repo = new StateStore({ provider: 'json' })
    expect(await repo.load()).toEqual({ swtcUsers: { zz: {} } })
  })

  it('USER_OWNED_FIELDS 与水合合同互锁（新增运行时字段必须同步登记两处）', () => {
    // 缓存往 user 写的标记字段——漏一个，重启水合就丢、下次存盘还 $unset
    expect(USER_OWNED_FIELDS).toContain('usageStartedAt')
    expect(USER_OWNED_FIELDS).toContain('pinnedImage')
  })
})

// —— B 组 ——
let store = null
let repo = null
let available = false
const skip = (ctx) => (available ? true : (ctx.skip(), false))

beforeAll(async () => {
  store = new MongoStore({ dbName: 'dsh_m2_test', mongodbUri: mongoTestUri('dsh_m2_test') })
  try {
    await store.connect()
    available = (await store.health()).topology === 'replset'
  } catch {
    available = false
  }
  repo = new StateStore({ provider: 'mongodb', store })
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

describe('B 组·mongodb 扇出', () => {
  it('round-trip：扇出后整读，与源状态语义一致', async (ctx) => {
    if (!skip(ctx)) return
    await store._db.dropDatabase()
    const state = fixtureState()
    await repo.save(state)
    const back = await repo.load()
    expect(back.swtcUsers.ja).toEqual({
      port: 31001,
      containerStatus: 'running',
      tier: 1,
      usageStartedAt: 123,
      pinnedImage: 'img:1',
    })
    expect(back.swtcUsers.jb.pinnedImage).toBe('img:jb')
    expect(back.nextPort).toBe(31003)
    expect(back.availablePorts).toEqual([31009])
    expect(back.cleanupPolicy.stopTimeoutMs).toBe(111)
    expect(back.usages.ja).toEqual({ date: '2026-01-02', minutes: 7 })
  })

  it('所有权：白名单外的库字段（profile/历史遗留值）不被扇出误伤', async (ctx) => {
    if (!skip(ctx)) return
    await store
      .col('users')
      .updateOne(
        { _id: 'ja' },
        { $set: { profile: { nickname: 'keepme' }, legacyMarker: 777 } },
        { upsert: true },
      )
    await repo.save(fixtureState())
    const ja = await store.col('users').findOne({ _id: 'ja' })
    expect(ja.profile).toEqual({ nickname: 'keepme' })
    // 白名单外的库侧字段：扇出既不抹也不改
    expect(ja.legacyMarker).toBe(777)
  })

  it('删除传播：缓存里消失的用户，库文档同步删除', async (ctx) => {
    if (!skip(ctx)) return
    const state = fixtureState()
    delete state.swtcUsers.jb
    await repo.save(state)
    expect(await store.col('users').countDocuments({})).toBe(1)
    expect(await store.col('users').findOne({ _id: 'jb' })).toBe(null)
  })

  it('usage 历史保全：扇出只 upsert 现行行，旧日期不动；load 取最新', async (ctx) => {
    if (!skip(ctx)) return
    await store.col('usage').insertOne({ _id: { address: 'ja', date: '2026-01-01' }, minutes: 99 })
    const state = fixtureState()
    state.usages = { ja: { date: '2026-01-03', minutes: 3 } }
    await repo.save(state)
    // 旧日期行原样在（跨测试行数是累计的，只钉这一行的存在性）
    expect(
      await store.col('usage').findOne({ '_id.address': 'ja', '_id.date': '2026-01-01' }),
    ).toMatchObject({
      minutes: 99,
    })
    const back = await repo.load()
    expect(back.usages.ja).toEqual({ date: '2026-01-03', minutes: 3 })
  })

  it('原子性：扇出中途失败（非法字段名）→ 库保持上次镜像，一个字段都不动', async (ctx) => {
    if (!skip(ctx)) return
    const broken = fixtureState()
    broken.cleanupPolicy = { $bad: 1 } // updateOne $set 文档校验必炸 → 事务整体回滚
    await expect(repo.save(broken)).rejects.toThrow()
    const ports = await store.col('meta').findOne({ _id: 'ports' })
    expect(ports.nextPort).toBe(31003) // 上次成功扇出的值，未被中途状态污染
    expect(await store.col('users').countDocuments({ _id: 'jb' })).toBe(1)
  })

  it('P7 结算顺序在仓库语义下成立：清表针与累计同一次扇出原子落库', async (ctx) => {
    if (!skip(ctx)) return
    const state = fixtureState()
    delete state.swtcUsers.ja.usageStartedAt // 结算先清针
    state.usages = { ja: { date: '2026-01-04', minutes: 12 } } // 再累计
    await repo.save(state)
    const ja = await store.col('users').findOne({ _id: 'ja' })
    const row = await store.col('usage').findOne({ '_id.date': '2026-01-04' })
    expect(ja.usageStartedAt).toBe(undefined) // 针已清
    expect(row.minutes).toBe(12) // 值已加——两者同一事务，不存在"加了又加"窗口
  })
})
