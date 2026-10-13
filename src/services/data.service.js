/**
 * 数据存储模块
 * 支持原子写入的 JSON 数据读写
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  appendFileSync,
  chmodSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { CONFIG, setAdminAddressesOverride } from '../config/config.js'
import { getStore } from './mongo.store.js'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)))
const STATE_FILE = join(ROOT, 'state.json')
const DATA_DIR = join(ROOT, 'data')

/** 审计日志尾部读取的初始窗口（字节）；不足 limit 条时按倍数向前扩大 */
const RECORDS_TAIL_CHUNK = 64 * 1024
/** 审计日志轮转阈值（字节）；超过则由 appendCwtRecord 归档为 records.log.1 */
const RECORDS_MAX_BYTES = 5 * 1024 * 1024

export class DataService {
  constructor() {
    this.stateFile = STATE_FILE
    this.dataDir = DATA_DIR
    // 轮转阈值（实例字段便于测试注入小值）
    this.recordsMaxBytes = RECORDS_MAX_BYTES
    this.initDataDir()
    this.hardenDataPermissions()
    this._adminCache = null
    this._dshImageCache = null
  }

  /**
   * 启动时收敛既有数据文件权限到 0600（security-hardening-plan P1-9）
   * 迁移/历史创建的文件可能仍是默认 umask（0644），在此一次性收敛。
   */
  hardenDataPermissions() {
    const targets = [
      this.stateFile,
      this.cwtFilePath('registry.json'),
      this.cwtFilePath('applications.json'),
      this.cwtFilePath('records.log'),
      join(this.dataDir, 'logs', 'operations.log'),
      join(this.dataDir, 'config', 'sessions.json'),
      join(this.dataDir, 'config', 'user-sessions.json'),
      // 镜像版本记录也应 0600：它暴露平台在用哪个 DSH 版本（攻击面信息）
      join(this.dataDir, 'dsh-image.json'),
    ]
    for (const filePath of targets) {
      try {
        chmodSync(filePath, 0o600)
      } catch {
        // 文件尚不存在则跳过
      }
    }
  }

  // ---------- 管理员会话（data/config/sessions.json，P0-1） ----------

  /**
   * 加载管理员会话表（sha256(token) -> { address, expiresAt }）
   */
  loadSessions() {
    return this.readJson(join(this.dataDir, 'config', 'sessions.json'))
  }

  /**
   * 保存管理员会话表（原子写 + 0600）
   */
  saveSessions(sessions) {
    this.writeWithLock(join(this.dataDir, 'config', 'sessions.json'), sessions)
  }

  // ---------- 普通用户会话（data/config/user-sessions.json，网关门禁凭据） ----------

  /**
   * 加载普通用户会话表（sha256(token) -> { address, expiresAt }）
   */
  loadUserSessions() {
    return this.readJson(join(this.dataDir, 'config', 'user-sessions.json'))
  }

  /**
   * 保存普通用户会话表（原子写 + 0600）
   */
  saveUserSessions(sessions) {
    this.writeWithLock(join(this.dataDir, 'config', 'user-sessions.json'), sessions)
  }

  /**
   * 初始化数据目录
   */
  initDataDir() {
    mkdirSync(this.dataDir, { recursive: true })
    mkdirSync(join(this.dataDir, 'users'), { recursive: true })
    mkdirSync(join(this.dataDir, 'config'), { recursive: true })
    mkdirSync(join(this.dataDir, 'stats'), { recursive: true })
    mkdirSync(join(this.dataDir, 'cwt'), { recursive: true })
  }

