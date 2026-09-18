/**
 * DSH 版本列表服务
 *
 * 职责：从 npm registry 拉取 @deepseek-ai/dsh 的可用版本，按 dist-tag 分组，
 * 供管理端选择"升级到哪个版本 / 回退到哪个版本"。
 *
 * 设计要点：
 *   - 带 TTL 缓存：这是网络调用，不能每个请求都打 registry；且刷新失败时
 *     回退到旧缓存（registry 不可达不应让整个版本页失效）
 *   - 失败不抛：返回 { ok:false, error }，由路由层决定如何呈现
 *   - 预发布识别：版本号含 '-'（如 0.1.6-alpha.1、0.1.5-rc.1）即为预发布。
 *     DSH 版本决定容器内安全边界（bash 沙箱等），因此默认把预发布折叠起来，
 *     只展示 latest，避免"一键换成早期宽松版本"成为最短路径。
 */

import { execFile } from 'node:child_process'
import { mkdirSync, accessSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG } from '../config/config.js'

const PACKAGE = '@deepseek-ai/dsh'

/** 平台根目录 / 数据目录（npm 缓存兜底位置放这儿，容器里也稳） */
const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)))
const DATA_ROOT = join(ROOT, 'data')

/** 预发布版本号形如 0.1.5-rc.1 / 0.1.6-alpha.1 → 含 '-' 即预发布 */
function isPrerelease(version) {
  return String(version).includes('-')
}

/** 粗排序键：正式 > 预发布，其余按字典序（不做完整 semver 实现，够用） */
function sortVersions(list) {
  return [...list].sort((a, b) => {
    const pa = isPrerelease(a)
    const pb = isPrerelease(b)
    if (pa !== pb) return pa ? 1 : -1 // 正式的排前面
    return b.localeCompare(a, undefined, { numeric: true })
  })
}

// ---------------------------------------------------------------------------
// DSH 能力判定：该版本是否要求「浏览器认证」
// ---------------------------------------------------------------------------

/**
 * DSH 引入浏览器认证（`dsh web authentication required` + `?token=` 激活）
 * 的首个版本。
 *
 * 为什么需要这个常量：从该版本起，DSH 的 `/` 与 `/api` 都被一层"绑定
 * authority 的签名 cookie"保护，必须先用进程级 launch token 激活才能访问。
 * 而在本平台里，用户永远拿不到那个 token —— token 是容器**进程级**的，
 * 激活 URL 指向容器内的 `127.0.0.1:3080` / 容器内网 IP，浏览器都够不着。
 * 于是从该版本起，"网关放行即进容器"这个前提被破坏了。
 *
 * 分界线经**逐版本下载 tarball 实际验证**（不是推断）：
 *   无认证：0.0.1-rc.1 … 0.1.1-rc.2        （10 个版本，token 字样 0 次）
 *   有认证：0.1.2-alpha.2 … 0.1.6-alpha.1  （11 个版本）
 * 中间没有任何回退，所以一个下界常量即可完整表达。
 */
export const DSH_TOKEN_AUTH_SINCE = '0.1.2-alpha.2'

/** 解析版本号为可比较的部分：[major, minor, patch, preKind, preNum]
 *  preKind：正式版为 Infinity（比任何预发布都"新"），alpha=0 < rc=1。
 *  预发布之间按类型再按序号比较（0.1.5-alpha.2 < 0.1.5-rc.1 < 0.1.5）。
 */
function parseVersionParts(version) {
  // 去掉可能的前缀（如 v1.2.3 → 1.2.3）
  const str = String(version ?? '')
    .trim()
    .replace(/^v/i, '')
  const m = str.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([A-Za-z]+)\.?(\d+)?)?/)
  if (!m) return null
  const nums = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)]
  if (!nums.every(Number.isSafeInteger)) return null
  const kind = m[4]
  if (kind === undefined) return [...nums, Number.POSITIVE_INFINITY, 0]
  const rank = kind.toLowerCase() === 'alpha' ? 0 : kind.toLowerCase() === 'rc' ? 1 : 0.5
  return [...nums, rank, Number(m[5] ?? 0)]
}

/**
 * 比较两个 DSH 版本：a < b 返回负数，相等返回 0，a > b 返回正数。
 * 解析失败返回 null（调用方必须把它当作"未知"处理，不能猜）。
 */
