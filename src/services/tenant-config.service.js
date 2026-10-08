/**
 * 租户密钥与模型配置服务
 *
 * 身份验证：钱包签名挑战-响应
 *   1. POST config-challenge 领取一次性 nonce（5 分钟有效，用完即焚）
 *   2. 前端让 CCDAO 插件对服务端下发的 message（用途绑定内容）签名
 *      （swtc_signMessage）+ 取公钥（swtc_getPublicKey）。**不能签裸 nonce**。
 *   3. 服务端用 @swtc/keypairs 验签，且公钥推导出的 SWTC 地址必须等于声称地址
 *   全部通过才允许写入该租户的数据卷。
 *
 * 写入内容（全部热加载，无需重启容器）：
 *   - 官方 DeepSeek key → $DSH_HOME/.credentials.yaml 的 DEEPSEEK_API_KEY
 *   - 官方端点覆盖（可选）→ $DSH_HOME/settings.yaml 的 llm-deepseek 段
 *   - 自定义 Provider（llm-pi-ai 多 provider 适配器，可多个并存，进入 DSH
 *     模型选择器后与官方 DeepSeek 并列可选）→
 *       settings.yaml 的 llm-pi-ai.providers.<route> 段（api/displayName/baseURL/models）
 *       credentials.yaml 的 <ROUTE>_API_KEY
 *
 * 绕过了 DSH 配置平面的 loopback-only 限制，同时保留真实认证：
 *   - 不是"网段信任"（放开 loopback 会让局域网任何人可改配置）
 *   - 而是"钱包签名认证"（能签出对应地址的签名 = 持有该地址私钥）
 *
 * 安全边界：
 *   - key 只写入租户卷（容器内 0600），服务端/日志绝不落盘或回显
 *   - GET 状态只回 configured/absent，永不返回 key 内容
 *   - DSH credentials-local / settings-file 热加载（chokidar，约 100ms 生效）
 */

import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypairs } from '@swtc/keypairs'
import { CONFIG } from '../config/config.js'
import { normalizeAddress, swtcVolumeName } from '../utils/address.js'
import { ForbiddenError, BadRequestError, InternalError, NotFoundError } from '../utils/errors.js'

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)))
const SCRIPTS_DIR = join(ROOT, 'src', 'services')
const IMAGE = process.env.DSH_TENANT_IMAGE || CONFIG.docker.image

/** 容器内凭据文件路径（DSH 的 $DSH_HOME/.credentials.yaml） */
const CREDENTIALS_FILE = '/dsh-home/.credentials.yaml'
/** 容器内设置文档路径（DSH 的 $DSH_HOME/settings.yaml） */
const SETTINGS_FILE = '/dsh-home/settings.yaml'
/** 官方 DeepSeek 凭据引用名（DSH llm-deepseek 默认从 DEEPSEEK_API_KEY 解析密钥） */
const CREDENTIAL_KEY = 'DEEPSEEK_API_KEY'
/** llm-pi-ai 多 provider 适配器的 settings 段 */
const PI_AI_SECTION = 'llm-pi-ai'
/** 挑战有效期：5 分钟 */
const CHALLENGE_TTL_MS = 5 * 60 * 1000
/** 一次性挑战 Map 上限（防未认证洪泛导致内存耗尽，security-hardening-plan P0-3） */
const MAX_CHALLENGES = 10000
/** API Key 长度上限（防止超大 payload） */
const MAX_KEY_LENGTH = 4096
/** baseURL 长度上限 */
const MAX_BASE_URL_LENGTH = 2048
/** 自定义模型数量上限 */
const MAX_MODELS = 64
/** 自定义 Provider 数量上限 */
const MAX_PROVIDERS = 20

