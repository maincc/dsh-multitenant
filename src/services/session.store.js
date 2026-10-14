/**
 * 会话域的 MongoDB 镜像（M2-3，storage-design §4.1 sessions+TTL）
 *
 * 中间件里的 AdminSessionStore/UserSessionStore 保持【读缓存同步】（resolve 在
 * 网关热路径，不许变异步），本模块只负责 mongodb 形态下的持久化镜像与水合：
 *
 *   写方向语义（刻意的不对称，按安全强度分配）：
 *   - revoke/logout：persistNow 后【必须 await】——吊销不落实就返回，崩溃重启
 *     会"复活已登出的会话"，是安全回退，必须写确认后才算成功。
 *   - create：enqueue 镜像（串行队列，进程内最终一致）——丢了只是重启后要
 *     重新登录，无安全面；TTL 索引兜底清理删除方向的残行。
 *   - resolve 惰性删除过期：enqueue 即可（同样是删除方向，TTL 兜底）。
 *
 * ⚠️ TTL 索引只认 BSON Date（expireAfterSeconds 相对字段值比较）——毫秒 number
 * 会被监控器静默无视、过期行永久堆积。这里写入统一 new Date(ms)，水合统一
 * Number() 归一（兼容 M1 前已迁入的 number 旧行）。见 bash 探针实证与
 * migration.js 同步修正。
 */
import { CONFIG } from '../config/config.js'
import { getStore } from './mongo.store.js'

export class SessionMirror {
  /** @param {'admin'|'user'} scope 会话域（§4.1 双文件合并后靠 scope 区分） */
  constructor(scope) {
    this.scope = scope
    this._tail = Promise.resolve()
  }

  get provider() {
    return CONFIG.storage?.provider || 'json'
  }

  /** 从库水合 → { sha256hex: { address, expiresAt: number } } */
  async hydrate() {
    if (this.provider === 'json') return null
    const store = getStore()
    await store.connect()
    const docs = await store.col('sessions').find({ scope: this.scope }).toArray()
    const map = {}
    for (const d of docs) map[d._id] = { address: d.address, expiresAt: Number(d.expiresAt) }
    return map
  }

  /**
   * 入队一次全量镜像（缓存对象的引用传入——执行时才展开，串行队列的
   * 末位任务必然携带最新缓存态；json 形态直接 no-op，文件写由调用方自理）。
   * 返回 this 便于 revoke 场景接 flush() await 拿写确认。
   */
  enqueue(sessionsRef) {
    if (this.provider === 'json') return this
    this._tail = this._tail
      .then(() => this._replace(sessionsRef))
      .catch((err) => {
        console.error(
          `[session:${this.scope}] 镜像失败（内存态不受影响；TTL 兜底残行）：`,
          err.message,
        )
      })
    return this
  }

  /** 等队列排空（revoke 的"写确认"与测试/关停用） */
  async flush() {
    await this._tail
  }

  async _replace(sessions) {
    const store = getStore()
    await store.connect()
    await store.withTransaction(async (session) => {
      const c = store.col('sessions')
      // 只动自己 scope 的行——admin 镜像绝不越权删 user 会话（反之亦然）
      await c.deleteMany({ scope: this.scope }, { session })
      const docs = Object.entries(sessions)
        .filter(([, v]) => v)
        .map(([hash, v]) => ({
          _id: hash,
          scope: this.scope,
          address: v.address,
          expiresAt: new Date(Number(v.expiresAt) || 0), // TTL 只认 Date
        }))
      if (docs.length) await c.insertMany(docs, { session })
    })
  }
}
