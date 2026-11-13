/**
 * /connect 签名内核（P3 T4 收敛 2026-11-10）
 *
 * 桌面 connectWithOwnership（UserCenter，带单飞锁/阶段化 loading）与移动拷贝
 * （MobileContainer，裸 fetch）此前各写各的——判例 58 孪生面漂移在签名链的
 * 投影：移动拷贝**漏记 canonical 拼法**（swtc_plugin_case），纯移动路径登录的
 * 用户，凭证"档案优先发现"少了拼法线索。本模块把最易漂移的
 * requestAccounts→/connect-challenge→signMessage→getPublicKey 原语收成一支：
 *  - onPluginAddress 回调：调用方自理拼法记录（桌面记得内存 ref + localStorage，
 *    移动写 localStorage），语义不减；
 *  - onPhase 回调：桌面插阶段化 loading 的挂点（'challenge'|'sign'），移动不传=无声；
 *  - buildConnectUrl：/connect 参数拼装统一（format=json 与 action 追加语义照旧；
 *    address 由调用方给——桌面传会话地址、移动传插件地址，后端 normalize，差异如实保留）。
 * 用途仍是 CONNECT 专属消息（挑战池按用途隔离，防跨端点凭证混淆——原注释口径）。
 */
import { requestAccounts, signMessage, getPublicKey } from './wallet.js'

/**
 * @param {{ onPluginAddress?: (addr:string)=>void, onPhase?: (phase:'challenge'|'sign')=>void }} [opts]
 * @returns {Promise<{pluginAddress:string, nonce:string, signature:string, publicKey:string}>}
 */
export async function signConnectPlugin(opts = {}) {
  const { onPluginAddress, onPhase } = opts
  const pluginAddress = await requestAccounts()
  onPluginAddress && onPluginAddress(pluginAddress)

  // 领取一次性挑战：走 /connect-challenge（200 正身；旧链路借 /connect 的
  // 无签名 401 下发挑战，浏览器必标红、每次登录都像"报错"）
  onPhase && onPhase('challenge')
  const chalRes = await fetch(`/connect-challenge?address=${encodeURIComponent(pluginAddress)}`)
  const challenge = await chalRes.json()
  const nonce = challenge.nonce
  const message = challenge.message
  if (!nonce || !message) {
    throw new Error(challenge.error || '领取连接挑战失败，请重试')
  }

  // 插件签名（用户确认弹窗，可能等待较久）：签的是用途绑定消息（hex）
  onPhase && onPhase('sign')
  const signature = await signMessage(pluginAddress, message)
  const publicKey = await getPublicKey(pluginAddress)

  return { pluginAddress, nonce, signature, publicKey }
}

/**
 * 组装带签名的 /connect URL。action=login 只换 cookie 不建容器（v1.5 反馈②）；
 * 额外 query 不参与签名内容，防重放语义不变。
 */
export function buildConnectUrl(address, core, action = null) {
  const params = new URLSearchParams({
    address,
    nonce: core.nonce,
    signature: core.signature,
    publicKey: core.publicKey,
    format: 'json',
    ...(action ? { action } : {}),
  })
  return `/connect?${params}`
}
