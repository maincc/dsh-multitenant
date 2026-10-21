/**
 * Docker 服务模块
 * 封装所有 Docker CLI 操作
 */

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CONFIG } from '../config/config.js'
import { requiresToken, DSH_TOKEN_AUTH_SINCE } from './dsh-version.service.js'

const IMAGE = process.env.DSH_TENANT_IMAGE || CONFIG.docker.image
const STARTUP_TIMEOUT_MS = Number(process.env.STARTUP_TIMEOUT_MS || CONFIG.docker.startupTimeoutMs)

/**
 * 租户隔离网络（2026-10 全面审计 CRITICAL 修复）。
 *
 * 修复前所有租户容器都落在 default bridge：端口虽以 127.0.0.1 回环发布（只挡
 * 外部，不挡桥内），租户容器自带 shell，`nc 172.17.x.x 3080` 即可直连其他租户的
 * DSH 进程，绕过网关全部会话门禁（老镜像无 token 门禁=跨租户完全沦陷）。
 * 方案：共享一张 enable_icc=false 的自定义 bridge——容器间数据面被 daemon 的
 * iptables 规则丢弃，而宿主↔容器的回环映射走 docker-proxy 不受影响
 * （2026-10-20 已 scratch 实测：宿主映射收发正常、容器互访 ICC_BLOCKED）。
 *
 * 存量容器随下一次重建自动迁入（restart 漂移重建/版本应用/销毁重建路径都走
 * createContainer）；平台自己的 helper 容器用 --network container: 共享租户
 * netns，天然继承隔离网络，不需改。
 */
const TENANT_NETWORK =
  process.env.DSH_TENANT_NETWORK || CONFIG.docker.tenantNetwork || 'dsh-tenant-net'
let _tenantNetDisabled = false
let _tenantNet = null // Promise<void>：幂等建网，进程内只探测/创建一次

/** test-only：重置建网缓存（同 setSecurityModeForTest 的隔离语义） */
export function setTenantNetworkForTest() {
  _tenantNet = null
  _tenantNetDisabled = false
}

/**
 * 启动时主动建隔离网（server 启动链调用）。不这样做的事故形态：本进程
 * 从未供应过新容器时 lazy 建网不触发，存量容器（default bridge，容器间
 * 互通）可被"重启容器"原样复活——修复只覆盖新容器等于没修。
 */
export function primeTenantNetwork() {
  return ensureTenantNetwork()
}

/**
 * 存量容器迁入隔离网（2026-10 审计 CRITICAL 的存量轨）。
 * 纯网络层操作（disconnect default bridge → connect icc=false 网），
 * 容器/卷/端口映射都不动；stop→start 之间调用，数据零丢失。
 * 已在隔离网/他网/建网降级态一律 no-op；失败只 warn（下次重启再试）。
 */
