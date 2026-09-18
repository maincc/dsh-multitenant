/**
 * 用户服务模块
 * 管理用户状态、容器生命周期
 */

import { join, resolve } from 'node:path'
import {
  mkdirSync,
  statSync,
  writeFileSync,
  existsSync,
  readFileSync,
  accessSync,
  constants,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG, getTierLimits, isAdmin } from '../config/config.js'
import { dockerService } from './docker.service.js'
import { dataService } from './data.service.js'
import { cwtStore } from './cwt.store.js'
import { tenantGateway } from './tenant-proxy.service.js'
// 代激活 cookie 缓存（check-rpc 的 /api 调用也要带上，否则新版会 401）
import { authCookieCache } from './dsh-auth.service.js'
import { swtcContainerName, swtcVolumeName, normalizeAddress } from '../utils/address.js'
import { NotFoundError, BadRequestError, ConflictError } from '../utils/errors.js'

const execFileAsync = promisify(execFile)
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PATCHES_DIR = join(ROOT, 'patches')

/**
 * 版本切换前卷快照的默认目录（平台自有、运行用户必然可写）。
 *
 * 真实故障：内置默认是 `/backup/dsh-multitenant`（为多机部署/独立备份盘设计），
 * 但在"平台以普通用户直接跑在宿主机"的常见形态下 `/backup` 根本不存在且根目录
 * 需要 root 才能创建 → 备份目录 EPERM → **「更新」按钮必然失败**（用户实测：
 * `✗ 备份目录不可用 /backup/dsh-multitenant: EPERM`）。
 *
 * 安全语义不变：备份依旧"失败即中止，绝不在没有退路的情况下动容器"，只是把
 * 退路放在平台自己管得着的地方，而不是一个可能要 root 才能创建的绝对路径。
 * 想放到独立备份盘/共享存储，改 config.json 的 dsh.backupDir 即可。
 */
const DEFAULT_BACKUP_DIR = join(ROOT, 'data', 'backups')

/**
 * 确认备份目录可用并返回最终路径。
 *
 * 顺序：显式配置 > 平台 data/backups。
 * 配置的目录不可写时**自动降级**到 data/backups 并显著告警，而不是让「更新」
 * 直接失败——对一个"保护性"步骤来说，换到可写的位置比拒绝执行更有价值。
 *
 * @returns {{ dir: string, fallbackFrom: string|null }}
 */
function ensureBackupDir() {
  const configured = CONFIG.dsh?.backupDir
  const candidates = configured ? [configured, DEFAULT_BACKUP_DIR] : [DEFAULT_BACKUP_DIR]
  let lastErr = null

  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      return { dir, fallbackFrom: lastErr ? candidates[0] : null }
    } catch (err) {
      if (!lastErr) lastErr = err
    }
  }

  // 连平台自有目录都建不了（只读文件系统等）→ 此时必须明确报错
  throw new Error(`备份目录不可用 ${candidates.join(' / ')}: ${lastErr?.message ?? '未知错误'}`)
}

/**
 * 判断"能否在这个路径下创建目录"，**不产生任何副作用**。
 *
 * 做法：向上找到最近的已存在祖先，检查它是否可写（`accessSync(W_OK)`）。
 * 这与真正 `mkdirSync` 的成败高度一致（权限/只读文件系统），同时不会像
 * `mkdirSync` 那样真的把目录建出来 —— 预览必须零副作用。
 *
 * @param {string} dir
 * @returns {string|null} 可用返回 null，否则返回原因
 */
function checkDirWritable(dir) {
  let cur = resolve(dir)
  for (;;) {
    if (existsSync(cur)) {
      try {
        accessSync(cur, constants.W_OK)
        return null
      } catch (err) {
        return err.message
      }
    }
    const parent = resolve(cur, '..')
    if (parent === cur) return `路径不存在且无法回溯到可写祖先: ${dir}`
    cur = parent
  }
}

/**
 * 只探测备份目录是否可用，不创建任何目录（供 dryRun 预览报告）。
 * @returns {{ dir: string|null, ok: boolean, fallbackFrom: string|null, error: string|null }}
 */
function probeBackupDir() {
  const configured = CONFIG.dsh?.backupDir

  // 未显式配置 → 平台自有目录（必然随 data/ 可写）
  if (!configured) {
    const err = checkDirWritable(DEFAULT_BACKUP_DIR)
    return err
      ? { dir: null, ok: false, fallbackFrom: null, error: `${DEFAULT_BACKUP_DIR}: ${err}` }
      : { dir: DEFAULT_BACKUP_DIR, ok: true, fallbackFrom: null, error: null }
  }

  const configuredErr = checkDirWritable(configured)
  if (!configuredErr) {
    return { dir: configured, ok: true, fallbackFrom: null, error: null }
  }

  // 配置的目录不可写 → 报告"会降级"，让管理员提前知道（而不是等更新时才发现）
  const fallbackErr = checkDirWritable(DEFAULT_BACKUP_DIR)
  return fallbackErr
    ? {
        dir: null,
        ok: false,
        fallbackFrom: null,
        error: `${configured}: ${configuredErr}（备用目录 ${DEFAULT_BACKUP_DIR} 也不可用：${fallbackErr}）`,
      }
    : {
        dir: DEFAULT_BACKUP_DIR,
        ok: true,
        fallbackFrom: configured,
        error: null,
      }
}

/**
 * 当前要使用的 patch 目录。
 *
 * 生产上恒为 `<repo>/patches`。测试通过 `patchDirForTest` 指向临时目录，
 * 避免像 restContainer 这样的用例去动仓库里的真实 patch 文件。
 */
let patchDirForTest = null
/** @internal 仅供测试：把 patch 目录临时指向别处；传 null 还原 */
export function setPatchDirForTest(dir) {
  patchDirForTest = dir || null
}
function patchesDir() {
  return patchDirForTest ?? PATCHES_DIR
}
const SCRIPTS_DIR = join(ROOT, 'src', 'services')
/** 等待队列上限与过期时间（security-hardening-plan P0-3） */
const WAIT_QUEUE_MAX = 500
const WAIT_QUEUE_STALE_MS = 60 * 60 * 1000
// 确保 patches 目录存在（旧版入口在启动时创建，模块化版需自行保证）
mkdirSync(patchesDir(), { recursive: true })

/** 租户卷内 DSH 凭据文件（损坏会让 DSH 拒绝启动） */
const CREDENTIALS_BASENAME = '.credentials.yaml'

/**
 * 判断一次启动失败是否由**凭据文件损坏**引起。
 *
 * 用 DSH 自己的报错当判据（生产依赖里没有 YAML 库，写不出等价的解析器；
 * DSH 的 credentials-local 才是权威）。必须同时命中文件名与错误类型，
 * 否则会把 OOM、端口占用等无关故障误判成"凭据坏了" —— 那会白白隔离掉
 * 用户已保存的 API Key。
 * @param {string} text 诊断文本（containerDiagnostics 的输出）
 * @returns {boolean}
 */
function isCredentialsCorruption(text) {
  const s = String(text || '')
  if (!s.includes(CREDENTIALS_BASENAME)) return false
  return /invalid document|credentials-local|failed to parse/i.test(s)
}

