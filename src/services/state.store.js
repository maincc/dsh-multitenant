/**
 * 用户域状态仓库（M2-1，storage-design D1/D5/§5.2）
 *
 * user.service 的内存缓存 this.state 只有一个读写出口——这里：
 *   provider=json     透传 dataService（同步写文件，行为与现网逐字节一致；
 *                     async 签名只是壳，json 分支内不产生真实 await 点）
 *   provider=mongodb  把整个缓存打包成【一个事务】原子扇出四域：
 *                     users(逐地址 upsert+差集删除) / meta#ports / meta#cleanup /
 *                     usage(按 {address,date} upsert，绝不删历史行)
 *                     ——与 writeWithLock 整写文件同级的"要么全成要么全不动"；
 *                     失败=库保持上一次镜像，进程缓存不受影响（重试即追平）。
 *
 * ⚠️ 所有权纪律（§4.1 meta 准入同款思路）：扇出只碰 USER_OWNED_FIELDS 白名单。
 * users 文档里的 profile 属技能/资料域、迁移回填的 cwtVerifiedAt 初值属 CWT 域——
 * 白名单外的键永不动，杜绝"用户域存盘顺手把别人家的字段抹掉"。
 * 白名单内、缓存里不存在的键会 $unset（缓存是权威：delete user.port 必须传播）。
 */
import { CONFIG } from '../config/config.js'
import { dataService } from './data.service.js'
import { getStore } from './mongo.store.js'

/** user 域在 users 文档上拥有的字段（其余为外域所有，见文件头纪律） */
export const USER_OWNED_FIELDS = [
  'port',
  'internalPort',
  'tier',
  'createdAt',
  'lastSeenAt',
  'containerStatus',
  'baseImageVersion',
  'imageId',
  'requiresToken',
  'lastDshVersion',
  'versionChangedAt',
  'usageStartedAt', // 计量表针（P7：结算先清针再累计，随整存盘单事务原子落库）
  'pinnedImage',
  'cwtVerifiedAt', // 冗余标记：缓存里由 CWT 授权路径维护（hydrate 时从库里带回）
  'cwtAuthorizedAt',
]

const DEFAULT_STATE = () => ({
  swtcUsers: {},
  nextPort: 31000,
  availablePorts: [],
  cleanupPolicy: { stopTimeoutMs: 900000, destroyTimeoutMs: 3600000, checkIntervalMs: 300000 },
  usages: {},
})

export class StateStore {
  /** 测试注入：{ provider, store }；缺省每次调用现读 CONFIG（灰度可运行时切换） */
  constructor(inject = {}) {
    this._inject = inject
  }
  get provider() {
    return this._inject.provider || CONFIG.storage?.provider || 'json'
  }
  _mongoStore() {
    return this._inject.store || getStore()
  }

  /** 整读（启动 hydrate / 未来多进程一致性刷新用；稳态读走 user.service 缓存） */
  async load() {
    if (this.provider === 'json') return dataService.loadState()
    const store = this._mongoStore()
    await store.connect() // 冷路径防呆：不能假设迁移钩子已把连接热好
    return loadFromMongo(store)
  }

  /**
   * 整存（user.service._saveState 的唯一下游）。
   * {session}=加入【外部事务】（§5.2 CWT 审批四方写共用一个事务）；缺省自开单事务。
   */
  async save(state, { session } = {}) {
    if (this.provider === 'json') return dataService.saveState(state)
    const store = this._mongoStore()
    await store.connect()
    if (session) return fanoutOps(store, state, session)
    return store.withTransaction((s) => fanoutOps(store, state, s))
  }
}

async function loadFromMongo(store) {
  const state = DEFAULT_STATE()
  const docs = await store.find('users', {})
  for (const d of docs) {
    const u = {}
    for (const f of USER_OWNED_FIELDS) {
      if (d[f] !== undefined && d[f] !== null) u[f] = d[f] // 迁移期的 null 占位归并为"未设置"
    }
    state.swtcUsers[d._id] = u
  }
  const ports = await store.col('meta').findOne({ _id: 'ports' })
  if (ports && typeof ports.nextPort === 'number') state.nextPort = ports.nextPort
  if (ports && Array.isArray(ports.availablePorts)) state.availablePorts = ports.availablePorts
  const cleanup = await store.col('meta').findOne({ _id: 'cleanup' })
  if (cleanup) {
    const { _id, ...policy } = cleanup
    if (Object.keys(policy).length) state.cleanupPolicy = policy
  }
  // usages 语义=每地址一现行行：取最新日期文档；更早日期留在库里作历史（R3 修正项）
  const rows = await store
    .col('usage')
    .aggregate([
      { $sort: { '_id.date': -1 } },
      {
        $group: {
          _id: '$_id.address',
          date: { $first: '$_id.date' },
          minutes: { $first: '$minutes' },
        },
      },
    ])
    .toArray()
  for (const r of rows) state.usages[r._id] = { date: r.date, minutes: r.minutes ?? 0 }
  return state
}

// 扇出操作序列，跑在【传入的 session】上——是否包事务由调用方决定（save 自开 /
// CWT 审批注入外部事务）。绝不在这里 withTransaction，否则与外部事务嵌套会炸。
async function fanoutOps(store, state, session) {
  const users = store.col('users')
  const addrs = Object.keys(state.swtcUsers || {})
  for (const addr of addrs) {
    const u = state.swtcUsers[addr] || {}
    const set = {}
    const unset = {}
    for (const f of USER_OWNED_FIELDS) {
      if (u[f] !== undefined && u[f] !== null) set[f] = u[f]
      else unset[f] = ''
    }
    await users.updateOne(
      { _id: addr },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { upsert: true, session },
    )
  }
  // 缓存是权威：不在缓存里的用户文档删除（对齐文件模式整写覆盖语义）
  await users.deleteMany(addrs.length ? { _id: { $nin: addrs } } : {}, { session })

  const meta = store.col('meta')
  await meta.updateOne(
    { _id: 'ports' },
    { $set: { nextPort: state.nextPort ?? 31000, availablePorts: state.availablePorts ?? [] } },
    { upsert: true, session },
  )
  await meta.updateOne(
    { _id: 'cleanup' },
    { $set: { ...(state.cleanupPolicy || {}) } },
    { upsert: true, session },
  )

  // usage：只 upsert 现行行，历史日期不动（文件模式做不到的保真，这里白拿）
  const usage = store.col('usage')
  for (const [addr, rec] of Object.entries(state.usages || {})) {
    if (!rec || !rec.date) continue
    await usage.updateOne(
      { _id: { address: addr, date: rec.date } },
      { $set: { minutes: rec.minutes ?? 0 } },
      { upsert: true, session },
    )
  }
}

export const stateStore = new StateStore()
