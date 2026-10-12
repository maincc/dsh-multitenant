/**
 * M2-5 meta 单例域的真库测试（provider='mongodb' 形态）
 * 覆盖：meta#dsh_image 追加+50 封顶+await 写确认、meta#admin 保存并即时注入
 * 提权热路径（config.js isAdmin 走进程内权威、零磁盘）、init 按迁移合同行
 * 形状水合往返、单文档 upsert 幂等。
 * json 形态行为由存量 data.test.js/config.test.js 覆盖（分流默认走原逻辑）。
 * 需 27018 副本集；不可达优雅跳过。隔离库 dsh_m25_test。
 */
import { mongoTestUri } from './mongo-test-env.js'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { CONFIG, isAdmin, setAdminAddressesOverride } from '../src/config/config.js'
import { getStore } from '../src/services/mongo.store.js'
import { dataService } from '../src/services/data.service.js'

let store = null
let available = false
const skip = (ctx) => (available ? true : (ctx.skip(), false))
const ADMIN_A = 'jtestmetaa0000000000000000000000000000'
const ADMIN_B = 'jtestmetab0000000000000000000000000000'

let savedProvider = null
let savedUri = null

beforeAll(async () => {
  savedProvider = CONFIG.storage.provider
  savedUri = CONFIG.storage.mongodbUri
  CONFIG.storage.provider = 'mongodb'
  CONFIG.storage.mongodbUri = mongoTestUri('dsh_m25_test')
  store = getStore() // 首个 getStore 固化 uri → 隔离到测试库
  try {
    await store.connect()
    available = (await store.health()).topology === 'replset'
    if (available) {
      await store._db.dropDatabase()
      dataService._adminCache = null
      dataService._dshImageCache = null
    }
  } catch {
    available = false
  }
}, 15000)

afterAll(async () => {
  CONFIG.storage.provider = savedProvider
  CONFIG.storage.mongodbUri = savedUri
  setAdminAddressesOverride(null) // 还 config.js 以清白（防御式，worker 本就隔离）
  if (store && available) {
    try {
      await store._db.dropDatabase()
    } catch {}
  }
  if (store) await store.close()
})

const metaCol = () => store.col('meta')

describe('mongodb 形态·meta 单例域（admin/dsh_image）', () => {
  it('saveDshImage：await 返回=库里已确认；追加历史 + slice(-50) 封顶', async (ctx) => {
    if (!skip(ctx)) return
    for (let i = 1; i <= 52; i++) {
      await dataService.saveDshImage({
        version: `0.1.${i}`,
        imageId: `sha256:img${i}`,
        by: ADMIN_A,
      })
    }
    const doc = await metaCol().findOne({ _id: 'dsh_image' })
    expect(doc.history).toHaveLength(50) // 合同：增长有界（slice(-50) 封顶）
    expect(doc.current.version).toBe('0.1.52')
    expect(doc.history[49].version).toBe('0.1.52')
    expect(doc.history[0].version).toBe('0.1.3') // 前 2 条被裁
    // 同步读缓存，签名不变
    const rec = dataService.getDshImage()
    expect(rec.current.imageId).toBe('sha256:img52')
    expect(rec.history).toHaveLength(50)
    expect(await metaCol().countDocuments({ _id: 'dsh_image' })).toBe(1) // 单例幂等
  })

  it('addAdmin：库里确认 + 提权热路径即时生效（isAdmin 零磁盘走注入缓存）', async (ctx) => {
    if (!skip(ctx)) return
    const added = await dataService.addAdmin(ADMIN_A, 'test')
    expect(added).toBe(true)
    expect(isAdmin(ADMIN_A)).toBe(true) // config.js 的提权判定已读进程内权威
    const doc = await metaCol().findOne({ _id: 'admin' })
    expect(doc.addresses).toContain(ADMIN_A)
    expect(doc.history[0].action).toBe('add')

    expect(await dataService.addAdmin(ADMIN_A, 'test')).toBe(false) // 重复拒绝
    await dataService.addAdmin(ADMIN_B, 'test')
    expect(isAdmin(ADMIN_B)).toBe(true)
    expect(isAdmin('jnope00000000000000000000000000000000')).toBe(false)
    const after = await metaCol().findOne({ _id: 'admin' })
    expect(after.addresses).toHaveLength(2) // 幂等：没重复入列
  })

  it('init 水合往返：迁移合同的行形状直接可用', async (ctx) => {
    if (!skip(ctx)) return
    // 用迁移合同的原始形状重写两行（模拟 M1 从文件搬进来的数据）
    await metaCol().updateOne(
      { _id: 'admin' },
      {
        $set: {
          addresses: [ADMIN_B],
          history: [{ action: 'add', address: ADMIN_B, timestamp: 5, operator: 'x' }],
          updatedAt: 777,
        },
      },
      { upsert: true },
    )
    await metaCol().updateOne(
      { _id: 'dsh_image' },
      {
        $set: {
          current: { version: '0.9.9', imageId: 'sha256:old', at: 1 },
          history: [{ version: '0.9.9', imageId: 'sha256:old', at: 1 }],
        },
      },
      { upsert: true },
    )
    dataService._adminCache = null
    dataService._dshImageCache = null
    await dataService.init()
    expect(isAdmin(ADMIN_B)).toBe(true) // 水合即接管热路径
    expect(isAdmin(ADMIN_A)).toBe(false) // 库里没有 A → 缓存没 A（旧态不带入）
    const rec = dataService.getDshImage()
    expect(rec.current.version).toBe('0.9.9')
    expect(rec.history).toHaveLength(1)
  })

  it('json 形态回归锁：provider 还原后写点仍走同步文件轨（临时 dataDir，不碰真实文件）', async (ctx) => {
    if (!skip(ctx)) return
    CONFIG.storage.provider = 'json'
    const realDir = dataService.dataDir
    dataService.dataDir = mkdtempSync(join(tmpdir(), 'meta-json-'))
    try {
      const p = dataService.saveDshImage({
        version: '0.5.0-filemode',
        imageId: 'sha256:file',
        by: 't',
      })
      // json 分支体同步完成（不 await 也已落盘）——与改造前逐调用一致
      expect(p).toBeInstanceOf(Promise) // 签名已是 async，但 json 写效果不依赖 await
      const raw = JSON.parse(readFileSync(dataService.dshImageFile(), 'utf8'))
      expect(raw.current.version).toBe('0.5.0-filemode')
      await p
    } finally {
      dataService.dataDir = realDir
      CONFIG.storage.provider = 'mongodb'
    }
  })
})
