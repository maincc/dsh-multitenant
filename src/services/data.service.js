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
  }

  /**
   * 初始化数据目录
   */
  initDataDir() {
    mkdirSync(this.dataDir, { recursive: true })
    mkdirSync(join(this.dataDir, 'users'), { recursive: true })
    mkdirSync(join(this.dataDir, 'config'), { recursive: true })
    mkdirSync(join(this.dataDir, 'stats'), { recursive: true })
  }

  /**
   * 原子写入 JSON（先写临时文件，再重命名）
   */
  writeWithLock(filePath, data) {
    const tmpPath = `${filePath}.tmp.${Date.now()}`
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n')
    renameSync(tmpPath, filePath)
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

    appendFileSync(logFile, JSON.stringify(logEntry) + '\n')
  }
}

export const dataService = new DataService()
