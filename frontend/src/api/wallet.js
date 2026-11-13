/**
 * 钱包工具（CCDAO 插件 / JDID WebView）—— UserCenter / AdminPanel / 技能市场等页面共用
 *
 * 关键约定：
 *  - 插件账户【保留原始大小写】：swtc_signMessage 对 accounts.includes(from)
 *    是大小写敏感严格匹配，只有 requestAccounts 原样返回的字符串才能通过；
 *    展示 / 后端校验时再自行 toLowerCase()。
 *  - Provider 优先级：window.ccdao（JDID WebView）→ window.ethereum（浏览器插件）
 *  - 账户变化监听三通道兼容：window.ccdao.on → window.ethereum.on → 轮询兜底。
 *    部分环境事件只广播在 ccdao 对象上，只挂 ethereum 会漏。
 *  - 地址规范化：处理 did:swtc: / swtc: 前缀，统一成裸地址
 */

import axios from 'axios'

// 错误码常量（对齐 JDID / CCDAO 桥接规范）
export const CCDAO_ERR_USER_REJECTED = 4001
export const CCDAO_ERR_PENDING = 32002

// 超时配置（毫秒）
const TIMEOUT_ACCOUNTS_MS = 120_000
const TIMEOUT_SIGN_MS = 120_000
const TIMEOUT_KEY_MS = 60_000

/** 错误类：桥接调用失败 */
export class CcdaoBridgeError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CcdaoBridgeError'
    this.code = code
  }
}

/** 错误类：桥接调用超时 */
export class CcdaoTimeoutError extends CcdaoBridgeError {
  constructor() {
    super('桥接调用超时，请重试', null)
    this.name = 'CcdaoTimeoutError'
  }
}

/** 获取 provider：优先 window.ccdao（JDID WebView），回退 window.ethereum（浏览器插件） */
function getCcdaoProvider() {
  if (typeof window === 'undefined') return undefined
  if (typeof window.ccdao?.request === 'function') return window.ccdao
  if (typeof window.ethereum?.request === 'function') return window.ethereum
  return undefined
}

/** 检测是否有可用的钱包桥接（JDID WebView 或浏览器插件） */
export function ccdaoAvailable() {
  return !!getCcdaoProvider()
}

