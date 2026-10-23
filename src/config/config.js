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
    dailyMinutes: 120, // 每个地址每天累计使用上限（分钟）
    checkIntervalMs: 60000, // 超时检查间隔（毫秒）
  },
  // ---- v1.4 凭证体系（2026-10-19）：DID 普通凭证 / CWT 解除凭证，一地址一条互斥 ----
  credential: {
    enabled: true,
    // relay：公共档案读（免签）+ 档案写（multipart，带用户插件的文件签）
    relayBaseURL: 'https://ipfsserver.ccda.ooo',
    apiBase: '/v0/api/ipfs',
    chain: 'swtc',
    // 判权顺序预算（2026-10-23 用户定式："先跑档案，出错跑台账"）：enter 对
    // claimed 卡同步等档案活验结论的上限；超预算不拖登录——落台账结论，后台
    // 核验照跑照落库。relay resolve 冷启动实测 2.7s 级常态，5s 覆盖尾部。
    enterVerifyBudgetMs: 5000,
    profileProbeTimeoutMs: 8000, // 实测 resolve 冷启动 2.7s 级常态，3s 会误判"没档案"
    profileProbeCacheMs: 900000,
    // 平台签发钥与公共档案：VC proof 用 @jccdex/did SDK 真签（EcdsaSecp256k1Signature2019）
    keyFile: 'data/keys/issuer.key',
    profileFile: 'data/keys/issuer-profile.json',
    contextFile: 'data/keys/secp256k1-2019-v1.json',
    // 无 DID 档案时的用户指引（务必提醒核对地址）
    didGenUrl: 'https://app.ccda.ooo/#/',
    // VC issuer 展示名（2026-10-23 用户实测：官网删卡弹窗读 issuer.name 显示签发方，
    // 纯 DID 字符串=空白）——mintVC 经 SDK issuerObject 槽注入 {id,name}
    platformName: 'DSH 平台',
    // 旧版 CWT registry（解除限制白名单）：命中=直接签发 CWT 凭证
    legacyFile: 'data/legacy-cwt.json',
    exemptCacheMs: 60000,
    vcNamespace: 'urn:dshm-test:credential',
  },
  // v1.5 刀5B·准入闸（凭证即准入，V3.1 定式）：建容器与网关导航须持台账有效凭证。
  // credential=did|cwt 任一有效即进（默认；admin=cwt+roles 天然在内）；
  // license=仅 cwt/admin 可进（did 拒，运营备用方向）；off=全放行（灰度逃生门）。
  accessGate: {
    mode: 'credential',
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
    // 租户隔离网络（2026-10 审计 CRITICAL）：所有租户容器落这张
    // enable_icc=false 的自定义 bridge——容器间数据面丢弃、宿主回环映射
    // 不受影响（default bridge 上租户 shell 可直连他人 3080 绕过网关）。
    tenantNetwork: 'dsh-tenant-net',
    // 租户容器安全参数档位（P1-6 降权第一阶段，2026-09）：
    //   auto   默认。首次供应容器前用 strict 参数跑一次 DSH 同款 bwrap 探测：
    //          通过 → 全租户用 strict；失败 → 回落 compat 并告警（结果缓存，
    //          镜像重建 clearCapabilityCache 或平台重启会重新判定）。
    //   strict 强制新参数组：保留 SYS_ADMIN + no-new-privileges + 白名单 seccomp
    //          （seccompProfilePath）。探测失败**不回退**、报错上抛——管理员
    //          显式选择，静默降级坏过好。
    //   compat 强制旧参数组：SYS_ADMIN + seccomp=unconfined + apparmor=unconfined
    //          （2026-09-22 之前的行为，应急回退开关）。
    privilegeProfile: 'auto',
    // 白名单 seccomp profile 的宿主机路径（由 Docker daemon 读取，不是容器内）。
    // 默认指向仓库内 deploy/ 文件，rsync 部署随代码走；daemon 读不到时
    // auto 自动降级 compat。
    seccompProfilePath: join(ROOT, 'deploy', 'seccomp-bwrap-minimal.json'),
    // 资源预检（F1，2026-09 磁盘防复发方案）：
    // minFreeBytes：Docker 数据分区的可用空间阈值。旧值写死 2GB 且查的是
    //   `df -k /`——Linux 上 /var/lib/docker 独立挂载时查错分区（disk-fix
    //   缺口 C）。现改查 DockerRootDir 所在分区，阈值默认提到 4GB 留缓冲。
    // preflightMode：warn=预检不拦截只记日志（上线观察期默认，行为=历史）；
    //   enforce=不足时拒绝供应并入等待队列。环境变量 DSH_PREFLIGHT_MODE 可临时覆盖。
    minFreeBytes: 4 * 1024 * 1024 * 1024,
    preflightMode: 'warn',
    // 磁盘维护定时器（F3，disk-fix）：周期回收悬空镜像/构建缓存，防累积再满盘。
    // 红线写在 maintenance.service.js 顶部并被单测锁定：永不 volume prune、
    // 永不 image prune -a、builder 必带 --keep-storage、构建窗口互斥。
    maintenance: {
      enabled: true, // false=定时器全停（只留预检与告警面）；env DSH_MAINTENANCE_ENABLED 可应急覆盖
      keepCache: '4GB', // builder prune --keep-storage
      lowFreeBytes: 4 * 1024 * 1024 * 1024, // 低盘告警阈值（挂 5min 磁盘采集，红条+日志列可回收 top-N）
      fstrim: true, // 仅 Docker Desktop 生效的 TRIM 回吐（Linux 删即释放，自动跳过）
    },
  },
  dsh: {
    // 镜像内 DSH 版本的升级/回退管理
    buildContext: '.', // 构建上下文（相对启动目录）；平台自己构建镜像时用
    allowLocalBuild: true, // 允许平台执行 docker build（需要源码树在场）
    // 这里曾有一个 allowPull（「允许 docker pull 现成镜像」）开关，但平台
    // **根本没有 pull 逻辑**（只有构建），没有任何代码读取它，已删除。
    registry: 'https://registry.npmjs.org', // npm registry（版本列表来源）
    versionCacheTtlMs: 600000, // 版本列表缓存 10 分钟（网络调用，不宜每次请求都打）
    npmTimeoutMs: 20000, // npm view 超时
    npmCacheDir: '', // npm view 的缓存目录；留空则自动选可写目录（默认 data/npm-cache）
    // 注意：这里曾有一个 allowPrerelease 开关，但它**从未被任何代码读取**
    // （版本列表始终同时返回 stable 与 prerelease，由前端统一展示）——
    // 留着会让人以为改它能过滤版本，已删除。真要过滤请在 dsh-version.service
    // 的 _fetchFromRegistry 之后加过滤。
    authActivateTimeoutMs: 8000, // DSH 浏览器认证「代激活」请求超时（毫秒）
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
  storage: {
    // 业务数据存储介质。见 docs/storage-design.md（MongoDB 集中存储，9 集合合同）。
    // provider：'json'=维持现状（文件，默认）；'mongodb'=迁入 Mongo。
    // D5 灰度：本地验证通过后手动切 'mongodb'，服务器本期不部署。
    provider: 'json',
    // 连接串。环境变量 MONGODB_URI 优先于此（部署侧注入凭据，不入仓库）。
    // 本地专用单成员副本集（27018，独立 dbpath，与 brew 服务隔离）。
    mongodbUri: 'mongodb://127.0.0.1:27018/?replicaSet=dsh-rs',
    dbName: 'dsh', // 测试库由 globalSetup 覆盖为 dsh_test
    // 事务必须副本集；裸 standalone 下 withTransaction 直接报错（见设计 §5.2 R1）。
    txnRetries: 3, // withTransaction 冲突重试上限
    connectTimeoutMs: 5000,
    archiveAfterMigration: true, // 迁移后 data/+state.json 保留归档（D3，不自动删）
  },
}