export async function migrateContainerToTenantNetwork(name) {
  try {
    const out = await sh('docker', [
      'inspect',
      '--format',
      '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}',
      name,
    ])
    const nets = String(out || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (nets.includes(TENANT_NETWORK)) return 'already'
    if (!nets.includes('bridge')) return 'skip' // host/其他自定义网：不冒动
    await ensureTenantNetwork()
    if (_tenantNetDisabled) return 'skip' // 降级态不迁（目标网不存在，摘了更糟）
    await sh('docker', ['network', 'disconnect', 'bridge', name])
    await sh('docker', ['network', 'connect', TENANT_NETWORK, name])
    console.log(`[docker] 存量容器已迁入隔离网：${name}（bridge → ${TENANT_NETWORK}）`)
    return 'migrated'
  } catch (err) {
    console.warn(`[docker] ${name} 迁入隔离网失败（下次启动重试）:`, err.message)
    return 'failed'
  }
}

/**
 * 全量迁移存量租户容器（server 启动链，primeTenantNetwork 之后调）。
 * disconnect/connect 对 stopped/exited 容器同样有效（docker 标准热迁），
 * 不 stop 不 rm 不动卷——存量租户在下一次平台重启即静默完成隔离。
 */
export async function migrateExistingContainers() {
  let names = []
  try {
    const out = await sh('docker', [
      'ps',
      '-a',
      '--filter',
      'name=dsh-swtc-',
      '--format',
      '{{.Names}}',
    ])
    names = String(out || '')
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch (err) {
    console.warn('[docker] 存量容器枚举失败（跳过迁移）:', err.message)
    return { total: 0, migrated: 0, failed: 0 }
  }
  let migrated = 0
  let failed = 0
  for (const n of names) {
    const r = await migrateContainerToTenantNetwork(n)
    if (r === 'migrated') migrated++
    else if (r === 'failed') failed++
  }
  if (migrated || failed)
    console.log(`[docker] 存量隔离迁移：迁入 ${migrated}，失败 ${failed}，共 ${names.length}`)
  return { total: names.length, migrated, failed }
}
function ensureTenantNetwork() {
  if (!_tenantNet) {
    _tenantNet = (async () => {
      try {
        await sh('docker', [
          'network',
          'create',
          '-o',
          'com.docker.network.bridge.enable_icc=false',
          '--label',
          'dsh-managed=1',
          TENANT_NETWORK,
        ])
        _tenantNetDisabled = false
        console.log(`[docker] 租户隔离网络已建立：${TENANT_NETWORK}（icc=false）`)
      } catch (err) {
        if (/already exists|Existing network/i.test(String(err?.message || err))) {
          _tenantNetDisabled = false
          return
        }
        // 建网失败（daemon 抖动/不支持 bridge option）：本轮降级保住供应可用，
        // 隔离缺失打在日志最亮处；失败不缓存死，下轮供应自动重试
        console.error(
          `[docker] ⚠️ 租户隔离网络创建失败（${String(err?.message || err).slice(0, 120)}）——` +
            `本轮供应退回 default bridge（容器间互通，隔离降级）！下次供应自动重试；` +
            '持续出现请检查 docker daemon 对 com.docker.network.bridge.enable_icc=false 的支持',
        )
        _tenantNet = null // 失败不缓存：下一轮 createContainer 重试建网
        _tenantNetDisabled = true // 本轮 run 不带网络参数（网络不存在时带了必失败）
        return
      }
    })()
  }
  return _tenantNet
}

/**
 * imageCapability 缓存的兜底存活时间。
 * 正常路径由 clearCapabilityCache() 显式失效（平台重建镜像后），
 * 这个 TTL 只兜"镜像被平台之外的方式换掉了"。
 */
const CAPABILITY_CACHE_TTL_MS = Number(process.env.DSH_CAPABILITY_CACHE_MS || 30000)

/**
 * Docker CLI 子进程默认超时（毫秒）。
 *
 * 修复前 execFile 只有 maxBuffer、没有 timeout：daemon 卡死/磁盘 hang/DNS 不通时
 * 子进程会永久挂起 → 挂住的是 HTTP 请求，以及定时任务（_cleanupRunning 等标志位
 * 永久为 true，空闲清理从此静默失效）。
 *
 * 默认取 120s 而不是更小，因为部分调用本身很慢（首次 docker run 拉镜像、
 * `du -sb` 扫描大卷、docker stats 采样）。需要更长的调用可在 opts.timeout 覆盖。
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.DOCKER_CLI_TIMEOUT_MS || 120000)

/**
 * 容器实际 DSH 版本缓存：镜像 ID -> 版本。
 *
 * 版本由镜像决定，不会中途变化（要变就换镜像 ID），所以不需要 TTL；
 * 只有"重建镜像"时才需要清（见 clearCapabilityCache / 镜像构建成功后）。
 * inflight 用于合并并发 exec（管理面板一次刷新会同时问所有租户）。
 */
const dshVersionByImageId = new Map()
const dshVersionInflight = new Map()

/** 清掉容器版本缓存（镜像被重建/重打 tag 后调用） */
export function clearDshVersionCache() {
  dshVersionByImageId.clear()
  dshVersionInflight.clear()
}

/**
 * 执行命令并把 **stdout 与 stderr 合并**返回（永不 reject）。
 *
 * 为什么需要：`sh()` 只在失败时保留 stderr。而 `docker logs` 把容器的
 * stdout 写 stdout、stderr 写 stderr —— 启动失败的堆栈几乎都在 stderr，
 * 用 `sh()` 采集日志会把最关键的行丢掉。诊断信息本身绝不能抛错把
 * 原始错误顶掉，所以这里统一 resolve。
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
function shCaptureBoth(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve(`${stdout ?? ''}${stderr ?? ''}`.trim()),
    )
  })
}

/**
 * 宿主机是否支持 `docker run --storage-opt size=`（磁盘配额）。
 *
 * null = 尚未遇到；false = 已确认不支持（后续创建直接跳过该参数）。
 *
 * 为什么必须探测而不是"直接用"：`--storage-opt size=` 只在特定后端可用
 * ——overlay2 需要底层 xfs 且挂载带 `pquota`，btrfs/zfs 原生支持。
 * 在不支持的宿主上 Docker **直接拒绝整个 `docker run`** 并返回 125：
 *   "--storage-opt is supported only for overlay over xfs with 'pquota' mount option"
 * 而不是像旧注释假设的那样"接受但不强制"。线上实测：新服务器
 * （/home/oc-skywelld-1，非 xfs+pquota）因此完全无法创建容器，租户全部进不去。
 *
 * 降级策略：首次被拒 → 记 false → 去掉该参数重试一次（配额退化为不限制），
 * 之后不再白发一次失败请求。宿主换成支持配额的存储后，重启平台即重新探测。
 */
let storageOptSupported = null

/** 仅供测试：重置/预设宿主配额支持状态 */
export function setStorageOptSupportedForTest(v) {
  storageOptSupported = v
}

/**
 * 镜像构建互斥标志（F3 维护定时器用）。
 * buildImage 期间维护任务必须整体跳过——prune 可能拆掉构建中的中间层；
 * 构建窗口以"进入计数"记，并发构建/异常退出都能配对还原。
 */
let buildDepth = 0

/** 当前是否有 docker build 在进行（maintenance.service 消费） */
export function isImageBuilding() {
  return buildDepth > 0
}

/**
 * 判断一次 `docker run` 失败是否**明确**由"宿主不支持 --storage-opt"引起。
 *
 * 必须精确匹配：其它错误（端口占用、镜像缺失、名称冲突）要原样上抛，
 * 否则会被这里吞成"配额不可用"，把真正的故障藏起来。
 * @param {any} err
 * @returns {boolean}
 */
function isStorageOptUnsupported(err) {
  const text = `${err?.stderr ?? ''}\n${err?.message ?? ''}`
  return (
    /--storage-opt is supported only for/i.test(text) ||
    /storage-opt.*(?:not supported|unsupported)/i.test(text)
  )
}

// ---------------------------------------------------------------------------
// 安全参数组（P1-6 降权第一阶段，2026-09）
//
// 背景（本机实测矩阵见 docs，此处留结论）：
//   租户容器里 DSH 的 bash 沙箱（bwrap）依赖三样东西：嵌套命名空间（需要
//   CAP_SYS_ADMIN 或宿主内核允许无特权 userns）、mount 族系统调用、以及
//   seccomp 放行 pivot_root（Docker 默认 profile 不放行 → bwrap 当场死）。
//   旧参数组用 seccomp=unconfined 一次性放行**全部**系统调用，等于把
//   bpf/io_uring/kexec/模块加载这些内核 CVE 高发入口一起开给租户代码——
//   危险的不是 SYS_ADMIN 本身，而是 SYS_ADMIN × unconfined 的组合。
//
//   新参数组（strict）：SYS_ADMIN 暂留（去它要宿主内核配合，属第二阶段，
//   见 privilegeProfile 配置注释），no-new-privileges 堵 setuid 升格，
//   seccomp 换成"默认白名单 + 仅追加 pivot_root"的最小 profile
//   （deploy/seccomp-bwrap-minimal.json，实测 read-only 与 workspace-write
//   双方言、node/git/tar/管道全功能无差异）。
//
// 探测：参数组能不能用不靠猜——首次供应容器前用 strict 参数实跑一次
// DSH 同款 bwrap 探测（argv 与 packages/sandbox/sandbox-local 的探测逐字
// 一致），auto 模式据此选档并缓存；探测不过就回落 compat（= 改动前行为，
// 功能零风险），daemon 读不到 profile 文件的场景在 run 时被拒也会降级重试
// 一次（与 --storage-opt 的降级同构，教训来自线上配额事故）。
// ---------------------------------------------------------------------------

/**
 * bwrap 探测命令参数（read-only 档）。导出是为了让测试直接断言，
 * 不靠复制粘贴；若 DSH 侧探测形态变化（packages/sandbox/sandbox-local），
 * 这里要同步改。
 */
export const BWRAP_PROBE_ARGS = [
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--unshare-pid',
  '--proc',
  '/proc',
  '--die-with-parent',
  '--',
  'true',
]

/** 探测子进程超时：正常 <3s；给 30s 兜 daemon 慢/镜像首次解包的场景 */
const SECCOMP_PROBE_TIMEOUT_MS = Number(process.env.DSH_SECCOMP_PROBE_TIMEOUT_MS || 30000)

/**
 * auto 模式的探测结果缓存：null = 未探测；'strict' | 'compat' = 已定档。
 * 平台重启重新探测（宿主内核/daemon 可能变了）；镜像重建时由
 * clearCapabilityCache() 一并清掉（bwrap 随镜像走）。
 * @type {null|'strict'|'compat'}
 */
let securityMode = null
/** 并发供应时合并探测：同一时刻只跑一次 docker run --rm */
let securityProbeInflight = null

/** 仅供测试：预设/重置安全档位（null 恢复"未探测"） */
export function setSecurityModeForTest(v) {
  securityMode = v
  securityProbeInflight = null
}

/** 当前生效的安全参数档位（auto 未探测时为 null）；供管理端展示 */
export function getSecurityMode() {
  return securityMode
}

/** 解析配置档位：环境变量可临时覆盖（排障用），非法值按 auto */
function configuredPrivilegeProfile() {
  const v = (process.env.DSH_PRIVILEGE_PROFILE || CONFIG.docker?.privilegeProfile || 'auto').trim()
  return v === 'strict' || v === 'compat' ? v : 'auto'
}

/**
 * 白名单 profile 路径的**使用处兜底**：config.json 的 docker 块会整块顶掉
 * DEFAULTS（loadConfig 是浅合并——loadConfig 同款警告），老部署
 * 不改 config.json 就没有 seccompProfilePath。兜回仓库内文件路径，
 * 与"未配置"语义一致；显式配置了别人的路径则尊重配置。
 */
function seccompProfilePath() {
  return (
    CONFIG.docker?.seccompProfilePath ||
    fileURLToPath(new URL('../../deploy/seccomp-bwrap-minimal.json', import.meta.url))
  )
}

/** strict 参数组：SYS_ADMIN 保留 + no-new-privileges + 白名单 seccomp */
function strictSecurityArgs() {
  return [
    '--cap-add',
    'SYS_ADMIN',
    '--security-opt',
    'no-new-privileges',
    '--security-opt',
    `seccomp=${seccompProfilePath()}`,
    '--security-opt',
    'apparmor=unconfined',
  ]
}

/** compat 参数组：2026-09-22 之前的原样行为（应急回退档） */
function compatSecurityArgs() {
  return [
    '--cap-add',
    'SYS_ADMIN',
    '--security-opt',
    'seccomp=unconfined',
    '--security-opt',
    'apparmor=unconfined',
  ]
}

/** 供测试/诊断：按档位名拿参数组 */
export function securityArgsFor(mode) {
  return mode === 'strict' ? strictSecurityArgs() : compatSecurityArgs()
}

/**
 * docker run 失败是否**明确**因 seccomp profile 文件引起（daemon 侧读取/解析失败）。
 * 必须精确匹配——端口占用、名称冲突等其它错误要原样上抛，不能被降级逻辑吞掉。
 */
function isSeccompProfileRejected(err) {
  const text = `${err?.stderr ?? ''}\n${err?.message ?? ''}`
  return (
    /opening seccomp profile .*failed/i.test(text) || /error loading seccomp profile/i.test(text)
  )
}

/**
 * 用 strict 参数实跑一次 bwrap 探测。
 * @returns {Promise<boolean>} true = 该宿主 + 该镜像上 strict 可用
 */
async function probeStrictSecurity() {
  try {
    await sh(
      'docker',
      ['run', '--rm', ...strictSecurityArgs(), '--entrypoint', 'bwrap', IMAGE, ...BWRAP_PROBE_ARGS],
      { timeout: SECCOMP_PROBE_TIMEOUT_MS },
    )
    return true
  } catch (err) {
    // 探测不过 ≠ docker 坏了：容器本身用 compat 照样起（= 改动前行为）。
    // 真坏了的话，供应流程下一步的 docker run 会把原始错误爆出来。
    console.warn(
      `[docker] strict 安全参数组探测未通过（${String(err?.stderr || err?.message || 'unknown').split('\n')[0]}），` +
        'auto 模式将使用 compat（与 2026-09-22 之前行为一致）',
    )
    return false
  }
}

/**
 * 把 `docker images` 的体积字符串（如 "1.22GB" / "843MB" / "0B"）解析为字节数。
 *
 * 用于给管理员一个量级参考。解析失败返回 0（宁可为 0 也不报错——体积只是
 * 展示信息，不该让整个列表接口失败）。
 * @param {string} s
 * @returns {number}
 */
function parseDockerSize(s) {
  const m = String(s || '')
    .trim()
    .match(/^([\d.]+)\s*([kKMGT]?i?B)?$/)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  const unit = (m[2] || 'B').toUpperCase().replace('I', '')
  const factor = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit] ?? 1
  return Math.round(n * factor)
}

/**
 * 封装 execFile 为 Promise（带超时 + 超时错误标注）
 */
function sh(cmd, args, opts = {}) {
  const timeout = Number(opts.timeout ?? DEFAULT_TIMEOUT_MS)
  return new Promise((resolvePromise, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 16 * 1024 * 1024, ...opts, timeout },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout ?? '')
          err.stderr = String(stderr ?? '')
          // 超时/被杀：补一个可判定的标记，避免调用方把它当成普通业务错误
          if (err.killed || err.signal === 'SIGTERM') {
            err.code = err.code ?? 'ETIMEDOUT'
            err.timedOut = true
            err.stderr = `${err.stderr}\n[docker-cli] timed out after ${timeout}ms`.trim()
          }
          reject(err)
        } else {
          resolvePromise(String(stdout ?? '').trim())
        }
      },
    )
  })
}

