/**
 * M2-3 会话域接线的真库测试（provider='mongodb' 形态）
 * 覆盖：SessionMirror 全量镜像与 scope 隔离、串行队列收敛（乱入队两次只留末位
 * 快照）、删除传播（revocation/过期方向落库）、expiresAt 写库必须是 BSON Date
 * （TTL 只认 Date——number 会被监控器静默无视，本机 70s 探针实证）、中间件
 * create/revoke 在翻转形态下的真实写行为（revoke await 返回=库里已删）。
 * json 形态的签发/解析/吊销行为由存量 auth 系列测试覆盖（零改动路径）。
 * 需 27018 副本集；不可达优雅跳过。隔离库 dsh_m23_test。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { CONFIG } from '../src/config/config.js'
import { getStore } from '../src/services/mongo.store.js'
import { SessionMirror } from '../src/services/session.store.js'
import { adminSessionStore } from '../src/middleware/auth.middleware.js'
import { userSessionStore } from '../src/middleware/user-auth.middleware.js'
import { dataService } from '../src/services/data.service.js'

let store = null
let available = false
const skip = (ctx) => (available ? true : (ctx.skip(), false))

let savedProvider = null
let savedUri = null

beforeAll(async () => {
  savedProvider = CONFIG.storage.provider
  savedUri = CONFIG.storage.mongodbUri
  CONFIG.storage.provider = 'mongodb'
  CONFIG.storage.mongodbUri = 'mongodb://127.0.0.1:27018/dsh_m23_test?replicaSet=dsh-rs'
  store = getStore() // 首个 getStore 固化 uri → 隔离到测试库
  try {
    await store.connect()
    available = (await store.health()).topology === 'replset'
    if (available) {
      await store._db.dropDatabase()
      adminSessionStore.sessions = {} // 不把本机 json 缓存带进测试
      userSessionStore.sessions = {}
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

const col = () => store.col('sessions')

describe('mongodb 形态·SessionMirror 镜像语义', () => {
  it('enqueue+flush 往返：库里 expiresAt 是 Date，hydrate 归一回 number', async (ctx) => {
    if (!skip(ctx)) return
    const mirror = new SessionMirror('admin')
    const cache = {
      h1: { address: 'jaaaa1', expiresAt: 111 },
      h2: { address: 'jaaaa2', expiresAt: 222 },
    }
    mirror.enqueue(cache)
    await mirror.flush()
    const raw = await col().findOne({ _id: 'h1' })
    expect(raw.scope).toBe('admin')
    expect(raw.expiresAt).toBeInstanceOf(Date) // 写库必须 Date，否则 TTL 静默失效
    const map = await mirror.hydrate()
    expect(map.h2).toEqual({ address: 'jaaaa2', expiresAt: 222 }) // 回读归一 number
  })

  it('scope 隔离：admin 的全量替换绝不触碰 user 的行', async (ctx) => {
    if (!skip(ctx)) return
    await col().insertOne({ _id: 'u1', scope: 'user', address: 'ju1', expiresAt: new Date(999) })
    const mirror = new SessionMirror('admin')
    mirror.enqueue({ h3: { address: 'ja3', expiresAt: 333 } })
    await mirror.flush()
    expect(await col().findOne({ _id: 'u1' })).not.toBeNull()
    expect(await col().findOne({ _id: 'h1' })).toBeNull() // 旧 admin 快照被替换清掉
    expect(await col().findOne({ _id: 'h3' })).not.toBeNull()
  })

  it('串行队列收敛：连入两次不等落库，终态=最后一次快照（删除也传播）', async (ctx) => {
    if (!skip(ctx)) return
    const mirror = new SessionMirror('user')
    const cache = { s1: { address: 'js1', expiresAt: 1000 } }
    mirror.enqueue(cache) // 入队时快照未展开
    cache.s2 = { address: 'js2', expiresAt: 2000 } // 队列还没跑，同步改缓存
    delete cache.s1 // 模拟惰性删除过期：s1 从缓存消失
    mirror.enqueue(cache)
    await mirror.flush() // 排空两次任务（第一次的内容不该是终态）
    const docs = await col()
      .find({ scope: 'user' })
      .toArray()
      .then((d) => Object.fromEntries(d.map((x) => [x._id, x])))
    expect(Object.keys(docs)).toEqual(['s2']) // s1 在第一次任务执行时已不在缓存
    expect(docs.s2.address).toBe('js2')
    expect(await col().findOne({ _id: 'h3' })).not.toBeNull() // admin 的行不受波及
  })
})

describe('mongodb 形态·中间件 store 真实接线', () => {
  it('create 返回 token（同步签名不变）且镜像最终落库；revoke await 返回=库里已删', async (ctx) => {
    if (!skip(ctx)) return
    const fileSpy = vi.spyOn(dataService, 'saveUserSessions')
    const token = userSessionStore.create('jtestcrt000000000000000000000000000000', 60_000)
    expect(typeof token).toBe('string') // create 保持同步返回明文 token
    expect(fileSpy).not.toHaveBeenCalled() // mongodb 分支不碰文件（provider 单轨）
    fileSpy.mockRestore()
    await userSessionStore._mirror.flush()
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update(token).digest('hex')
    const row = await col().findOne({ _id: hash })
    expect(row.scope).toBe('user')
    expect(row.expiresAt).toBeInstanceOf(Date)
    expect(userSessionStore.resolve(token)).toBe('jtestcrt000000000000000000000000000000') // 读缓存零变化
    await userSessionStore.revoke(token) // await 返回即写确认
    expect(await col().findOne({ _id: hash })).toBeNull() // 吊销不许复活：库里立删
    expect(userSessionStore.resolve(token)).toBeNull()
  })

  it('init 水合：库里的行接管缓存（Date→number），空库则清空', async (ctx) => {
    if (!skip(ctx)) return
    await col().deleteMany({ scope: 'user' }) // 清掉前序用例残留，水合面从零
    await col().insertOne({ _id: 'h9', scope: 'user', address: 'juuu9', expiresAt: new Date(777) })
    await userSessionStore.init()
    expect(userSessionStore.sessions).toEqual({ h9: { address: 'juuu9', expiresAt: 777 } })
    await col().deleteMany({ scope: 'user' })
    await userSessionStore.init()
    expect(userSessionStore.sessions).toEqual({}) // 空库水合=清空，不带旧态
  })

  it('admin 端惰性删除（resolve 命中过期）走镜像队列：库里行最终消失', async (ctx) => {
    if (!skip(ctx)) return
    const { createHash } = await import('node:crypto')
    const token = adminSessionStore.create('jtestadm000000000000000000000000000000', 60_000)
    await adminSessionStore._mirror.flush()
    const hash = createHash('sha256').update(token).digest('hex')
    expect(await col().findOne({ _id: hash })).not.toBeNull() // 先确认镜像里真有行
    adminSessionStore.sessions[hash].expiresAt = Date.now() - 1000 // 手动置过期
    expect(adminSessionStore.resolve(token)).toBeNull() // 惰性删除：缓存删+enqueue
    await adminSessionStore._mirror.flush()
    expect(await col().findOne({ _id: hash })).toBeNull() // 删除方向最终落库
  })
})