/** 本地日期 YYYY-MM-DD（每日限时按此重置） */
function todayStr() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export class UserService {
  constructor() {
    this.state = dataService.loadState()
    this.state.usages = this.state.usages || {} // 每日使用时长记录 { address: { date, minutes } }
    // 注：CWT 数据（cwtRegistry / cwtApplications / cwtRecords）已迁移到 data/cwt/，
    // 由 cwtStore 管理，不再写入 state.json
    this.waitQueue = [] // 等待队列
  }

  /**
   * 分配宿主内部回环端口（40000-49999 随机，避开已占用）。
   * 内部端口只绑 127.0.0.1，对外进路由网关（tenantGateway）代理。
   * @param {Set<number>} [exclude] 本次分配过程要排除的端口（重试时避免拿到同一个）
   */
  allocateInternalPort(exclude = new Set()) {
    const used = new Set(exclude)
    for (const u of Object.values(this.state.swtcUsers || {})) {
      if (u?.internalPort) used.add(u.internalPort)
    }
    for (let i = 0; i < 300; i++) {
      const p = 40000 + Math.floor(Math.random() * 10000)
      if (!used.has(p)) {
        used.add(p)
        return p
      }
    }
    throw new Error('no internal port available')
  }

  /**
   * 资源预检
   * 检查是否有足够资源创建新容器
   */
  async preflightCheck() {
    const checks = {
      ports: false,
      memory: false,
      disk: false,
      containers: false,
    }

    // 1. 检查端口（含可按需征用的 destroyed 闲置端口，避免僵尸占用导致误报耗尽）
    const availablePorts = this.state.availablePorts?.length ?? 0
    const nextPort = this.state.nextPort ?? CONFIG.docker.basePort
    checks.ports =
      availablePorts > 0 || nextPort < CONFIG.docker.maxPort || this.hasReclaimablePorts()

    // 2. 检查主机内存（需要至少 512MB 可用）
    try {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'hw.memsize'])
      const totalMemory = parseInt(stdout.trim(), 10)
      const { stdout: vmStats } = await execFileAsync('sysctl', ['-n', 'vm.vm_stats'])
      // 简化检查：如果总内存 > 8GB，认为足够
      checks.memory = totalMemory > 8 * 1024 * 1024 * 1024
    } catch {
      checks.memory = true // 无法检查时假设足够
    }

    // 3. 检查磁盘空间（需要至少 2GB 可用）
    try {
      const { stdout } = await execFileAsync('df', ['-k', '/'])
      const lines = stdout.trim().split('\n')
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/)
        const availableKB = parseInt(parts[3], 10)
        checks.disk = availableKB > 2 * 1024 * 1024 // 2GB
      } else {
        checks.disk = true
      }
    } catch {
      checks.disk = true
    }

    // 4. 检查容器数量（最多 50 个）
    try {
      const containers = await dockerService.listSwtcContainers()
      checks.containers = containers.length < 50
    } catch {
      checks.containers = true
    }

    const failed = Object.entries(checks)
      .filter(([_, v]) => !v)
      .map(([k]) => k)

    return {
      ok: failed.length === 0,
      checks,
      failed,
    }
  }

  /**
   * 添加到等待队列（security-hardening-plan P0-3：上限 + 过期淘汰，防无界内存增长）
   */
  addToWaitQueue(address, tier = 1) {
    this.pruneWaitQueue()
    // 检查是否已在队列中
    const existing = this.waitQueue.find((item) => item.address === address)
    if (existing) {
      return {
        position: this.waitQueue.indexOf(existing) + 1,
        alreadyInQueue: true,
      }
    }

    if (this.waitQueue.length >= WAIT_QUEUE_MAX) {
      return { position: -1, full: true, alreadyInQueue: false }
    }

    const item = {
      address,
      tier,
      timestamp: Date.now(),
      status: 'waiting',
    }
    this.waitQueue.push(item)
    return {
      position: this.waitQueue.length,
      alreadyInQueue: false,
    }
  }

  /**
   * 淘汰过期等待项（超过 1 小时仍未创建则移出队列）
   */
  pruneWaitQueue() {
    const now = Date.now()
    this.waitQueue = this.waitQueue.filter((item) => now - item.timestamp < WAIT_QUEUE_STALE_MS)
  }

  /**
   * 从等待队列移除
   */
  removeFromWaitQueue(address) {
    const index = this.waitQueue.findIndex((item) => item.address === address)
    if (index !== -1) {
      this.waitQueue.splice(index, 1)
      return true
    }
    return false
  }

  /**
   * 获取队列中的位置
   */
  getQueuePosition(address) {
    const index = this.waitQueue.findIndex((item) => item.address === address)
    if (index === -1) return null
    return {
      position: index + 1,
      total: this.waitQueue.length,
      timestamp: this.waitQueue[index].timestamp,
    }
  }

  /**
   * 处理等待队列
   * 尝试为队列中的用户创建容器
   */
  async processWaitQueue() {
    if (this.waitQueue.length === 0) return []

    const processed = []
    const check = await this.preflightCheck()

    if (!check.ok) {
      console.log(`[queue] Resources still insufficient: ${check.failed.join(', ')}`)
      return processed
    }

    // 处理队列中的第一个用户
    const next = this.waitQueue.shift()
    if (next) {
      try {
        console.log(`[queue] Processing ${next.address} (tier ${next.tier})`)
        await this.ensureContainer(next.address)
        next.status = 'completed'
        processed.push(next)
        console.log(`[queue] Successfully created container for ${next.address}`)
      } catch (err) {
        console.error(`[queue] Failed to create container for ${next.address}:`, err.message)
        next.status = 'failed'
        next.error = err.message
        processed.push(next)
      }
    }

    return processed
  }

  /**
   * 重启容器（用于安装插件后重启 DSH 服务）
   */
  async restartContainer(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const info = await dockerService.containerInfo(name)

    // 容器不在了 ≠ 报错（线上故障：「重启 DSH」抛 Container ... not found）。
    // 界面停留期间清理定时器可能把已停止 >60min 的容器销毁（或有人手工
    // docker rm）—— 状态漂移。用户点"重启"的意图是"让我的 DSH 跑起来"，
    // 所以这里降级为"启动"：委托 ensureContainer（停止→start、缺失→重建，
    // 且沿用该租户 pinnedImage）。数据卷一直保留，重建是无损的。
    if (!info.exists) {
      if (!this.state.swtcUsers?.[address]) {
        // 平台没有这个租户的任何记录：不能凭空给未知地址造容器
        throw new NotFoundError(`租户不存在: ${address}`)
      }
      console.warn(`[restart] ${address.slice(0, 10)}… 容器不存在（状态漂移），降级为启动/重建`)
      const port = await this.ensureContainer(address)
      return { ok: true, recreated: true, port }
    }

    // 绑定挂载源必须是"文件"：若 patch 缺失/被误删，Docker 会把源补建成"目录"，
    // 挂载到镜像内的文件挂载点时报 exit 127（directory onto file，容器起不来）。
    // 这里用重启前的对外端口显式重建 patch 文件（避免再次启动失败）。
    //
    // 注意是**每次重启都重建**，不只是文件缺失时：patch 里的 trustedHosts 由
    // 当前 PUBLIC_HOST 推导，而 patch 是创建容器时烘死的（宿主机文件 bind-mount
    // 进容器 /patches/tenant.patch.yml，DSH 启动时读取）。改完 config.json 的
    // server.publicHost 后若不重建，容器仍只信任旧 IP：DSH 的 /api fence 对
    // "非回环且不在 trustedHosts"的 authority 直接 403（`forbidden`），表现为
    // directoryPicker 等宿主管道报 `transport failure ... HTTP 403`。
    // 详见 test/tenant-patch-refresh.test.js。
    const patchFile = join(patchesDir(), `swtc-${address}.yml`)
    const portForPatch = this.state.swtcUsers?.[address]?.port
    if (portForPatch != null) {
      let patchIsFile = false
      let current = null
      try {
        patchIsFile = statSync(patchFile).isFile()
      } catch {
        patchIsFile = false
      }
      if (patchIsFile) {
        try {
          current = readFileSync(patchFile, 'utf8')
        } catch {
          current = null
        }
      }
      const next = this.tenantPatch(portForPatch)
      if (next !== current) {
        mkdirSync(patchesDir(), { recursive: true })
        writeFileSync(patchFile, next)
        console.log(
          patchIsFile
            ? `[restart] ${address} refreshed patch (trustedHosts/publicHost) for :${portForPatch}`
            : `[restart] ${address} rebuilt missing/typed patch file for :${portForPatch}`,
        )
      }
    }

    // 重启容器
    await dockerService.restartContainer(name)

    // 等待容器就绪（实际宿主映射 = 内部回环端口）
    const internalPort = await dockerService.publishedPort(name)
    if (internalPort === null) {
      throw new Error(`Container ${name} has no port mapping after restart`)
    }

    // 更新状态
    if (!this.state.swtcUsers) this.state.swtcUsers = {}
    const port = this.state.swtcUsers[address]?.port ?? internalPort
    this.state.swtcUsers[address] = {
      ...(this.state.swtcUsers[address] ?? {}),
      port,
      internalPort,
      lastSeenAt: Date.now(),
      containerStatus: 'running',
    }
    dataService.saveState(this.state)

    // 等待容器完全就绪
    const ready = await dockerService.waitReady(internalPort, undefined, {
      containerName: name,
    })
    if (!ready) {
      // 自愈：凭据文件损坏就隔离后重启一次；其它原因带着现场原样上报
      const heal = await this._healStartupFailure(address, name, internalPort)
      if (!heal.ready) {
        throw new Error(`Container ${name} did not become ready after restart\n${heal.diagnostics}`)
      }
    }

    // 恢复网关监听（进程重启后外部端口需要重新接管）
    // bind 可能失败（端口被宿主其他程序占用）——必须上报，否则用户拿到连不上的 URL
    try {
      await tenantGateway.listen(
        port,
        internalPort,
        address,
        await this.resolveTenantCapability(address),
      )
    } catch (err) {
      throw new Error(`restart 后网关端口 ${port} 绑定失败：${err.message}`)
    }

    console.log(
      `[restart] ${address} container restarted successfully (gateway :${port} -> :${internalPort})`,
    )
    return { ok: true, address, port, status: 'restarted' }
  }

  /**
   * 启动时修复"patch 配置漂移"：让已有租户的 trustedHosts 跟上当前 PUBLIC_HOST。
   *
   * 为什么需要：patch 里的 trustedHosts 由 PUBLIC_HOST 推导，而它在**创建容器时**
   * 就烘死了（宿主机文件 bind-mount 进容器 /patches/tenant.patch.yml，DSH 启动时
   * 读取，实测**不会热重载**）。运维把 config.json 的 server.publicHost 从 .118 改成
   * .121 后，老容器仍只信任 .118 —— DSH 的 /api fence 对"非回环且不在 trustedHosts"
   * 的 authority 直接 403 `forbidden`，前端表现为
   *   client api: directoryPicker/list failed: transport failure ... HTTP 403
   * 而且这个错误只在用到宿主管道时暴露，普通页面照常打开，极难自查。
   *
   * 这里在启动时对比"磁盘上的 patch"与"按当前配置应生成的 patch"：
   *   - 有漂移 → 重写文件，并重启**正在运行**的容器让 DSH 重新读取；
   *   - 容器已停 → 只重写文件，等它下次启动自然生效（不在这里捞起来跑）。
   * 一个容器失败不影响其它租户，只记录可见的错误。
   *
   * @returns {Promise<{checked:number, refreshed:string[], failed:string[]}>}
   */
  async syncTenantPatches() {
    const users = this.state.swtcUsers ?? {}
    const addresses = Object.keys(users)
    const refreshed = []
    const failed = []

    for (const address of addresses) {
      const user = users[address]
      const port = user?.port
      if (port == null) continue

      const patchFile = join(patchesDir(), `swtc-${address}.yml`)
      const next = this.tenantPatch(port)
      let current = null
      try {
        current = readFileSync(patchFile, 'utf8')
      } catch {
        current = null
      }
      // 字符级比较：patch 是"当前配置的纯函数"，不一致就是漂移
      if (next === current) continue

      try {
        mkdirSync(patchesDir(), { recursive: true })
        writeFileSync(patchFile, next)
      } catch (err) {
        console.error(`[startup] ${address} 写 patch 失败:`, err.message)
        failed.push(address)
        continue
      }

      // 只有正在运行的容器才值得重启（停了的下次启动会读到新文件）
      const name = swtcContainerName(address)
      let running = false
      try {
        const info = await dockerService.containerInfo(name)
        running = info.exists && info.status === 'running'
      } catch {
        running = false
      }

      if (!running) {
        console.log(`[startup] ${address} patch 已刷新（容器未运行，下次启动生效）`)
        refreshed.push(address)
        continue
      }

      // 先把新 patch 落盘再重启：万一下面的重启抛错，状态也要如实记为"未生效"，
      // 否则 next === current 会让我们误以为已经修好（restartContainer 不写 state）。
      try {
        const prev = this.state.swtcUsers?.[address] ?? {}
        this.state.swtcUsers = this.state.swtcUsers ?? {}
        this.state.swtcUsers[address] = {
          ...prev,
          port,
          internalPort: prev.internalPort ?? null,
          containerStatus: 'running',
        }
        dataService.saveState(this.state)
      } catch (err) {
        console.error(`[startup] ${address} 保存状态失败:`, err.message)
      }

      try {
        console.log(
          `[startup] ${address} 检测到 patch 配置漂移（trustedHosts 跟不上 publicHost），重启容器使其生效`,
        )
        await this.restartContainer(address)
        refreshed.push(address)
      } catch (err) {
        console.error(`[startup] ${address} 漂移修复重启失败:`, err.message)
        failed.push(address)
      }
    }

    return { checked: addresses.length, refreshed, failed }
  }

  /**
   * 重置容器（删除数据卷并重建，放弃当前配置重新开始）
   */
  async resetContainer(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const volume = swtcVolumeName(address)
    const info = await dockerService.containerInfo(name)

    // 1. 停止并删除容器
    if (info.exists) {
      try {
        await dockerService.stopContainer(name)
      } catch {
        // ignore
      }
      try {
        await dockerService.removeContainer(name)
      } catch {
        // ignore
      }
    }

    // 2. 删除数据卷
    try {
      await dockerService.removeVolume(volume)
      console.log(`[reset] Volume ${volume} deleted`)
    } catch {
      // 卷可能不存在，忽略
    }

    // 3. 删除用户记录（保留端口分配）
    const user = this.state.swtcUsers?.[address]
    const port = user?.port
    const tier = user?.tier ?? 1

    // 重置 = 全新开始：结算并清除当日时长记录
    this.settleUsage(address)
    delete this.state.usages[address]

    if (this.state.swtcUsers?.[address]) {
      // 关闭旧网关监听（重置后内部端口会重新分配）
      if (this.state.swtcUsers[address].port) {
        tenantGateway.close(this.state.swtcUsers[address].port)
      }
      delete this.state.swtcUsers[address]
    }

    // 4. 回收端口
    if (port) {
      if (!this.state.availablePorts) this.state.availablePorts = []
      if (!this.state.availablePorts.includes(port)) {
        this.state.availablePorts.push(port)
        this.state.availablePorts.sort((a, b) => a - b)
      }
    }

    dataService.saveState(this.state)

    // 5. 立即重建全新容器（重置 = 清空后重新开始，一步到位；返回新端口供前端直接跳转）
    let newPort = null
    try {
      newPort = await this.ensureContainer(address)
      console.log(`[reset] ${address} fresh container rebuilt on port ${newPort}`)
    } catch (err) {
      console.error(`[reset] ${address} rebuild failed after reset:`, err.message)
      throw new Error(`容器已清空但重建失败：${err.message}`)
    }

    console.log(
      `[reset] ${address} container & volume deleted, port ${port} recycled, rebuilt on ${newPort}`,
    )
    return {
      ok: true,
      address,
      portRecycled: port,
      volumeDeleted: volume,
      port: newPort,
      rebuilt: true,
    }
  }

  /**
   * 每日使用时限配置（优先 state，回退 config.json）
   */
  usageLimitConfig() {
    return this.state?.usageLimit ?? CONFIG.usageLimit ?? {}
  }

  /**
   * CWT 授权用户豁免每日限时。
   * 判定：审批注册表（cwtStore，data/cwt/registry.json）status=approved 优先（权威）；
   * 其次兼容 swtcUsers 上的授权/验证时间戳字段。撤销（revoked）后不再豁免，冗余字段同步清除。
   */
  isUsageExempt(address) {
    const registry = cwtStore.getRegistry()[address]
    if (registry?.status === 'approved') return true
    const user = this.state.swtcUsers?.[address]
    return Boolean(user && (user.cwtAuthorizedAt || user.cwtVerifiedAt))
  }

  /**
   * 结算一段运行时长：把 usageStartedAt 累计进当日 usages，然后清零起点。
   * 所有"容器停止"路径都要调用，保证挂机时间也被准确结算。
   * @returns {number} 本次结算的分钟数
   */
  settleUsage(address) {
    const user = this.state.swtcUsers?.[address]
    const startedAt = user?.usageStartedAt
    if (!startedAt) return 0
    const today = todayStr()
    const rec = this.state.usages[address] || {}
    const prev = rec.date === today ? rec.minutes || 0 : 0
    const minutes = Math.floor((Date.now() - startedAt) / 60000)
    this.state.usages[address] = { date: today, minutes: prev + minutes }
    delete user.usageStartedAt
    return minutes
  }

  /**
   * 当日已用分钟（含当前运行段），跨日自动归零
   */
  getUsedMinutes(address) {
    const today = todayStr()
    const rec = this.state.usages[address]
    let minutes = rec && rec.date === today ? rec.minutes || 0 : 0
    const user = this.state.swtcUsers?.[address]
    if (user?.usageStartedAt) {
      minutes += Math.floor((Date.now() - user.usageStartedAt) / 60000)
    }
    return minutes
  }

  /**
   * 是否存在「容器已销毁（destroyed）但记录还占着端口」的闲置端口（可按需征用）
   */
  hasReclaimablePorts() {
    for (const user of Object.values(this.state.swtcUsers || {})) {
      if (user.containerStatus === 'destroyed' && user.port) return true
    }
    return false
  }

  /**
   * 端口耗尽时的按需征用：把 destroyed 租户闲置的端口收进回收池供新用户分配。
   * 被征用者下次连接时会重新分配新端口（端口号对用户透明，内部资产转移）。
   * 前提：destroyed 状态时网关监听已关闭（cleanup/destroy 路径已补 close），端口确实空闲。
   * @param {string} excludeAddress - 本次申请者自身（不征用自己的端口）
   * @returns {number} 征用到的端口数量
   */
  reclaimDestroyedPorts(excludeAddress) {
    if (!this.state.availablePorts) this.state.availablePorts = []
    let reclaimed = 0
    for (const [addr, user] of Object.entries(this.state.swtcUsers || {})) {
      if (!user?.port) continue
      if (addr === excludeAddress) continue
      if (user.containerStatus !== 'destroyed') continue
      if (this.state.availablePorts.includes(user.port)) continue
      this.state.availablePorts.push(user.port)
      reclaimed++
      console.log(
        `[port] reclaiming destroyed tenant ${addr.slice(0, 8)}...: port ${user.port} → pool`,
      )
      // 端口已被征用：该地址下次连接时重新分配新端口（记录里不再保留旧号）
      delete user.port
    }
    if (reclaimed > 0) {
      this.state.availablePorts.sort((a, b) => a - b)
      dataService.saveState(this.state)
    }
    return reclaimed
  }

  /**
   * 启动容器前的每日额度检查；超限抛 USAGE_LIMIT_REACHED（CWT 授权豁免、开关关闭则放行）
   */
  ensureUsageAllowed(address) {
    const cfg = this.usageLimitConfig()
    if (!cfg.enabled) return
    if (this.isUsageExempt(address)) return
    const limit = cfg.dailyMinutes
    if (!Number.isFinite(limit) || limit <= 0) return
    const used = this.getUsedMinutes(address)
    if (used >= limit) {
      const err = new Error(
        `今日使用时长已达上限（${limit} 分钟），请明日再试，或完成 CWT 验证解锁`,
      )
      err.code = 'USAGE_LIMIT_REACHED'
      err.usedMinutes = used
      err.dailyLimit = limit
      throw err
    }
  }

  /**
   * 定时检查：运行中的非豁免容器超限 → 优雅停止（结算后停）
   */
  async checkUsageLimitAndStop() {
    if (this._usageCheckRunning) return
    this._usageCheckRunning = true
    try {
      const cfg = this.usageLimitConfig()
      if (!cfg.enabled) return
      const limit = cfg.dailyMinutes
      if (!Number.isFinite(limit) || limit <= 0) return
      const grace =
        this.state.cleanupPolicy?.stopGraceSeconds ?? CONFIG.cleanup.stopGraceSeconds ?? 60
      let changed = false
      for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
        if (user.containerStatus !== 'running') continue
        if (this.isUsageExempt(address)) continue
        if (this.getUsedMinutes(address) < limit) continue
        // 超限：先结算本次运行段，再优雅停止
        this.settleUsage(address)
        const name = swtcContainerName(address)
        try {
          await dockerService.stopContainer(name, grace)
        } catch (err) {
          console.error(`[usage-limit] failed to stop ${name}:`, err.message)
          continue
        }
        user.containerStatus = 'stopped'
        user.stoppedAt = Date.now()
        changed = true
        console.log(
          `[usage-limit] ${address} reached ${limit}min daily limit, container stopped (grace ${grace}s)`,
        )
      }
      if (changed) dataService.saveState(this.state)
    } finally {
      this._usageCheckRunning = false
    }
  }

  /**
   * 资源监控：内存使用率超阈自动升级配额（升一级）
   *
   * 规则（config.json → resource）：
   *   - 仅检查 containerStatus === 'running' 的容器；
   *   - 读取 docker stats 的 memPercent，超过 autoUpgradeThreshold（默认 80%）→ 自动升一级 tier；
   *   - 已达最高 tier 不再升级；
   *   - 同一容器升级后进入冷却期（autoUpgradeCooldownMs，默认 10min），防止升级重启反复触发；
   *   - stats 读取失败（容器刚停/不存在）→ 跳过该容器，不报错。
   *
   * 防重入：_monitorRunning 标志（与 cleanup/usage-limit 同风格），
   * 本轮未结束的重复触发直接跳过。
   */
  async monitorResources() {
    if (this._monitorRunning) return
    this._monitorRunning = true
    try {
      const cfg = CONFIG.resource || {}
      const threshold = Number(cfg.autoUpgradeThreshold ?? 80)
      const cooldownMs = Number(cfg.autoUpgradeCooldownMs ?? 10 * 60 * 1000)
      if (!Number.isFinite(threshold) || threshold <= 0) return

      // 最高 tier（config.tiers 的最大 key）
      const maxTier = Object.keys(CONFIG.tiers || {})
        .map(Number)
        .filter(Number.isFinite)
        .reduce((m, t) => (t > m ? t : m), 1)

      let changed = false
      const now = Date.now()
      for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
        if (user.containerStatus !== 'running') continue
        const tier = user.tier ?? 1
        if (tier >= maxTier) continue
        // 冷却期内不重复升级
        if (user.lastAutoUpgradeAt && now - user.lastAutoUpgradeAt < cooldownMs) continue

        const name = swtcContainerName(address)
        let stats
        try {
          stats = await dockerService.getContainerStats(name)
        } catch {
          // stats 读取失败（容器刚停等）→ 跳过
          continue
        }
        if (!stats) continue

        // docker stats memPercent 形如 "12.34%"，parseFloat 取数值
        const memPercent = Number.parseFloat(String(stats.memPercent ?? ''))
        if (!Number.isFinite(memPercent) || memPercent < threshold) continue

        // 超阈：自动升一级
        const nextTier = tier + 1
        try {
          await this.upgradeContainer(address, nextTier)
          // 冷却标记（upgradeContainer 内部已 saveState，落盘由它完成）
          this.state.swtcUsers[address].lastAutoUpgradeAt = Date.now()
          changed = true
          console.log(
            `[monitor] ${address} memory ${memPercent.toFixed(1)}% >= ${threshold}%, auto-upgraded to tier ${nextTier}`,
          )
        } catch (err) {
          console.error(`[monitor] auto-upgrade failed for ${address}:`, err.message)
        }
      }
      if (changed) dataService.saveState(this.state)
    } finally {
      this._monitorRunning = false
    }
  }

  /**
   * 采集磁盘使用情况（宿主 + Docker 总体 + 租户数据卷），结果缓存到 this.diskUsage
   * 供 /api/stats 返回给管理面板展示；采集任一失败则该项为 null，不影响其他项。
   * 防重入：_diskCollectRunning 标志。
   */
  async collectDiskUsage() {
    if (this._diskCollectRunning) return
    this._diskCollectRunning = true
    try {
      const [host, docker, volumes] = await Promise.all([
        dockerService.hostDiskUsage(),
        dockerService.dockerDiskSummary(),
        dockerService.tenantVolumeUsage(),
      ])
      this.diskUsage = {
        collectedAt: Date.now(),
        host,
        docker,
        volumes,
      }
    } catch (err) {
      console.error('[disk] collect failed:', err.message)
      this.diskUsage = { collectedAt: Date.now(), host: null, docker: null, volumes: null }
    } finally {
      this._diskCollectRunning = false
    }
  }

  /**
   * 精确扫描：用 du 实测每个租户卷的真实占用（覆盖 docker system df 的
   * overlayfs 口径偏差），结果写入 this.diskUsage.volumes[i].sizeActual（字节数）。
   *
   * 设计取舍：
   *   - 引擎口径（collectDiskUsage）O(1) 可扩展，但 Docker Desktop overlayfs 下数值偏小；
   *   - du 实测准确但 O(n)（每卷起一次临时容器，~1s），卷多时不可进定时器热路径；
   *   - 因此扫描按需/低频执行：管理员手动触发（POST /api/admin/disk-scan）或
   *     每日自动快照（见 server.js startDiskMonitor）。
   *
   * 防重入：_volumeScanRunning 标志；卷数超过 maxVolumes 时跳过（保护宿主资源）。
   * @param {number} [maxVolumes] 单次扫描卷数上限，超出不扫描返回 false
   * @returns {Promise<boolean>} 是否执行了扫描
   */
  async scanVolumeUsage(maxVolumes = 50) {
    if (this._volumeScanRunning) return false
    const volumes = this.diskUsage?.volumes
    if (!Array.isArray(volumes) || volumes.length === 0) return false
    if (volumes.length > maxVolumes) {
      console.warn(
        `[disk] precise scan skipped: ${volumes.length} volumes exceed limit ${maxVolumes}`,
      )
      return false
    }
    this._volumeScanRunning = true
    try {
      console.log(`[disk] precise scan started: ${volumes.length} volumes (du)`)
      // 串行逐卷 du（避免同时起多个临时容器争抢宿主资源）
      for (const v of volumes) {
        const bytes = await dockerService.duVolumeSize(v.volume)
        if (bytes !== null) {
          v.sizeActual = bytes
          v.sizeActualAt = Date.now()
        }
      }
      this.diskUsage.preciseScannedAt = Date.now()
      console.log(`[disk] precise scan finished: ${volumes.length} volumes`)
      return true
    } catch (err) {
      console.error('[disk] precise scan failed:', err.message)
      return false
    } finally {
      this._volumeScanRunning = false
    }
  }

  /**
   * 用户主动停止自己的容器：结算当前运行段（保全每日额度），优雅停止
   */
  async stopContainerForUser(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const info = await dockerService.containerInfo(name)
    if (!info.exists) {
      // 状态漂移（清理定时器已销毁/手工 rm）：用户要的"停"已达成了。
      // 照常结算运行段（额度保全不能丢）并把状态对齐，绝不 404。
      this.settleUsage(address)
      const driftUser = this.state.swtcUsers?.[address]
      if (driftUser && driftUser.containerStatus !== 'destroyed') {
        driftUser.containerStatus = 'stopped'
        driftUser.stoppedAt = Date.now()
        dataService.saveState(this.state)
      }
      console.log(`[user-stop] ${address} container already absent (state aligned)`)
      return { ok: true, address, status: 'already_stopped' }
    }

    // 结算当前运行段：时间停在停止时刻，剩余额度保全
    this.settleUsage(address)

    if (info.status === 'running') {
      const grace =
        this.state.cleanupPolicy?.stopGraceSeconds ?? CONFIG.cleanup.stopGraceSeconds ?? 60
      await dockerService.stopContainer(name, grace)
    }

    const user = this.state.swtcUsers?.[address]
    if (user) {
      user.containerStatus = 'stopped'
      user.stoppedAt = Date.now()
      dataService.saveState(this.state)
    }
    console.log(`[user-stop] ${address} container stopped by user (data preserved)`)
    return { ok: true, address, status: 'stopped' }
  }

  /**
   * 强制下线容器（停止容器，保留数据卷）
   */
  async forceStopContainer(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const info = await dockerService.containerInfo(name)

    if (!info.exists) {
      // 漂移：容器本就不在，"强制下线"的目标状态已达成 —— 对齐状态即可。
      // （已销毁的记录别改回 stopped，否则会把清理定时器的结论覆盖掉）
      const driftUser = this.state.swtcUsers?.[address]
      if (driftUser && driftUser.containerStatus !== 'destroyed') {
        driftUser.containerStatus = 'stopped'
        driftUser.stoppedAt = Date.now()
        dataService.saveState(this.state)
      }
      return { ok: true, address, status: 'already_stopped' }
    }

    if (info.status === 'stopped' || info.status === 'exited') {
      // 已经停止了，直接更新状态
      if (this.state.swtcUsers?.[address]) {
        this.state.swtcUsers[address].containerStatus = 'stopped'
        dataService.saveState(this.state)
      }
      return { ok: true, address, status: 'already_stopped' }
    }

    // 停止容器
    await dockerService.stopContainer(name)

    // 结算本次运行段（管理端强停也计入当日时长）
    this.settleUsage(address)

    // 更新状态
    if (this.state.swtcUsers?.[address]) {
      this.state.swtcUsers[address].containerStatus = 'stopped'
      this.state.swtcUsers[address].stoppedAt = Date.now()
      dataService.saveState(this.state)
    }

    console.log(`[force-stop] ${address} container stopped by admin`)
    return { ok: true, address, status: 'stopped' }
  }

  /**
   * 删除用户数据卷（容器必须已停止并删除）
   */
  async deleteUserVolume(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const volume = swtcVolumeName(address)
    const info = await dockerService.containerInfo(name)

    // 如果容器还在运行，先停止
    if (info.exists && info.status === 'running') {
      await dockerService.stopContainer(name)
      console.log(`[delete-volume] ${address} container stopped before volume deletion`)
    }

    // 删除容器（如果存在）
    if (info.exists) {
      try {
        await dockerService.removeContainer(name)
        console.log(`[delete-volume] Container ${name} removed`)
      } catch (err) {
        throw new Error(`Failed to remove container: ${err.message}`)
      }
    }

    // 删除数据卷
    try {
      await dockerService.removeVolume(volume)
      console.log(`[delete-volume] Volume ${volume} deleted for ${address}`)
    } catch (err) {
      throw new Error(`Failed to delete volume: ${err.message}`)
    }

    // 更新状态：关闭网关监听 + 容器销毁
    if (this.state.swtcUsers?.[address]) {
      if (this.state.swtcUsers[address].port) {
        tenantGateway.close(this.state.swtcUsers[address].port)
      }
      this.state.swtcUsers[address].containerStatus = 'destroyed'
      delete this.state.swtcUsers[address].internalPort // 重建时会分配新的内部端口
      dataService.saveState(this.state)
    }

    return { ok: true, address, volumeDeleted: volume }
  }

  /**
   * 获取用户信息
   */
  /**
   * 判断该地址的容器是否已存在（/connect 所有权口径 B 用：
   * 已存在免签名直连，需要创建时才要求钱包签名）
   * @param {string} address
   * @returns {Promise<boolean>}
   */
  async containerExists(address) {
    const info = await dockerService.containerInfo(swtcContainerName(normalizeAddress(address)))
    return info.exists
  }

  async getUserInfo(address) {
    const user = this.state.swtcUsers?.[address]
    if (!user) throw new NotFoundError('User not found')

    const stats =
      user.containerStatus === 'running'
        ? await dockerService.getContainerStats(swtcContainerName(address))
        : null

    return {
      address,
      port: user.port,
      tier: user.tier ?? 1,
      tierLabel: getTierLimits(user.tier ?? 1)?.label ?? '基础',
      tierLimits: getTierLimits(user.tier ?? 1),
      status: user.containerStatus ?? 'running',
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
      idle: Date.now() - user.lastSeenAt,
      isAdmin: isAdmin(address),
      stats: stats
        ? {
            cpu: stats.cpu,
            memory: stats.mem,
            memoryPercent: stats.memPercent,
          }
        : null,
    }
  }

  /**
   * 获取所有用户列表
   */
  async getAllUsers() {
    const users = this.state.swtcUsers || {}

    // 检查 Docker 是否可用
    const dockerAvailable = await dockerService.isDockerAvailable()

    return Promise.all(
      Object.entries(users).map(async ([address, user]) => {
        let stats = null
        let actualStatus = user.containerStatus ?? 'unknown'

        // 只有 Docker 可用时才查询实时状态
        if (dockerAvailable && user.containerStatus === 'running') {
          stats = await dockerService.getContainerStats(swtcContainerName(address))
          // 如果获取 stats 失败，可能容器实际已停止
          if (!stats) {
            actualStatus = 'unknown'
          }
        } else if (!dockerAvailable) {
          // Docker 不可用，显示未知状态
          actualStatus = 'unknown'
        }

        return {
          address,
          port: user.port,
          tier: user.tier ?? 1,
          tierLabel: getTierLimits(user.tier ?? 1)?.label ?? '基础',
          status: actualStatus,
          // 管理员要看到"这个租户到底在跑哪个 DSH 版本"。
          // 优先问容器本身（真实值）；容器不在/exec 失败时退回创建时记录值。
          // 走 dockerService 的镜像 ID 缓存，同一镜像只 exec 一次。
          dshVersion:
            (await dockerService.containerDshVersion(swtcContainerName(address))) ??
            user.baseImageVersion ??
            null,
          createdAt: user.createdAt,
          lastSeenAt: user.lastSeenAt,
          lastAutoUpgradeAt: user.lastAutoUpgradeAt ?? null,
          idle: Date.now() - user.lastSeenAt,
          isAdmin: isAdmin(address),
          stats: stats
            ? {
                cpu: stats.cpu,
                memory: stats.mem,
                memoryPercent: stats.memPercent,
              }
            : null,
          dockerAvailable,
        }
      }),
    )
  }

  /**
   * 确保用户容器存在并运行
   * @param {boolean} skipQueueCheck - 跳过队列检查（队列处理时调用）
   */
  async ensureContainer(address, skipQueueCheck = false, image = null) {
    address = normalizeAddress(address)

    // 每日使用时限额度检查（CWT 授权用户豁免；超限抛 USAGE_LIMIT_REACHED）
    this.ensureUsageAllowed(address)

    const name = swtcContainerName(address)
    const volume = swtcVolumeName(address)

    // 1) 容器已存在：启动（若停止）→ 读取实际映射端口（内部回环）→ 等待就绪
    const info = await dockerService.containerInfo(name)
    if (info.exists) {
      if (info.status !== 'running') {
        await dockerService.startContainer(name)
        // 等待容器完全启动
        await new Promise((r) => setTimeout(r, 3000))
      }

      // 获取端口映射（可能需要重试）；宿主实际映射的就是内部回环端口
      let internalPort = await dockerService.publishedPort(name)

      // 如果端口映射丢失，尝试重启容器
      if (internalPort === null) {
        console.warn(`[user] Container ${name} has no port mapping, restarting...`)
        await dockerService.restartContainer(name)
        await new Promise((r) => setTimeout(r, 5000))
        internalPort = await dockerService.publishedPort(name)
      }

      if (internalPort === null) {
        throw new Error(`SWTC container ${name} has no readable port mapping`)
      }
      const port = this.state.swtcUsers?.[address]?.port ?? internalPort
      return await this.finalizeTenant(address, name, port, internalPort)
    }

    // 2) 资源预检（队列处理时跳过）
    if (!skipQueueCheck) {
      const check = await this.preflightCheck()
      if (!check.ok) {
        // 资源不足，添加到等待队列
        const tier = this.state.swtcUsers?.[address]?.tier ?? 1
        const queueResult = this.addToWaitQueue(address, tier)
        if (queueResult.full) {
          const error = new Error('等待队列已满，请稍后再试')
          error.code = 'QUEUE_FULL'
          throw error
        }
        const error = new Error('资源不足，已进入等待队列')
        error.code = 'RESOURCE_EXHAUSTED'
        error.queuePosition = queueResult.position
        error.failedResources = check.failed
        throw error
      }
    }

    // 3) 容器不存在：创建新容器
    //
    // 镜像优先级：显式传入 > 该租户钉住的镜像 > 平台默认（latest）。
    // 「钉住」必须在这里也生效：租户被销毁后下次连接会走这条路径重建，
    // 若忽略它，pin 会被悄悄重置回 latest —— 那这个功能就是假的。
    if (!image) {
      const pinned = this.state.swtcUsers?.[address]?.pinnedImage ?? null
      if (pinned) image = pinned
    }

    // 优先使用回收的对外端口，其次使用 nextPort；内部回环端口随机分配
    let port
    if (this.state.availablePorts && this.state.availablePorts.length > 0) {
      port = this.state.availablePorts.shift() // 取出最小的可用端口
      console.log(`[port] using recycled port ${port} for ${address}`)
    } else {
      port = this.state.swtcUsers?.[address]?.port ?? this.state.nextPort ?? CONFIG.docker.basePort
      // 端口即将耗尽：把「容器已销毁（destroyed）、记录还占着端口」的闲置端口
      // 一次性征用进回收池，供新用户使用（被征用者下次连接时重新分配新端口，内部透明）
      if (port > CONFIG.docker.maxPort && this.reclaimDestroyedPorts(address) > 0) {
        port = this.state.availablePorts.shift()
        console.log(`[port] reclaimed destroyed tenants' ports, using ${port} for ${address}`)
      }
    }
    const tier = this.state.swtcUsers?.[address]?.tier ?? 1
    const limits = getTierLimits(tier)
    let internalPort = this.allocateInternalPort()
    const excludedInternal = new Set() // 本次创建已尝试过的内部端口（冲突时换新）

    for (let attempt = 0; attempt < 64; attempt++) {
      if (attempt > 0) port = port + 1
      if (port > CONFIG.docker.maxPort) {
        throw new Error(`exhausted host port range for SWTC tenant ${address}`)
      }

      const patchFile = join(patchesDir(), `swtc-${address}.yml`)
      writeFileSync(patchFile, this.tenantPatch(port)) // patch 里 trustedHosts 用对外端口

      try {
        await dockerService.createContainer(name, internalPort, volume, patchFile, limits, {
          image,
        })
        this.state.nextPort = Math.max(this.state.nextPort ?? CONFIG.docker.basePort, port + 1)
        return await this.finalizeTenant(address, name, port, internalPort)
      } catch (err) {
        const msg = String(err.stderr)
        // 容器已存在（并发连接）：直接接管
        if (msg.includes('already in use')) {
          const info2 = await dockerService.containerInfo(name)
          if (info2.exists) {
            if (info2.status !== 'running') {
              await dockerService.startContainer(name)
            }
            const p2 = await dockerService.publishedPort(name)
            if (p2 !== null) {
              const p2public = this.state.swtcUsers?.[address]?.port ?? p2
              return await this.finalizeTenant(address, name, p2public, p2)
            }
          }
          continue
        }
        // 内部回环端口冲突（Bind for 127.0.0.1:xxxxx / port is already allocated）：
        // 对外端口现在由网关监听、docker 不再发布，故 docker 层只会因内部端口冲突报错，
        // 换一个新的内部端口重试（对外端口不动）。
        if (msg.includes('port is already allocated') || msg.includes('Bind for 127.0.0.1')) {
          excludedInternal.add(internalPort)
          internalPort = this.allocateInternalPort(excludedInternal)
          continue
        }
        throw err
      }
    }
    throw new Error(`could not allocate a host port for SWTC tenant ${address}`)
  }

  /**
   * 租户收尾：写入 state（含内部回环端口）→ 等待容器就绪 → 开放网关监听
   * @param {string} address
   * @param {string} name 容器名
   * @param {number} port 对外端口（网关监听，用户 URL 用）
   * @param {number} internalPort 内部回环端口（容器实际映射）
   */
  /**
   * 取某租户的 DSH 版本能力，用于网关分岔（放行 / 明确拒绝）。
   *
   * 为什么不直接用 state 里的 `requiresToken`：
   *   该字段是 finalizeTenant 写的，但 restoreFromDocker / restart 等路径下
   *   租户记录可能是平台升级前留下的（没有这个字段）。此时回退到
   *   `imageCapability()`（按镜像 ID 缓存，命中零 docker 开销），
   *   而不是把"未知"当"老版本可直通"——后者会让用户撞上英文 401。
   *
   * @returns {Promise<{requiresToken:boolean|null, version:string|null,
   *                    tokenAuthSince?:string}>} 永不抛：读不到就返回未知能力
   */
  async resolveTenantCapability(address) {
    address = normalizeAddress(address)
    const recorded = this.state.swtcUsers?.[address]

    // ------------------------------------------------------------------
    // 唯一权威依据：**租户容器实际在用的那个镜像**
    //
    // 这里曾经用 `dockerService.imageId()`（= 当前平台镜像）去判断，那是错的：
    // 租户容器固定引用创建时的镜像，管理员之后切换镜像并不会改变已存在的容器。
    // 用平台当前镜像的结论去描述旧容器，会得出与容器真实情况相反的判定：
    //   实测 09:52 用 0.1.0-rc.2 建好容器（可进），09:55 管理端切到 0.1.5-rc.1，
    //   于是平台把"当前镜像 0.1.5-rc.1 需要认证"套到了这个跑 0.1.0-rc.2 的
    //   容器上，把它拦下来并声称"该容器使用的 DSH 0.1.5-rc.1"——既拦错了，
    //   报出的版本也是假的。
    //
    // 因此：先读容器真实镜像 ID，按该 ID 查能力（按镜像 ID 缓存，命中零开销）。
    // ------------------------------------------------------------------
    let containerImageId = null
    try {
      containerImageId = await dockerService.containerImageId(swtcContainerName(address))
    } catch {
      // 容器不存在/查询失败 → 落到记录或当前镜像兜底
    }

    if (containerImageId) {
      // 平台当前镜像的版本：只用于让拒绝信息能区分
      // "容器落后于平台镜像"（→ 重建容器）与"平台镜像本身就要认证"（→ 回退镜像）。
      // 读不到就算了（null），不影响主判定。
      let platformVersion = null
      try {
        platformVersion = (await dockerService.imageCapability())?.version ?? null
      } catch {
        // 忽略：仅影响错误信息的措辞
      }

      // 记录里的快照恰好就是"这个容器的镜像"→ 最省，直接采纳（内容必然一致）
      if (
        recorded &&
        typeof recorded.requiresToken === 'boolean' &&
        recorded.imageId === containerImageId
      ) {
        return {
          requiresToken: recorded.requiresToken,
          version: recorded.baseImageVersion ?? null,
          platformVersion,
        }
      }
      // 否则按容器真实镜像探测（结果按镜像 ID 缓存）
      try {
        const cap = await dockerService.imageCapability(containerImageId)
        return {
          requiresToken: cap.requiresToken,
          version: cap.version,
          tokenAuthSince: cap.tokenAuthSince,
          platformVersion,
        }
      } catch (err) {
        console.error(`[capability] ${address} 查询容器镜像能力失败:`, err.message)
        return { requiresToken: null, version: null }
      }
    }

    // 容器不存在：此时该租户还没有可进入的容器，用记录快照或当前镜像兜底
    if (recorded && typeof recorded.requiresToken === 'boolean') {
      try {
        const platformImageId = await dockerService.imageId()
        if (platformImageId && platformImageId === recorded.imageId) {
          return {
            requiresToken: recorded.requiresToken,
            version: recorded.baseImageVersion ?? null,
          }
        }
      } catch {
        // 继续走下面的探测
      }
    }

    try {
      const cap = await dockerService.imageCapability()
      return {
        requiresToken: cap.requiresToken,
        version: cap.version,
        tokenAuthSince: cap.tokenAuthSince,
      }
    } catch (err) {
      console.error(`[capability] ${address} 查询镜像能力失败:`, err.message)
      // 返回未知（null）→ 网关保守拒绝，不会误放行
      return { requiresToken: null, version: null }
    }
  }

  async finalizeTenant(address, name, port, internalPort) {
    if (!this.state.swtcUsers) this.state.swtcUsers = {}
    const prev = this.state.swtcUsers[address] ?? {}
    const tier = prev.tier ?? 1
    const startedAt = prev.usageStartedAt ?? Date.now()

    // 顺序很重要（修复"假 running"窗口）：
    //   ① 等容器真正就绪 → ② 网关 bind 成功 → ③ 才写 running 并落盘。
    // 修复前是"先写 running 落盘、再等就绪（最长 120s）、最后才 listen"，
    // 期间状态/接口都报 running 并给出端口，用户 302 过去是 connection refused；
    // 且 waitReady 失败时容器已创建在跑，却不回滚 → 孤儿容器 + 状态不一致。

    // ① 就绪探测（失败 → 自愈一次，仍失败则回滚容器，不留下半启动态）
    const ready = await dockerService.waitReady(internalPort, undefined, {
      containerName: name,
    })
    if (!ready) {
      // _healStartupFailure 会先采集现场（回滚会删容器，日志随之永久消失），
      // 仅在确认是凭据文件损坏时才隔离并重启；其它故障原样走回滚。
      const heal = await this._healStartupFailure(address, name, internalPort)
      if (!heal.ready) {
        await this._rollbackFailedContainer(address, name, internalPort, {
          reason: `did not become ready on port ${internalPort} within ${CONFIG.docker.startupTimeoutMs}ms`,
        })
        throw new Error(
          `SWTC container ${name} did not become ready on port ${internalPort} within ` +
            `${CONFIG.docker.startupTimeoutMs}ms\n${heal.diagnostics}`,
        )
      }
    }

    // ①′ 记录该容器所用镜像的 DSH 版本与能力（缓存过，命中不产生 docker 开销）。
    //    为什么在收尾时记录：容器一旦创建就固定引用某个镜像，版本随之固定；
    //    网关据此决定"放行即进"还是"该版本需要认证（明确报错）"，
    //    check-rpc 也据此决定要不要带认证 cookie。
    const cap = await dockerService.imageCapability()
    const capFields = {
      baseImageVersion: cap.version ?? null,
      imageId: cap.imageId ?? null,
      requiresToken: cap.requiresToken, // true/false/null(未知)
    }

    // 自愈留下的隔离痕迹要带到最终记录里：下面的 `...prev` 是函数入口的快照，
    // 早于 _healStartupFailure 写入，不显式合并就会被覆盖掉。
    const cur = this.state.swtcUsers?.[address]
    const healFields = cur?.credentialsQuarantinedAt
      ? {
          credentialsQuarantinedAt: cur.credentialsQuarantinedAt,
          credentialsQuarantinedPath: cur.credentialsQuarantinedPath ?? null,
        }
      : {}

    // ② 开放网关：外部只能经 0.0.0.0:port 进入，且必须先过会话门禁
    //    bind 失败必须让调用方看见（旧实现吞成日志却照样记 routes + 写 running）
    //    能力随路由一起交给网关：网关据此决定"放行即进"还是"明确拒绝"，
    //    网关刻意不 import 本模块（会成环），只保留这一份快照。
    try {
      await tenantGateway.listen(port, internalPort, address, {
        requiresToken: cap.requiresToken,
        version: cap.version,
        tokenAuthSince: cap.tokenAuthSince,
      })
    } catch (err) {
      // 容器本身是好的，只是对外端口绑不上：保留容器与卷，标记 stopped，
      // 端口留在记录里供下次重连复用（listen 是幂等的，会先 close 再重绑）。
      this.state.swtcUsers[address] = {
        ...prev,
        port,
        internalPort,
        tier,
        createdAt: prev.createdAt ?? Date.now(),
        lastSeenAt: Date.now(),
        containerStatus: 'stopped',
        stoppedAt: Date.now(),
        ...capFields,
        ...healFields,
      }
      dataService.saveState(this.state)
      throw new Error(`网关端口 ${port} 绑定失败（该端口可能被宿主其他程序占用）：${err.message}`)
    }

    // ③ 就绪 + 门禁都通了，才对外宣告 running
    this.state.swtcUsers[address] = {
      ...prev,
      port,
      internalPort,
      tier,
      createdAt: prev.createdAt ?? Date.now(),
      lastSeenAt: Date.now(),
      containerStatus: 'running',
      usageStartedAt: startedAt,
      ...capFields,
      ...healFields,
    }
    delete this.state.swtcUsers[address].stoppedAt
    dataService.saveState(this.state)
    return port
  }

  /**
   * 回滚一个"创建成功但没能就绪"的容器：删容器、保数据卷、状态置 destroyed。
   * 修复前这条路径不存在，导致 waitReady 超时后容器继续运行却无人管理
   * （状态还写着 running），只能等 15 分钟后的空闲清理碰运气。
   * @private
   */
  async _rollbackFailedContainer(address, name, internalPort, { reason } = {}) {
    console.error(`[finalize] rolling back ${name} (${reason ?? 'unknown'})`)
    try {
      await dockerService.stopContainer(name, 10)
    } catch (err) {
      console.error(`[finalize] rollback stop failed for ${name}:`, err.message)
    }
    try {
      await dockerService.removeContainer(name) // 不删卷：用户数据保留
    } catch (err) {
      console.error(`[finalize] rollback remove failed for ${name}:`, err.message)
    }
    const prev = this.state.swtcUsers?.[address]
    if (prev) {
      this.state.swtcUsers[address] = {
        ...prev,
        internalPort,
        containerStatus: 'destroyed',
        lastSeenAt: Date.now(),
      }
      delete this.state.swtcUsers[address].stoppedAt
      delete this.state.swtcUsers[address].usageStartedAt
      dataService.saveState(this.state)
    }
  }

  /**
   * 启动未就绪时的自愈：若失败原因是**凭据文件损坏**，隔离该文件并再启一次。
   *
   * 背景（线上故障）：`/dsh-home/.credentials.yaml` 一旦损坏，DSH 的
   * credentials-local 会在启动时拒绝加载 → 进程退出 1 → 3080 永不监听 →
   * 平台只能报"容器未能就绪"，用户完全进不去（数据卷其实是好的）。
   * 这里把坏文件改名为 `.credentials.yaml.broken-<时间戳>`（留档不删），
   * DSH 便能用默认值起来；代价是已保存的 API Key 需要重填，因此
   * 在租户记录里留下 `credentialsQuarantinedAt/Path` 以便界面提示。
   *
   * 判据来自 DSH 自己的报错（见 isCredentialsCorruption）：只对这一种
   * 故障自愈，其它原因照旧走回滚，绝不误伤用户凭据。
   *
   * @returns {Promise<{ready:boolean, quarantined:string|null, diagnostics:string}>}
   */
  async _healStartupFailure(address, name, internalPort) {
    const diagnostics = await dockerService.containerDiagnostics(name)
    if (!isCredentialsCorruption(diagnostics)) {
      return { ready: false, quarantined: null, diagnostics }
    }

    let quarantined = null
    try {
      quarantined = await dockerService.quarantineVolumeFile(
        swtcVolumeName(address),
        CREDENTIALS_BASENAME,
      )
    } catch (err) {
      console.error(`[heal] ${address} 隔离凭据文件失败：${err.message}`)
      return { ready: false, quarantined: null, diagnostics }
    }
    console.warn(
      `[heal] ${address} 凭据文件无法解析，已隔离为 ${quarantined ?? '(文件不存在)'}；` +
        '重启容器重试（已保存的 API Key 需在「模型配置」重填）',
    )

    // 记录以便界面提示；调用方随后会 saveState
    if (!this.state.swtcUsers) this.state.swtcUsers = {}
    this.state.swtcUsers[address] = {
      ...(this.state.swtcUsers[address] ?? {}),
      credentialsQuarantinedAt: Date.now(),
      credentialsQuarantinedPath: quarantined,
    }

    try {
      await dockerService.startContainer(name)
    } catch (err) {
      return {
        ready: false,
        quarantined,
        diagnostics: `${diagnostics}\n隔离后重启失败: ${err.message}`,
      }
    }

    const ready = await dockerService.waitReady(internalPort, undefined, { containerName: name })
    return { ready, quarantined, diagnostics }
  }

  // ---------------------------------------------------------------------------
  // DSH 版本：把镜像版本应用到租户容器
  // ---------------------------------------------------------------------------

  /**
   * 查询某租户容器的 DSH 版本归属
   * @returns {Promise<{exists:boolean, status:string, imageId:string|null,
   *                    containerImageId:string|null, stale:boolean, dshVersion:string|null}>}
   */
  async getTenantDshVersion(address) {
    address = normalizeAddress(address)
    const name = swtcContainerName(address)
    const info = await dockerService.containerInfo(name)
    if (!info.exists) {
      return {
        exists: false,
        status: 'missing',
        imageId: null,
        containerImageId: null,
        stale: false,
        dshVersion: this.state.swtcUsers?.[address]?.baseImageVersion ?? null,
      }
    }
    const imageId = await dockerService.imageId()
    const containerImageId = await dockerService.containerImageId(name)
    return {
      exists: true,
      status: info.status,
      imageId,
      containerImageId,
      // 容器记录的是创建时的镜像 ID；与当前镜像不同即"还在旧镜像上"
      stale: Boolean(imageId) && containerImageId !== imageId,
      dshVersion: this.state.swtcUsers?.[address]?.baseImageVersion ?? null,
    }
  }

  /**
   * 把当前租户镜像应用到某个租户容器（重建容器以换镜像，保留数据卷）。
   *
   * 与 /reset 的区别：reset 删数据卷（全新开始），本方法**只重建容器**，
   * 用户数据、配置、技能全部保留，对外 URL（port）也不变。
   *
   * 为什么必须重建容器而不是原地升级：Docker 容器记录的是创建时的镜像 ID，
   * 换 `latest` 标签对已有容器无效（见 docs 讨论）；镜像层要生效只能重建容器。
   *
   * 安全约束（版本切换是**破坏性**操作，可能踩存储格式差异）：
   *   ① 先备份数据卷（唯一可能真丢东西的风险点）
   *   ② 目标镜像必须存在（否则停容器才发现 → 白白停机）
   *   ③ 端口保留（URL 稳定），并防止该端口在重建窗口内被分配给别的租户
   *   ④ 重建失败时回报备份路径，便于人工恢复
   *
   * @param {string} address
   * @param {{mode?: 'rebuild'|'inplace', dryRun?: boolean, backup?: boolean,
   *          skipQueueCheck?: boolean}} opts
   */
  async applyImageVersion(address, opts = {}) {
    address = normalizeAddress(address)
    const { mode = 'rebuild', dryRun = false, skipQueueCheck = true } = opts
    // 指定要钉到哪个镜像（租户镜像选择）。null = 平台默认（latest）
    const targetImage = opts.image ? String(opts.image) : null
    const backupRequested = opts.backup ?? CONFIG.dsh?.backupBeforeApply !== false

    const name = swtcContainerName(address)
    const volume = swtcVolumeName(address)
    const user = this.state.swtcUsers?.[address]

    if (!user) throw new NotFoundError(`租户不存在: ${address}`)

    const info = await dockerService.containerInfo(name)

    // 容器不存在：没有可重建的对象，交由 /connect 自然创建。
    //
    // 但**指定镜像时必须先把 pin 记下来**，否则"选择镜像"对已销毁的租户
    // 完全无效（下次连接会照旧用平台默认，而界面却提示"已选择"）。
    // 同时也要校验镜像：指定了一个不存在的镜像却报"无需重建"，会骗过管理员。
    if (!info.exists) {
      if (targetImage) {
        const exists = await dockerService.imageId(targetImage)
        if (!exists) {
          throw new BadRequestError(`租户镜像不存在：${targetImage}（请先在第 1/2 步构建该版本）`)
        }
        const ver = await dockerService.imageDshVersion(targetImage)
        if (!ver) {
          throw new BadRequestError(`目标镜像不是可用的 DSH 镜像：${targetImage}`)
        }
        if (!dryRun) {
          this.state.swtcUsers[address] = { ...user, pinnedImage: targetImage }
          dataService.saveState(this.state)
        }
        return {
          skipped: true,
          // 容器本来就不存在 → 不留停机窗口，只是把"下次用哪个镜像"记下来
          reason: `容器不存在，已记住该租户下次创建时使用 ${targetImage}`,
          pinnedImage: targetImage,
          dshVersion: ver,
        }
      }
      return {
        skipped: true,
        reason: '容器不存在（下次连接时会用当前镜像新建，无需重建）',
        dshVersion: user.baseImageVersion ?? null,
      }
    }

    // 目标镜像必须存在——否则要等到停掉容器才发现，白白制造停机。
    // targetImage 非空表示"钉到指定镜像"（租户镜像选择），否则用平台默认 latest。
    const imageId = targetImage
      ? await dockerService.imageId(targetImage)
      : await dockerService.imageId()
    if (!imageId) {
      throw new BadRequestError(
        `租户镜像不存在：${targetImage || CONFIG.docker.image}（请先在第 1/2 步构建该版本）`,
      )
    }
    // 指定镜像时，必须确认它确实是本项目的 DSH 镜像：否则可能把租户指向
    // 任意一个本地镜像（别的项目的 / 完全无关的镜像），容器会起不来。
    // 读版本号同时兼作这个校验 —— 读不到就不是我们的 DSH 镜像。
    const targetVersion = targetImage
      ? await dockerService.imageDshVersion(targetImage)
      : await dockerService.imageDshVersion()
    if (targetImage && !targetVersion) {
      throw new BadRequestError(`目标镜像不是可用的 DSH 镜像：${targetImage}（读不到 DSH 版本号）`)
    }

    const containerImageId = await dockerService.containerImageId(name)
    if (containerImageId === imageId) {
      return {
        skipped: true,
        reason: 'already-current',
        containerImageId,
        imageId,
        dshVersion: user.baseImageVersion ?? null,
      }
    }

    if (dryRun) {
      // 只探测，绝不写盘（dryRun 的语义是"零副作用"）。
      // 但必须把备份目录可写性报出来：否则用户点了「更新」才发现 EPERM，
      // 白白停一次容器。
      const backupProbe = backupRequested ? probeBackupDir() : null
      return {
        dryRun: true,
        address,
        containerStatus: info.status,
        fromImageId: containerImageId,
        toImageId: imageId,
        targetVersion,
        mode,
        backup: backupRequested,
        backupDir: backupProbe?.dir ?? null,
        // 配置的目录不可写、已自动降级到平台自有目录时要让管理员知道
        backupDirFallback: backupProbe?.fallbackFrom ?? null,
        backupDirError: backupProbe?.error ?? null,
      }
    }

    if (mode === 'inplace') {
      throw new BadRequestError('原地换包模式尚未实现（当前仅支持 rebuild）')
    }

    // ① 备份数据卷（失败即中止，绝不在没有退路的情况下动容器）
    let backupPath = null
    if (backupRequested) {
      const { dir: backupDir, fallbackFrom } = ensureBackupDir()
      if (fallbackFrom) {
        // 显著告警：管理员可能以为备份落在独立盘上，实际落在了平台数据目录
        console.warn(
          `[apply] 备份目录 ${fallbackFrom} 不可写，已自动改用 ${backupDir}（如需指定请设 config.json 的 dsh.backupDir）`,
        )
      }
      const safeVer = String(user.baseImageVersion ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')
      const fileName = `vol-${volume}-${safeVer}-${Date.now()}.tgz`
      try {
        backupPath = await dockerService.backupVolume(volume, backupDir, fileName)
        console.log(`[apply] ${address} volume backed up to ${backupPath}`)
      } catch (err) {
        throw new Error(`数据卷备份失败，已中止（未改动容器）：${err.message}`)
      }
    }

    // ② 结算当前运行段，避免租户被按停机时间或重建时间计费
    this.settleUsage(address)

    // ③ 保护对外端口：重建窗口内不能被回收池分给别的租户（否则 URL 会变）
    const keptPort = user.port ?? null

    // ④ 停容器 → 删容器（保数据卷）
    try {
      await dockerService.stopContainer(name, 30)
    } catch (err) {
      console.error(`[apply] ${address} stop failed:`, err.message)
    }
    try {
      await dockerService.removeContainer(name) // 不删卷
    } catch (err) {
      throw new Error(`移除旧容器失败，已中止：${err.message}`)
    }

    if (keptPort !== null && Array.isArray(this.state.availablePorts)) {
      this.state.availablePorts = this.state.availablePorts.filter((p) => p !== keptPort)
    }
    // 标记为待重建，同时保留 port 供 ensureContainer 复用
    this.state.swtcUsers[address] = {
      ...user,
      port: keptPort,
      containerStatus: 'stopped',
      stoppedAt: Date.now(),
      lastDshVersion: user.baseImageVersion ?? null,
    }
    delete this.state.swtcUsers[address].usageStartedAt
    dataService.saveState(this.state)

    // ⑤ 重建容器（ensureContainer 会复用记录里的 port → 对外 URL 不变）
    let newPort
    try {
      newPort = await this.ensureContainer(address, skipQueueCheck, targetImage)
    } catch (err) {
      // 容器已重建失败：状态保持 stopped（与"容器已删除"一致），并回报备份路径
      console.error(`[apply] ${address} rebuild failed:`, err.message)
      const e = new Error(
        `容器已移除但重建失败：${err.message}` +
          (backupPath ? `（数据卷备份在 ${backupPath}）` : ''),
      )
      e.backupPath = backupPath
      throw e
    }

    // ⑥ 记录版本变更（用于管理端"当前版本 / 上一次版本"与回退依据）
    const rec = this.state.swtcUsers[address] ?? {}
    this.state.swtcUsers[address] = {
      ...rec,
      baseImageVersion: targetVersion ?? rec.baseImageVersion ?? null,
      imageId,
      // 记住"钉到哪个镜像"：下次重建/恢复都按它走，而不是悄悄回到 latest。
      // null = 不钉，跟随平台默认（这样默认行为与改动前一致）
      pinnedImage: targetImage,
      versionChangedAt: Date.now(),
    }
    dataService.saveState(this.state)

    console.log(
      `[apply] ${address} rebuilt on image ${imageId} (dsh ${targetVersion ?? 'unknown'}), port ${newPort}`,
    )
    return {
      applied: true,
      address,
      port: newPort,
      imageId,
      dshVersion: targetVersion,
      previousVersion: this.state.swtcUsers[address].lastDshVersion ?? null,
      backupPath,
    }
  }

  /**
   * 升级用户配额
   */
  async upgradeContainer(address, tier) {
    const limits = getTierLimits(tier)
    if (!limits) throw new BadRequestError(`Invalid tier: ${tier}`)

    const name = swtcContainerName(address)
    const info = await dockerService.containerInfo(name)
    if (!info.exists) {
      // 漂移：没有容器可"重启升级"。但 tier 是租户记录上的字段，
      // 新限额在下次创建时生效（limits 在 createContainer 读取），
      // 所以这里落配额、不动容器 —— 绝不 404（资源监控循环里会炸日志）。
      if (!this.state.swtcUsers) this.state.swtcUsers = {}
      this.state.swtcUsers[address] = {
        ...(this.state.swtcUsers[address] ?? {}),
        tier,
        lastUpgradeAt: Date.now(),
      }
      dataService.saveState(this.state)
      console.log(
        `[upgrade] ${address} container absent: tier ${tier} (${limits.label}) 已记录，下次创建生效`,
      )
      return { tier, limits, deferredToNextCreate: true }
    }

    // 先结算当前运行段，再停止容器
    if (info.status === 'running') {
      this.settleUsage(address)
      await dockerService.stopContainer(name)
    }

    // 更新容器配置
    await dockerService.updateContainer(name, limits)

    // 重新启动容器
    await dockerService.startContainer(name)

    // 更新状态
    if (!this.state.swtcUsers) this.state.swtcUsers = {}
    this.state.swtcUsers[address] = {
      ...(this.state.swtcUsers[address] ?? {}),
      tier,
      lastUpgradeAt: Date.now(),
      containerStatus: 'running',
      lastSeenAt: Date.now(),
      usageStartedAt: Date.now(), // 升级重启 = 新的运行段
    }
    dataService.saveState(this.state)

    console.log(
      `[upgrade] ${address} upgraded to tier ${tier} (${limits.label}), container restarted`,
    )
    return { tier, limits }
  }

  /**
   * 停止并销毁容器（可选删除数据卷）
   * @param {boolean} removeRecord - 是否彻底删除用户记录并释放端口
   * @param {{keepVolume?: boolean}} options - removeRecord=true 时：keepVolume=true 保留数据卷
   *   （管理员主动留档/审计），默认删除（用户数据与平台记录一并清除，不产生孤儿卷）
   */
  async destroyContainer(address, removeRecord = false, options = {}) {
    const user = this.state.swtcUsers?.[address]
    if (!user) throw new NotFoundError('User not found')

    const name = swtcContainerName(address)
    try {
      // 容器可能还在运行：先结算本次运行段（销毁也计入当日时长）
      this.settleUsage(address)
      await dockerService.stopContainer(name)
    } catch {
      // ignore
    }
    try {
      await dockerService.removeContainer(name)
    } catch {
      // ignore
    }

    if (removeRecord) {
      const keepVolume = Boolean(options?.keepVolume)
      // 彻底删除：关闭网关、移除记录，释放端口
      const port = user.port
      // 网关监听随容器一并关闭（重建时会重新 listen）
      if (port) tenantGateway.close(port)

      // 数据卷：默认一并删除，不留孤儿卷；管理员选择保留则留在磁盘（可后续手动清理）
      let volumeStatus = 'kept'
      if (!keepVolume) {
        try {
          await dockerService.removeVolume(swtcVolumeName(address))
          volumeStatus = 'deleted'
          console.log(`[destroy] volume ${swtcVolumeName(address)} deleted (${address})`)
        } catch {
          // 卷可能不存在，忽略
        }
      }

      delete this.state.swtcUsers[address]

      // 将端口回收到可用端口池
      if (!this.state.availablePorts) this.state.availablePorts = []
      if (!this.state.availablePorts.includes(port)) {
        this.state.availablePorts.push(port)
        this.state.availablePorts.sort((a, b) => a - b)
      }

      dataService.saveState(this.state)
      console.log(
        `[destroy] ${address} completely removed, port ${port} recycled, volume ${volumeStatus}`,
      )
      return {
        ok: true,
        address,
        status: 'removed',
        portRecycled: port,
        volume: volumeStatus,
      }
    } else {
      // 仅销毁容器，保留记录
      // 容器没了 → 网关转发无上游：关闭网关监听，重建时重新开放
      if (user.port) tenantGateway.close(user.port)
      user.containerStatus = 'destroyed'
      delete user.internalPort // 重建时会分配新的内部端口
      dataService.saveState(this.state)
      return { ok: true, address, status: 'destroyed', volume: swtcVolumeName(address) }
    }
  }

  /**
   * 租户的"对外 authority"：用户浏览器经网关访问时的 Host 头。
   * 网关透传不改 Host，所以这就是 DSH 看到的 authority，也是 dsh-auth cookie
   * 必须绑定的那个值（本机访问时返回 null = 不显式列入 trustedHosts）。
   * @returns {string|null}
   */
  externalAuthority(port) {
    const PUBLIC_HOST = process.env.PUBLIC_HOST || CONFIG.server.publicHost
    if (!PUBLIC_HOST || ['127.0.0.1', 'localhost'].includes(PUBLIC_HOST.toLowerCase())) {
      return null
    }
    return `${PUBLIC_HOST}:${port}`
  }

  /**
   * 为容器内 RPC 调用（check-rpc.mjs）准备认证信息。
   *
   * 只有"需要 token 认证"的 DSH 版本才需要 cookie；老版本返回空即可
   * （脚本不带认证照样通）。
   *
   * authority 的选择必须与网关代激活时用的一致，否则签名校验不过：
   * 优先用对外 authority（用户浏览器实际用的 Host，也已列入 trustedHosts），
   * 其次退回回环 authority。
   *
   * @returns {Promise<{authority: string|null, cookie: string|null}>} 永不抛
   */
  async rpcAuthFor(address) {
    try {
      const user = this.state.swtcUsers?.[address]
      if (!user?.port || !user?.internalPort) return { authority: null, cookie: null }

      // 用 state 里记录的能力，**不在这里探测镜像**：
      // cleanup 每分钟跑一轮，探测会引入不必要的 docker 调用（实测会让
      // 空闲检测明显变慢甚至超时）。记录缺失时按"老版本"处理——真的需要
      // 认证的话脚本会回 authRequired:true，上游有保守分支兜底。
      if (user.requiresToken !== true) {
        return { authority: null, cookie: null }
      }

      const authority = this.externalAuthority(user.port) || `127.0.0.1:${user.internalPort}`
      // 优先用网关已经激活好的 cookie（命中零开销）；没有才现场激活一次。
      // 必须按 authority 取：cookie 绑定 authority，用别个 authority 的会 401。
      let cookie = authCookieCache.peek(user.port, authority)
      if (!cookie) {
        cookie = await authCookieCache.get(user.port, {
          internalPort: user.internalPort,
          host: authority,
          containerName: swtcContainerName(address),
        })
      }
      return { authority, cookie }
    } catch (err) {
      console.error(`[cleanup] ${address} 准备 RPC 认证失败:`, err.message)
      return { authority: null, cookie: null }
    }
  }

  /**
   * 生成租户 cordis patch 内容
   */
  tenantPatch(port) {
    const PUBLIC_TRUST = (process.env.PUBLIC_TRUST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // 对外 authority：用户浏览器经网关访问时的 Host 头（网关透传不改 Host），
    // 显式列入 trustedHosts，保证将来关闭"局域网自动信任"后也能过 DSH 的 fence。
    const externalAuthority = this.externalAuthority(port)
    const trusted = [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      ...(externalAuthority ? [externalAuthority] : []),
      ...PUBLIC_TRUST,
    ]
    return (
      `# Generated by dsh-multitenant entry server for tenant ${port}.\n` +
      `- id: webserver\n` +
      `  config:\n` +
      `    host: '0.0.0.0'\n` +
      `    port: 3080\n` +
      `- id: web-runtime\n` +
      `  config:\n` +
      `    printUrl: true\n` +
      `    surfaceContext: true\n` +
      `    trustedHosts: [${trusted.map((t) => JSON.stringify(t)).join(', ')}]\n`
    )
  }

  /**
   * 网关路由自愈：给"已运行但平台侧没有路由"的租户补上监听。
   *
   * 为什么需要：`restoreFromDocker()` 只在**平台启动那一刻**检查容器状态。
   * 但容器可以在平台运行期间被重建（清理机制先销毁 → 用户再连接时新建），
   * 于是出现"容器 running、state.port 有值、平台却没有该端口的路由"的状态。
   * 用户此时访问容器 URL 会拿到网关的
   *   `该租户容器需要登录会话才能访问，请回到平台重新连接`（403），
   * 而容器本身其实是好的 —— 实测踩过（平台重启才恢复）。
   *
   * 幂等且只补不拆：已有正确路由就跳过；端口被无关进程占用只记日志，不影响
   * 其它租户。定时器周期调用，可自愈"路由在运行期丢失"。
   *
   * @returns {Promise<{checked:number, restored:number, failed:number}>}
   */
  async ensureGatewayRoutes() {
    let checked = 0
    let restored = 0
    let failed = 0

    for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
      if (user.containerStatus !== 'running') continue
      if (!user.port) continue
      checked++

      if (tenantGateway.hasRoute(user.port, address)) continue

      const internalPort = await dockerService.publishedPort(swtcContainerName(address))
      if (internalPort === null) {
        failed++
        console.error(`[gateway-heal] ${address.slice(0, 10)}... 容器运行中但读不到映射端口`)
        continue
      }

      try {
        await tenantGateway.listen(
          user.port,
          internalPort,
          address,
          await this.resolveTenantCapability(address),
        )
        restored++
        console.log(
          `[gateway-heal] 补回路由 :${user.port} -> 127.0.0.1:${internalPort} (${address.slice(0, 10)}...)`,
        )
      } catch (err) {
        failed++
        console.error(
          `[gateway-heal] ${address.slice(0, 10)}... 端口 ${user.port} 绑定失败：${err.message}`,
        )
      }
    }

    return { checked, restored, failed }
  }

  /**
   * 从 Docker 恢复状态
   */
  async restoreFromDocker() {
    const names = await dockerService.listSwtcContainers()
    const running = new Set(names)
    for (const name of names) {
      const address = name.replace(/^dsh-swtc-/, '').toLowerCase()
      const saved = this.state.swtcUsers?.[address]

      // 只恢复"运行中"的容器：Exited/暂停一律结算残留运行段并标记 stopped
      // （docker ps -a 会列出已停止容器；之前无条件标 running 且恢复网关监听，
      //   导致 state 与 docker 长期不一致、已停止容器的端口仍被网关占用）
      const info = await dockerService.inspectContainer(name)
      if (info?.State?.Status !== 'running') {
        this.settleUsage(address)
        this.state.swtcUsers[address] = {
          ...(saved ?? {}),
          containerStatus: 'stopped',
          stoppedAt: saved?.stoppedAt ?? Date.now(),
        }
        console.log(
          `[restore] ${address.slice(0, 10)}... 容器不在运行（${info?.State?.Status ?? 'inspect 失败'}）→ stopped，不恢复网关`,
        )
        continue
      }

      // 宿主实际映射端口 = 内部回环端口；对外端口从 state 保留（缺省退化为同端口）
      const internalPort = await dockerService.publishedPort(name)
      if (internalPort === null) continue
      const port = saved?.port ?? internalPort

      // 从 Docker 容器检查实际配额（info 已在上面成功获取）
      let actualTier = 1
      try {
        if (info) {
          const memory = info.HostConfig?.Memory || 0
          const nanoCPUs = info.HostConfig?.NanoCPUs || 0
          if (memory >= 2147483648 || nanoCPUs >= 4000000000) {
            actualTier = 3
          } else if (memory >= 1073741824 || nanoCPUs >= 2000000000) {
            actualTier = 2
          } else {
            actualTier = 1
          }
        }
      } catch (err) {
        console.warn(`[restore] failed to inspect ${name}:`, err.message)
      }

      if (!this.state.swtcUsers) this.state.swtcUsers = {}
      const savedTier = this.state.swtcUsers[address]?.tier
      const targetTier = savedTier ?? actualTier

      this.state.swtcUsers[address] = {
        ...(saved ?? {}),
        port,
        internalPort,
        tier: targetTier,
        createdAt: saved?.createdAt ?? Date.now(),
        lastSeenAt: saved?.lastSeenAt ?? Date.now(),
        containerStatus: 'running',
        // 恢复运行中的容器：保留原运行段起点；缺失（新记录）则从恢复时刻开始计时
        usageStartedAt: saved?.usageStartedAt ?? Date.now(),
      }

      // 如果 tier 不匹配，更新 Docker 容器
      if (savedTier && savedTier !== actualTier) {
        console.log(
          `[restore] ${address} tier mismatch: state=${savedTier}, docker=${actualTier}, updating to ${targetTier}`,
        )
        try {
          const limits = getTierLimits(targetTier)
          await dockerService.updateContainer(name, limits)
        } catch (err) {
          console.error(`[restore] failed to update ${name}:`, err.message)
        }
      }

      // 对外端口回收基线只沿用"有对外端口记录"的容器（新恢复的 40000+ 内部端口不推高 nextPort）
      if (saved?.port) {
        this.state.nextPort = Math.max(this.state.nextPort ?? CONFIG.docker.basePort, port + 1)
      }

      // 重新开放网关监听（进程重启后外部端口需要接管）
      // 单个租户 bind 失败不应中断整轮恢复：记日志、标记该租户异常，继续处理其余
      try {
        await tenantGateway.listen(
          port,
          internalPort,
          address,
          await this.resolveTenantCapability(address),
        )
      } catch (err) {
        console.error(`[restore] gateway bind failed for ${address} :${port}:`, err.message)
        this.state.swtcUsers[address] = {
          ...(this.state.swtcUsers[address] ?? {}),
          containerStatus: 'stopped',
          stoppedAt: Date.now(),
        }
      }
    }

    // 对齐每日时长：Docker 中已不在运行的记录，结算残留运行段并校正状态
    // （进程重启前崩溃 / 容器被外部停止时，usageStartedAt 可能残留）
    for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
      if (running.has(swtcContainerName(address))) continue
      this.settleUsage(address)
      if (user.containerStatus === 'running') {
        user.containerStatus = 'stopped'
        user.stoppedAt = user.stoppedAt ?? Date.now()
      }
    }
    dataService.saveState(this.state)
  }

  /**
   * 判断租户容器是否真的在活动（三层检测，全部从宿主侧完成）：
   *   1) DSH 内部活动：卷内 sessions/ 会话文件最近有写入
   *      （对话流/工具调用/agent 任务都会 append 事件，文件在动 = 在干活）
   *   2) 外部程序：docker top 进程数超过基线
   *      （shell 命令、代码执行等 fork 出的额外进程）
   *   3) 活跃连接：容器内非回环 ESTABLISHED 连接 > 0
   *      （浏览器开着 DSH 页面 = WebSocket 长连；LLM 出站请求）
   * 全部安静才算空闲。
   * @param {string} address SWTC 地址
   * @param {string} name 容器名
   */
  async isContainerActive(address, name) {
    const policy = this.state.cleanupPolicy || {}
    const windowMs = policy.activityWindowMs ?? CONFIG.cleanup.activityWindowMs ?? 180000
    const baseline = policy.processBaseline ?? CONFIG.cleanup.processBaseline ?? 2
    const diag = {}

    // 1) 会话文件活动
    try {
      const out = await dockerService.runVolumeScript(
        swtcVolumeName(address),
        join(SCRIPTS_DIR, 'check-activity.mjs'),
        'check-activity.mjs',
        ['/dsh-home/sessions'],
      )
      const parsed = JSON.parse(out)
      const ageMs = parsed?.latestSessionMtime ? Date.now() - parsed.latestSessionMtime : null
      diag.session = {
        mtime: parsed?.latestSessionMtime ?? 0,
        ageMs,
        windowMs,
        active: ageMs !== null && ageMs < windowMs,
      }
      if (diag.session.active) return true
    } catch (err) {
      diag.session = { error: err.message }
    }

    // 2) 外部进程
    try {
      const count = await dockerService.topProcessCount(name)
      diag.process = { count, baseline, active: count > baseline }
      if (diag.process.active) return true
    } catch (err) {
      diag.process = { error: err.message }
    }

    // 3) 活跃连接（共享租户容器网络命名空间看连接表）
    try {
      const out = await dockerService.runVolumeScript(
        swtcVolumeName(address),
        join(SCRIPTS_DIR, 'check-connections.mjs'),
        'check-connections.mjs',
        [],
        { networkContainer: name },
      )
      const parsed = JSON.parse(out)
      diag.connection = {
        established: parsed?.established ?? 0,
        active: (parsed?.established ?? 0) > 0,
      }
      if (diag.connection.active) return true
    } catch (err) {
      diag.connection = { error: err.message }
    }

    // 4) DSH 任务状态：session.list 存在 running 会话
    try {
      // 新版 DSH（≥0.1.2-alpha.2）给 /api 也加了浏览器认证：不带 cookie 会 401，
      // 于是"正在跑任务的会话"被误判为空闲并停掉。这里把代激活得到的
      // authority + cookie 传进脚本，让空闲检测在新版本上依然准确。
      const rpcAuth = await this.rpcAuthFor(address)
      const out = await dockerService.runVolumeScript(
        swtcVolumeName(address),
        join(SCRIPTS_DIR, 'check-rpc.mjs'),
        'check-rpc.mjs',
        [
          ...(rpcAuth.authority ? [`--authority=${rpcAuth.authority}`] : []),
          ...(rpcAuth.cookie ? [`--cookie=${rpcAuth.cookie}`] : []),
        ],
        { networkContainer: name },
      )
      const parsed = JSON.parse(out)
      diag.rpc = {
        ok: parsed?.ok === true,
        runningSessions: parsed?.runningSessions ?? 0,
        active: parsed?.ok === true && parsed.runningSessions > 0,
        // 401 = 认证没带上/失效。**绝不能因此判空闲**：那会停掉正在跑任务的容器。
        // 认证问题应当"保守地认为可能活跃"，让上游走别的判据。
        authRequired: parsed?.authRequired === true,
      }
      if (diag.rpc.active) return true
      if (diag.rpc.authRequired) {
        console.warn(
          `[cleanup] ${address} check-rpc 认证失败（HTTP 401）：已保守跳过 RPC 判据，避免误停正在跑任务的容器`,
        )
        return true // 保守：认证类失败不判空闲
      }
    } catch (err) {
      diag.rpc = { error: err.message }
    }

    // 全部安静：记录诊断，便于排查"为何判空闲"
    console.log(`[cleanup] ${address} judged idle: ${JSON.stringify(diag)}`)
    return false
  }

  /**
   * 清理空闲容器
   * 运行中的容器空闲超时 → 先做活动检测（会话文件 + 进程数），
   * 确认空闲才优雅停止（SIGTERM 宽限）；停止超时 → 销毁（数据卷保留）。
   * 防重入：docker stop -t 的宽限等待可能超过检查间隔，重复触发会对同一
   * 容器并发 stop，因此正在执行的本轮直接跳过（不做任何事）。
   */
  async cleanupIdleContainers() {
    if (this._cleanupRunning) return
    this._cleanupRunning = true
    try {
      await this._cleanupIdleContainersInner()
    } finally {
      this._cleanupRunning = false
    }
  }

  async _cleanupIdleContainersInner() {
    const now = Date.now()
    let changed = false

    for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
      const idle = now - user.lastSeenAt
      const name = swtcContainerName(address)
      const status = user.containerStatus ?? 'running'

      // 阶段 1：运行中的容器空闲超过阈值 → 先检测真实活动，确认空闲再停止
      if (status === 'running' && idle > this.state.cleanupPolicy.stopTimeoutMs) {
        // 容器内还有真实活动（会话在写 / 有额外进程）→ 刷新 lastSeenAt，跳过本次清理
        let active = false
        try {
          active = await this.isContainerActive(address, name)
        } catch (err) {
          console.error(`[cleanup] activity check failed for ${address}:`, err.message)
        }
        if (active) {
          user.lastSeenAt = now
          changed = true
          console.log(
            `[cleanup] ${address} is still active, skipping (idle ${(idle / 60000).toFixed(0)}min)`,
          )
          continue
        }
        try {
          const grace =
            this.state.cleanupPolicy.stopGraceSeconds ?? CONFIG.cleanup.stopGraceSeconds ?? 60
          this.settleUsage(address) // 结算本次运行段（空闲停止同样累计当日时长）
          await dockerService.stopContainer(name, grace)
          user.containerStatus = 'stopped'
          user.stoppedAt = now
          // 清理不相关字段
          delete user.lastUpgradeAt
          const idleMin = (idle / 60000).toFixed(0)
          console.log(
            `[cleanup] stopped idle container: ${address} (idle ${idleMin}min, grace ${grace}s)`,
          )
          changed = true
        } catch (err) {
          if (String(err.stderr).includes('No such container')) {
            user.containerStatus = 'destroyed'
            delete user.stoppedAt
            delete user.lastUpgradeAt
            if (user.port) tenantGateway.close(user.port)
            changed = true
          } else {
            console.error(`[cleanup] failed to stop ${address}:`, err.message)
          }
        }
      }
      // 阶段 2：停止的容器超过阈值 → 销毁
      else if (status === 'stopped') {
        const stoppedDuration = now - (user.stoppedAt || user.lastSeenAt)
        if (stoppedDuration > this.state.cleanupPolicy.destroyTimeoutMs) {
          try {
            await dockerService.removeContainer(name)
            user.containerStatus = 'destroyed'
            // 清理不相关字段
            delete user.stoppedAt
            delete user.lastUpgradeAt
            // 关闭网关监听：容器已销毁，端口闲置但保留在记录中供重建复用；
            // 不关的话僵尸监听会占用端口并持续转发失败（EADDRINUSE/502）
            if (user.port) tenantGateway.close(user.port)
            const stoppedMin = (stoppedDuration / 60000).toFixed(0)
            console.log(
              `[cleanup] destroyed stopped container: ${address} (stopped ${stoppedMin}min, data preserved)`,
            )
            changed = true
          } catch (err) {
            if (String(err.stderr).includes('No such container')) {
              user.containerStatus = 'destroyed'
              delete user.stoppedAt
              delete user.lastUpgradeAt
              if (user.port) tenantGateway.close(user.port)
              changed = true
            } else {
              console.error(`[cleanup] failed to destroy ${address}:`, err.message)
            }
          }
        }
      }
      // 修复：running 状态不应有 stoppedAt
      else if (status === 'running' && user.stoppedAt) {
        delete user.stoppedAt
        changed = true
      }
    }

    if (changed) {
      dataService.saveState(this.state)
    }
  }

  /**
   * 获取系统统计
   */
  getStats() {
    const users = this.state.swtcUsers || {}
    const totalUsers = Object.keys(users).length
    const runningUsers = Object.values(users).filter((u) => u.containerStatus === 'running').length
    const tierCounts = { 1: 0, 2: 0, 3: 0 }
    Object.values(users).forEach((u) => {
      const tier = u.tier ?? 1
      tierCounts[tier] = (tierCounts[tier] || 0) + 1
    })
    // 资源监控相关（供管理面板展示）
    const resource = CONFIG.resource || {}
    const autoUpgradeCount = Object.values(users).filter((u) => u.lastAutoUpgradeAt).length
    return {
      totalUsers,
      runningUsers,
      tierCounts,
      tiers: CONFIG.tiers,
      resource: {
        enabled: true,
        monitorIntervalMs: resource.monitorIntervalMs ?? 30000,
        autoUpgradeThreshold: resource.autoUpgradeThreshold ?? 80,
        autoUpgradeCooldownMs: resource.autoUpgradeCooldownMs ?? 600000,
        diskCheckIntervalMs: resource.diskCheckIntervalMs ?? 300000,
        autoUpgradeCount,
        disk: this.diskUsage ?? null,
      },
    }
  }
}

export const userService = new UserService()