/**
 * 签名用途（purpose）。每个"需要钱包签名"的入口一个，**服务端常量**，
 * 客户端无法影响。
 *
 * ## 为什么必须有它（这是本次安全加固的核心）
 *
 * 加固前所有入口只签一个与用途无关的裸 nonce，且共用同一个挑战池：
 * 攻击者可以自行向**公开无鉴权**的挑战接口领取"地址为管理员"的 nonce，
 * 再诱导管理员对这个无任何语义的十六进制串签名（钱包弹窗里看不出在授权
 * 什么），然后把签名交到另一个入口兑现。最严重的是：
 *
 *   /api/admin/challenge（登录挑战，匿名可取）
 *     → 管理员签了 → POST /api/admin/login → 12 小时管理员会话
 *
 * 把用途绑进**被签内容**之后，为 A 用途取的签名在 B 用途处一律验签失败，
 * 上面这条链就断了（跨用途兑换不再可能）。
 */
export const SIGN_PURPOSE = Object.freeze({
  LOGIN: 'login',
  CONNECT: 'connect',
  TENANT_CONFIG: 'tenant-config',
  SKILLS: 'skills',
  GATEWAY: 'gateway-verify',
  ADMIN_OP: 'admin-op',
})

/** 签名域前缀：把"哪个应用"也绑进被签内容，避免与其它 DSH 部署互换签名 */
const SIGN_DOMAIN = 'dsh-multitenant'

/**
 * 构造"这次到底签什么"的规范化消息，hex 编码后交付钱包。
 *
 * 被签原文形如：
 *   dsh-multitenant|<purpose>|<address>|<nonce>[|<binding>]
 *
 * **为什么必须 hex 编码**：`@swtc/keypairs` 的 sign/verify 内部走
 * `funcHexToBytes()`，它是按 2 字符 `parseInt(substr(c,2),16)` 解码的——
 * 直接喂含 `|`/`:` 的 ASCII 会被**有损解码**（非法字符对 → NaN → 0），
 * 于是不同的用途/绑定串可能解码成同一串字节 → 碰撞 → 绑定失效。
 * hex 编码后解码无损，用途才真正被密码学地绑定（也不再有碰撞面）。
 *
 * @param {string} purpose SIGN_PURPOSE 之一
 * @param {string} address SWTC 地址
 * @param {string} nonce 一次性挑战
 * @param {string} [binding] 额外的操作绑定串（如破坏性操作的 promote:address=xxx）
 * @returns {string} 交给钱包签名的消息（hex）
 */
export function buildSignedMessage(purpose, address, nonce, binding = '') {
  const base = `${SIGN_DOMAIN}|${purpose}|${normalizeAddress(address)}|${nonce}`
  const canonical = binding ? `${base}|${binding}` : base
  return Buffer.from(canonical, 'utf8').toString('hex')
}

/**
 * 一次性挑战池。
 *
 * key = `<purpose>|<address>` —— 按**用途分池**，这是与用途绑定配套的第二道
 * 防线：即使某个入口的消息格式将来被改回裸 nonce，为 A 用途发放的 nonce
 * 也无法在 B 用途处被消费。
 * value = { nonce, purpose, expiresAt }（进程内存，重启即失效，可接受）
 */
const challenges = new Map()

/** 挑战池的复合 key（用途 + 地址） */
const challengeKey = (purpose, address) => `${purpose}|${normalizeAddress(address)}`

/** 自定义 provider route 对应的凭据引用名：<ROUTE>_API_KEY（大写、非字母数字转下划线） */
const credentialRefFor = (route) => `${route.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`

/**
 * Docker CLI 子进程默认超时（毫秒）。
 * 修复前只有 maxBuffer 没有 timeout：辅助容器卡住会让 HTTP 请求永久挂起。
 * 取 180s：这些调用要起辅助容器（必要时拉镜像），比普通 docker 命令慢。
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.DOCKER_CLI_TIMEOUT_MS || 180000)

/** 封装 execFile 为 Promise（带超时 + 超时错误标注） */
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

