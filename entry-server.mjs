#!/usr/bin/env node
/**
 * ============================================================================
 *  dsh-multitenant 入口服务（兼容层）
 * ============================================================================
 *  本文件保留作为向后兼容，实际逻辑已迁移到 src/server.js
 *  运行方式：
 *    node entry-server.mjs    # 旧方式（兼容）
 *    node src/server.js       # 新方式（推荐）
 *    npm start                # 新方式（推荐）
 * ============================================================================
 */

// 重定向到新的模块化服务器
import('./src/server.js').catch(err => {
  console.error('[fatal] Failed to start modular server:', err)
  process.exit(1)
})


// ---------------------------------------------------------------- 常量区 ---
// 所有路径都基于本脚本所在目录解析，保证从任意工作目录启动都正确。

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url))) // 项目根目录
const PATCHES_DIR = join(ROOT, 'patches')   // 每个租户生成的 cordis patch 存放处
const STATE_FILE = join(ROOT, 'state.json') // 用户 -> 端口映射的持久化状态
const CONFIG_FILE = join(ROOT, 'config.json') // 配置文件
const FRONTEND_DIST = join(ROOT, 'frontend', 'dist') // Vue 前端构建产物

// ---- 加载配置文件 ----
function loadConfig() {
  const defaults = {
    server: { port: 8090, publicHost: '127.0.0.1' },
    cleanup: { stopTimeoutMs: 900000, destroyTimeoutMs: 3600000, checkIntervalMs: 300000 },
    resource: { monitorIntervalMs: 30000, autoUpgradeThreshold: 80 },
    tiers: {
      1: { label: '基础', memory: '512m', memorySwap: '1g', cpus: '1.0', pids: 256 },
      2: { label: '增强', memory: '1g', memorySwap: '2g', cpus: '2.0', pids: 512 },
      3: { label: '高性能', memory: '2g', memorySwap: '4g', cpus: '4.0', pids: 1024 },
    },
    docker: { image: 'dsh-multitenant:latest', basePort: 31000, maxPort: 65535, startupTimeoutMs: 120000 },
  }
  try {
    if (existsSync(CONFIG_FILE)) {
      const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
      return { ...defaults, ...config }
    }
  } catch (err) {
    console.error(`[config] Failed to load config.json: ${err.message}, using defaults`)
  }
  return defaults
}

const CONFIG = loadConfig()

// ---- SWTC 地址校验 ----
// 井通地址格式：以 j 开头，30-35 位 base58 字符（字母数字，不含 0OIl）
// 示例：jGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or
function isValidSwtcAddress(addr) {
  // 允许小写 l，因为前端会统一转小写后再发送
  // base58 原本排除 l，但为了兼容小写存储，这里放宽限制
  return /^j[1-9A-HJ-NP-Za-km-zl]{29,34}$/.test(addr)
}

// SWTC 地址转容器名：直接用地址（Docker 允许字母数字）
// 但为了与旧的 UUID 容器区分，加前缀 dsh-swtc-
function swtcContainerName(address) {
  return `dsh-swtc-${address.toLowerCase()}`
}

function swtcVolumeName(address) {
  return `dsh-data-swtc-${address.toLowerCase()}`
}

// ---- 可用环境变量（均可在启动时覆盖，见 README.md）----
const IMAGE = process.env.DSH_TENANT_IMAGE || CONFIG.docker.image
const BASE_PORT = Number(process.env.BASE_PORT || CONFIG.docker.basePort)
const MAX_PORT = CONFIG.docker.maxPort
const STARTUP_TIMEOUT_MS = Number(process.env.STARTUP_TIMEOUT_MS || CONFIG.docker.startupTimeoutMs)
const PUBLIC_HOST = process.env.PUBLIC_HOST || CONFIG.server.publicHost

// ---- 资源配额层级（从配置文件加载）----
const TIER_LIMITS = CONFIG.tiers
const DEFAULT_TIER = 1
const MONITOR_INTERVAL_MS = CONFIG.resource.monitorIntervalMs
const AUTO_UPGRADE_THRESHOLD = CONFIG.resource.autoUpgradeThreshold

// ---- 管理员权限验证 ----
// 管理员地址列表统一用小写（因为 state.json 的 key 也是小写）
const ADMIN_ADDRESSES = new Set((CONFIG.admin?.addresses || []).map(addr => addr.toLowerCase()))

