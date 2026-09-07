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
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)))
const STATE_FILE = join(ROOT, 'state.json')
const DATA_DIR = join(ROOT, 'data')

export class DataService {
  constructor() {
    this.stateFile = STATE_FILE
    this.dataDir = DATA_DIR
    this.initDataDir()
    this.hardenDataPermissions()
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
    ]
    for (const filePath of targets) {
      try {
        chmodSync(filePath, 0o600)
      } catch {
        // 文件尚不存在则跳过
      }
    }
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
   * 追加一条 CWT 审计记录（append-only 日志，顺序写，天然防膨胀）
   */
  appendCwtRecord(record) {
    mkdirSync(join(this.dataDir, 'cwt'), { recursive: true })
    const filePath = this.cwtFilePath('records.log')
    appendFileSync(filePath, JSON.stringify(record) + '\n', { mode: 0o600 })
    chmodSync(filePath, 0o600)
  }

  /**
   * 读取审计记录尾部 N 条（新 → 旧）
   */
  readCwtRecords(limit = 200) {
    const filePath = this.cwtFilePath('records.log')
    if (!existsSync(filePath)) return []
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    const records = []
    for (const line of lines) {
      try {
        records.push(JSON.parse(line))
      } catch {
        // 跳过损坏行
      }
    }
    return records.slice(-limit).reverse()
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
    const filePath = join(this.dataDir, 'config', 'admin.json')
    return this.readJson(filePath) || { addresses: [], history: [], updatedAt: null }
  }

  /**
   * 保存管理员配置
   */
  saveAdminConfig(config) {
    const filePath = join(this.dataDir, 'config', 'admin.json')
    config.updatedAt = Date.now()
    this.writeWithLock(filePath, config)
  }

  /**
   * 添加管理员
   */
  addAdmin(address, operator = 'system') {
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
      this.saveAdminConfig(config)
      return true
    }
    return false
  }

  /**
   * 记录操作日志
   */
  logOperation(operation, details) {
    const logDir = join(this.dataDir, 'logs')
    mkdirSync(logDir, { recursive: true })
    const logFile = join(logDir, 'operations.log')

    const logEntry = {
      timestamp: Date.now(),
      operation,
      details,
    }

    appendFileSync(logFile, JSON.stringify(logEntry) + '\n', { mode: 0o600 })
    chmodSync(logFile, 0o600)
  }
}

export const dataService = new DataService()