export class TenantConfigService {
  /**
   * 清理过期挑战（每次发放时顺带执行，防 Map 无限增长）
   */
  pruneChallenges() {
    const now = Date.now()
    for (const [key, rec] of challenges) {
      if (rec.expiresAt < now) challenges.delete(key)
    }
  }

  /**
   * 发放一次性挑战（按用途分池）
   * @param {string} address SWTC 地址
   * @param {string} purpose SIGN_PURPOSE 之一（服务端常量，客户端不可影响）
   * @returns {{nonce: string, message: string}|null}
   *   nonce 用于回传定位挑战；message 是**交给钱包签名**的用途绑定消息。
   *   挑战池已满时返回 null。
   */
  issueChallenge(address, purpose) {
    this.pruneChallenges()
    if (challenges.size >= MAX_CHALLENGES) return null
    const nonce = randomBytes(32).toString('hex')
    challenges.set(challengeKey(purpose, address), {
      nonce,
      purpose,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    })
    return { nonce, message: buildSignedMessage(purpose, address, nonce) }
  }

  /**
   * 消费挑战（一次性；用途/地址/nonce 任一不匹配或过期都失败）
   * @param {string} purpose 必须与发放时一致，否则取不到（分池效果）
   */
  consumeChallenge(address, nonce, purpose) {
    const key = challengeKey(purpose, address)
    const rec = challenges.get(key)
    if (!rec || rec.nonce !== nonce || rec.expiresAt < Date.now()) return false
    challenges.delete(key)
    return true
  }

  /**
   * 验签：消息的签名有效，且公钥推导出的地址 === 声称地址。
   * 与 CCDAO 插件同库同流程（Keypairs.sign(messageHex, privateKey)）。
   *
   * 注意：调用方必须传入**服务端构造的用途绑定消息**
   * （见 `buildSignedMessage`），绝不能把裸 nonce 或客户端传来的原文交给它。
   *
   * @param {string} message 被签消息（hex；由 buildSignedMessage 构造）
   */
  verifySignature(address, message, signature, publicKey) {
    try {
      if (typeof signature !== 'string' || typeof publicKey !== 'string') return false
      if (typeof message !== 'string' || !message) return false
      if (!Keypairs.verify(message, signature, publicKey)) return false
      const derived = normalizeAddress(Keypairs.deriveAddress(publicKey))
      return derived === normalizeAddress(address)
    } catch {
      return false
    }
  }

  /**
   * 该地址的租户数据卷是否存在（docker volume inspect）
   * @param {string} address SWTC 地址
   */
  async volumeExists(address) {
    const volume = swtcVolumeName(address)
    try {
      await sh('docker', ['volume', 'inspect', volume])
      return true
    } catch {
      return false
    }
  }

  /**
   * 在租户镜像的辅助容器内执行一个卷脚本（借助数据卷挂载，不依赖宿主卷路径）
   * @param {string} address SWTC 地址（决定挂哪个租户卷）
   * @param {string} script 脚本文件名（src/services/ 下的 .mjs）
   * @param {string[]} scriptArgs 传给脚本的参数
   */
  async runScript(address, script, scriptArgs) {
    const volume = swtcVolumeName(address)
    // 无容器/无卷地址：拒绝执行卷脚本。docker 的 -v 会对不存在的卷隐式创建空卷，
    // 会留下孤儿卷污染；安装/发布/卸载也会因此"成功"却无处可用。
    if (!(await this.volumeExists(address))) {
      throw new NotFoundError(
        `该地址尚未创建容器（数据卷 ${volume} 不存在），请先在用户中心「连接钱包」创建容器后再操作`,
      )
    }
    const scriptPath = join(SCRIPTS_DIR, script)
    const args = [
      'run',
      '--rm',
      '-v',
      `${volume}:/dsh-home`,
      '-v',
      `${scriptPath}:/${script}:ro`,
      IMAGE,
      'node',
      `/${script}`,
      ...scriptArgs,
    ]
    try {
      const out = await sh('docker', args)
      return out
    } catch (err) {
      throw new InternalError(
        `脚本执行失败（volume=${volume}, script=${script}）: ${err.message} ${err.stderr ?? ''}`,
      )
    }
  }

