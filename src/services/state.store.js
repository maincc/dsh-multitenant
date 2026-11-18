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
 * users 文档里的 profile 属技能/资料域——
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
]

const DEFAULT_STATE = () => ({
  swtcUsers: {},
  nextPort: 31000,
  availablePorts: [],
  // 占用账本（双段配对探针产物，2026-11-14）：mongo 走 meta#occupations 单文档
  // 整镜像（同 cleanup 先例），json 走整写天然包含
  externalOccupations: {},
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
   * {session}=加入【外部事务】（§5.2 审批多表写共用一个事务）；缺省自开单事务。
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
  // 占用账本整镜像（键必须是字符串，回读归一：mongo BSON 会把数字键变字符串，
  // 而 recordOccupation 按数字键写——不统一则重启后同口重复开账）
  const occ = await store.col('meta').findOne({ _id: 'occupations' })
  if (occ && occ.entries && typeof occ.entries === 'object') {
    for (const [k, v] of Object.entries(occ.entries)) {
      if (v && typeof v === 'object' && 'port' in v)
        state.externalOccupations[String(k)] = { ...v, port: Number(v.port) }
    }
  }
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
// 审批注入外部事务）。绝不在这里 withTransaction，否则与外部事务嵌套会炸。
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
  // 缓存是权威：不在缓存里的用户文档删除（对齐文件模式整写覆盖语义）。
  // 2026-10 审计护栏：addrs 为空时 `$nin: []` 会匹配**全部**文档——水合失败/
  // 连接抖动窗口的空快照一旦被写回，等价于清库级事故。业务上不存在"全体用户
  // 一次性消失"（reset/销毁都逐条、销毁后仍留 destroyed 记录），所以空缓存
  // 只可能是异常态：跳过对账删除并显式告警，宁可留下孤儿行也不能删活数据。
  if (addrs.length) {
    await users.deleteMany({ _id: { $nin: addrs } }, { session })
  } else {
    console.error(
      '[state.store] swtcUsers 缓存为空：跳过 $nin 对账删除（防整表清库；若这是真实状态请人工核对 users 集合）',
    )
  }

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
  // 占用账本单文档整镜像；$unset old 防形态切换遗留（本行从不写 old 字段）
  await meta.updateOne(
    { _id: 'occupations' },
    {
      $set: { entries: state.externalOccupations || {} },
      $unset: { old: '' },
    },
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

// 测试护盾出口（v1.2 白名单丢字段事故复盘）：round-trip 直测内部纯函数
export { loadFromMongo as __test_loadFromMongo, fanoutOps as __test_fanoutOps }