/**
 * 递归深合并（2026-10 审计）：旧实现 `{ ...DEFAULTS, ...config }` 是**浅**合并——
 * config.json 只要写 `usageLimit: { enabled: true }`，DEFAULTS.usageLimit 整段
 * （dailyMinutes/checkIntervalMs…）就被替换蒸发，功能随"半个配置"悄悄失灵
 * （privilegeProfile/minFreeBytes 等同理）。深合并让"部分覆盖"回归直觉：
 * 用户没写的子键保留默认。数组按整体替换（宿主列表等语义本就显式）。
 */
function deepMerge(base, over) {
  if (over === undefined) return base
  if (Array.isArray(over)) return over.slice()
  if (over === null || typeof over !== 'object') return over
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return deepMerge({}, over)
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v)
  return out
}

export function loadConfig() {
  let merged = DEFAULTS
  try {
    if (existsSync(CONFIG_FILE)) {
      const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
      merged = deepMerge(DEFAULTS, config)
    }
  } catch (err) {
    console.error(`[config] Failed to load config.json: ${err.message}, using defaults`)
    merged = DEFAULTS
  }
  // storage.mongodbUri：env MONGODB_URI 覆盖 config.json（部署侧注入凭据，不入仓库）。
  // env DSH_STORAGE_PROVIDER 可临时切介质（灰度/回退应急开关）。
  const uri = process.env.MONGODB_URI
  const prov = process.env.DSH_STORAGE_PROVIDER
  if (uri || prov) {
    merged = { ...merged, storage: { ...merged.storage } }
    if (uri) merged.storage.mongodbUri = uri
    if (prov === 'json' || prov === 'mongodb') merged.storage.provider = prov
  }
  return merged
}

export function getConfig() {
  return loadConfig()
}

/** mongodb 形态注入的 admin.json 地址权威（小写 Set）；null=json 文件直读 */
let ADMIN_JSON_OVERRIDE = null
export function setAdminAddressesOverride(addresses) {
  ADMIN_JSON_OVERRIDE = addresses
    ? new Set([...addresses].map((a) => String(a).toLowerCase()))
    : null
}

export function getAdminAddresses() {
  const config = loadConfig()
  const addresses = new Set((config.admin?.addresses || []).map((addr) => addr.toLowerCase()))

  // admin.json 部分（提权操作写入的位置）：mongodb 形态下由 dataService
  // 注入【进程内权威缓存】（水合/保存时更新，热路径提权判定零磁盘 I/O；
  // override 已小写化）；json 形态逐调用原样读文件，行为零变化。
  if (ADMIN_JSON_OVERRIDE) {
    ADMIN_JSON_OVERRIDE.forEach((addr) => addresses.add(addr))
  } else {
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

// ★存储护栏（2026-10-16 生产事故根修）：测试进程读本地 config.json（provider=mongodb），
// 凡未 mock storage 的测试就会拿 fixture 内存对生产库做 fanoutOps —— $unset 凭证账本、
// deleteMany 多行；服务端再加载被污染快照并反向固化，对账器把真卡当无主摘架。
// 6 处 provider 分叉拦不住漏网之鱼，在唯一出口整体降档：测试进程永不碰生产库。
if (
  (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') &&
  CONFIG.storage?.provider === 'mongodb'
) {
  CONFIG.storage = { ...(CONFIG.storage || {}), provider: 'json' }
  // eslint-disable-next-line no-console
  console.warn('[config] 测试进程护栏：storage 已由 mongodb 降档为 json（生产库保护）')
}
export { ROOT, CONFIG_FILE, deepMerge as _deepMergeForTest }