  /**
   * 对指定凭据引用执行合并（.credentials.yaml）
   * @param {string} address SWTC 地址
   * @param {string} ref 凭据引用名（如 DEEPSEEK_API_KEY / CUSTOM_X_API_KEY）
   * @param {string} action get | set | del
   * @param {string} [value] set 时的值
   */
  async runCredential(address, ref, action, value) {
    const args = [action, CREDENTIALS_FILE, ref]
    if (value !== undefined) args.push(value)
    return this.runScript(address, 'merge-credentials.mjs', args)
  }

  /** 官方 DeepSeek key 的便捷封装 */
  async runMerge(address, action, value) {
    return this.runCredential(address, CREDENTIAL_KEY, action, value)
  }

  /** 读取 settings.yaml 的 llm-pi-ai.providers 映射：{ route: profile }（失败返回 {}） */
  async readProvidersMap(address) {
    try {
      const out = await this.runScript(address, 'merge-settings.mjs', [
        'get',
        SETTINGS_FILE,
        PI_AI_SECTION,
      ])
      const parsed = JSON.parse(out)
      if (parsed?.providers && typeof parsed.providers === 'object') return parsed.providers
    } catch {
      // 读取失败按空处理
    }
    return {}
  }

  /** 查询配置状态（只回 configured/absent，不回显 key） */
  async getStatus(address) {
    // 凭据引用集合（一次容器调用，list 不输出值）
    let configuredRefs = []
    try {
      const refsOut = await this.runScript(address, 'merge-credentials.mjs', [
        'list',
        CREDENTIALS_FILE,
      ])
      const parsed = JSON.parse(refsOut)
      if (Array.isArray(parsed)) configuredRefs = parsed
    } catch {
      // ignore
    }
    const apiKeyConfigured = configuredRefs.includes(CREDENTIAL_KEY)
    let deepseek = {}
    let providers = []
    try {
      const dsOut = await this.runScript(address, 'merge-settings.mjs', [
        'get',
        SETTINGS_FILE,
        'llm-deepseek',
      ])
      const parsed = JSON.parse(dsOut)
      if (parsed && typeof parsed === 'object') deepseek = parsed
    } catch {
      // ignore
    }
    try {
      const paOut = await this.runScript(address, 'merge-settings.mjs', [
        'get',
        SETTINGS_FILE,
        PI_AI_SECTION,
      ])
      const parsed = JSON.parse(paOut)
      if (parsed?.providers && typeof parsed.providers === 'object') {
        providers = Object.entries(parsed.providers).map(([route, p]) => ({
          route,
          displayName: typeof p?.displayName === 'string' ? p.displayName : route,
          baseURL: p?.baseURL ?? null,
          models: Array.isArray(p?.models) ? p.models : [],
          apiKeyEnv: p?.apiKeyEnv ?? null,
          keyConfigured: typeof p?.apiKeyEnv === 'string' && configuredRefs.includes(p.apiKeyEnv),
        }))
      }
    } catch {
      // ignore
    }
    return {
      apiKeyConfigured,
      baseURL: deepseek.baseURL ?? null,
      models: deepseek.models ?? null,
      providers,
    }
  }