function isAdmin(address) {
  return ADMIN_ADDRESSES.has(address.toLowerCase())
}

function getAdminSession(req) {
  // 从 Cookie 或 Header 中获取管理员会话
  const cookie = req.headers.cookie || ''
  const match = cookie.match(/admin_session=([^;]+)/)
  return match ? match[1] : null
}

function requireAdmin(req, res) {
  const session = getAdminSession(req)
  if (!session || !isAdmin(session)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: '需要管理员权限' }))
    return false
  }
  return true
}

// 额外信任的浏览器 authority（host 或 host:port，逗号分隔），会写进每个租户的
// DSH /api 浏览器信任篱笆（trustedHosts）。局域网/公网访问时必须把对外地址加进来。
const PUBLIC_TRUST = (process.env.PUBLIC_TRUST || '')
  .split(',').map(s => s.trim()).filter(Boolean)
// 注入到每个租户容器的环境变量名列表（逗号分隔，值取自宿主机同名变量）。
// 仅作开发便利（例如把宿主的 DEEPSEEK_API_KEY 带进容器）；多租户生产环境
// 应让每个用户在 UI 里填自己的密钥，不要用共享密钥。
const INJECT_ENV = (process.env.INJECT_ENV || '')
  .split(',').map(s => s.trim()).filter(Boolean)

mkdirSync(PATCHES_DIR, { recursive: true }) // 确保 patches 目录存在

// ------------------------------------------------------------------ 工具函数 ---

/**
 * 封装 execFile 为 Promise。
 * 统一处理 docker CLI 的 stdout/stderr，出错时把两者附加到 Error 对象上，
 * 便于上层输出可读的错误信息（docker 的报错主要在 stderr）。
 */
function sh(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout ?? '')
        err.stderr = String(stderr ?? '')
        reject(err)
      } else {
        resolvePromise(String(stdout ?? '').trim())
      }
    })
  })
}

/**
 * 从磁盘加载 state.json。
 * 文件不存在或损坏时回退到空状态（swtcUsers 为空，nextPort 从 BASE_PORT 开始）。
 * nextPort 是"确定性端口分配"的关键：新用户从它开始取端口，取完 +1 并持久化，
 * 这样即使入口服务重启也不会重复分配端口。
 */
function loadState() {
  const defaults = {
    swtcUsers: {},
    nextPort: BASE_PORT,
    cleanupPolicy: {
      stopTimeoutMs: CONFIG.cleanup.stopTimeoutMs,
      destroyTimeoutMs: CONFIG.cleanup.destroyTimeoutMs,
      checkIntervalMs: CONFIG.cleanup.checkIntervalMs,
    },
  }
  if (!existsSync(STATE_FILE)) return defaults
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (typeof s.nextPort !== 'number') s.nextPort = BASE_PORT
    if (!s.cleanupPolicy) {
      s.cleanupPolicy = {
        stopTimeoutMs: CONFIG.cleanup.stopTimeoutMs,
        destroyTimeoutMs: CONFIG.cleanup.destroyTimeoutMs,
        checkIntervalMs: CONFIG.cleanup.checkIntervalMs,
      }
    }
    if (!s.swtcUsers) s.swtcUsers = {}
    return s
  } catch {
    return defaults
  }
}

/** 把状态写回磁盘（每次变更后立即落盘，避免进程崩溃丢失分配记录）。 */
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
}

// 进程级状态：启动时从磁盘加载，运行中常驻内存，变更即落盘。
const state = loadState()

/**
 * 查询容器实际映射到宿主的端口。
 * 通过 `docker inspect` 读取 NetworkSettings.Ports，正则提取 3080/tcp 对应的
 * 宿主端口。为什么不用我们分配时记下的端口？因为容器可能是外部（手动）创建
 * 或入口服务重启后恢复的，实际端口以 docker 的权威数据为准。
 * @returns {Promise<number|null>} 端口号；容器不存在/无法读取时返回 null
 */
