/**
 * M2-2 CWT 域接线的真库测试（provider='mongodb' 形态）
 * 覆盖：cwtStore 三原语的集合映射、init 水合往返、runTxn 四方写
 * （registry+applications+users 冗余+audit 跨两个 store 同事务）、失败整体回滚。
 * approveApplication 的验签前置逻辑由存量 cwt-admin.test.js（json 形态）覆盖，
 * 这里测的是【改造引入的新语义】——事务串接与原子性。
 * 需 27018 副本集；不可达优雅跳过。隔离库 dsh_m22_test。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { CONFIG } from '../src/config/config.js'
import { cwtStore } from '../src/services/cwt.store.js'
import { userService } from '../src/services/user.service.js'
import { stateStore } from '../src/services/state.store.js'
import { getStore } from '../src/services/mongo.store.js'

let store = null
let available = false
const skip = (ctx) => (available ? true : (ctx.skip(), false))
const ADDR = 'jtestcwt00000000000000000000000000000000'
const ADMIN = 'jtestadmin000000000000000000000000000000'

let savedProvider = null
let savedUri = null

beforeAll(async () => {
  savedProvider = CONFIG.storage.provider
  savedUri = CONFIG.storage.mongodbUri
  CONFIG.storage.provider = 'mongodb'
  CONFIG.storage.mongodbUri = 'mongodb://127.0.0.1:27018/dsh_m22_test?replicaSet=dsh-rs'
  store = getStore() // 首个 getStore 固化 uri → 隔离到测试库
  try {
    await store.connect()
    available = (await store.health()).topology === 'replset'
    if (available) {
      await store._db.dropDatabase()
      await cwtStore.init() // 空库 → 缓存清空（本机 json 缓存不带进测试）
    }
  } catch {
    available = false
  }
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

describe('mongodb 形态·CWT 写原语', () => {
  it('setRegistryEntry → cwt_registry upsert；缓存与库同形', async (ctx) => {
    if (!skip(ctx)) return
    await cwtStore.setRegistryEntry(ADDR, {
      usr: 'alice',
      wallet: ADDR,
      approvedAt: 555,
      approvedBy: ADMIN,
      status: 'approved',
    })
    const doc = await store.col('cwt_registry').findOne({ _id: ADDR })
    expect(doc.status).toBe('approved')
    expect(cwtStore.getRegistry()[ADDR].approvedAt).toBe(555)
  })

  it('saveApplications → 整表替换 + rejected 裁剪在库里同样生效', async (ctx) => {
    if (!skip(ctx)) return
    cwtStore.applications = [
      { id: 'p1', status: 'pending', submittedAt: 1, parsed: { address: ADDR } },
      ...Array.from({ length: 102 }, (_, i) => ({
        id: `r${i}`,
        status: 'rejected',
        submittedAt: 2,
      })),
    ]
    await cwtStore.saveApplications()
    const n = await store.col('cwt_applications').countDocuments({})
    expect(n).toBe(1 + 100) // pending 不裁，rejected 留最近 100
    expect(await store.col('cwt_applications').findOne({ _id: 'r0' })).toBe(null)
    expect(await store.col('cwt_applications').findOne({ _id: 'r101' })).not.toBe(null)
  })

  it('appendRecord → audit{kind:cwt}；listRecords 异步分页且只回 cwt 原字段', async (ctx) => {
    if (!skip(ctx)) return
    await cwtStore.appendRecord({ address: ADDR, action: 'approve', at: 100, by: ADMIN })
    await cwtStore.appendRecord({ address: ADDR, action: 'revoke', at: 200, by: ADMIN })
    await store.col('audit').insertOne({ kind: 'ops', at: 300, action: 'admin_login' }) // 混入 ops
    const page = await cwtStore.listRecords(1, 0)
    expect(page.records).toHaveLength(1)
    expect(page.records[0].action).toBe('revoke') // at 倒序最新
    expect(page.hasMore).toBe(true)
    expect(page.records[0].kind).toBe(undefined) // 对外形状与 json 版一致
    expect(page.records[0]._id).toBe(undefined)
  })

  it('init 水合往返：库为权威重建缓存', async (ctx) => {
    if (!skip(ctx)) return
    cwtStore.registry = {}
    cwtStore.applications = []
    await cwtStore.init()
    expect(Object.keys(cwtStore.registry)).toEqual([ADDR])
    expect(cwtStore.getRegistry()[ADDR].status).toBe('approved')
    expect(cwtStore.applications.find((a) => a.id === 'p1').status).toBe('pending')
    expect(cwtStore.applications[0]).not.toHaveProperty('_id') // _id 还原成 id 字段
  })
})

describe('mongodb 形态·四方写单事务（§5.2 边界①的事务机制）', () => {
  const commitFour = (session) => {
    return (async () => {
      await cwtStore.setRegistryEntry(
        ADDR,
        { usr: 'alice', wallet: ADDR, approvedAt: 900, approvedBy: ADMIN, status: 'approved' },
        { session },
      )
      const app = cwtStore.applications.find((a) => a.id === 'p1')
      app.status = 'approved'
      await cwtStore.saveApplications({ session })
      userService.state.swtcUsers = {
        [ADDR]: { port: 31999, containerStatus: 'destroyed', cwtAuthorizedAt: 900 },
      }
      await stateStore.save(userService.state, { session })
      await cwtStore.appendRecord(
        { address: ADDR, action: 'approve', at: 900, by: ADMIN },
        { session },
      )
    })()
  }

  it('正路径：四方全落库（跨 cwt/user 两个 store 共用一个 session）', async (ctx) => {
    if (!skip(ctx)) return
    await cwtStore.runTxn(commitFour)
    expect((await store.col('cwt_registry').findOne({ _id: ADDR })).approvedAt).toBe(900)
    expect((await store.col('cwt_applications').findOne({ _id: 'p1' })).status).toBe('approved')
    const u = await store.col('users').findOne({ _id: ADDR })
    expect(u.cwtAuthorizedAt).toBe(900)
    // at 存 Date（TTL 只认 Date），查询同型
    expect((await store.col('audit').findOne({ action: 'approve', at: new Date(900) })).kind).toBe(
      'cwt',
    )
  })

  it('失败全回滚：applications 整表替换里藏重复 _id（dup key 必炸）→ 三方零改动', async (ctx) => {
    if (!skip(ctx)) return
    await expect(
      cwtStore.runTxn(async (session) => {
        await cwtStore.setRegistryEntry(ADDR, { usr: 'x', status: 'revoked' }, { session })
        const app = cwtStore.applications.find((a) => a.id === 'p1')
        app.status = 'rejected'
        cwtStore.applications.push({ id: 'p1', status: 'pending', submittedAt: 9 }) // 撞 _id
        await cwtStore.saveApplications({ session })
        userService.state.swtcUsers[ADDR].cwtAuthorizedAt = 12345
        await stateStore.save(userService.state, { session })
      }),
    ).rejects.toThrow()
    // 三方全部保持上一个事务的形态
    expect((await store.col('cwt_registry').findOne({ _id: ADDR })).approvedAt).toBe(900)
    expect((await store.col('cwt_applications').findOne({ _id: 'p1' })).status).toBe('approved')
    expect((await store.col('users').findOne({ _id: ADDR })).cwtAuthorizedAt).toBe(900)
  })
})