  /**
   * 校验并规范化模型配置（baseURL / models）
   * 非法输入抛 BadRequestError；返回只含显式提供字段的规范化对象。
   * 语义：baseURL 空串 = 删除字段（回官方端点）；models 空数组 = 删除字段（回默认模型）。
   */
  normalizeModelConfig({ baseURL, models } = {}) {
    const out = {}
    if (baseURL !== undefined && baseURL !== null) {
      const b = String(baseURL).trim()
      if (b === '') {
        out.baseURL = ''
      } else if (!/^https?:\/\//.test(b) || b.length > MAX_BASE_URL_LENGTH) {
        throw new BadRequestError('baseURL 必须是 http(s) 地址')
      } else {
        out.baseURL = b.replace(/\/+$/, '')
      }
    }
    if (models !== undefined && models !== null) {
      if (!Array.isArray(models) || models.length > MAX_MODELS) {
        throw new BadRequestError(`models 必须是数组且不超过 ${MAX_MODELS} 项`)
      }
      out.models = models.map((m) => {
        const id = typeof m?.id === 'string' ? m.id.trim() : ''
        if (!id || id.length > 128) {
          throw new BadRequestError(`模型 id 非法: ${JSON.stringify(m?.id)}`)
        }
        const row = { id }
        if (typeof m?.name === 'string' && m.name.trim()) row.name = m.name.trim()
        if (m?.contextWindow !== undefined) {
          if (
            typeof m.contextWindow !== 'number' ||
            !Number.isFinite(m.contextWindow) ||
            m.contextWindow < 1
          ) {
            throw new BadRequestError(`模型 ${id} 的 contextWindow 非法`)
          }
          row.contextWindow = m.contextWindow
        }
        if (m?.maxTokens !== undefined) {
          if (typeof m.maxTokens !== 'number' || !Number.isFinite(m.maxTokens) || m.maxTokens < 1) {
            throw new BadRequestError(`模型 ${id} 的 maxTokens 非法`)
          }
          row.maxTokens = m.maxTokens
        }
        return row
      })
      const ids = new Set(out.models.map((m) => m.id))
      if (ids.size !== out.models.length) {
        throw new BadRequestError('模型 id 重复')
      }
    }
    return out
  }

  /** 写入（或覆盖）官方端点覆盖（settings.yaml 的 llm-deepseek 段） */
  async setModelConfig(address, raw) {
    const cfg = this.normalizeModelConfig(raw)
    if (Object.keys(cfg).length === 0) {
      throw new BadRequestError('没有可写入的模型配置')
    }
    await this.runScript(address, 'merge-settings.mjs', ['set', SETTINGS_FILE, JSON.stringify(cfg)])
  }

  /**
   * 校验并规范化自定义 Provider 列表（llm-pi-ai）
   * 每个 provider：{ route?, displayName, baseURL, models?, apiKey? }
   *   - route 缺省 = 新建（由 setProviders 分配）；提供 = 更新现有
   *   - apiKey 非空才返回（写入对应凭据引用）
   * @returns {Array<{route?, displayName, baseURL, models?, apiKey?}>}
   */
  normalizeProviders(providers) {
    if (!Array.isArray(providers) || providers.length > MAX_PROVIDERS) {
      throw new BadRequestError(`providers 必须是数组且不超过 ${MAX_PROVIDERS} 项`)
    }
    return providers.map((p) => {
      if (!p || typeof p !== 'object') {
        throw new BadRequestError('provider 格式不正确')
      }
      const displayName = typeof p.displayName === 'string' ? p.displayName.trim() : ''
      if (!displayName || displayName.length > 64) {
        throw new BadRequestError('provider 显示名不能为空且不超过 64 字符')
      }
      const baseURL = typeof p.baseURL === 'string' ? p.baseURL.trim() : ''
      if (!/^https?:\/\//.test(baseURL) || baseURL.length > MAX_BASE_URL_LENGTH) {
        throw new BadRequestError(`provider "${displayName}" 的 baseURL 必须是 http(s) 地址`)
      }
      const row = {
        displayName,
        baseURL: baseURL.replace(/\/+$/, ''),
      }
      if (p.route !== undefined && p.route !== null) {
        const route = String(p.route).trim()
        if (!/^[a-z0-9-]+$/.test(route) || route.length > 64) {
          throw new BadRequestError(`provider route 非法: ${route}`)
        }
        row.route = route
      }
      if (p.apiKey !== undefined && p.apiKey !== null) {
        const k = String(p.apiKey).trim()
        if (k) {
          if (k.length > MAX_KEY_LENGTH) throw new BadRequestError('API Key 长度超出限制')
          row.apiKey = k
        }
      }
      if (p.models !== undefined && p.models !== null) {
        const norm = this.normalizeModelConfig({ models: p.models })
        row.models = norm.models ?? []
      }
      return row
    })
  }