/**
 * 探测镜像内 DSH 版本的单条 shell 命令（构建期校验与运行期查询共用同一份）。
 *
 * 两级读取：
 *   ① `/usr/local/share/dsh-version` —— 构建期写入，权威且已在构建时校验过
 *   ② 回退读包内 `package.json` —— 兼容**本次改动之前构建的旧镜像**
 *      （那时不写版本文件，但包本身有 version）
 *
 * 之所以不能只认 ①：线上现役镜像都是旧 Dockerfile 构建的，只认 ① 会让
 * 界面永远显示"版本未知"，管理员反而看不出自己落后了几个版本——而
 * "知道自己落后"正是这个功能存在的意义。
 *
 * 回退用 `sh` + `sed` 而非 `node`：镜像里一定有 /bin/sh，node 反而可能不在
 * PATH（或换了基础镜像）。也不用 `node -p require(...)`，避免依赖 Node
 * 模块解析路径。
 *
 * 抽成常量是为了让测试直接断言命令内容，不靠复制粘贴字符串。
 */
export const VERSION_PROBE_CMD =
  'cat /usr/local/share/dsh-version 2>/dev/null || ' +
  'sed -n "s/.*\\"version\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" ' +
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json 2>/dev/null | head -1'

export class DockerService {
  constructor() {
    /**
     * imageCapability 的缓存：Map<镜像名, { at, imageId, value }>。
     * 按镜像名分别记忆（本方法带 image 参数，可能查询不同镜像）；
     * 平台重建镜像后由 clearCapabilityCache() 显式失效。
     * @type {Map<string, { at: number, imageId: string|null, value: object }>}
     */
    this._capCache = new Map()
  }

  /**
   * 检查 Docker 是否可用
   */
  async isDockerAvailable() {
    try {
      await sh('docker', ['version'])
      return true
    } catch {
      return false
    }
  }

  /**
   * 查询容器是否存在及其运行状态
   */
  async containerInfo(name) {
    try {
      const out = await sh('docker', ['inspect', '--format', '{{.State.Status}}', name])
      return { exists: true, status: out }
    } catch {
      return { exists: false, status: 'missing' }
    }
  }

