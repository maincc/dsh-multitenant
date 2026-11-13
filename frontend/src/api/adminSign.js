/**
 * 管理破坏性操作·当场签名（全端唯一权威实现）
 *
 * 语义（对齐 AdminPanel 2026-11-02 加固版 + 三条判权不变量）：
 * challenge 绑 (operation, payload) → 钱包签 message（用途绑定 hex）→ 三头 x-admin-*；
 * 材料不齐（nonce/签名/公钥任一非串/空）就地刹车并指名缺哪件——插件未解锁时
 * swtc_getPublicKey 可回 undefined/对象，axios 静默丢非串头，裸 POST 撞上
 * SIGNATURE_REQUIRED 的报错会把人引向"没签名"，实际是"签了但材料半路蒸发"。
 *
 * P3 孪生收敛（2026-11-10）：此前 AdminPanel（权威全装）、EnvTemplatesAdmin.signOp
 * （缺材料校验的裸孪生——判例 58 漂移活体）、本文件（移动版）三份并存；现全端唯此一支，
 * 桌面差异装进 opts，语义不减：
 *  - opts.sessionAddress：桌面传入"登录会话地址"，做钱包账户≠会话预检（移动壳无此
 *    持有者，不传=跳过，服务端 challenge 绑地址一房保平安）；
 *  - opts.t：桌面 vue-i18n 的 t，材料不齐/类型名文案走 zh.js 键；移动不传=内联中文
 *    直出（现行口径）。
 * 桌面 hasCCDAO 前置闸与 friendlyPluginError 包装留在各桌面调用方（本地关注，不外溢）。
 */
import axios from 'axios'
import { requestAccounts, signMessage, getPublicKey } from './wallet.js'

/**
 * @param {string} operation 后端白名单操作名（如 'cleanup-orphan-volumes'）
 * @param {object} payload   会改变行为的入参（服务端据此推导 binding，防"签A执行B"）
 * @param {object} [opts]    { sessionAddress?: string, t?: i18n t 函数 }
 * @returns {Promise<object>} 可直接展开进 axios config 的 headers
 */
export async function signAdminOperation(operation, payload, opts = {}) {
  const { sessionAddress = null, t = null } = opts

  const pluginAddress = await requestAccounts()

  // 桌面预检：钱包已切走而登录会话还是旧地址（账户监听有竞态/漏检窗口）——
  // 立刻说人话指引，不必等后端 403 再猜"是不是只能操作自己的数据"（不是）
  if (
    sessionAddress &&
    String(pluginAddress).toLowerCase() !== String(sessionAddress).toLowerCase()
  ) {
    throw new Error(
      `钱包当前账户与登录管理面板的账户不一致（${String(sessionAddress).slice(0, 10)}…）。` +
        '请在 CCDAO 插件中切回登录时的账户，或退出重新登录。',
    )
  }

  const chalRes = await axios.post('/api/admin/challenge', {
    address: String(pluginAddress).toLowerCase(),
    operation,
    payload,
  })
  const nonce = chalRes.data.nonce
  const { message } = chalRes.data

  const signature = await signMessage(pluginAddress, message)
  const publicKey = await getPublicKey(pluginAddress)

  const sigStr = typeof signature === 'string' ? signature : (signature?.signature ?? '')
  const pubStr =
    typeof publicKey === 'string' ? publicKey : (publicKey?.publicKey ?? publicKey?.pubKey ?? '')
  if (!nonce || !sigStr || !pubStr) {
    const miss = [
      !nonce && 'nonce',
      !sigStr && (t ? t('admin.sigKindSign') : '签名'),
      !pubStr && (t ? t('admin.sigKindPub') : '公钥'),
    ]
      .filter(Boolean)
      .join('、')
    throw new Error(
      t
        ? t('admin.sigMaterialMissing', { miss })
        : `签名材料不齐（缺 ${miss}）——请确认 CCDAO 钱包已解锁后重试`,
    )
  }

  return {
    'x-admin-nonce': nonce,
    'x-admin-signature': sigStr,
    'x-admin-pubkey': pubStr,
  }
}