  /**
   * 写入自定义 Provider 列表（全量语义：列表即最终状态，被移除的 route 会删除）
   * @returns {Promise<{routes: string[]}>} 实际生效的 route 列表
   */
  async setProviders(address, providers) {
    const rows = this.normalizeProviders(providers)
    const current = await this.readProvidersMap(address)
    const nextMap = {}
    const keyWrites = []
    const deletions = []
    const now = Date.now()
    let seq = 0

    for (const row of rows) {
      const route = row.route || `custom-${now}-${seq++}`
      const ref = credentialRefFor(route)
      nextMap[route] = {
        api: 'openai-completions',
        displayName: row.displayName,
        baseURL: row.baseURL,
        apiKeyEnv: ref,
      }
      if (Array.isArray(row.models) && row.models.length > 0) {
        nextMap[route].models = row.models
      }
      if (row.apiKey) keyWrites.push([ref, row.apiKey])
    }

    for (const route of Object.keys(current)) {
      if (!(route in nextMap)) deletions.push(route)
    }

    // 1) 写 settings（新增/更新 route；删除用 null 标记）
    const payload = { providers: { ...nextMap } }
    for (const route of deletions) payload.providers[route] = null
    await this.runScript(address, 'merge-settings.mjs', [
      'set',
      SETTINGS_FILE,
      JSON.stringify(payload),
      PI_AI_SECTION,
    ])

    // 2) 写 key（新/更新的 provider）
    for (const [ref, key] of keyWrites) {
      await this.runCredential(address, ref, 'set', key)
    }

    // 3) 清 key（被移除的 provider）
    for (const route of deletions) {
      await this.runCredential(address, credentialRefFor(route), 'del')
    }

    return { routes: Object.keys(nextMap) }
  }