/** 带超时的桥接调用 */
async function ccdaoRequest(method, params = [], timeoutMs = 60_000) {
  const provider = getCcdaoProvider()
  if (!provider) {
    throw new CcdaoBridgeError('未检测到 JDID / 钱包桥接（window.ccdao 或 window.ethereum）')
  }

  let timer = null
  try {
    return await Promise.race([
      provider.request({ method, params }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CcdaoTimeoutError()), timeoutMs)
      }),
    ])
  } catch (e) {
    if (e instanceof CcdaoBridgeError) throw e
    const err = e
    throw new CcdaoBridgeError(
      err?.message || `桥接调用失败: ${method}`,
      typeof err?.code === 'number' ? err.code : undefined,
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 规范化钱包地址：去除 did:swtc: / swtc: 前缀 */
function normalizeWalletAddress(raw) {
  if (typeof raw !== 'string') return null
  return raw
    .replace(/^did:swtc:/i, '')
    .replace(/^swtc:/i, '')
    .trim()
}

/** 校验是否为 SWTC 地址格式（j 开头） */
function isSwtcAddressFormat(address) {
  return /^j[1-9A-HJ-NP-Za-km-z]{20,64}$/.test(address)
}

/** 插件当前账户（原始大小写）；未授权/未安装时抛可读错误 */
export async function requestAccounts() {
  if (!ccdaoAvailable()) {
    throw new CcdaoBridgeError(
      '未检测到钱包桥接：JDID WebView 环境请确认已注入 window.ccdao；浏览器环境请安装 CCDAO 插件',
    )
  }

  // 尝试多个方法（兼容不同版本的桥接）
  const methods = ['swtc_requestAccounts', 'accounts', 'eth_requestAccounts']
  let lastError = null

  for (const method of methods) {
    try {
      const accounts = await ccdaoRequest(method, [], TIMEOUT_ACCOUNTS_MS)
      if (Array.isArray(accounts) && accounts.length > 0) {
        const raw = accounts[0]
        const normalized = normalizeWalletAddress(raw)
        if (normalized && isSwtcAddressFormat(normalized)) {
          return normalized
        }
        lastError = new CcdaoBridgeError(`不支持的钱包地址格式: ${raw}`)
      }
    } catch (e) {
      lastError = e
      // 用户拒绝或超时：不再尝试其它方法
      if (
        e instanceof CcdaoBridgeError &&
        (e.code === CCDAO_ERR_USER_REJECTED || e instanceof CcdaoTimeoutError)
      ) {
        throw e
      }
    }
  }

  throw lastError || new CcdaoBridgeError('未获取到钱包账户')
}

/** 钱包对**服务端下发的消息**签名（from 必须为原始大小写插件地址）
 *  注意：传的应是 challenge 响应里的 `message`（用途绑定内容），不是 `nonce`。 */
export async function signMessage(pluginAddress, message) {
  const signature = await ccdaoRequest(
    'swtc_signMessage',
    [pluginAddress, message],
    TIMEOUT_SIGN_MS,
  )
  if (typeof signature !== 'string' || !signature) {
    throw new CcdaoBridgeError('swtc_signMessage 未返回签名')
  }
  return signature
}

/**
 * 文件签名（wodecards 文件接口专用，**IPFS 口径**）：传 `utf8(sha256(文件).hex)`
 * 的**消息字节**（官方 @jccdex/ipfs-rpc-client 拆包定样），插件内部做前缀+哈希+DER 签。
 * 与 swtc_signMessage（ripple 口径）不通用：wodecards ipfs-service 只认这一种。
 */
export async function signFileBytes(pluginAddress, bytes) {
  return await ccdaoRequest('ipfs_personalSign', [bytes, pluginAddress], TIMEOUT_SIGN_MS)
}

/** IPFS 口径配套公钥（did_DApp 与写接口同一调用；个别旧版插件无此方法时可回退 swtc_getPublicKey） */
export async function getIpfsPublicKey(pluginAddress) {
  return await ccdaoRequest('ipfs_getPublicKey', [pluginAddress], TIMEOUT_KEY_MS)
}

/** 取插件账户公钥（address 必须为原始大小写插件地址） */
export async function getPublicKey(pluginAddress) {
  const pub = await ccdaoRequest('swtc_getPublicKey', [pluginAddress], TIMEOUT_KEY_MS)
  if (typeof pub === 'string' && pub.trim()) return pub.trim()
  // 兼容个别桥返回 { publicKey } / { result }
  if (pub && typeof pub === 'object') {
    const o = pub
    for (const k of ['publicKey', 'result', 'data']) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  throw new CcdaoBridgeError('swtc_getPublicKey 未返回公钥')
}

/**
 * 监听钱包账户变化（三通道兼容），供各页面切换地址时统一处理。
 * @param {(accounts: string[], source: 'event'|'poll') => void} handler
 *   收到新账户数组（数组元素为原始大小写地址；空数组 = 断开）。
 * @param {number} [pollIntervalMs] 轮询兜底间隔，默认 3000ms
 * @returns {() => void} unbind —— 组件卸载时调用（解绑事件 / 停止轮询）
 */
export function watchAccountsChanged(handler, { pollIntervalMs = 3000 } = {}) {
  let eventEmitter = null
  let pollTimer = null
  const wrapped = (accounts) => handler(accounts, 'event')

  // 通道 1/2：事件监听（优先 ccdao，回退 ethereum）
  if (window.ccdao && window.ccdao.on) eventEmitter = window.ccdao
  else if (window.ethereum && window.ethereum.on) eventEmitter = window.ethereum

  if (eventEmitter) {
    eventEmitter.on('swtcAccountsChanged', wrapped)
    return () => {
      eventEmitter.removeListener?.('swtcAccountsChanged', wrapped)
      eventEmitter.off?.('swtcAccountsChanged', wrapped)
    }
  }

  // 通道 3：轮询兜底（每 N 秒对比一次地址，仅在无事件通道时启用）
  let lastAddr = null
  pollTimer = setInterval(async () => {
    try {
      const provider = getCcdaoProvider()
      if (provider && provider.request) {
        const accounts = await provider.request({
          method: 'swtc_requestAccounts',
          params: [],
        })
        const cur = accounts?.[0]
        if (cur && cur !== lastAddr) {
          lastAddr = cur
          await handler(accounts, 'poll')
        }
      }
    } catch {
      // 忽略轮询错误
    }
  }, pollIntervalMs)
  return () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}

/** 钱包签名挑战-响应：返回 { address, nonce, signature, publicKey }。
 *  challengeUrl 决定签名用途池：默认技能（'/api/skills/challenge'）；模型配置传
 *  '/api/user/config-challenge'（TENANT_CONFIG 池）。两池 nonce 互不兑现（用途绑定
 *  消息），一次操作一次签名（钱包弹窗逐个确认，与桌面 UserCenter 同款语义）。 */
export async function signChallenge(challengeUrl = '/api/skills/challenge') {
  const pluginAddress = await requestAccounts()
  const challengeRes = await axios.post(challengeUrl, { address: pluginAddress })
  // 签的是服务端下发的**用途绑定消息**（message，hex），不是裸 nonce：
  // 这样为其它用途取得的签名不能在此处兑现（跨端点凭证混淆加固）。
  const { nonce, message } = challengeRes.data
  const signature = await signMessage(pluginAddress, message)
  const publicKey = await getPublicKey(pluginAddress)
  return { address: pluginAddress, nonce, signature, publicKey }
}

/**
 * 把 CCDAO 插件的未授权错误转成可操作的提示
 */
export function friendlyPluginError(err) {
  // 处理我们自定义的错误类
  if (err instanceof CcdaoTimeoutError) {
    return '钱包桥接调用超时，请检查网络连接后重试'
  }
  if (err instanceof CcdaoBridgeError) {
    if (err.code === CCDAO_ERR_USER_REJECTED) {
      return '您已取消钱包连接，如需使用请重新连接'
    }
    if (err.code === CCDAO_ERR_PENDING) {
      return '钱包操作正在进行中，请稍后再试'
    }
    return err.message
  }

  // 处理 HTTP 响应错误
  const msg = err.response?.data?.error || err.message || '未知错误'
  if (/not been authorized|unauthorized/i.test(String(msg))) {
    return (
      '钱包尚未授权本网站：' +
      'JDID WebView 环境请确认已注入桥接；' +
      '浏览器环境请点击 CCDAO 插件图标解锁钱包，' +
      '然后重新连接'
    )
  }
  return msg
}