  /**
   * 读取原始 state.json（不做任何默认值补全，供迁移等场景）
   */
  readStateFile() {
    if (!existsSync(this.stateFile)) return null
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * 移除 state.json 中的 CWT 旧块（迁移完成后清理，防止 state.json 继续膨胀）
   */
  stripLegacyCwt() {
    const s = this.readStateFile()
    if (!s) return
    if (
      s.cwtRegistry !== undefined ||
      s.cwtApplications !== undefined ||
      s.cwtRecords !== undefined
    ) {
      delete s.cwtRegistry
      delete s.cwtApplications
      delete s.cwtRecords
      this.writeWithLock(this.stateFile, s)
    }
  }

  // ---------- CWT 数据（data/cwt/） ----------

  cwtFilePath(name) {
    return join(this.dataDir, 'cwt', name)
  }

  loadCwtRegistry() {
    return this.readJson(this.cwtFilePath('registry.json'))
  }

  saveCwtRegistry(registry) {
    this.writeWithLock(this.cwtFilePath('registry.json'), registry)
  }

  loadCwtApplications() {
    return this.readJson(this.cwtFilePath('applications.json'))
  }

  saveCwtApplications(applications) {
    this.writeWithLock(this.cwtFilePath('applications.json'), applications)
  }

  /**
   * 追加一条 CWT 审计记录（append-only 日志）。
   * 超过 recordsMaxBytes 时轮转：当前日志归档为 records.log.1（覆盖旧归档），
   * 新建空日志继续写——保证磁盘占用有界且保留最近一份历史。
   */
  appendCwtRecord(record) {
    mkdirSync(join(this.dataDir, 'cwt'), { recursive: true })
    const filePath = this.cwtFilePath('records.log')

    // 轮转检查（失败不阻断写入：记录审计优先）
    try {
      if (existsSync(filePath) && statSync(filePath).size >= this.recordsMaxBytes) {
        renameSync(filePath, `${filePath}.1`)
        console.log(
          `[data] cwt records rotated → records.log.1 (threshold ${this.recordsMaxBytes} bytes)`,
        )
      }
    } catch (err) {
      console.error(`[data] cwt records rotation failed: ${err.message}`)
    }

    appendFileSync(filePath, JSON.stringify(record) + '\n', { mode: 0o600 })
    chmodSync(filePath, 0o600)
  }

  /**
   * 分页读取审计记录（新 → 旧）。
   * 只从文件尾部按块读取，不读整个文件：日志随运行时间增长时本方法开销恒定。
   * @param {number} [limit] 本页条数
   * @param {number} [offset] 偏移（0 = 最新一条开始）
   * @returns {{ records: object[], hasMore: boolean }} hasMore 表示还有更早的记录
   */
  readCwtRecords(limit = 10, offset = 0) {
    const filePath = this.cwtFilePath('records.log')
    if (!existsSync(filePath)) return { records: [], hasMore: false }

    // 需要从尾部读出的条数；多读 1 条用于判断是否还有更早记录
    const pageLimit = Math.max(1, limit)
    const pageOffset = Math.max(0, offset)
    const need = pageLimit + pageOffset

    let fd
    try {
      fd = openSync(filePath, 'r')
      const size = fstatSync(fd).size
      if (size <= 0) return { records: [], hasMore: false }

      // 从尾部向前取窗口；行数不足 need 时窗口翻倍继续（最终可覆盖整个文件）
      let windowSize = Math.max(RECORDS_TAIL_CHUNK, need * 256)
      let start = Math.max(0, size - windowSize)
      let text = ''
      for (;;) {
        const len = size - start
        const buf = Buffer.allocUnsafe(len)
        readSync(fd, buf, 0, len, start)
        text = buf.toString('utf8')
        const lineCount = text.split('\n').filter(Boolean).length
        // 留一行余量：非文件开头时首行可能被截断，需丢弃
        if (start === 0 || lineCount > need) break
        windowSize *= 2
        start = Math.max(0, size - windowSize)
      }

      let lines = text.split('\n').filter(Boolean)
      // 非从头读取时，首行可能是不完整的半行（或含截断的多字节字符）→ 丢弃
      if (start > 0) lines = lines.slice(1)

      const parsed = []
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line))
        } catch {
          // 跳过损坏行
        }
      }
      const newestFirst = parsed.reverse() // 新 → 旧
      return {
        records: newestFirst.slice(pageOffset, pageOffset + pageLimit),
        hasMore: newestFirst.length > pageOffset + pageLimit,
      }
    } catch (err) {
      console.error(`[data] readCwtRecords failed: ${err.message}`)
      return { records: [], hasMore: false }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // 忽略关闭失败
        }
      }
    }
  }

  /**
   * 原子写入 JSON（先写临时文件，再重命名）
   * 权限收敛到 0600（security-hardening-plan P1-9：地址/端口/豁免状态不落 0644 被宿主本地任意用户读）
   */
  writeWithLock(filePath, data) {
    const tmpPath = `${filePath}.tmp.${Date.now()}`
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmpPath, filePath)
    chmodSync(filePath, 0o600) // 已存在的旧文件也收敛到 0600
  }

  /**
   * 读取 JSON 文件
   */
  readJson(filePath) {
    if (!existsSync(filePath)) return null
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * 加载 state.json（兼容旧格式）
   */
  loadState() {
    const defaults = {
      swtcUsers: {},
      nextPort: 31000,
      cleanupPolicy: {
        stopTimeoutMs: 900000,
        destroyTimeoutMs: 3600000,
        checkIntervalMs: 300000,
      },
    }
    if (!existsSync(this.stateFile)) return defaults
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (typeof s.nextPort !== 'number') s.nextPort = 31000
      if (!s.cleanupPolicy) {
        s.cleanupPolicy = defaults.cleanupPolicy
      }
      if (!s.swtcUsers) s.swtcUsers = {}
      return s
    } catch {
      return defaults
    }
  }

  /**
   * 保存 state.json
   */
  saveState(state) {
    this.writeWithLock(this.stateFile, state)
  }

  /**
   * 获取用户数据
   */
  getUser(address) {
    const filePath = join(this.dataDir, 'users', `${address}.json`)
    return this.readJson(filePath)
  }

  /**
   * 保存用户数据
   */
  saveUser(address, data) {
    const filePath = join(this.dataDir, 'users', `${address}.json`)
    this.writeWithLock(filePath, data)
  }

  /**
   * 删除用户数据文件
   */
  deleteUserFile(address) {
    const filePath = join(this.dataDir, 'users', `${address}.json`)
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  }

  /**
   * 获取所有用户列表
   */
  getAllUsers() {
    const usersDir = join(this.dataDir, 'users')
    if (!existsSync(usersDir)) return []

    const files = readdirSync(usersDir)
    const users = []
    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = this.readJson(join(usersDir, file))
        if (data) users.push(data)
      }
    }
    return users
  }

  /**
   * 获取管理员配置
   */
  getAdminConfig() {
    if (this.provider !== 'json')
      return this._adminCache ?? { addresses: [], history: [], updatedAt: null }
    const filePath = join(this.dataDir, 'config', 'admin.json')
    return this.readJson(filePath) || { addresses: [], history: [], updatedAt: null }
  }

  /**
   * 保存管理员配置
   */
  /** provider 分流（M2-5）：json 默认=逐调用不变；mongodb=meta 单例入库 */
  get provider() {
    return CONFIG.storage?.provider || 'json'
  }

  /**
   * provider='mongodb' 启动水合（server 启动链调；json=空操作）。
   * meta#admin / meta#dsh_image 两个单例文档 → 进程内缓存；admin 地址同步
   * 注入 config.js 的提权热路径（getAdminAddresses 不再碰磁盘）。
   */
  async init() {
    if (this.provider === 'json') return
    const store = getStore()
    await store.connect()
    const [adminDoc, imgDoc] = await Promise.all([
      store.col('meta').findOne({ _id: 'admin' }),
      store.col('meta').findOne({ _id: 'dsh_image' }),
    ])
    this._adminCache = adminDoc
      ? {
          addresses: adminDoc.addresses ?? [],
          history: adminDoc.history ?? [],
          updatedAt: adminDoc.updatedAt ?? null,
        }
      : { addresses: [], history: [], updatedAt: null }
    this._dshImageCache = imgDoc
      ? {
          current: imgDoc.current ?? null,
          history: Array.isArray(imgDoc.history) ? imgDoc.history : [],
        }
      : { current: null, history: [] }
    this._applyAdminOverride()
    console.log(
      `[meta] 已从 MongoDB 水合管理员/镜像版本域：管理员 ${this._adminCache.addresses.length} 个，镜像历史 ${this._dshImageCache.history.length} 条`,
    )
  }

  _applyAdminOverride() {
    setAdminAddressesOverride(this._adminCache?.addresses ?? [])
  }

  /**
   * 保存管理员配置。mongodb：await 返回=库里已确认（单文档 updateOne 天然
   * 原子，无需事务包裹）；json：同步文件写，行为零变化。
   */
  async saveAdminConfig(config) {
    config.updatedAt = Date.now()
    if (this.provider !== 'json') {
      this._adminCache = config
      this._applyAdminOverride()
      const store = getStore()
      await store.connect()
      await store.col('meta').updateOne(
        { _id: 'admin' },
        {
          $set: {
            addresses: config.addresses ?? [],
            history: config.history ?? [],
            updatedAt: config.updatedAt,
          },
        },
        { upsert: true },
      )
      return
    }
    const filePath = join(this.dataDir, 'config', 'admin.json')
    this.writeWithLock(filePath, config)
  }

  // ---------- DSH 镜像版本记录（data/dsh-image.json） ----------

  /** data/dsh-image.json 路径 */
  dshImageFile() {
    return join(this.dataDir, 'dsh-image.json')
  }

  /**
   * 读取镜像版本记录
   * @returns {{current: object|null, history: Array<object>}}
   */
  getDshImage() {
    if (this.provider !== 'json') return this._dshImageCache ?? { current: null, history: [] }
    const data = this.readJson(this.dshImageFile())
    return {
      current: data?.current ?? null,
      history: Array.isArray(data?.history) ? data.history : [],
    }
  }

  /**
   * 记录一次镜像升级（追加历史，保留最近 50 条）
   * @param {{version:string|null, imageId:string|null, tag?:string|null, by?:string}} info
   */
  async saveDshImage(info) {
    const prev = this.getDshImage()
    const record = {
      version: info.version ?? null,
      imageId: info.imageId ?? null,
      tag: info.tag ?? null,
      at: Date.now(),
      by: info.by ?? 'system',
    }
    const next = { current: record, history: [...prev.history, record].slice(-50) }
    if (this.provider !== 'json') {
      this._dshImageCache = next
      const store = getStore()
      await store.connect()
      await store.col('meta').updateOne({ _id: 'dsh_image' }, { $set: next }, { upsert: true })
      return record
    }
    this.writeWithLock(this.dshImageFile(), next)
    return record
  }

  /**
   * 添加管理员
   */
  async addAdmin(address, operator = 'system') {
    const config = this.getAdminConfig()
    if (!config.addresses.includes(address)) {
      config.addresses.push(address)
      if (!config.history) config.history = []
      config.history.push({
        action: 'add',
        address,
        timestamp: Date.now(),
        operator,
      })
      await this.saveAdminConfig(config)
      return true
    }
    return false
  }

  /**
   * 记录操作日志（ops 审计：admin_login / admin_promote / 钉版 等）。
   *
   * provider 分流——mongodb 落 audit 集合（与 cwt 审计同表，靠 kind 区分），
   * 这是 M2 漏掉的分流点：mongodb 形态下 ops 审计曾【只进文件、不进库】，
   * 等于管理动作在库里没录像。行形状对齐迁移器（migration.js）的 ops 记录：
   *   {kind:'ops', action, actor, at:Date(BSON)} + 保留原 {timestamp,operation,details}
   * 供读侧兼容。关键语义：
   *   - at 必须是【BSON Date】——audit 的 ttl_90d 索引只认 Date（90 天合规
   *     留存要求，实测：number 类型 TTL 永不回收 = 静默泄露）。
   *   - 写失败【不阻塞调用方】：审计是尽力轨（丢了是合规缺口，不是正确性/
   *     安全漏洞；登录本身已成功不应因审计回滚）。返回 Promise 便于需要确认
   *     的调用方 await；失败已被内部 catch，不会炸调用方。
   * json 形态维持原样：operations.log 追加，行为零变化。
   */
  logOperation(operation, details) {
    const timestamp = Date.now()
    const logEntry = { timestamp, operation, details }
    if (this.provider !== 'json') {
      // async 闭包不可省：getStore()/col() 在"库未连接"时是【同步 throw】，
      // 挂在 promise 链上接不住（e2e 实测炸过一次）——包进 try 转成 rejection，
      // 才兑现"审计失败不反噬调用方"的承诺。
      return (async () => {
        await getStore()
          .col('audit')
          .insertOne({
            ...logEntry,
            kind: 'ops',
            action: operation,
            actor: details?.address ?? details?.operator ?? null,
            at: new Date(timestamp),
          })
      })().catch((err) => {
        console.error(`[audit:ops] 操作审计写库失败（不阻塞业务）：${operation} → ${err.message}`)
      })
    }
    const logDir = join(this.dataDir, 'logs')
    mkdirSync(logDir, { recursive: true })
    const logFile = join(logDir, 'operations.log')
    appendFileSync(logFile, JSON.stringify(logEntry) + '\n', { mode: 0o600 })
    chmodSync(logFile, 0o600)
    return Promise.resolve()
  }
}

export const dataService = new DataService()