  /**
   * 查询容器实际映射到宿主的端口
   */
  async publishedPort(container) {
    try {
      // 先尝试从 NetworkSettings.Ports 获取（容器运行时的实际映射）
      const out = await sh('docker', [
        'inspect',
        '--format',
        '{{json .NetworkSettings.Ports}}',
        container,
      ])
      const parsed = JSON.parse(out)
      const binding = parsed?.['3080/tcp']?.[0]
      if (binding?.HostPort) return Number(binding.HostPort)
    } catch {
      // container gone / 格式异常
    }
    try {
      // 如果 NetworkSettings.Ports 为空，尝试从 HostConfig.PortBindings 获取（配置的目标端口）
      const configOut = await sh('docker', [
        'inspect',
        '--format',
        '{{json .HostConfig.PortBindings}}',
        container,
      ])
      const configMatch = configOut.match(/"3080\/tcp":\[.*?"HostPort":"(\d+)"/)
      if (configMatch) return Number(configMatch[1])
    } catch {
      // container gone
    }
    return null
  }

  /**
   * 创建并启动容器
   * @param {string} name 容器名
   * @param {number} internalPort 宿主回环端口（127.0.0.1 只本机可连；外部进路由网关代理）
   * @param {string} volume 租户数据卷名
   * @param {string} patchFile cordis patch 路径
   * @param {object} limits 资源限额
   */
  async createContainer(name, internalPort, volume, patchFile, limits, opts = {}) {
    // 磁盘配额防御：旧版配置用 tiers.*.memorySwap，无 disk 字段；缺失/非法时
    // 不传 --storage-opt（否则 btrfs/zfs 驱动会因 "size=undefined" 拒绝启动容器），
    // 并告警提示迁移（memorySwap → disk）。
    const diskQuota =
      typeof limits.disk === 'string' && /^\d+(\.\d+)?[kmgt]$/i.test(limits.disk)
        ? limits.disk
        : null
    if (!diskQuota) {
      console.warn(
        `[docker] disk quota missing/invalid for ${name} (disk=${limits.disk ?? 'undefined'})；` +
          '已跳过 --storage-opt。旧配置请把 tiers.*.memorySwap 改名为 disk 后重启。',
      )
    }
    // 宿主已确认不支持配额时直接不带该参数（避免每次创建都先失败一次再重试）
    const wantQuota = Boolean(diskQuota) && storageOptSupported !== false

    // 安全参数组（auto 会在首次调用时探测，见文件头"安全参数组"注释）
    const { securityArgs, allowSecFallback } = await this._resolveSecurityArgs()

    // 租户隔离网络（2026-10 审计 CRITICAL：default bridge 容器互访绕过网关）
    await ensureTenantNetwork()

    const buildArgs = (secArgs, withQuota) => [
      'run',
      '-d',
      '--name',
      name,
      // icc=false 隔离网（详见 TENANT_NETWORK 注释）；建网失败降级时不带，
      // 由 ensureTenantNetwork 的错误日志兜底可见性
      ...(_tenantNetDisabled ? [] : ['--network', TENANT_NETWORK]),
      '--restart',
      'unless-stopped',
      // 安全参数组说明见"安全参数组"注释块：strict = SYS_ADMIN 保留 +
      // no-new-privileges + 白名单 seccomp；compat = 旧行为（seccomp=unconfined）。
      // 仅对租户容器内部生效（容器本身就是租户隔离边界），不暴露给宿主。
      ...secArgs,
      '--memory',
      limits.memory,
      '--cpus',
      limits.cpus,
      '--pids-limit',
      String(limits.pids),
      // 日志轮转（disk-fix 缺口 E，2026-09）：租户 DSH web 访问日志 + 管理面板
      // 15s 轮询过网关 = 不轮转时 json-file 无限增长，Linux 生产最无声的磁盘
      // 杀手。每租户封顶 ~40MB（10m × 3 份）。docker update 不支持改日志驱动，
      // 存量容器随重建（空闲销毁/版本应用）渐进带上。
      // ⚠️ 与代激活配套：token 读取已改「tail→启动缓存→重启自愈」三段式
      //（dsh-auth.service.js），启动行滚出 tail 窗口也不会 401 死局——两边同车。
      '--log-opt',
      'max-size=10m',
      '--log-opt',
      'max-file=3',
      // 磁盘配额（尽力而为）：--storage-opt size= 只在支持配额的后端可用
      // （overlay2 需 xfs+pquota；btrfs/zfs 原生）。不支持的宿主会**整个拒绝**
      // 本次 docker run（exit 125），因此这里只在"已知支持"时才带上，
      // 并在下面捕获该拒绝后降级重试（见 isStorageOptUnsupported）。
      // 配额值缺失/非法时跳过本参数（见上方 diskQuota 防御）。
      ...(withQuota ? ['--storage-opt', `size=${diskQuota}`] : []),
      // 回环发布：外部网络物理不可达，只有宿主本机（网关）能连。
      // 用户浏览器访问的是网关的对外端口（0.0.0.0），网关转发到这里。
      '-p',
      `127.0.0.1:${internalPort}:3080`,
      '-v',
      `${volume}:/dsh-home`,
      '-v',
      `${patchFile}:/patches/tenant.patch.yml:ro`,
      // 允许按租户指定镜像（版本选择）；不传则用平台默认（latest）
      opts.image || IMAGE,
    ]

    // 两类降级（seccomp 文件被 daemon 拒 / 存储驱动不支持配额）各自最多
    // 触发一次、参数翻转后重试；guard 上限 = 初始 1 次 + 降级 2 次。
    let sec = securityArgs
    let quota = wantQuota
    let secFallbackArmed = allowSecFallback
    for (;;) {
      try {
        await sh('docker', buildArgs(sec, quota))
        return
      } catch (err) {
        // 降级 1：白名单 seccomp 文件 daemon 读不到/解析失败（如部署文件缺失）。
        // 只允许 auto 探出来的 strict 静默降一次；配置显式 strict 不回退——
        // 管理员点名要的文件没了，必须爆出来而不是悄悄换回 unconfined。
        if (secFallbackArmed && isSeccompProfileRejected(err)) {
          secFallbackArmed = false
          securityMode = 'compat'
          sec = compatSecurityArgs()
          console.warn(
            `[docker] 白名单 seccomp profile 被 daemon 拒绝（容器 ${name}），` +
              `确认文件存在且 docker 用户可读：${seccompProfilePath()}；` +
              '本进程后续供应已降级为 compat（seccomp=unconfined）。',
          )
          continue
        }
        // 降级 2：宿主不支持磁盘配额：去掉该参数重试一次，让容器照常起来。
        // 只在这一种明确原因下降级 —— 其它错误必须原样上抛。
        if (quota && isStorageOptUnsupported(err)) {
          quota = false
          storageOptSupported = false
          console.warn(
            `[docker] 宿主存储驱动不支持 --storage-opt size=${diskQuota}（容器 ${name}）：` +
              '已降级为不限制磁盘后重试。如需硬配额，宿主需 overlay2 + xfs(pquota) 或 btrfs/zfs。',
          )
          continue
        }
        throw err
      }
    }
  }

  /**
   * 决定本次供应使用的安全参数组。
   * auto：未定档时跑一次探测（并发调用共享同一次探测），探测过就缓存。
   * strict/compat：显式配置不探测；strict 同时关闭 run 时降级重试。
   * @returns {Promise<{securityArgs: string[], allowSecFallback: boolean}>}
   */
  async _resolveSecurityArgs() {
    const mode = configuredPrivilegeProfile()
    if (mode === 'strict') return { securityArgs: strictSecurityArgs(), allowSecFallback: false }
    if (mode === 'compat') return { securityArgs: compatSecurityArgs(), allowSecFallback: false }
    // auto
    if (!securityMode) {
      securityProbeInflight ??= probeStrictSecurity()
        .then((ok) => {
          securityMode = ok ? 'strict' : 'compat'
          console.log(
            `[docker] 安全参数组 auto 探测完成 → ${securityMode}` +
              (securityMode === 'strict'
                ? '（SYS_ADMIN+no-new-priv+白名单seccomp）'
                : '（维持现状：seccomp=unconfined）'),
          )
          return securityMode
        })
        .finally(() => {
          securityProbeInflight = null
        })
      await securityProbeInflight
    }
    return {
      securityArgs: securityMode === 'strict' ? strictSecurityArgs() : compatSecurityArgs(),
      allowSecFallback: true,
    }
  }

  /**
   * 启动容器（实际执行 restart 以确保端口映射恢复）。
   *
   * 与 restartContainer 的实现从建立之日起就一字不差（2026-09 查重确认）；
   * 保留两个名字只为调用方语义——"把停着的捞起来" vs "把跑着的重启"，
   * 实现单源于此，行为零变化（`docker start` 不恢复端口映射的老坑仍在注释里）。
   */
  async startContainer(name) {
    await this.restartContainer(name)
  }

  /**
   * 重启容器
   */
  async restartContainer(name) {
    await sh('docker', ['restart', name])
  }

  /**
   * 停止容器（支持优雅宽限：先 SIGTERM，宽限超时后 SIGKILL）
   * @param {string} name 容器名
   * @param {number} [graceSeconds] SIGTERM 后等待秒数，默认 10
   */
  async stopContainer(name, graceSeconds = 10) {
    await sh('docker', ['stop', '-t', String(graceSeconds), name])
  }

  /**
   * 删除容器（保留数据卷）
   */
  async removeContainer(name) {
    await sh('docker', ['rm', name])
  }

  /**
   * 删除数据卷
   */
  async removeVolume(name) {
    await sh('docker', ['volume', 'rm', name])
  }

  /**
   * 列出全量 docker 卷名
   */
  async listVolumes() {
    try {
      const out = await sh('docker', ['volume', 'ls', '--format', '{{.Name}}'])
      return out.split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * 所有容器（含已停止）当前挂载引用的卷名集合
   * （清理孤儿卷时用于排除"仍有容器在用"的卷，避免误删）
   */
  async listReferencedVolumes() {
    const refs = new Set()
    try {
      const out = await sh('docker', ['ps', '-a', '--format', '{{.Names}}'])
      const names = out.split('\n').filter(Boolean)
      for (const name of names) {
        const info = await this.inspectContainer(name)
        for (const mount of info?.Mounts || []) {
          if (mount.Name) refs.add(mount.Name.toLowerCase())
        }
      }
    } catch {
      /* 返回已收集到的引用（尽力而为） */
    }
    return refs
  }

  /**
   * 强制删除容器
   */
  async forceRemoveContainer(name) {
    try {
      await sh('docker', ['rm', '-f', name])
    } catch {
      // already gone
    }
  }

  // ---------------------------------------------------------------------------
  // 镜像 / DSH 版本
  // ---------------------------------------------------------------------------

  /**
   * 镜像 ID（如 sha256:...）；不存在返回 null
   */
  /**
   * 所有容器（含已停止）与其镜像 ID、状态的对应关系。
   *
   * 删镜像时需要**看见**谁在用：运行中的容器删了镜像会直接影响业务，
   * 已停止的容器删了镜像会再也起不来。只给一个布尔值不够，必须能列出来。
   *
   * @returns {Promise<Array<{name:string, imageId:string|null, state:string}>>}
   */
  async listContainerImages() {
    const out = await sh('docker', ['ps', '-a', '--format', '{{.Names}}|{{.State}}'])
    const rows = []
    for (const line of out.split('\n').filter(Boolean)) {
      const [name, state] = line.split('|')
      if (!name) continue
      rows.push({
        name: name.trim(),
        state: (state || '').trim(),
        imageId: await this.containerImageId(name.trim()),
      })
    }
    return rows
  }

  /**
   * 所有容器（含已停止）当前引用的**真实镜像 ID** 集合。
   *
   * 用途：删镜像前的安全校验 —— 只要还有容器（哪怕已停止）钉在这个镜像上就不能删，
   * 否则那些容器会变成无法启动的僵尸。宁可漏删也不能误删。
   *
   * 必须用 `inspect` 逐个取 `{{.Image}}`（完整 sha256），**不能**用
   * `docker ps --format '{{.Image}}'`：后者对"镜像被 tag 引用"的容器返回的是
   * **名字**（如 `dsh-multitenant:latest`），对已悬空的返回短 ID。
   * 名字永远匹配不上 sha256 → 该容器会被漏判 → 可能误删它正在用的镜像。
   *
   * 任一容器 inspect 失败时抛错（并由调用方按"拿不到引用集合"保守处理），
   * 因为静默漏掉一个引用就等于放行一次误删。
   * @returns {Promise<Set<string>>} 形如 sha256:xxx
   */
  async listReferencedImageIds() {
    const refs = new Set()
    const out = await sh('docker', ['ps', '-a', '--format', '{{.Names}}'])
    const names = out.split('\n').filter(Boolean)
    for (const name of names) {
      const id = await this.containerImageId(name)
      if (!id) {
        // 拿不到某个容器的镜像 → 不能假装它不存在，交给调用方保守处理
        throw new Error(`无法确认容器 ${name} 引用的镜像，拒绝在信息不全时删除镜像`)
      }
      refs.add(id)
    }
    return refs
  }

  /**
   * 本地镜像清单（含 tag、体积、创建时间）。
   *
   * 体积由 `docker images` 的 Size 字符串解析为字节数，便于前端求和展示。
   * 注意：该数值是"镜像独占层"大小，多镜像共享层时直接相加会高估——
   * 仅用于给管理员一个量级参考，不作为精确回收量。
   * @returns {Promise<Array<{id:string, repository:string, tag:string, sizeBytes:number, createdAt:string}>>}
   */
  async listImages() {
    try {
      const out = await sh('docker', [
        'images',
        '--format',
        '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedAt}}',
      ])
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [id, repository, tag, size, createdAt] = line.split('|')
          return {
            id: (id || '').trim(),
            repository: (repository || '').trim(),
            tag: (tag || '').trim(),
            sizeBytes: parseDockerSize(size),
            createdAt: (createdAt || '').trim(),
          }
        })
    } catch {
      return []
    }
  }

  /**
   * 用 Dockerfile 特征识别"本项目的镜像"，返回这些镜像的短 ID。
   *
   * 为什么需要：平台只记录自己成功走完构建流程的镜像（`dsh-image.json` 历史）。
   * 中途失败、手工 `docker build`、或早先版本留下的悬空镜像**不在历史里**，
   * 只靠历史认领会把它们当成"别人的镜像"而永远清不掉（实测就有过一个 843MB 的）。
   *
   * 只对**无 tag** 的镜像逐个 inspect（带 tag 的已由仓库名/历史认出，无需付费），
   * 命中 `DSH_HOME` / `DSH_TELEMETRY_DISABLED` / `DSH_VERSION` 任一即认定是本项目。
   * inspect 失败一律返回"不是"，宁可漏认也不误报别人的镜像。
   *
   * @param {Array<{id:string, repository:string, tag:string}>} images listImages() 的结果
   * @returns {Promise<Set<string>>} 认定属于本项目的镜像短 ID
   */
  async listUntaggedBySignature(images = []) {
    const suspects = images.filter(
      (im) => (!im.tag || im.tag === '<none>') && (!im.repository || im.repository === '<none>'),
    )
    const ours = new Set()
    for (const im of suspects) {
      try {
        const out = await sh('docker', ['inspect', im.id, '--format', '{{json .Config.Env}}'])
        if (/DSH_HOME|DSH_TELEMETRY_DISABLED|DSH_VERSION/.test(out)) ours.add(im.id)
      } catch {
        // 拿不到就不认领
      }
    }
    return ours
  }

  /**
   * 列出"可以指定给某个租户运行"的本地镜像（租户镜像选择用）。
   *
   * 只列**带版本 tag** 的镜像：无 tag 的悬空构建虽然按 ID 也能跑，但对管理员来说
   * 没有版本语义（无法判断该选哪个），只会让下拉框出现重复且看不懂的条目；
   * 它们属于"占用空间"的问题，由镜像清理负责。
   *
   * 为什么需要这个能力：平台原来只能把租户升到 `latest`（最新构建的那个），
   * 既不能回滚到旧版本，也不能让不同租户跑不同版本。有了它，租户可以**钉版本**。
   *
   * @param {string} image 镜像仓库名（含或不含 tag 都可，会取仓库名部分）
   * @returns {Promise<Array<{ref:string, version:string, imageId:string, createdAt:string}>>}
   */
  async listAvailableImages(image = IMAGE) {
    const repo = image.split(':')[0]
    const tags = await this.listLocalVersionTags(repo)
    return (
      tags
        .filter((t) => t.version && t.version !== '<none>')
        // 版本降序，latest 置顶（它是"默认走哪个"的答案，管理员最常选）
        .sort((a, b) => {
          if (a.version === 'latest') return -1
          if (b.version === 'latest') return 1
          return String(b.version).localeCompare(String(a.version), undefined, { numeric: true })
        })
        .map((t) => ({
          ref: `${repo}:${t.version}`,
          version: t.version,
          imageId: t.imageId,
          createdAt: t.createdAt,
        }))
    )
  }

  /**
   * 删除镜像（按 ID，精确删除，绝不使用 `docker image prune`）。
   *
   * 为什么必须精确到 ID：这台机器上同时跑着其它项目（k8s / 各种业务镜像），
   * `prune -a` 会把它们一起删掉且未必能重新拉回。调用方负责先做安全校验。
   * @param {string[]} ids
   * @returns {Promise<{removed: string[], failed: Array<{id:string, error:string}>}>}
   */
  async removeImages(ids) {
    const removed = []
    const failed = []
    for (const id of ids) {
      try {
        await sh('docker', ['rmi', id])
        removed.push(id)
      } catch (err) {
        failed.push({ id, error: err?.message || String(err) })
      }
    }
    return { removed, failed }
  }

  async imageId(image = IMAGE) {
    try {
      const out = await sh('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
      return out.trim() || null
    } catch {
      return null
    }
  }

  /**
   * 把任意本地镜像**钦定为平台默认**。
   *
   * 语义 = `docker tag <ref> <IMAGE>`（IMAGE 即创建容器时 opts.image 缺位的
   * 兜底，通常是 dsh-multitenant:latest）。纯元数据操作：不动任何容器与卷；
   * 新连接/重建的租户从此用这个镜像，已在跑的租户不受影响（切换它们在面板
   * 点"应用"）。调用方（路由层）负责：管理员会话 + 当场签名 + 镜像存在性
   * + 内嵌版本可读（"是不是本项目的镜像"的权威判定），这里只执行改 tag。
   *
   * @param {string} ref 形如 repo:tag 或镜像 ID 的本地镜像引用
   */
  async setDefaultImage(ref) {
    await sh('docker', ['tag', ref, IMAGE])
    return { defaultRef: IMAGE, imageId: await this.imageId(IMAGE) }
  }

  /**
   * 读取镜像内【实际烘焙】的 DSH 版本（权威值）。
   *
   * 镜像内 /usr/local/share/dsh-version 由 Dockerfile 在装完 npm 包后写入，
   * 记录的是"解析后的真实版本"——而 LABEL dsh.version 记的是构建参数
   * （可能是 latest，没有信息量）。旧镜像没有该文件，返回 null。
   * @returns {Promise<string|null>}
   */
  /**
   * 镜像内实际的 DSH 版本。
   *
   * 读取逻辑见 {@link VERSION_PROBE_CMD}（含"为什么必须有回退"的说明）。
   *
   * @param {string} image
   * @returns {Promise<string|null>} 读不到返回 null（界面据此显示"未知"）
   */
  async imageDshVersion(image = IMAGE) {
    try {
      const out = await sh('docker', [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        image,
        '-c',
        VERSION_PROBE_CMD,
      ])
      const v = out.trim().split('\n')[0]?.trim()
      return v || null
    } catch {
      return null
    }
  }

  /**
   * 当前租户镜像的"版本 + 能力"（带缓存）。
   *
   * 为什么要缓存：读取版本要 `docker run` 起一个临时容器，秒级开销。
   *   - finalizeTenant 每次建容器都要它 → 不缓存会明显拖慢建容器
   *   - check-rpc / 空闲检测每次轮询也要它 → 不缓存会造成持续开销
   *
   * 缓存键是**镜像 ID**，不是镜像名：ID 变了（管理员重建了镜像）就自动失效，
   * 不需要任何显式清除逻辑。这与"容器记录的是创建时镜像 ID"是同一套语义。
   *
   * 读不到版本时 requiresToken 返回 null（未知），调用方必须保守处理 ——
   * 绝不能把未知当"老版本可直通"，否则新镜像会让用户撞上看不懂的英文 401。
   *
   * @returns {Promise<{version: string|null, requiresToken: boolean|null,
   *                    imageId: string|null, tokenAuthSince: string}>}
   */
  async imageCapability(image = IMAGE) {
    // 缓存命中判定放在最前面：命中时**不执行任何 docker 命令**。
    // （早期版本先 docker inspect 取镜像 ID 再比对，缓存命中仍要 ~800ms，
    //   而 check-rpc 空闲检测会高频调用它，缓存就失去意义了。）
    // 短 TTL 兜底"管理员在别处重建了镜像"的情况；平台自己构建镜像后
    // 会显式调用 clearCapabilityCache()，所以正常路径不会用到 TTL。
    //
    // 缓存**按镜像名分别记忆**（Map），不能只存一份：本方法带 image 参数，
    // 调用方可能针对不同镜像查询（如管理端对比 latest 与某个版本标签）。
    // 只存一份会让第二次查询直接复用第一个镜像的结论——实测把
    // dsh-multitenant:latest(0.1.5-rc.1) 与 verify-011(0.1.1-rc.2)
    // 一起查时，后者被误报成前者，且 cached=true 掩盖了错误。
    const now = Date.now()
    const hit = this._capCache.get(image)
    if (hit && now - hit.at < CAPABILITY_CACHE_TTL_MS) {
      return { ...hit.value, cached: true }
    }

    const imageId = await this.imageId(image)
    const version = await this.imageDshVersion(image)
    const value = {
      version,
      // null = 无法判定（版本缺失/无法解析），调用方须按"未知"保守处理
      requiresToken: requiresToken(version),
      imageId,
      tokenAuthSince: DSH_TOKEN_AUTH_SINCE,
      cached: false,
    }
    this._capCache.set(image, { at: now, imageId, value })
    return value
  }

  /**
   * 清空能力缓存。平台成功构建/切换镜像后必须调用，
   * 否则最长 CAPABILITY_CACHE_TTL_MS 内仍按旧镜像的能力判定。
   * bwrap 随镜像走，所以安全参数组的 auto 探测结果也在这里失效。
   */
  clearCapabilityCache() {
    this._capCache.clear()
    clearDshVersionCache()
    if (configuredPrivilegeProfile() === 'auto') {
      securityMode = null
      securityProbeInflight = null
    }
  }

  /**
   * 容器创建时所用的镜像 ID（不受之后 latest 被重指的影响）。
   * 这是判断"租户是否还在旧镜像上"的唯一可靠依据。
   * @returns {Promise<string|null>}
   */
  async containerImageId(name) {
    try {
      const out = await sh('docker', ['inspect', '--format', '{{.Image}}', name])
      return out.trim() || null
    } catch {
      return null
    }
  }

  /**
   * 容器内**实际安装**的 DSH 版本（`dsh --version`）。
   *
   * 为什么不读 state.baseImageVersion：那是"创建/重建时记录"的值，实测会漂
   * （平台把当前镜像版本回落到 0.1.1-rc.1 时，容器里其实装着 0.1.5-rc.1），
   * 管理员看到的版本必须是容器真实在跑的那个。
   *
   * 缓存按**镜像 ID** 键：同一镜像的所有容器版本必然相同，避免每次刷新都 exec。
   * 版本不会变（要变就换镜像 ID），所以缓存不过期；并发 exec 合并为一次。
   *
   * @param {string} name 容器名
   * @returns {Promise<string|null>} 容器不存在/未运行时 null
   */
  async containerDshVersion(name) {
    const imageId = await this.containerImageId(name)
    if (!imageId) return null
    if (dshVersionByImageId.has(imageId)) return dshVersionByImageId.get(imageId)
    if (dshVersionInflight.has(imageId)) return dshVersionInflight.get(imageId)

    const p = (async () => {
      try {
        // 一定要读"容器里"的二进制；容器未运行时 docker exec 会失败 → null
        const out = await sh('docker', ['exec', name, 'dsh', '--version'])
        const v = out.trim().split('\n')[0]?.trim() || null
        if (v) dshVersionByImageId.set(imageId, v)
        return v
      } catch {
        return null
      } finally {
        dshVersionInflight.delete(imageId)
      }
    })()

    dshVersionInflight.set(imageId, p)
    return p
  }

  /**
   * 构建指定 DSH 版本的新镜像。
   *
   * 注意超时：构建要编译 node-pty（见 Dockerfile），必须远大于普通命令的
   * 默认 120s，否则会被中途掐死。默认 30 分钟，可用 BUILD_TIMEOUT_MS 覆盖。
   *
   * @param {string} dshVersion 目标 DSH 版本（'latest' 或确切版本号）
   * @param {{context?: string, image?: string, tagVersion?: boolean}} opts
   * @returns {Promise<{version: string|null, imageId: string|null, tag: string|null}>}
   */
  async buildImage(dshVersion, opts = {}) {
    const image = opts.image || IMAGE
    const context = opts.context || process.env.DSH_BUILD_CONTEXT || '.'
    const timeout = Number(process.env.BUILD_TIMEOUT_MS || 30 * 60 * 1000)

    // 确切版本时额外打版本 tag：latest 被下个版本覆盖后，这是回滚的唯一退路
    const tagVersion = opts.tagVersion ?? dshVersion !== 'latest'
    const tag = tagVersion ? `${image.split(':')[0]}:${dshVersion}` : null

    const args = ['build', '--build-arg', `DSH_VERSION=${dshVersion}`, '-t', image]
    if (tag) args.push('-t', tag)
    args.push(context)

    // 构建窗口对维护任务互斥（见 isImageBuilding / maintenance.service）
    buildDepth++
    try {
      await sh('docker', args, { timeout })
    } finally {
      buildDepth--
    }

    return {
      version: await this.imageDshVersion(image),
      imageId: await this.imageId(image),
      tag,
    }
  }

  /**
   * 本地已有的版本 tag 列表（dsh-multitenant:<版本>）
   * 供管理端展示"可回滚的版本"
   */
  async listLocalVersionTags(image = IMAGE) {
    const repo = image.split(':')[0]
    try {
      const out = await sh('docker', [
        'image',
        'ls',
        repo,
        '--format',
        '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}',
      ])
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [full, id, createdAt] = line.split('\t')
          return { tag: full, version: full.split(':')[1], imageId: id, createdAt }
        })
    } catch {
      return []
    }
  }

