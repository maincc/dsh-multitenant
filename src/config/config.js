/**
 * 配置管理模块
 * 从 config.json 加载配置，提供默认值
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)))
const CONFIG_FILE = join(ROOT, 'config.json')
const ADMIN_FILE = join(ROOT, 'data', 'config', 'admin.json')

const DEFAULTS = {
  server: { port: 8090, publicHost: '127.0.0.1' },
  cleanup: {
    stopTimeoutMs: 900000, // 15 分钟
    destroyTimeoutMs: 3600000, // 1 小时
    checkIntervalMs: 300000, // 5 分钟
    activityWindowMs: 180000, // 会话文件多久没写入视为内部空闲（3 分钟）
    processBaseline: 2, // docker top 进程数超过此值视为有外部程序在跑（基础进程数 1 + 1）
    stopGraceSeconds: 60, // 停止容器前的 SIGTERM 宽限秒数
  },
  resource: {
    monitorIntervalMs: 30000,
    autoUpgradeThreshold: 80,
  },
  tiers: {
    1: { label: '基础', memory: '512m', memorySwap: '1g', cpus: '1.0', pids: 256 },
    2: { label: '增强', memory: '1g', memorySwap: '2g', cpus: '2.0', pids: 512 },
    3: { label: '高性能', memory: '2g', memorySwap: '4g', cpus: '4.0', pids: 1024 },
  },
  docker: {
    image: 'dsh-multitenant:latest',
    basePort: 31000,
    maxPort: 65535,
    startupTimeoutMs: 120000,
  },
  admin: { addresses: [] },
}

export function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
      return { ...DEFAULTS, ...config }
    }
  } catch (err) {
    console.error(`[config] Failed to load config.json: ${err.message}, using defaults`)
  }
  return DEFAULTS
}

export function getConfig() {
  return loadConfig()
}

export function getAdminAddresses() {
  const config = loadConfig()
  const addresses = new Set((config.admin?.addresses || []).map((addr) => addr.toLowerCase()))

  // 同时从 data/config/admin.json 读取（提权操作写入的位置）
  try {
    if (existsSync(ADMIN_FILE)) {
      const adminConfig = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'))
      if (adminConfig.addresses) {
        adminConfig.addresses.forEach((addr) => addresses.add(addr.toLowerCase()))
      }
    }
  } catch {
    // 忽略读取错误
  }

  return addresses
}

export function isAdmin(address) {
  return getAdminAddresses().has(address.toLowerCase())
}

export function getTierLimits(tier) {
  const config = loadConfig()
  return config.tiers[tier] || config.tiers[1]
}

export const CONFIG = loadConfig()
export { ROOT, CONFIG_FILE }