  /**
   * 探测 baseURL 提供的模型列表（OpenAI 兼容 /models）
   * 探测在辅助容器内执行：apiKey 未显式提供时自动读租户卷内已存 key，
   * key 不经过宿主进程与前端。
   * @param {object} param0 { baseURL, apiKey?, credentialRef? }
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async discoverModels(address, { baseURL, apiKey, credentialRef } = {}) {
    if (
      typeof baseURL !== 'string' ||
      !/^https?:\/\//.test(baseURL.trim()) ||
      baseURL.trim().length > MAX_BASE_URL_LENGTH
    ) {
      throw new BadRequestError('baseURL 必须是 http(s) 地址')
    }
    const out = await this.runScript(address, 'probe-models.mjs', [
      baseURL.trim(),
      typeof apiKey === 'string' ? apiKey.trim() : '',
      typeof credentialRef === 'string' ? credentialRef : '',
    ])
    let parsed
    try {
      parsed = JSON.parse(out)
    } catch {
      throw new InternalError('模型探测返回无法解析')
    }
    if (parsed?.error) {
      throw new BadRequestError(`模型探测失败: ${parsed.error}`)
    }
    return Array.isArray(parsed?.models) ? parsed.models : []
  }

  /** 写入（或覆盖）官方 DeepSeek API Key */
  async setKey(address, apiKey) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new BadRequestError('API Key 不能为空')
    }
    if (apiKey.length > MAX_KEY_LENGTH) {
      throw new BadRequestError('API Key 长度超出限制')
    }
    await this.runMerge(address, 'set', apiKey.trim())
  }

  /** 清除官方 DeepSeek API Key */
  async clearKey(address) {
    await this.runMerge(address, 'del')
  }

  /**
   * 模型探测完整流程：验签 + 探测
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async discoverWithAuth(address, { nonce, signature, publicKey, baseURL, apiKey, credentialRef }) {
    if (!this.consumeChallenge(address, nonce, SIGN_PURPOSE.TENANT_CONFIG)) {
      throw new ForbiddenError('挑战无效或已过期，请重新获取')
    }
    if (
      !this.verifySignature(
        address,
        buildSignedMessage(SIGN_PURPOSE.TENANT_CONFIG, address, nonce),
        signature,
        publicKey,
      )
    ) {
      throw new ForbiddenError('签名验证失败：无法确认该地址归您所有')
    }
    return this.discoverModels(address, { baseURL, apiKey, credentialRef })
  }

  /**
   * 完整配置流程：验签 + 写官方 key（可选）+ 官方端点覆盖（可选）+ 自定义 Provider 列表（可选）
   * @param {object} param0 { nonce, signature, publicKey, apiKey?, baseURL?, models?, providers? }
   *   显式提供的字段才会被写入；providers 为全量语义（列表即最终状态）。
   * @throws ForbiddenError 签名/地址不匹配
   * @throws BadRequestError 全部字段为空，或配置非法
   */
  async configure(address, { nonce, signature, publicKey, apiKey, baseURL, models, providers }) {
    if (!this.consumeChallenge(address, nonce, SIGN_PURPOSE.TENANT_CONFIG)) {
      throw new ForbiddenError('挑战无效或已过期，请重新获取')
    }
    if (
      !this.verifySignature(
        address,
        buildSignedMessage(SIGN_PURPOSE.TENANT_CONFIG, address, nonce),
        signature,
        publicKey,
      )
    ) {
      throw new ForbiddenError('签名验证失败：无法确认该地址归您所有')
    }
    const hasKey = typeof apiKey === 'string' && apiKey.trim() !== ''
    const hasModelConfig = baseURL !== undefined || models !== undefined
    const hasProviders = providers !== undefined
    if (!hasKey && !hasModelConfig && !hasProviders) {
      throw new BadRequestError(
        '没有可配置的内容（API Key / 模型配置 / 自定义 Provider 至少提供一项）',
      )
    }
    if (hasKey) {
      await this.setKey(address, apiKey)
    }
    if (hasModelConfig) {
      await this.setModelConfig(address, { baseURL, models })
    }
    if (hasProviders) {
      await this.setProviders(address, providers)
    }
  }

  /**
   * 清除配置：验签后按 scope 执行
   * @param {object} param0 { nonce, signature, publicKey, scope? }
   *   scope === 'official-key'：只删官方 DeepSeek key（端点覆盖与自定义 Provider 保留）
   *   其他（默认）：删官方 key + 端点覆盖 + 自定义 Provider（恢复默认）
   */
  async clear(address, { nonce, signature, publicKey, scope }) {
    if (!this.consumeChallenge(address, nonce, SIGN_PURPOSE.TENANT_CONFIG)) {
      throw new ForbiddenError('挑战无效或已过期，请重新获取')
    }
    if (
      !this.verifySignature(
        address,
        buildSignedMessage(SIGN_PURPOSE.TENANT_CONFIG, address, nonce),
        signature,
        publicKey,
      )
    ) {
      throw new ForbiddenError('签名验证失败：无法确认该地址归您所有')
    }
    if (scope === 'official-key') {
      await this.clearKey(address)
      return
    }
    let providerRoutes = []
    try {
      providerRoutes = Object.keys(await this.readProvidersMap(address))
    } catch {
      // ignore
    }
    await this.clearKey(address)
    await this.runScript(address, 'merge-settings.mjs', ['del', SETTINGS_FILE])
    for (const route of providerRoutes) {
      await this.runCredential(address, credentialRefFor(route), 'del')
    }
  }
}

export const tenantConfigService = new TenantConfigService()