  /**
   * 更新容器资源配额（热更新）
   * 注：docker update 不支持 --storage-opt，磁盘配额须在重建容器时应用（见 createContainer）
   */
  async updateContainer(name, limits) {
    await sh('docker', [
      'update',
      '--memory',
      limits.memory,
      '--cpus',
      limits.cpus,
      '--pids-limit',
      String(limits.pids),
      name,
    ])
  }

  /**
   * 获取容器资源使用统计
   */
  async getContainerStats(containerName) {
    try {
      const out = await sh('docker', [
        'stats',
        '--no-stream',
        '--format',
        '{"cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","memPercent":"{{.MemPerc}}","net":"{{.NetIO}}","block":"{{.BlockIO}}"}',
        containerName,
      ])
      return JSON.parse(out)
    } catch {
      return null
    }
  }

  /**
   * 轮询等待容器就绪
   */
  /**
   * 等待容器内 DSH 真正开始监听 HTTP。
   *
   * ⚠ 判定标准是"**拿到了 HTTP 响应**"，不是"返回 200"。
   *
   * 原因：本方法探测的是容器内部回环端口，也就是**直接打 DSH、不经过租户网关**。
   * 而 DSH 对未认证请求返回 **401**（认证挑战）——那是"服务活着"的证据，
   * 不是"服务没起来"。早期版本只认 `res.ok`（2xx），于是：
   *   容器 1 秒内启动完毕、401 稳定返回 → 却被判为未就绪 → 死等满 120s →
   *   回滚销毁容器。用户侧表现为"一直卡在正在建立容器连接…"。
   *
   * 反向风险很小：Connection refused / DNS 失败会走 catch（仍算未就绪）；
   * 而 4xx/5xx 只能由"已经在跑并解析了 HTTP 的进程"产生。真正的可用性问题
   * （如 5xx 循环）由后续的网关监听与用户请求暴露，不该由就绪探测重复把关。
   *
   * @param {number} port 容器内部回环端口
   * @param {number} timeoutMs 最长等待
   * @returns {Promise<boolean>}
   */
  /**
   * 采集容器"起不来"的现场信息：状态 / 退出码 / 是否 OOM / 内存上限 / 日志尾部。
   *
   * 为什么需要：原来启动失败只抛一句 "did not become ready after restart"，
   * 既没说容器是崩了还是没监听，也没带日志 —— 远程排查必须上机器 `docker logs`，
   * 而 finalizeTenant 失败时还会**回滚删容器**，日志随之永久消失。
   * 这里把现场拼成一段可读文本带进错误里；诊断本身绝不抛错。
   *
   * @param {string} name 容器名
   * @param {number} [tailLines] 日志尾部行数
   * @returns {Promise<string>}
   */
  async containerDiagnostics(name, tailLines = 30) {
    const parts = []
    try {
      const fmt =
        'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} ' +
        'error={{.State.Error}} memLimit={{.HostConfig.Memory}}'
      parts.push(await sh('docker', ['inspect', '--format', fmt, name]))
    } catch (err) {
      parts.push(`inspect 失败: ${err.message}`)
    }
    try {
      // docker logs 的容器 stderr 走进程 stderr：必须合并采集，否则丢关键行
      const logs = await shCaptureBoth('docker', ['logs', '--tail', String(tailLines), name])
      parts.push(logs ? `--- 日志尾部(${tailLines} 行) ---\n${logs}` : '（容器无日志输出）')
    } catch (err) {
      parts.push(`日志读取失败: ${err.message}`)
    }
    return parts.join('\n')
  }

