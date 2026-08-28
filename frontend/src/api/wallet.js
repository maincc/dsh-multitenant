/**
 * 钱包签名工具（CCDAO 插件）
 *
 * 与 UserCenter.vue 内实现同流程，独立成模块供技能市场等页面复用：
 *   1. swtc_requestAccounts 取插件当前账户（保留原始大小写）
 *   2. POST /api/skills/challenge 领取一次性 nonce
 *   3. swtc_signMessage(nonce) + swtc_getPublicKey
 *
 * 注意：swtc_signMessage 对 accounts.includes(from) 大小写敏感，
 * 必须使用 requestAccounts 原样返回的字符串。
 */

import axios from 'axios'

export function ccdaoAvailable() {
  return Boolean(window.ccdao && window.ccdao.request)
}

/** 插件当前账户（原始大小写） */
export async function getPluginAccount() {
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

/** 钱包签名挑战-响应：返回 { address, nonce, signature, publicKey } */
export async function signChallenge() {
  const pluginAddress = await getPluginAccount()
  const challengeRes = await axios.post('/api/skills/challenge', { address: pluginAddress })
  const nonce = challengeRes.data.nonce
  const signature = await window.ccdao.request({
    method: 'swtc_signMessage',
    params: [pluginAddress, nonce],
  })
  const publicKey = await window.ccdao.request({
    method: 'swtc_getPublicKey',
    params: [pluginAddress],
  })
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