async function publishedPort(container) {
  try {
    const out = await sh('docker', ['inspect', '--format', '{{range $p, $c := .NetworkSettings.Ports}}{{$p}}={{$c}}{{end}}', container])
    const m = out.match(/3080\/tcp=\[?\{?0\.0\.0\.0 (\d+)|3080\/tcp=(\d+)/)
    if (m) return Number(m[1] || m[2])
  } catch { /* container gone：当作无法读取 */ }
  return null
}

/**
 * 轮询等待租户 DSH Web 就绪。
 * DSH 首次启动要做初始化（生成 profile、storages 等），可能耗时较长，
 * 因此每 500ms 探测一次首页，直到返回 2xx 或超时。
 */
async function waitReady(port, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) return true
    } catch { /* 还没起来，继续等 */ }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

/**
 * 生成某个租户的 cordis patch 内容（写入 patches/<id>.yml 并挂载进容器）。
 *
 * patch 语义：cordis 的 patch 是【按 id 整行替换 config】，不是合并，
 * 所以这里必须把被覆盖行需要的全部字段写全：
 *  - webserver  行：完整覆盖 host/port（容器内监听 0.0.0.0:3080）
 *  - web-runtime 行：完整覆盖 printUrl/surfaceContext/trustedHosts。
 *    trustedHosts 是 DSH /api 的浏览器信任篱笆，必须包含用户浏览器实际访问的
 *    authority（host:port）。因为端口是动态分配的，所以必须由入口服务按端口生成。
 */
function tenantPatch(port) {
  const trusted = [`127.0.0.1:${port}`, `localhost:${port}`, ...PUBLIC_TRUST]
  return `# Generated by dsh-multitenant entry server for tenant ${port}.\n` +
    `- id: webserver\n` +
    `  config:\n` +
    `    host: '0.0.0.0'\n` +
    `    port: 3080\n` +
    `- id: web-runtime\n` +
    `  config:\n` +
    `    printUrl: true\n` +
    `    surfaceContext: true\n` +
    `    trustedHosts: [${trusted.map(t => JSON.stringify(t)).join(', ')}]\n`
}

// --------------------------------------------------------- 容器管理（核心） ---

/**
 * 查询容器是否存在及其运行状态。
 * docker inspect 失败（容器不存在）时返回 { exists: false }。
 */
async function containerInfo(name) {
  try {
    const out = await sh('docker', ['inspect', '--format', '{{.State.Status}}', name])
    return { exists: true, status: out }
  } catch {
    return { exists: false, status: 'missing' }
  }
}

/** 强制删除容器（保留数据卷）。入口服务当前未使用，保留供运维/脚本调用。 */
async function removeContainer(name) {
  try { await sh('docker', ['rm', '-f', name]) } catch { /* already gone */ }
}

/**
 * 两阶段清理：空闲容器先停止，长时间停止后销毁（保留数据卷）
 * - 阶段1：空闲超过 stopTimeoutMs（15分钟）→ 停止容器
 * - 阶段2：停止超过 destroyTimeoutMs（1小时）→ 销毁容器（保留数据卷）
 */
async function cleanupIdleContainers() {
  const now = Date.now()
  let changed = false

  for (const [address, user] of Object.entries(state.swtcUsers || {})) {
    const idle = now - user.lastSeenAt
    const name = swtcContainerName(address)
    const status = user.containerStatus ?? 'running'

    // 阶段1：运行中的容器空闲超过阈值 → 停止
    if (status === 'running' && idle > state.cleanupPolicy.stopTimeoutMs) {
      try {
        await sh('docker', ['stop', name])
        user.containerStatus = 'stopped'
        user.stoppedAt = now
        const idleMin = (idle / 60000).toFixed(0)
        console.log(`[cleanup] stopped idle container: ${address} (idle ${idleMin}min)`)
        changed = true
      } catch (err) {
        if (String(err.stderr).includes('No such container')) {
          user.containerStatus = 'destroyed'
          changed = true
        } else {
          console.error(`[cleanup] failed to stop ${address}:`, err.message)
        }
      }
    }
    // 阶段2：停止的容器超过阈值 → 销毁（保留数据卷）
    else if (status === 'stopped') {
      const stoppedDuration = now - (user.stoppedAt || user.lastSeenAt)
      if (stoppedDuration > state.cleanupPolicy.destroyTimeoutMs) {
        try {
          await sh('docker', ['rm', name])
          user.containerStatus = 'destroyed'
          const stoppedMin = (stoppedDuration / 60000).toFixed(0)
          console.log(`[cleanup] destroyed stopped container: ${address} (stopped ${stoppedMin}min, data preserved)`)
          changed = true
        } catch (err) {
          if (String(err.stderr).includes('No such container')) {
            user.containerStatus = 'destroyed'
            changed = true
          } else {
            console.error(`[cleanup] failed to destroy ${address}:`, err.message)
          }
        }
      }
    }
  }

  if (changed) {
    saveState(state)
  }
}

/** 启动清理定时器（每 checkIntervalMs 检查一次不活跃容器）。 */
function startCleanupTimer() {
  setInterval(cleanupIdleContainers, state.cleanupPolicy.checkIntervalMs)
  const checkMin = (state.cleanupPolicy.checkIntervalMs / 60000).toFixed(0)
  const stopMin = (state.cleanupPolicy.stopTimeoutMs / 60000).toFixed(0)
  const destroyMin = (state.cleanupPolicy.destroyTimeoutMs / 60000).toFixed(0)
  console.log(`[cleanup] timer started: check every ${checkMin}min, stop after ${stopMin}min idle, destroy after ${destroyMin}min stopped`)
}

/**
 * 确保 SWTC 地址对应的容器存在并运行，返回其宿主端口。
 * 
 * 地址统一用小写作为唯一标识（state.json 的 key、Docker 容器名都用小写）
 */
async function ensureSwtcContainer(address) {
  // 统一转小写
  address = address.toLowerCase()
  const name = swtcContainerName(address)
  const volume = swtcVolumeName(address)

  // 1) 容器已存在：启动（若停止）→ 读取实际端口 → 等待就绪
  const info = await containerInfo(name)
  if (info.exists) {
    if (info.status !== 'running') await sh('docker', ['start', name])
    const port = await publishedPort(name)
    if (port === null) throw new Error(`SWTC container ${name} has no readable port mapping`)
    return await finalizeSwtcTenant(address, name, port)
  }

  // 2) 容器不存在：创建新容器
  let port = state.swtcUsers?.[address]?.port ?? state.nextPort ?? BASE_PORT
  const tier = state.swtcUsers?.[address]?.tier ?? DEFAULT_TIER
  const limits = TIER_LIMITS[tier]
  
  for (let attempt = 0; attempt < 64; attempt++) {
    if (attempt > 0) port = port + 1
    if (port > MAX_PORT) throw new Error(`exhausted host port range for SWTC tenant ${address}`)

    const patchFile = join(PATCHES_DIR, `swtc-${address.toLowerCase()}.yml`)
    writeFileSync(patchFile, tenantPatch(port))

    const args = [
      'run', '-d', '--name', name,
      '--restart', 'unless-stopped',
      // 资源限制
      '--memory', limits.memory,
      '--memory-swap', limits.memorySwap,
      '--cpus', limits.cpus,
      '--pids-limit', String(limits.pids),
      // 端口和卷
      '-p', `${port}:3080`,
      '-v', `${volume}:/dsh-home`,
      '-v', `${patchFile}:/patches/tenant.patch.yml:ro`,
    ]
    for (const kv of INJECT_ENV) {
      const [k] = kv.split('=')
      if (process.env[k]) args.push('-e', `${k}=${process.env[k]}`)
    }
    args.push(IMAGE)

    try {
      await sh('docker', args)
      state.nextPort = Math.max(state.nextPort ?? BASE_PORT, port + 1)
      return await finalizeSwtcTenant(address, name, port)
    } catch (err) {
      const msg = String(err.stderr)
      if (msg.includes('already in use')) {
        const info2 = await containerInfo(name)
        if (info2.exists) {
          if (info2.status !== 'running') await sh('docker', ['start', name])
          const p2 = await publishedPort(name)
          if (p2 !== null) return await finalizeSwtcTenant(address, name, p2)
        }
        continue
      }
      if (msg.includes('port is already allocated')) continue
      throw err
    }
  }
  throw new Error(`could not allocate a host port for SWTC tenant ${address}`)
}

/**
 * SWTC 租户收尾：写入 state.swtcUsers 并等待容器就绪。
 */
async function finalizeSwtcTenant(address, name, port) {
  if (!state.swtcUsers) state.swtcUsers = {}
  const tier = state.swtcUsers[address]?.tier ?? DEFAULT_TIER
  state.swtcUsers[address] = {
    ...(state.swtcUsers[address] ?? {}),
    port,
    tier,  // 资源配额层级
    createdAt: state.swtcUsers[address]?.createdAt ?? Date.now(),
    lastSeenAt: Date.now(),
    containerStatus: 'running',
  }
  saveState(state)
  const ready = await waitReady(port)
  if (!ready) {
    throw new Error(`SWTC container ${name} did not become ready on port ${port} within ${STARTUP_TIMEOUT_MS}ms`)
  }
  return port
}

/**
 * 获取容器资源使用统计
 */
async function getContainerStats(containerName) {
  try {
    const out = await sh('docker', ['stats', '--no-stream', '--format', 
      '{"cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","memPercent":"{{.MemPerc}}","net":"{{.NetIO}}","block":"{{.BlockIO}}"}',
      containerName])
    return JSON.parse(out)
  } catch {
    return null
  }
}

/**
 * 动态调整容器资源配额（需要重启容器才能生效）
 */
async function upgradeContainer(address, tier) {
  if (!TIER_LIMITS[tier]) throw new Error(`Invalid tier: ${tier}`)
  
  const name = swtcContainerName(address)
  const limits = TIER_LIMITS[tier]
  const info = await containerInfo(name)
  
  if (!info.exists) throw new Error(`Container ${name} not found`)
  
  // 先停止容器
  if (info.status === 'running') {
    await sh('docker', ['stop', name])
  }
  
  // 更新容器配置
  await sh('docker', ['update',
    '--memory', limits.memory,
    '--memory-swap', limits.memorySwap,
    '--cpus', limits.cpus,
    '--pids-limit', String(limits.pids),
    name
  ])
  
  // 重新启动容器
  await sh('docker', ['start', name])
  
  // 更新状态（保留所有现有字段）
  if (!state.swtcUsers) state.swtcUsers = {}
  state.swtcUsers[address] = {
    ...(state.swtcUsers[address] ?? {}),
    tier,
    lastUpgradeAt: Date.now(),
    containerStatus: 'running',
    lastSeenAt: Date.now(),
  }
  saveState(state)
  
  console.log(`[upgrade] ${address} upgraded to tier ${tier} (${limits.label}), container restarted`)
  return { tier, limits }
}

/**
 * 监控容器资源使用，自动扩容
 */
async function monitorContainerResources() {
  if (!state.swtcUsers) return
  
  for (const [address, user] of Object.entries(state.swtcUsers)) {
    if (user.containerStatus !== 'running') continue
    
    const stats = await getContainerStats(swtcContainerName(address))
    if (!stats) continue
    
    const memPercent = parseFloat(stats.memPercent)
    const currentTier = user.tier ?? DEFAULT_TIER
    
    // 自动扩容：内存使用 > 80% 且当前是 Tier 1
    if (memPercent > AUTO_UPGRADE_THRESHOLD && currentTier === 1) {
      console.log(`[monitor] ${address} memory ${memPercent.toFixed(1)}%, auto-upgrading to tier 2`)
      try {
        await upgradeContainer(address, 2)
      } catch (err) {
        console.error(`[monitor] failed to upgrade ${address}:`, err.message)
      }
    }
  }
}

/**
 * 启动资源监控定时器
 */
function startResourceMonitor() {
  setInterval(monitorContainerResources, MONITOR_INTERVAL_MS)
  console.log(`[monitor] resource monitor started: check every ${(MONITOR_INTERVAL_MS/1000).toFixed(0)}s, auto-upgrade at ${AUTO_UPGRADE_THRESHOLD}% memory`)
}

/**
 * 入口服务启动时调用：从现有 SWTC 容器重建内存状态。
 */
async function restoreSwtcFromDocker() {
  let names = []
  try {
    names = (await sh('docker', ['ps', '-a', '--filter', 'name=dsh-swtc-', '--format', '{{.Names}}']))
      .split('\n').filter(Boolean)
  } catch { return }
  for (const name of names) {
    const address = name.replace(/^dsh-swtc-/, '').toLowerCase()
    if (!isValidSwtcAddress(address)) continue
    const port = await publishedPort(name)
    if (port === null) continue
    
    // 从 Docker 容器检查实际配额
    let actualTier = 1
    try {
      const inspect = await sh('docker', ['inspect', name])
      const info = JSON.parse(inspect)[0]
      const memory = info.HostConfig?.Memory || 0
      const nanoCPUs = info.HostConfig?.NanoCPUs || 0
      
      // 根据实际配额反推 tier
      if (memory >= 2147483648 || nanoCPUs >= 4000000000) {
        actualTier = 3  // 高性能：2GiB, 4核
      } else if (memory >= 1073741824 || nanoCPUs >= 2000000000) {
        actualTier = 2  // 增强：1GiB, 2核
      } else {
        actualTier = 1  // 基础：512MiB, 1核
      }
    } catch (err) {
      console.warn(`[restore] failed to inspect ${name}:`, err.message)
    }
    
    if (!state.swtcUsers) state.swtcUsers = {}
    const savedTier = state.swtcUsers[address]?.tier
    
    // 保留已有字段（tier、createdAt 等），只更新端口和状态
    // 如果 state 中没有 tier，使用从 Docker 检查到的实际 tier
    // 如果 state 中的 tier 与 Docker 实际配额不匹配，以 state 为准，并更新 Docker 容器
    const targetTier = savedTier ?? actualTier
    state.swtcUsers[address] = {
      ...(state.swtcUsers[address] ?? {}),
      port,
      tier: targetTier,
      createdAt: state.swtcUsers[address]?.createdAt ?? Date.now(),
      lastSeenAt: state.swtcUsers[address]?.lastSeenAt ?? Date.now(),
      containerStatus: 'running',
    }
    
    // 如果 state 中的 tier 与 Docker 实际配额不匹配，更新 Docker 容器
    if (savedTier && savedTier !== actualTier) {
      console.log(`[restore] ${address} tier mismatch: state=${savedTier}, docker=${actualTier}, updating docker to tier ${targetTier}`)
      try {
        const limits = TIER_LIMITS[targetTier]
        await sh('docker', ['update',
          '--memory', limits.memory,
          '--memory-swap', limits.memorySwap,
          '--cpus', limits.cpus,
          '--pids-limit', String(limits.pids),
          name
        ])
        console.log(`[restore] ${address} docker updated to tier ${targetTier}`)
      } catch (err) {
        console.error(`[restore] failed to update ${name}:`, err.message)
      }
    }
    
    state.nextPort = Math.max(state.nextPort ?? BASE_PORT, port + 1)
  }
  saveState(state)
}

// --------------------------------------------------------- 静态文件服务 ---

/**
 * 提供 Vue 前端静态文件服务
 * - 对于 /assets/* 等静态资源，直接返回文件
 * - 对于前端路由（/, /admin, /user 等），返回 index.html（SPA fallback）
 */
function serveStaticFile(filePath, res) {
  const ext = filePath.split('.').pop().toLowerCase()
  const mimeTypes = {
    'html': 'text/html; charset=utf-8',
    'js': 'application/javascript; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
  }
  const contentType = mimeTypes[ext] || 'application/octet-stream'
  
  try {
    const content = readFileSync(filePath)
    res.writeHead(200, { 'content-type': contentType })
    res.end(content)
    return true
  } catch {
    return false
  }
}

/**
 * 处理前端路由：返回 index.html（SPA fallback）
 */
function serveFrontend(res) {
  const indexPath = join(FRONTEND_DIST, 'index.html')
  if (serveStaticFile(indexPath, res)) {
    return true
  }
  // 如果 dist 不存在，返回简单提示
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><body>
    <h1>前端未构建</h1>
    <p>请先运行: <code>cd frontend && npm install && npm run build</code></p>
  </body></html>`)
  return true
}

// --------------------------------------------------------------- HTTP 路由 ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  // ---- GET /health：健康检查（容器编排/监控用）----
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // ---- API 路由（供 Vue 前端调用）----
  
  // POST /api/admin/login - 管理员登录
  if (path === '/api/admin/login' && req.method === 'POST') {
    const body = await new Promise(resolve => {
      let data = ''
      req.on('data', chunk => data += chunk)
      req.on('end', () => resolve(data))
    })
    const { address } = JSON.parse(body || '{}')
    if (!address || !isValidSwtcAddress(address)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid SWTC address' }))
      return
    }
    // 统一转小写
    const addrLower = address.toLowerCase()
    if (!isAdmin(addrLower)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: '不是管理员地址' }))
      return
    }
    // 设置管理员会话 Cookie（用小写）
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `admin_session=${addrLower}; path=/; max-age=86400; httponly`
    })
    res.end(JSON.stringify({ ok: true, address: addrLower, isAdmin: true }))
    return
  }

  // GET /api/admin/check - 检查管理员权限
  if (path === '/api/admin/check') {
    const session = getAdminSession(req)
    const isAdm = session && isAdmin(session)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ isAdmin: isAdm, address: session || null }))
    return
  }

  // POST /api/admin/promote/:address - 提权用户为管理员
  if (path.startsWith('/api/admin/promote/') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    let address = path.slice(19)
    if (!isValidSwtcAddress(address)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid SWTC address' }))
      return
    }
    // 统一转小写
    address = address.toLowerCase()
    // 添加到管理员列表（运行时）
    ADMIN_ADDRESSES.add(address)
    console.log(`[admin] promoted ${address} to admin`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, address, promoted: true }))
    return
  }

  // GET /api/users - 获取所有用户列表（Admin 用）
  if (path === '/api/users') {
    if (!requireAdmin(req, res)) return
    const users = await Promise.all(
      Object.entries(state.swtcUsers || {}).map(async ([address, user]) => {
        const stats = user.containerStatus === 'running' 
          ? await getContainerStats(swtcContainerName(address))
          : null
        return {
          address,
          port: user.port,
          tier: user.tier ?? DEFAULT_TIER,
          tierLabel: TIER_LIMITS[user.tier ?? DEFAULT_TIER]?.label ?? '基础',
          status: user.containerStatus ?? 'running',
          createdAt: user.createdAt,
          lastSeenAt: user.lastSeenAt,
          idle: Date.now() - user.lastSeenAt,
          isAdmin: isAdmin(address),
          stats: stats ? {
            cpu: stats.cpu,
            memory: stats.mem,
            memoryPercent: stats.memPercent,
          } : null,
        }
      })
    )
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ users, tiers: TIER_LIMITS }))
    return
  }

  // GET /api/user/:address - 获取单个用户详情
  if (path.startsWith('/api/user/')) {
    let address = path.slice(10)
    if (!isValidSwtcAddress(address)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid SWTC address' }))
      return
    }
    // 统一转小写
    address = address.toLowerCase()
    // 权限验证：用户可以查看自己的信息，管理员可以查看所有
    const session = getAdminSession(req)
    const isAdm = session && isAdmin(session)
    // 如果没有 session 且不是管理员，允许访问（前端会处理）
    // 只有当有 session 且不是自己也不是管理员时才拒绝
    if (session && session !== address && !isAdm) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: '无权查看其他用户信息' }))
      return
    }
    const user = state.swtcUsers?.[address]
    if (!user) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'User not found' }))
      return
    }
    const stats = user.containerStatus === 'running'
      ? await getContainerStats(swtcContainerName(address))
      : null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      address,
      port: user.port,
      tier: user.tier ?? DEFAULT_TIER,
      tierLabel: TIER_LIMITS[user.tier ?? DEFAULT_TIER]?.label ?? '基础',
      tierLimits: TIER_LIMITS[user.tier ?? DEFAULT_TIER],
      status: user.containerStatus ?? 'running',
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
      idle: Date.now() - user.lastSeenAt,
      isAdmin: isAdmin(address),
      stats: stats ? {
        cpu: stats.cpu,
        memory: stats.mem,
        memoryPercent: stats.memPercent,
      } : null,
    }))
    return
  }

  // POST /api/upgrade/:address - 升级用户配额（需要管理员权限）
  if (path.startsWith('/api/upgrade/') && req.method === 'POST') {
    if (!requireAdmin(req, res)) return
    let address = path.slice(13)
    if (!isValidSwtcAddress(address)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid SWTC address' }))
      return
    }
    // 统一转小写
    address = address.toLowerCase()
    const user = state.swtcUsers?.[address]
    if (!user) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'User not found' }))
      return
    }
    // 读取请求体
    const body = await new Promise(resolve => {
      let data = ''
      req.on('data', chunk => data += chunk)
      req.on('end', () => resolve(data))
    })
    const { tier } = JSON.parse(body || '{}')
    if (!tier || !TIER_LIMITS[tier]) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid tier' }))
      return
    }
    try {
      const result = await upgradeContainer(address, tier)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // GET /api/stats - 系统统计
  if (path === '/api/stats') {
    const users = state.swtcUsers || {}
    const totalUsers = Object.keys(users).length
    const runningUsers = Object.values(users).filter(u => u.containerStatus === 'running').length
    const tierCounts = { 1: 0, 2: 0, 3: 0 }
    Object.values(users).forEach(u => {
      const tier = u.tier ?? DEFAULT_TIER
      tierCounts[tier] = (tierCounts[tier] || 0) + 1
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      totalUsers,
      runningUsers,
      tierCounts,
      tiers: TIER_LIMITS,
    }))
    return
  }

  // ---- GET /connect：CCDAO 插件连接端点（SWTC 地址作为用户标识）----
  // 用法：GET /connect?address=jGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or
  // 流程：验证地址 → 创建/恢复容器 → 302 跳转到专属端口
  if (path === '/connect') {
    let address = url.searchParams.get('address')
    if (!address || !isValidSwtcAddress(address)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Invalid SWTC address. Expected format: j... (30-35 chars)')
      return
    }
    // 统一转小写
    address = address.toLowerCase()
    try {
      const port = await ensureSwtcContainer(address)
      res.writeHead(302, { location: `http://${PUBLIC_HOST}:${port}/` })
      res.end()
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`SWTC tenant provisioning failed: ${err.message}\n${err.stderr ?? ''}`)
    }
    return
  }

  // ---- GET /connect-status：检查 SWTC 地址的容器状态（JSON）----
  if (path === '/connect-status') {
    let address = url.searchParams.get('address')
    if (!address || !isValidSwtcAddress(address)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid SWTC address' }))
      return
    }
    // 统一转小写
    address = address.toLowerCase()
    const user = state.swtcUsers?.[address]
    if (!user) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ exists: false, address }))
      return
    }
    const idle = Date.now() - user.lastSeenAt
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      exists: true,
      address,
      port: user.port,
      status: user.containerStatus ?? 'running',
      idleMs: idle,
      idleHuman: idle < 60000 ? `${Math.floor(idle/1000)}s` : idle < 3600000 ? `${Math.floor(idle/60000)}min` : `${(idle/3600000).toFixed(1)}h`,
    }))
    return
  }

  // ---- GET /leave/<address>：显式销毁指定 SWTC 用户的容器（保留数据卷）----
  if (path.startsWith('/leave/')) {
    let address = decodeURIComponent(path.slice(7))
    if (!isValidSwtcAddress(address)) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('Invalid SWTC address')
      return
    }
    // 统一转小写
    address = address.toLowerCase()
    const user = state.swtcUsers?.[address]
    if (!user) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('User not found')
      return
    }
    try {
      const name = swtcContainerName(address)
      try { await sh('docker', ['stop', name]) } catch {}
      try { await sh('docker', ['rm', name]) } catch {}
      user.containerStatus = 'destroyed'
      saveState(state)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, address, status: 'destroyed', volume: swtcVolumeName(address) }))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`failed to destroy container: ${err.message}`)
    }
    return
  }

  // ---- 静态文件服务（Vue 前端）----
  
  // 静态资源（/assets/*, /favicon.ico 等）
  if (path.startsWith('/assets/') || path === '/favicon.ico') {
    const filePath = join(FRONTEND_DIST, path)
    if (serveStaticFile(filePath, res)) {
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found')
    return
  }

  // ---- SPA 路由 fallback：所有其他路径返回 index.html ----
  // 前端路由：/, /admin, /user, /user/:address 等
  serveFrontend(res)
})

// ---- 启动 ----
const PORT = Number(process.env.PORT || 8090)
server.listen(PORT, '0.0.0.0', async () => {
  await restoreSwtcFromDocker() // 恢复 SWTC 地址租户容器
  startCleanupTimer()           // 启动两阶段清理定时器
  startResourceMonitor()        // 启动资源监控定时器
  console.log(`[dsh-multitenant] entry server on http://127.0.0.1:${PORT}/`)
  console.log(`[dsh-multitenant] tenant image: ${IMAGE}, host: ${PUBLIC_HOST}, ports from ${BASE_PORT}`)
  console.log(`[dsh-multitenant] Frontend: http://127.0.0.1:${PORT}/`)
  console.log(`[dsh-multitenant] Admin: http://127.0.0.1:${PORT}/admin`)
  console.log(`[dsh-multitenant] User: http://127.0.0.1:${PORT}/user`)
  console.log(`[dsh-multitenant] API endpoints: /api/users, /api/user/:address, /api/upgrade/:address, /api/stats`)
})