  /**
   * 确保 DSH 会话的默认工作目录存在（幂等，失败只记日志）。
   *
   * 为什么需要：DSH 新建会话时 cwd 默认取 $HOME/workspace（本镜像 /root/workspace）。
   * 该目录不存在时，bash 工具的沙箱以它作为 spawn 的 cwd —— Node 在 cwd 不存在时
   * 也抛 ENOENT，而报错文案是 `spawn bwrap ENOENT`，于是被误判成"bwrap 没装"
   * （连 DSH 自己都这么提示），实际容器里所有 bash 命令都会失败。
   * 镜像已内置该目录（Dockerfile），这里再兜一层：老镜像建的容器也能自愈。
   *
   * @param {string} name 容器名
   * @param {string} [dir] 工作目录
   * @returns {Promise<boolean>} 是否成功（失败不影响容器启动）
   */
  async ensureDshWorkspace(name, dir = '/root/workspace') {
    try {
      await sh('docker', ['exec', name, 'mkdir', '-p', dir])
      return true
    } catch (err) {
      console.warn(`[docker] 创建 ${dir} 失败（容器 ${name}）：${err.message}`)
      return false
    }
  }

  /**
   * 批量取多个容器的实时 stats —— **一次 docker 进程**拿全部。
   *
   * 为什么需要：管理端列表每轮都要每个 running 租户跑一次 `docker stats`，
   * 租户多时就是 N 个进程；实测 2 个租户逐个 3.75s、批量 2.77s，租户越多差距越大。
   *
   * 容错：某个容器不存在/已停时它的名字不会出现在结果里（值为 null），
   * 整批失败（docker 不可用）时全部为 null —— 调用方按"未知"处理，绝不因此报错。
   *
   * @param {string[]} names 容器名
   * @returns {Promise<Map<string, {cpu:string,mem:string,memPercent:string}|null>>}
   */
  async getContainerStatsMany(names = []) {
    const map = new Map(names.map((n) => [n, null]))
    if (names.length === 0) return map
    try {
      const out = await sh('docker', [
        'stats',
        '--no-stream',
        '--format',
        '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}',
        ...names,
      ])
      for (const line of out.split('\n')) {
        const [name, cpu, mem, memPercent] = line.split('\t')
        if (!name || !map.has(name)) continue
        map.set(name, { cpu, mem, memPercent })
      }
    } catch (err) {
      console.warn(`[docker] 批量 stats 失败（${names.length} 个容器）：${err.message}`)
    }
    return map
  }

