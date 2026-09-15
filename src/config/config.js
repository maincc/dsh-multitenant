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
  usageLimit: {
    enabled: true, // 每日使用时限开关
    dailyMinutes: 120, // 每个地址每天累计使用上限（分钟），CWT 授权用户豁免
    checkIntervalMs: 60000, // 超时检查间隔（毫秒）
  },
  cwt: {
    enabled: true, // CWT 申请-审批-出示体系开关
    ttlMs: 300000, // 出示 token 全局时效（±5 分钟，双向）
    allowCwtEnt: false, // CWT_ENT 组形态预留，本期关闭
  },
  skills: {
    autoInvoke: false, // 市场技能默认禁止模型自动调用（P0-4：安装到用户卷时强制
    // disable-model-invocation: true，除非本配置开启）
  },
  resource: {
    monitorIntervalMs: 30000,
    autoUpgradeThreshold: 80, // 内存使用率超过此值自动升一级配额（百分比）
    autoUpgradeCooldownMs: 600000, // 自动升级后冷却期（毫秒），防止反复升级重启
    diskCheckIntervalMs: 300000, // 磁盘使用采集间隔（宿主 + docker + 租户卷，毫秒）
  },
  tiers: {
    1: { label: '基础', memory: '512m', disk: '1g', cpus: '1.0', pids: 256 },
    2: { label: '增强', memory: '1g', disk: '2g', cpus: '2.0', pids: 512 },
    3: { label: '高性能', memory: '2g', disk: '4g', cpus: '4.0', pids: 1024 },
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

/**
 * 读取指定 tier 配额。配额仅由 config.json 管理（管理端只读展示，
 * 不支持运行时修改，避免误填/越权）；改配额 = 编辑 config.json + 重启服务。
 */
export function getTierLimits(tier) {
  const config = loadConfig()
  return config.tiers[tier] || config.tiers[1]
}

export const CONFIG = loadConfig()
export { ROOT, CONFIG_FILE }
