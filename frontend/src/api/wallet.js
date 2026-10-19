/**
 * 钱包工具（CCDAO 插件）—— UserCenter / AdminPanel / 技能市场等页面共用
 *
 * 关键约定：
 *  - 插件账户【保留原始大小写】：swtc_signMessage 对 accounts.includes(from)
 *    是大小写敏感严格匹配，只有 requestAccounts 原样返回的字符串才能通过；
 *    展示 / 后端校验时再自行 toLowerCase()。
 *  - 账户变化监听三通道兼容：window.ethereum.on → window.ccdao.on → 轮询兜底。
 *    部分环境事件只广播在 ccdao 对象上，只挂 ethereum 会漏。
 */

import axios from 'axios'

export function ccdaoAvailable() {
  return Boolean(window.ccdao && window.ccdao.request)
}

/** 插件当前账户（原始大小写）；未授权/未安装时抛可读错误 */
export async function requestAccounts() {
  if (!ccdaoAvailable()) {
    throw new Error('未检测到 CCDAO 插件，请先安装并连接钱包')
  }
  const accounts = await window.ccdao.request({
    method: 'swtc_requestAccounts',
    params: [],
  })
  const address = accounts?.[0]
  if (!address) {
    throw new Error('未获取到钱包账户，请确认 CCDAO 插件已解锁并授权本网站')
  }
  return address
}

/** 钱包对**服务端下发的消息**签名（from 必须为原始大小写插件地址）
 *  注意：传的应是 challenge 响应里的 `message`（用途绑定内容），不是 `nonce`。 */
export async function signMessage(pluginAddress, message) {
  return window.ccdao.request({
    method: 'swtc_signMessage',
    params: [pluginAddress, message],
  })
}

/**
 * 文件签名（wodecards 文件接口专用，**IPFS 口径**）：传 `utf8(sha256(文件).hex)`
 * 的**消息字节**（官方 @jccdex/ipfs-rpc-client 拆包定样），插件内部做前缀+哈希+DER 签。
 * 与 swtc_signMessage（ripple 口径）不通用：wodecards ipfs-service 只认这一种。
 */
export async function signFileBytes(pluginAddress, bytes) {
  return window.ccdao.request({
    method: 'ipfs_personalSign',
    params: [bytes, pluginAddress],
  })
}

/** IPFS 口径配套公钥（did_DApp 与写接口同一调用；个别旧版插件无此方法时可回退 swtc_getPublicKey） */
export async function getIpfsPublicKey(pluginAddress) {
  return window.ccdao.request({
    method: 'ipfs_getPublicKey',
    params: [pluginAddress],
  })
}

/** 取插件账户公钥（address 必须为原始大小写插件地址） */
export async function getPublicKey(pluginAddress) {
  return window.ccdao.request({
    method: 'swtc_getPublicKey',
    params: [pluginAddress],
  })
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

  // 通道 1/2：事件监听
  if (window.ethereum && window.ethereum.on) eventEmitter = window.ethereum
  else if (window.ccdao && window.ccdao.on) eventEmitter = window.ccdao

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
      if (window.ccdao && window.ccdao.request) {
        const accounts = await window.ccdao.request({
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

/** 钱包签名挑战-响应：返回 { address, nonce, signature, publicKey }（技能市场用） */
export async function signChallenge() {
  const pluginAddress = await requestAccounts()
  const challengeRes = await axios.post('/api/skills/challenge', { address: pluginAddress })
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
  const msg = err.response?.data?.error || err.message || '未知错误'
  if (/not been authorized|unauthorized/i.test(String(msg))) {
    return (
      'CCDAO 插件尚未授权本网站：请先点击浏览器上的 CCDAO 插件图标解锁钱包，' +
      '再点击用户中心"连接钱包"完成授权（会弹出授权确认框），然后重试'
    )
  }
  return msg
}