  /**
   * 隔离卷内某个文件：改名成 `<文件名>.broken-<时间戳>`，返回新路径。
   *
   * 用途：容器内 DSH 因配置文件损坏而起不来时的自愈 —— 把坏文件挪开，让 DSH
   * 用默认值启动。用"改名"而不是"删除"：内容留档，可人工抢救（例如里面的
   * API Key 可能只是格式坏了）。
   *
   * 注入安全：文件名与后缀经**位置参数**传入，不拼进脚本文本。
   *
   * @param {string} volume 数据卷名
   * @param {string} fileName 卷内文件名（相对卷根，如 .credentials.yaml）
   * @returns {Promise<string|null>} 新路径；文件不存在时返回 null
   */
  async quarantineVolumeFile(volume, fileName) {
    const suffix = `broken-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const out = await sh('docker', [
      'run',
      '--rm',
      '-v',
      `${volume}:/dsh-home`,
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      'f="/dsh-home/$1"; if [ -f "$f" ]; then mv "$f" "$f.$2"; echo "$f.$2"; fi',
      'sh',
      fileName,
      suffix,
    ])
    return out ? out.trim() : null
  }

  async waitReady(port, timeoutMs = STARTUP_TIMEOUT_MS, opts = {}) {
    const deadline = Date.now() + timeoutMs
    let lastAliveCheck = 0
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`)
        const s = res.status
        // 判据不能是"任何状态码"（早期实现用 res.status > 0）——那会把
        // "进程已监听但 web 接口还没挂载"误判成就绪。实测冷启动状态序列：
        //   +0.1s 连接被拒 → +32.6s 404 → +33.2s 401（DSH web 真正就绪）
        // 32.6s 放行后 /connect 立刻返回 URL，浏览器正好撞进这 0.6s 的 404 窗口，
        // 表现为「刚启动时第一次点进入没进去，第二三次才进去」。
        //
        // 就绪 = web 接口能服务：2xx/3xx 或 DSH 的 401（待认证）/403。
        // 404 与 5xx 是"还在挂载/内部未就绪"，继续等。
        if ((s >= 200 && s < 400) || s === 401 || s === 403) return true
      } catch {
        // 连接被拒 / 尚未监听，继续等
      }
      // 容器已经退出就不可能再就绪：每 5s 查一次存活，避免白等满超时
      // （线上实测：DSH 起不来时用户要等 120s 才看到一句含糊的报错）
      if (opts.containerName && Date.now() - lastAliveCheck > 5000) {
        lastAliveCheck = Date.now()
        const st = await this.containerInfo(opts.containerName)
        if (st.exists && st.status !== 'running') return false
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  /**
   * 列出所有 dsh-swtc- 容器
   */
  async listSwtcContainers() {
    try {
      const out = await sh('docker', [
        'ps',
        '-a',
        '--filter',
        'name=dsh-swtc-',
        '--format',
        '{{.Names}}',
      ])
      return out.split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * 列出容器内运行的进程数（宿主侧 docker top，无需进容器）
   * @param {string} name 容器名
   * @returns {Promise<number>} 进程数；容器不存在/停止返回 0
   */
  async topProcessCount(name) {
    try {
      const out = await sh('docker', ['top', name])
      const lines = out.split('\n').filter(Boolean)
      return Math.max(0, lines.length - 1) // 去掉表头
    } catch {
      return 0
    }
  }

  /**
   * 在租户镜像的辅助容器内执行一个卷脚本（挂载租户卷 + 宿主脚本）
   * @param {string} volume 租户数据卷名
   * @param {string} scriptHostPath 宿主脚本绝对路径
   * @param {string} scriptName 容器内脚本文件名
   * @param {string[]} [scriptArgs] 传给脚本的参数
   * @param {object} [opts] 选项：{ networkContainer: 共享该容器的网络命名空间 }
   * @returns {Promise<string>} 脚本 stdout
   */
  async runVolumeScript(volume, scriptHostPath, scriptName, scriptArgs = [], opts = {}) {
    const args = ['run', '--rm']
    if (opts.networkContainer) {
      args.push('--network', `container:${opts.networkContainer}`)
    }
    args.push(
      '-v',
      `${volume}:/dsh-home`,
      '-v',
      `${scriptHostPath}:/${scriptName}:ro`,
      IMAGE,
      'node',
      `/${scriptName}`,
      ...scriptArgs,
    )
    const out = await sh('docker', args)
    return out
  }

  /**
   * 检查容器详细配置
   */
  async inspectContainer(name) {
    try {
      const out = await sh('docker', ['inspect', name])
      return JSON.parse(out)[0]
    } catch {
      return null
    }
  }

  /**
   * Docker 数据根目录（daemon 侧路径，如 /var/lib/docker），带 10min 记忆。
   * 取不到返回 null（预检/监控自动回落 `/`——语义等于改造前的旧行为）。
   *
   * 为什么要它：`df -k /` 在 Linux 服务器上可能查的不是 Docker 数据所在
   * 分区（/var/lib/docker 独立挂载是常态），盘真满了预检反而全绿。
   * macOS Docker Desktop 上 DockerRootDir 是 VM 内路径、宿主不可达，
   * df 会失败 → 逐候选回落到 `/`（APFS 容器级，与宿主可用同源）。
   */
  async dockerDataRootDir() {
    const now = Date.now()
    if (this._dockerRootMemo && now - this._dockerRootMemo.at < 600000) {
      return this._dockerRootMemo.path
    }
    let path = null
    try {
      const out = await sh('docker', ['info', '--format', '{{.DockerRootDir}}'], { timeout: 10000 })
      const t = String(out ?? '').trim()
      if (t.startsWith('/')) path = t
    } catch {
      path = null
    }
    this._dockerRootMemo = { path, at: now }
    return path
  }

  /**
   * 对候选路径逐个 `df -k`，返回第一个解析成功的结果。
   * 候选：DockerRootDir（Linux 生产命中）→ `/`（macOS/异常回落）。
   * @returns {Promise<{totalKB:number,usedKB:number,availableKB:number,usePercent:string,checkedPath:string}|null>}
   */
  async _dfOnDockerTarget() {
    const targets = []
    const root = await this.dockerDataRootDir()
    if (root) targets.push(root)
    targets.push('/')
    for (const target of targets) {
      try {
        // -P（POSIX 输出）：设备名再长（如 /dev/mapper/ubuntu--vg-lv--0）也
        // 保证每分区一行，纯空白拆列——Linux 生产专用坑，BSD/macOS df 同样支持
        const out = await sh('df', ['-k', '-P', target])
        const lines = out.trim().split('\n')
        if (lines.length < 2) continue
        const parts = lines[lines.length - 1].split(/\s+/)
        const totalKB = parseInt(parts[1], 10)
        const availableKB = parseInt(parts[3], 10)
        if (!Number.isFinite(totalKB) || !Number.isFinite(availableKB)) continue
        return {
          totalKB,
          usedKB: parseInt(parts[2], 10) || 0,
          availableKB,
          usePercent: parts[4] || '0%',
          checkedPath: target,
        }
      } catch {
        // 该候选不可达（如 macOS 上的 VM 内路径），试下一个
      }
    }
    return null
  }

  /**
   * Docker 数据分区可用字节数（资源预检用，F1）。读不到返回 null——
   * 由调用方决定放行还是 fail-closed，探针只报事实。
   */
  async hostFreeBytes() {
    const raw = await this._dfOnDockerTarget()
    if (!raw) return null
    return {
      freeBytes: raw.availableKB * 1024,
      totalBytes: raw.totalKB * 1024,
      usePercent: raw.usePercent,
      checkedPath: raw.checkedPath,
    }
  }

  /**
   * 宿主磁盘使用情况（管理面板/磁盘监控用）。
   * F1 改造：查 Docker 数据分区而非写死 `/`；返回结构与旧版一致，
   * 多一个 checkedPath（面板可显示"查的是哪块盘"，失败语义不变：null）。
   */
  async hostDiskUsage() {
    try {
      const raw = await this._dfOnDockerTarget()
      if (!raw) return null
      return {
        totalKB: raw.totalKB,
        usedKB: raw.usedKB,
        availableKB: raw.availableKB,
        usePercent: raw.usePercent,
        path: raw.checkedPath,
      }
    } catch {
      return null
    }
  }

  /**
   * Docker 整体磁盘占用（docker system df）
   * 使用 --format 输出（| 分隔），避免 Local Volumes / Build Cache 多词类型名被空白拆开。
   * 返回各类型 { name, total, active, size, reclaimable } 列表，失败返回 null
   */
  async dockerDiskSummary() {
    try {
      const out = await sh('docker', [
        'system',
        'df',
        '--format',
        '{{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}|{{.Reclaimable}}',
      ])
      const items = out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, total, active, size, reclaimable] = line.split('|')
          return { name, total, active, size, reclaimable }
        })
      return { items }
    } catch {
      return null
    }
  }

  /**
   * 租户数据卷占用（docker system df -v，筛选 dsh-data-swtc-*）
   * 返回 [ { volume, size } ]，失败返回 null
   */
  async tenantVolumeUsage() {
    try {
      const out = await sh('docker', ['system', 'df', '-v'])
      const volumes = []
      out.split('\n').forEach((line) => {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 3 && parts[0].startsWith('dsh-data-swtc-')) {
          volumes.push({ volume: parts[0], size: parts[2] })
        }
      })
      return volumes
    } catch {
      return null
    }
  }

  /**
   * 单卷真实占用（du -s 实测，起一次临时容器）
   * 返回字节数；失败返回 null
   * 注：低频校正用途（如手动扫描/每日快照），勿在定时器热路径中逐卷调用。
   */
  async duVolumeSize(volume) {
    try {
      const out = await sh(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          'sh',
          '-v',
          `${volume}:/dsh-home`,
          IMAGE,
          '-c',
          'du -sb /dsh-home 2>/dev/null | cut -f1',
        ],
        // `du` 递归扫描大卷可能远超默认超时；给 10 分钟，避免把慢卷误判为失败
        { timeout: Number(process.env.DU_VOLUME_TIMEOUT_MS || 600000) },
      )
      const bytes = Number.parseInt(out, 10)
      return Number.isFinite(bytes) && bytes >= 0 ? bytes : null
    } catch {
      return null
    }
  }

  /**
   * 备份租户数据卷到宿主机目录（tar.gz）。
   *
   * 应用镜像/切换 DSH 版本属于"重建容器"操作，而版本间可能存在存储格式差异
   * （settings.yaml / sessions / storages）。回退时旧版本可能读不了新版本写入的
   * 数据——这是唯一可能真丢东西的风险，所以重建前必须留快照。
   *
   * 用只读挂载 + 独立 alpine 容器打包，不依赖租户容器本身（它此时可能已停止）。
   * @param {string} volume 卷名
   * @param {string} hostDir 宿主机目标目录（需已存在且可写）
   * @param {string} fileName 目标文件名（如 <address>-0.1.5-rc.1-1758000000000.tgz）
   * @returns {Promise<string>} 备份文件的宿主机路径
   */
  async backupVolume(volume, hostDir, fileName) {
    const timeout = Number(process.env.BACKUP_TIMEOUT_MS || 20 * 60 * 1000)
    await sh(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${volume}:/src:ro`,
        '-v',
        `${hostDir}:/dst`,
        'alpine:3',
        'tar',
        'czf',
        `/dst/${fileName}`,
        '-C',
        '/src',
        '.',
      ],
      { timeout },
    )
    return `${hostDir}/${fileName}`
  }
}

export const dockerService = new DockerService()
