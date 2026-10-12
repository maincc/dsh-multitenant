/**
 * M2-4 技能域的真库测试（provider='mongodb' 形态）
 * 覆盖：writeIndex 整量替换（含旧行删除）、writeInstalls per-address
 * upsert + $nin 删行、init 水合往返（库为权威重建缓存）。
 * 业务链路（publish/install/uninstall 的校验与限流）由存量 50 个 json 用例
 * 覆盖——本块接线未改它们的控制流，只把存储原语换成分流+await。
 * ⚠️ SKILL.md 正文按合同边界仍走磁盘，这里不测（storeDir 用临时目录）。
 * 需 27018 副本集；不可达优雅跳过。隔离库 dsh_m24_test。
 */
import { mongoTestUri } from './mongo-test-env.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../src/config/config.js'
import { getStore } from '../src/services/mongo.store.js'
import { SkillService } from '../src/services/skill.service.js'

let store = null
let available = false
const skip = (ctx) => (available ? true : (ctx.skip(), false))
const ADDR_A = 'jtestskla000000000000000000000000000000'
const ADDR_B = 'jtestsklb000000000000000000000000000000'

let savedProvider = null
let savedUri = null
let svc = null

beforeAll(async () => {
  savedProvider = CONFIG.storage.provider
  savedUri = CONFIG.storage.mongodbUri
  CONFIG.storage.provider = 'mongodb'
  CONFIG.storage.mongodbUri = mongoTestUri('dsh_m24_test')
  store = getStore() // 首个 getStore 固化 uri → 隔离到测试库
  try {
    await store.connect()
    available = (await store.health()).topology === 'replset'
    if (available) await store._db.dropDatabase()
  } catch {
    available = false
  }
  svc = new SkillService({
    storeDir: mkdtempSync(join(tmpdir(), 'skill-store-')),
    installsFile: join(mkdtempSync(join(tmpdir(), 'skill-inst-')), 'installs.json'),
  })
}, 15000)

afterAll(async () => {
  CONFIG.storage.provider = savedProvider
  CONFIG.storage.mongodbUri = savedUri
  if (store && available) {
    try {
      await store._db.dropDatabase()
    } catch {}
  }
  if (store) await store.close()
})

describe('mongodb 形态·技能元数据写语义', () => {
  it('writeIndex → skills 集合整量替换：与迁移合同同形（_id=name），旧行删除', async (ctx) => {
    if (!skip(ctx)) return
    await svc.writeIndex([
      { name: 'alpha', publisher: ADDR_A, status: 'active' },
      { name: 'beta', publisher: ADDR_B, status: 'active' },
    ])
    expect(await store.col('skills').countDocuments({})).toBe(2)
    const alpha = await store.col('skills').findOne({ _id: 'alpha' })
    expect(alpha.publisher).toBe(ADDR_A)
    expect(alpha.name).toBe('alpha') // 形状合同（§4.1）：_id 即技能名，字段原样保留

    await svc.writeIndex([{ name: 'alpha', publisher: ADDR_A, status: 'inactive' }])
    expect(await store.col('skills').findOne({ _id: 'beta' })).toBeNull() // 不在新量=删
    expect((await store.col('skills').findOne({ _id: 'alpha' })).status).toBe('inactive')
    expect(svc.readIndex()).toEqual([{ name: 'alpha', publisher: ADDR_A, status: 'inactive' }]) // 同步读缓存，签名不变
  })

  it('writeInstalls → per-address upsert + $nin 删行（A 消失不影响 B）', async (ctx) => {
    if (!skip(ctx)) return
    const rec = (n) => [
      {
        name: n,
        source: 'import',
        installedAt: '2026-01-01T00:00:00.000Z',
        contentHash: 'h',
        size: 1,
      },
    ]
    await svc.writeInstalls({ [ADDR_A]: rec('alpha'), [ADDR_B]: rec('beta') })
    expect(await store.col('skill_installs').countDocuments({})).toBe(2)

    const after = { [ADDR_B]: rec('beta') } // A 卸载完 → 整量里不再含 A
    await svc.writeInstalls(after)
    expect(await store.col('skill_installs').findOne({ _id: ADDR_A })).toBeNull()
    expect(await store.col('skill_installs').findOne({ _id: ADDR_B })).not.toBeNull()
    expect(svc.readInstalls()).toEqual(after)
  })

  it('写点事务原子性：deleteMany 已执行、随后抛错 → 全部回滚不留半态', async (ctx) => {
    if (!skip(ctx)) return
    // 显式铺两行前提（writeInstalls 是整量替换，会清掉前序用例的行）
    await svc.writeInstalls({
      [ADDR_A]: [{ name: 'x', source: 'import' }],
      [ADDR_B]: [{ name: 'y', source: 'import' }],
    })
    await expect(
      store.withTransaction(async (session) => {
        await store.col('skill_installs').deleteMany({ _id: { $nin: [] } }, { session }) // 删到全部
        throw new Error('注入') // 事务中间炸
      }),
    ).rejects.toThrow('注入')
    // 若扇出没有包进事务，此刻库里应已空——现在必须两行都在
    expect(await store.col('skill_installs').findOne({ _id: ADDR_A })).not.toBeNull()
    expect(await store.col('skill_installs').findOne({ _id: ADDR_B })).not.toBeNull()
  })

  it('init 水合往返：换实例从库重建，与迁移合同行形状互通', async (ctx) => {
    if (!skip(ctx)) return
    // 清场：显式场景不继承前序用例残留
    await store.col('skills').deleteMany({})
    await store.col('skill_installs').deleteMany({})
    // 用迁移合同的原始行形状插库（模拟 M1 搬进来的数据）
    await store
      .col('skills')
      .insertOne({ _id: 'gamma', name: 'gamma', publisher: ADDR_A, status: 'active' })
    await store
      .col('skill_installs')
      .insertOne({ _id: ADDR_B, skills: [{ name: 'gamma', source: 'market' }] })
    const svc2 = new SkillService({
      storeDir: mkdtempSync(join(tmpdir(), 'skill-store2-')),
      installsFile: join(mkdtempSync(join(tmpdir(), 'skill-inst2-')), 'installs.json'),
    })
    await svc2.init()
    expect(svc2.readIndex()).toEqual([{ name: 'gamma', publisher: ADDR_A, status: 'active' }])
    expect(svc2.readInstalls()).toEqual({ [ADDR_B]: [{ name: 'gamma', source: 'market' }] })
    // 磁盘正文不参与水合：installsFile 不存在也不报错
  })
})
