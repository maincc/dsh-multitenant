/**
 * Docker 服务模块
 * 封装所有 Docker CLI 操作
 */

import { execFile } from 'node:child_process'
import { CONFIG } from '../config/config.js'
import { requiresToken, DSH_TOKEN_AUTH_SINCE } from './dsh-version.service.js'

const IMAGE = process.env.DSH_TENANT_IMAGE || CONFIG.docker.image
const STARTUP_TIMEOUT_MS = Number(process.env.STARTUP_TIMEOUT_MS || CONFIG.docker.startupTimeoutMs)

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

    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--restart',
      'unless-stopped',
      // DSH 的 bash 沙箱（bwrap）需要在这三个条件下才能工作：
      //   - --cap-add SYS_ADMIN：允许创建 mount/用户命名空间、pivot_root
      //   - --security-opt seccomp=unconfined：Docker 默认 seccomp profile
      //     会拦截 bwrap 的 namespace 创建与 pivot_root 系统调用
      //     （bwrap: Creating new namespace failed / pivot_root failed）
      //   - --security-opt apparmor=unconfined：Linux 主机 docker-default
      //     AppArmor profile 拦截 bwrap 的 mount 操作
      //     （bwrap: Failed to make / slave: Permission denied）
      // 仅对租户容器内部生效（容器本身就是租户隔离边界），不暴露给宿主。
      '--cap-add',
      'SYS_ADMIN',
      '--security-opt',
      'seccomp=unconfined',
      '--security-opt',
      'apparmor=unconfined',
      '--memory',
      limits.memory,
      '--cpus',
      limits.cpus,
      '--pids-limit',
      String(limits.pids),
      // 磁盘配额（尽力而为）：--storage-opt size= 只在支持配额的后端可用
      // （overlay2 需 xfs+pquota；btrfs/zfs 原生）。不支持的宿主会**整个拒绝**
      // 本次 docker run（exit 125），因此这里只在"已知支持"时才带上，
      // 并在下面捕获该拒绝后降级重试（见 isStorageOptUnsupported）。
      // 配额值缺失/非法时跳过本参数（见上方 diskQuota 防御）。
      ...(wantQuota ? ['--storage-opt', `size=${diskQuota}`] : []),
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
    try {
      await sh('docker', args)
    } catch (err) {
      // 宿主不支持磁盘配额：去掉该参数重试一次，让容器照常起来。
      // 只在这一种明确原因下降级 —— 其它错误必须原样上抛。
      if (wantQuota && isStorageOptUnsupported(err)) {
        storageOptSupported = false
        console.warn(
          `[docker] 宿主存储驱动不支持 --storage-opt size=${diskQuota}（容器 ${name}）：` +
            '已降级为不限制磁盘后重试。如需硬配额，宿主需 overlay2 + xfs(pquota) 或 btrfs/zfs。',
        )
        const i = args.indexOf('--storage-opt')
        const retryArgs = i === -1 ? args : [...args.slice(0, i), ...args.slice(i + 2)]
        await sh('docker', retryArgs)
      } else {
        throw err
      }
    }
  }

  /**
   * 启动容器（使用 restart 以确保端口映射恢复）
   */
  async startContainer(name) {
    // 使用 restart 而不是 start，因为 start 可能不会恢复端口映射
    await sh('docker', ['restart', name])
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
   */
  clearCapabilityCache() {
    this._capCache.clear()
    clearDshVersionCache()
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

    await sh('docker', args, { timeout })

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
   * 宿主磁盘使用情况（df -k /）
   * 返回 { totalKB, usedKB, availableKB, usePercent }，失败返回 null
   */
  async hostDiskUsage() {
    try {
      const out = await sh('df', ['-k', '/'])
      const lines = out.split('\n')
      if (lines.length < 2) return null
      const parts = lines[1].split(/\s+/)
      return {
        totalKB: parseInt(parts[1], 10) || 0,
        usedKB: parseInt(parts[2], 10) || 0,
        availableKB: parseInt(parts[3], 10) || 0,
        usePercent: parts[4] || '0%',
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