function compareVersions(a, b) {
  const pa = parseVersionParts(a)
  const pb = parseVersionParts(b)
  if (!pa || !pb) return null
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

/**
 * 该 DSH 版本是否要求浏览器认证（即是否需要 token 才能进容器）。
 *
 * @param {string|null|undefined} version
 * @returns {boolean|null} true=需要 token；false=不需要（老版本，可直通）；
 *   **null=无法判定**（版本缺失/格式无法解析）。调用方必须把 null 当作
 *   "未知"并采取保守策略，绝不能当成 false —— 否则新镜像会被误当老镜像直通，
 *   用户撞上看不懂的英文 401，而管理员在控制台看不到任何线索。
 */
export function requiresToken(version) {
  if (!version || typeof version !== 'string') return null
  const cmp = compareVersions(version, DSH_TOKEN_AUTH_SINCE)
  if (cmp === null) return null
  return cmp >= 0
}

/**
 * 面向管理端/日志的可读说明（解释"为什么这个版本进不去"）。
 * @returns {string|null}
 */
export function describeTokenRequirement(version) {
  const need = requiresToken(version)
  if (need === null) {
    return `无法判定 DSH 版本 ${version ?? '(未知)'} 是否要求浏览器认证`
  }
  if (need) {
    return `DSH ${version} 要求浏览器认证（自 ${DSH_TOKEN_AUTH_SINCE} 起引入），平台尚未代做激活，进入容器会被拒绝；可回退到 ≤ 0.1.1-rc.2 的版本`
  }
  return `DSH ${version} 不需要浏览器认证，网关放行即可进入`
}

class DshVersionService {
  constructor() {
    /** @type {{ at: number, data: object } | null} */
    this._cache = null
    /** 防并发打 registry：同一时刻只允许一个在途请求 */
    this._inflight = null
    /**
     * npm 缓存目录（惰性解析，见 _resolveCacheDir）。
     * @type {string|null|undefined} undefined=未解析
     */
    this._cacheDir = undefined
  }

  get ttlMs() {
    return Number(CONFIG.dsh?.versionCacheTtlMs ?? 600000)
  }

  get registry() {
    return CONFIG.dsh?.registry || 'https://registry.npmjs.org'
  }

  /**
   * 解析一个**确定可写**的 npm 缓存目录，避免 `npm view` 因 `~/.npm` 不可写而
   * 直接 EPERM 失败。
   *
   * 真实故障：宿主 `~/.npm/_cacache` 里有 root 拥有的文件（历史 npm 在所有
   * 者为 root 时留下），平台以普通用户运行 → 每次读版本列表都报
   *   EPERM ... path /Users/<u>/.npm/_cacache/tmp/***
   * 用户看到"无法获取 DSH 版本列表"，而**平台其它功能完全正常**。
   *
   * 注意：缓存目录与 registry 无关（registry 由 `--registry` 显式指定），所以
   * 把缓存挪到可写目录不会改变"用哪个源"的语义。
   *
   * 顺序：显式配置 > 平台的 data/ 下（容器里稳）> 系统临时目录。
   * @returns {string|null} null = 让 npm 用默认位置
   */
  _resolveCacheDir() {
    if (this._cacheDir !== undefined) return this._cacheDir

    const configured = CONFIG.dsh?.npmCacheDir
    if (configured) {
      this._cacheDir = configured
      return configured
    }

    const candidates = [join(DATA_ROOT, 'npm-cache'), join(tmpdir(), 'dsh-multitenant-npm-cache')]
    for (const dir of candidates) {
      try {
        mkdirSync(dir, { recursive: true })
        accessSync(dir, constants.W_OK)
        this._cacheDir = dir
        return dir
      } catch {
        // 试下一个
      }
    }
    // 都不可写 → 交回 npm 默认行为（它自己会给出更原始的报错）
    this._cacheDir = null
    return null
  }

  /**
   * 拉取 registry 元数据（npm view --json）
   * 用 npm CLI 而不是直连 HTTP：与镜像构建期安装走同一套 registry 配置，
   * 避免"能查到版本但构建时装不上"的不一致。
   */
  _fetchFromRegistry(timeoutMs) {
    return new Promise((resolvePromise) => {
      const cacheDir = this._resolveCacheDir()
      execFile(
        'npm',
        ['view', PACKAGE, '--json', '--registry', this.registry],
        {
          maxBuffer: 8 * 1024 * 1024,
          timeout: timeoutMs,
          // 显式指定缓存目录：不依赖平台运行用户的 ~/.npm 是否可写
          ...(cacheDir ? { env: { ...process.env, npm_config_cache: cacheDir } } : {}),
        },
        (err, stdout) => {
          if (err) {
            // 常见可操作错误：宿主 npm 不可用（cache 权限 / 网络），此时版本列表
            // 拿不到，但平台其它功能不受影响——错误信息要能指引排查方向
            const raw = String(err.message || err)
            let hint = raw
            if (/EPERM|EACCES/.test(raw)) {
              hint = `${raw}\n（宿主 npm 缓存不可写，请修复 npm 环境后重试，例如：sudo chown -R $(id -u):$(id -g) ~/.npm）`
            } else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED/.test(raw)) {
              hint = `${raw}\n（无法访问 registry：${this.registry}，请检查网络或改用内网镜像源）`
            }
            resolvePromise({ ok: false, error: hint })
            return
          }
          try {
            const raw = JSON.parse(String(stdout))
            // npm view 对单包返回对象；版本多时 versions 为数组
            const versions = Array.isArray(raw.versions)
              ? raw.versions
              : raw.versions
                ? Object.keys(raw.versions)
                : []
            const distTags =
              raw['dist-tags'] && typeof raw['dist-tags'] === 'object' ? raw['dist-tags'] : {}
            resolvePromise({ ok: true, versions, distTags, times: raw.time || {} })
          } catch (parseErr) {
            resolvePromise({ ok: false, error: `registry 响应解析失败: ${parseErr.message}` })
          }
        },
      )
    })
  }

  /**
   * 获取可用版本（带缓存）
   * @param {{ force?: boolean }} opts force=true 忽略缓存强制刷新
   * @returns {Promise<{ok:boolean, error?:string, stale?:boolean, latest?:string,
   *                    tags?:object, stable?:string[], prerelease?:string[],
   *                    all?:string[], fetchedAt?:number}>}
   */
  async getVersions(opts = {}) {
    const now = Date.now()
    const fresh = this._cache && now - this._cache.at < this.ttlMs
    if (fresh && !opts.force) return { ...this._cache.data, stale: false }

    // compareOnly：只读缓存，绝不联网。
    // 给 /status 这类"要快"的调用方用——过期缓存也比让管理面板卡几秒强。
    if (opts.compareOnly) {
      if (this._cache) return { ...this._cache.data, stale: true }
      return { ok: false, error: null, notLoaded: true }
    }

    // 并发合并：多个请求同时到达只打一次 registry
    if (!this._inflight) {
      this._inflight = this._fetchFromRegistry(Number(CONFIG.dsh?.npmTimeoutMs ?? 20000)).finally(
        () => {
          this._inflight = null
        },
      )
    }
    const res = await this._inflight

    if (!res.ok) {
      // registry 不可达：退化到旧缓存（哪怕过期），比整页报错可用
      if (this._cache) {
        return { ...this._cache.data, stale: true, error: res.error }
      }
      return { ok: false, error: res.error }
    }

    const all = sortVersions(res.versions)
    const data = {
      ok: true,
      latest: res.distTags.latest ?? null,
      tags: res.distTags,
      stable: all.filter((v) => !isPrerelease(v)),
      prerelease: all.filter(isPrerelease),
      all,
      fetchedAt: now,
    }
    this._cache = { at: now, data }
    return { ...data, stale: false }
  }

  /**
   * 该版本是否可安装（防止拼错/注入的版本号进到 docker build / npm install）
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async isInstallable(version) {
    if (!version || typeof version !== 'string') {
      return { ok: false, error: '版本号不能为空' }
    }
    // 只允许 npm 版本号字符：数字、点、连字符、加号、字母（预发布标识）
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) {
      return { ok: false, error: `版本号格式非法: ${version}` }
    }
    if (version === 'latest') return { ok: true }

    const list = await this.getVersions()
    if (!list.ok) {
      // 查不到列表时不放行确切版本（避免构建一个不存在的版本）
      return { ok: false, error: `无法校验版本（registry 不可达）: ${list.error}` }
    }
    if (!list.all.includes(version)) {
      return { ok: false, error: `registry 上不存在该版本: ${version}` }
    }
    return { ok: true }
  }

  /** 清空缓存（强制下次拉取） */
  clearCache() {
    this._cache = null
  }
}

export const dshVersionService = new DshVersionService()
export { isPrerelease }
