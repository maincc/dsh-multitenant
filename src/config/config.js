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
  dsh: {
    // 镜像内 DSH 版本的升级/回退管理
    buildContext: '.', // 构建上下文（相对启动目录）；平台自己构建镜像时用
    allowLocalBuild: true, // 允许平台执行 docker build（需要源码树在场）
    allowPull: true, // 允许 docker pull 现成镜像
    registry: 'https://registry.npmjs.org', // npm registry（版本列表来源）
    versionCacheTtlMs: 600000, // 版本列表缓存 10 分钟（网络调用，不宜每次请求都打）
    npmTimeoutMs: 20000, // npm view 超时
    npmCacheDir: '', // npm view 的缓存目录；留空则自动选可写目录（默认 data/npm-cache）
    allowPrerelease: false, // 默认不展示 rc/alpha；前端可显式请求包含
    // 版本切换前卷快照目录。默认放在平台自己的 data/ 下：它由运行用户创建，
    // 必然可写。原来的 /backup/dsh-multitenant 在多机部署里更合适，但在"普通用户
    // 直接跑在宿主机"的形态下根目录无权创建 → 备份 EPERM → 更新必然失败。
    // 要放独立备份盘/共享存储，在这里或 config.json 里显式指定即可。
    backupDir: join(ROOT, 'data', 'backups'),
    backupBeforeApply: true, // 应用镜像/切换版本前强制备份租户卷
  },
  admin: {
    addresses: [],
    // 管理端列表页的自动刷新间隔（毫秒）。只在前台可见时轮询：切到后台会停、
    // 回到前台立即刷一次、切 tab 也立即刷一次。
    // 15000 = 15 秒（默认）；想更省可填 300000（5 分钟），此时靠手动「刷新」补实时性。
    refreshIntervalMs: 15000,
    // 列表接口的服务端短缓存（毫秒）：多个管理员/多个标签页共享一次 docker 采样，
    // 避免「每个标签页各自每 15 秒」把 docker CLI 打爆。
    // 任何状态写入都会立即失效它（见 user.service 的 _saveState）。
    usersCacheTtlMs: 3000,
  },
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
