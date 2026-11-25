import { ref, computed } from 'vue'
import axios from 'axios'
import i18n from '../i18n'
import { toast, askConfirm } from './useDialog'
import { requestAccounts, signFileBytes, getIpfsPublicKey, getPublicKey } from '../api/wallet.js'
import { formatBytes } from '../utils/format.js'

/**
 * 用户侧凭证域单例（P3 UC 第一刀）：v1.4/v1.5 凭证卡（DID/CWT/管理三分）的
 * 状态与动作全在此，UserTabCredential 整卡消费；壳（UserCenter）的
 * handleAddressChange/fetchUserInfo/connect 等处经 import 调同名导出——
 * loadCredentialStatus 全域唯此一支（判例 58）。
 *
 * 宿主注入（bindUserCredHost）：connect 域的 loginOnly/currentAddress/
 * pluginCaseAddr/rememberPluginCase/connected——凭证动作要换会话、认插件
 * 大小写、盯连接态，这些状态主权在 connect 域，凭证域只消费不复制。
 */
const t = (key, params) => i18n.global.t(key, params)

let host = {
  loginOnly: async () => 'error',
  currentAddress: () => '',
  pluginCaseAddr: { value: '' },
  rememberPluginCase: () => {},
  connected: { value: false },
}
export function bindUserCredHost(h) {
  host = { ...host, ...h }
}

// ════ v1.4 凭证体系（进入即判定 / 账户详情领取 / CWT 申请）════════
const credInfo = ref(null) // 台账公开形态 {kind:'did'|'cwt', state:'assigned'|'claimed', source}
const credApp = ref(null) // 本人 CWT 申请单（did 凭证已领取态才查）
const credBusy = ref('') // 'claim' | 'apply' | ''
// 凭证卡自愈态：credErr=上次失败摘要 {status,code}；credRetrying=重试进行中（含重签会话）
const credErr = ref(null)
const credRetrying = ref(false)
// 判权依据来源（2026-10-23 用户定式"先跑档案出错跑台账"）：'archive'=本轮经档案
// 活验背书 / 'ledger'=档案出错或超预算落台账兜底 / ''=未加载或 assigned（无档可验）
const credVerifiedBy = ref('')
const credNoDid = ref(null) // scaffold 返回的无档案指引 {didGenUrl, expectedAddress}
const credPopupShown = ref('') // 已弹过提醒的地址（切钱包=新地址=再提醒一次，轮询不轰炸）
const credVcOpen = ref(false) // 凭证本体 JSON 展开态
const credVc = ref(null) // 档案读回的 VC 全文（收起再开会用缓存；换凭证时置 null）
const credVcConsistent = ref(true) // 档案卡与台账现行卡是否一致（false=档案是旧副本）
const credVcLoading = ref(false)

// 档案需要跟上链上：续发/被改动/缺失——显示"同步凭证"按钮，让信息归一
const credNeedsSync = computed(() => {
  const c = credInfo.value
  return !!c && c.state === 'claimed' && ['stale', 'missing', 'invalid'].includes(c.onChain?.status)
})

// 到期剩余天数：到期前 30 天黄标；≤0 无需慌——登录时平台按台账记录自动续发
const credExpDays = computed(() => {
  if (!credInfo.value?.expiresAt) return null
  return Math.ceil((new Date(credInfo.value.expiresAt).getTime() - Date.now()) / 864e5)
})

const copyText = async (text) => {
  if (!text) return
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    toast(t('user.credCopied'))
  } catch {
    toast(t('user.credCopyFail'))
  }
}

const toggleCredVc = async () => {
  credVcOpen.value = !credVcOpen.value
  if (!credVcOpen.value || credVc.value || credVcLoading.value) return
  credVcLoading.value = true
  try {
    const res = await axios.get('/api/user/credential-vc')
    const cred = res.data.credential
    // 同款防线：卡面 subject/id 的持有人必须=当前地址（会话切号竞态下拒显他人卡）
    const holder = String(cred?.id || cred?.credentialSubject?.id || '')
      .replace(/^did:swtc:/i, '')
      .split('#')[0]
    const mine = String(displayAddr.value || '').toLowerCase()
    if (holder && mine && holder.toLowerCase() !== mine) {
      toast(t('user.sessionMismatch'))
      credVcOpen.value = false
      return
    }
    credVc.value = cred
    credVcConsistent.value = res.data.consistent !== false
  } catch (err) {
    toast(t('user.credVcFail', { err: err?.response?.data?.error || err.message }))
    credVcOpen.value = false
  } finally {
    credVcLoading.value = false
  }
}

// 自动重签单飞器（切账户自愈用）：并发调用共享同一次钱包弹窗与结果，
// 成功返回"已按新会话重查且地址吻合"的 credential-status 载荷，否则 null。
let autoResignPromise = null
const resignSessionTo = (addr) => {
  if (!autoResignPromise) {
    autoResignPromise = (async () => {
      const st = await host.loginOnly(addr)
      if (st !== 'ok') return null
      try {
        const r = await axios.get('/api/user/credential-status', {
          params: { address: addr, canonical: host.pluginCaseAddr.value || undefined },
        })
        const d = r.data || {}
        return String(d.address || '').toLowerCase() === String(addr).toLowerCase() ? d : null
      } catch {
        return null
      }
    })().finally(() => {
      autoResignPromise = null
    })
  }
  return autoResignPromise
}

const loadCredentialStatus = async (address) => {
  if (!address) return
  // ★致命/非致命彻底分离（用户实测"200 却报服务连不上"的根治）：此前 fetch、
  // 状态装配、领取弹窗同居一个 try——axios 成功之后任何一行抛 JS 异常都会被
  // catch 当成请求失败：清掉已装配好的 credInfo、置无状态码的 credErr，
  // retryCredential 的 netFail()（判据=status 空）把干净的 200 谎报成"网络中断"。
  // 现在 catch 只包 fetch——credErr 有值 ⇔ 请求本身真失败；后续装配/弹窗的
  // 异常只留 console 痕，绝不动 credInfo/credErr。
  let data
  try {
    const res = await axios.get('/api/user/credential-status', {
      // canonical=钱包原始大小写：给服务端"档案优先发现"当拼法线索（台账丢行也能
      // 直达档案真卡）；服务端验归一同址才采信，缺省不影响既有链路
      params: { address, canonical: host.pluginCaseAddr.value || undefined },
    })
    data = res.data || {}
  } catch (err) {
    credInfo.value = null
    credErr.value = {
      status: err?.response?.status || null,
      code:
        err?.response?.data?.code || err?.code || (err?.request ? 'ERR_NETWORK' : 'ERR_UNKNOWN'),
    }
    console.error(
      '[UserCenter] credential-status 请求失败:',
      credErr.value.status,
      credErr.value.code,
      err?.message,
    )
    return
  }
  // ★钱包切换防线（2026-10-23 用户报"凭证与address不一致"严重 bug 的根治）：
  // credential-status 服务端绑定的是 user_session cookie（上次签名登录的钱包），
  // 插件切账户未重签时返回的是**会话主人**的卡与角色。绝不把他人凭证/role=admin
  // 渲染在当前地址名下——假页签、真泄露都不许过。后端所有写操作严格绑会话，
  // 权限不可冒用，此处切断的是显示层串号+领取弹窗误导。
  // 用户拍板恢复方式：**检测到账户切换即自动发起重签**（钱包弹一次，零操作自愈）；
  // 拒签/重签未完成才落到被动引导态（"重新登录并重载凭证"按钮出口）。
  if (data.address && String(data.address).toLowerCase() !== String(address).toLowerCase()) {
    const fresh = await resignSessionTo(address)
    if (fresh) {
      data = fresh
      toast(t('user.autoResigned'))
    }
  }
  if (data.address && String(data.address).toLowerCase() !== String(address).toLowerCase()) {
    credInfo.value = null
    credVc.value = null
    credApp.value = null
    credErr.value = { status: null, code: 'SESSION_MISMATCH' }
    role.value = 'user'
    if (isSystemTab.value) activeTab.value = 'account'
    // 不动 connected：插件确实连着，只是会话 cookie 属旧账户——若置 false 会把
    // retryCredential（解药，:disabled="!connected"）锁死，用户困进无出口空态
    toast(t('user.sessionMismatch'))
    return
  }
  // ↓↓↓ 以下为"请求已成功"的纯装配段：任何异常都不许推翻凭证卡本身 ↓↓↓
  try {
    credErr.value = null // 成功即清因（占位态/文案随之消退）
    credVerifiedBy.value = data.verifiedBy || 'ledger' // 判权顺序溯源（档案活验/台账兜底）
    credInfo.value = data.credential || null
    // v1.5 判权面：role='admin' 才装配「系统管理」tab（服务端活验证凭证属实）
    role.value = data.role === 'admin' ? 'admin' : 'user'
    // 红点节拍只在管理员在场：首起一次（badgesStarted 守，凭证状态刷新反复走此
    // 函数不叠加计数）；角色跌落=普通用户/登出，立即停表并复位
    if (role.value === 'admin') {
      if (!badgesStarted) {
        badgesStarted = true
        startAdminBadges()
      }
    } else if (badgesStarted) {
      badgesStarted = false
      stopAdminBadges()
    }
    roleSettled = true
    // 移动深链首落（B1 修复 2026-11-10）：角色定盘后才消费寄存/首见 query，
    // 后续 query 变化由 watch 走同一 applyMobileTabLink；桌面分支原样不动
    if (isMobile.value && !initialTabApplied) {
      initialTabApplied = true
      const mq = mobileDeepLinkPending ?? String(route.query.tab || '')
      mobileDeepLinkPending = null
      if (mq) applyMobileTabLink(mq)
    } else if (role.value === 'admin' && !initialTabApplied) {
      // （2026-10-23 修重大 bug：initialTabApplied 声明是裸布尔（:918），这里曾按
      // ref 用 .value——赋值即 TypeError，管理员每次装配都在此 throw，深链页签/
      // 续发提示/申请单态全被 catch 吞掉。恢复纯布尔用法，语义不变=仅首次生效）
      initialTabApplied = true
      // 深链落地：?tab=adm:cred 直达子页；旧入口 ?tab=system（/admin 重定向）落管理总览
      const q = String(route.query.tab || '')
      if (q.startsWith('adm:')) activeTab.value = q
      else if (q === 'system') activeTab.value = 'adm:overview'
    } else if (!initialTabApplied) {
      // 治动作歧义（用户裁定 2026-11-02）：首页「系统管理」按钮与普通入口同去用户
      // 中心——非管理员由管理深链进来时，管理页签根本不装配，旧版静默弹回账户页，
      // 用户无从知道是点错了、坏了、还是权限不够。现在给明话：落点在此、缘由在此。
      initialTabApplied = true
      const q0 = String(route.query.tab || '')
      if (q0.startsWith('adm:') || q0 === 'system') toast(t('user.adminEntryLocked'))
    }
    // 撤销即时收面：角色掉出 admin 且正停在管理页 → 弹回账户信息（移动壳同闸：
    // 审批 tab 是管理面，角色跌落/登出重入非 admin 时从审批页弹回首页）
    if (role.value !== 'admin' && isSystemTab.value) activeTab.value = 'account'
    if (role.value !== 'admin' && mobileTab.value === 'approvals') mobileTab.value = 'home'
    if (data.renewed) {
      // 平台按台账 cwt/did 记录自动续发了新凭证（链上登记册同步换卡）
      credVc.value = null
      toast(t('user.credRenewed'))
    }
    if (data.credential && data.credential.kind === 'did' && data.credential.state === 'claimed') {
      try {
        const ar = await axios.get('/api/user/cwt-application', { params: { address } })
        credApp.value = ar.data.application || null
      } catch {
        credApp.value = null
      }
    } else {
      credApp.value = null
    }
  } catch (err) {
    console.error('[UserCenter] 凭证装配异常（不影响凭证卡）:', err?.message)
  }
  // 分配了但还没领取 → 弹窗提醒（领取=把凭证写进用户自己的 DID 档案）；按地址节流。
  // 弹窗是锦上添花：its 成败与凭证卡彻底无关（askConfirm 本身永不 reject，双保险）
  try {
    if (data.popup && credInfo.value && credPopupShown.value !== address) {
      credPopupShown.value = address
      await askConfirm({
        message:
          credInfo.value.kind === 'cwt' && (credInfo.value.roles || []).includes('admin')
            ? t('user.credPopupAdmin') // v1.5：管理凭证到位（领取后即可见「系统管理」）
            : credInfo.value.kind === 'cwt'
              ? t('user.credPopupCwt')
              : t('user.credPopupDid'),
        confirmLabel: t('user.credClaimBtn'),
        run: () => claimCredential(),
      })
    }
  } catch (err) {
    console.error('[UserCenter] 领取弹窗异常（不影响凭证卡）:', err?.message)
  }
}

// 占位态的"重试"＝完整自愈：先重建会话再重拉。
// 历史根因：会话签发点曾硬编码 2h（cookie 却 12h），开着页面过夜必 401，
// 而旧重试只重发死请求、无反馈——表现"没反应"。后端已修（12h + 滑动续期），
// 但前端仍保留自愈路做纵深：loginOnly 会话健在→session-info 命中零弹窗复用；
// 已失效→走插件重签换 cookie（一次性挑战，验签与登录同式）。全程态可见、成败有话。
const retryCredential = async () => {
  const address = host.currentAddress()
  if (!address) {
    toast(t('user.errConnectFirst'))
    return
  }
  credRetrying.value = true
  // loadCredentialStatus 已保证：credErr 有值 ⇔ fetch 本身真失败（有留痕无  // HTTP 状态码=连接级：重启窗口/断网/超时）
  const netFail = () => credErr.value && !credErr.value.status
  try {
    const st = await host.loginOnly(address)
    if (st === 'ok') await loadCredentialStatus(address)
    // 连接级失败（实测主因：服务部署重启 ~10s 窗口 ECONNREFUSED）→ 等 3s 自动
    // 再试一次，瞬断不该劳烦用户二次点击
    if (st === 'ok' && !credInfo.value && netFail()) {
      await new Promise((r) => setTimeout(r, 3000))
      await loadCredentialStatus(address)
    }
    if (credInfo.value) {
      toast(t('user.credReloaded'))
    } else if (st === 'denied') {
      // loginOnly 已 toast 具体原因（拒签/验签失败），此处不叠话
    } else if (credErr.value?.code === 'SESSION_MISMATCH') {
      // 重签后仍不一致（理论上近零：loginOnly 失败静默/被拒的残余态）——
      // 不许误报成"应答异常"，直说是会话与账户没对齐
      toast(t('user.sessionMismatch'))
    } else if (credErr.value?.status === 401 || credErr.value?.status === 403) {
      toast(t('user.credFailSession'))
    } else if (netFail()) {
      toast(t('user.credFailNet'))
    } else if (credErr.value?.status) {
      toast(t('user.credFailHttp', { err: credErr.value.status }))
    } else {
      // 200 却无凭证体：服务端应答异常，与网络无关——旧版谎报"网络"的定位坑
      toast(t('user.credFailEmpty'))
    }
  } finally {
    credRetrying.value = false
  }
}

const sha256Hex = async (bytes) => {
  // 非安全上下文（http+局域网 IP）没有 crypto.subtle——纯 JS 兜底，输出逐字节一致
  // （2026-10-26 服务器实弹："存入失败：…digest"；fixlog#5/#27 同族；兜底见 utils/sha256.js）
  if (window.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  return sha256HexFallback(bytes)
}

/**
 * 领取凭证：scaffold（平台签 VC）→ 插件对档案字节做 IPFS 口径文件签 → upload 上链。
 * 无 DID 档案时只亮指引（生成地址 + 核对提醒），不硬试写入。
 */
const claimCredential = async () => {
  if (!window.ccdao || !window.ccdao.request) {
    toast(t('user.errNoCcdao'))
    return
  }
  credBusy.value = 'claim'
  try {
    const pluginAddress = await requestAccounts()
    host.rememberPluginCase(pluginAddress)
    if (!pluginAddress) {
      toast(t('user.errNoAccount'))
      return
    }
    const scfRes = await axios.post('/api/user/credential-scaffold', {
      canonicalAddress: pluginAddress,
    })
    const scf = scfRes.data || {}
    if (scf.alreadyClaimed) {
      credNoDid.value = null
      toast(t('user.credAlreadyClaimed'))
      await loadCredentialStatus(pluginAddress.toLowerCase())
      return
    }
    if (scf.probeFailed) {
      // 档案服务瞬断≠没档案：只提示重试，不出"去生成 DID"的重指引（防误导）
      credNoDid.value = null
      toast(scf.hint || t('user.credProbeFail'))
      return
    }
    if (scf.noProfile) {
      credNoDid.value = scf
      toast(t('user.credNeedDid'))
      return
    }
    if (!scf.document) throw new Error(scf.error || t('user.credScaffoldFail'))
    // wodecards 文件签口径：签的字节是 utf8(sha256(文件).hex)（官方 ipfs-rpc-client 拆包定样）
    const docBytes = new TextEncoder().encode(JSON.stringify(scf.document))
    const msgBytes = new TextEncoder().encode(await sha256Hex(docBytes))
    const signature = await signFileBytes(pluginAddress, msgBytes)
    let publicKey = null
    try {
      publicKey = await getIpfsPublicKey(pluginAddress)
    } catch {
      publicKey = await getPublicKey(pluginAddress)
    }
    await axios.post('/api/user/credential-upload', {
      document: scf.document,
      fileName: scf.fileName,
      publicKey,
      signature,
    })
    credNoDid.value = null
    toast(scf.reissue ? t('user.credSynced') : t('user.credClaimed'))
    credVc.value = null // 换卡/首领：重置凭证本体查看态
    credVcOpen.value = false
    await loadCredentialStatus(pluginAddress.toLowerCase())
  } catch (err) {
    const msg = err?.response?.data?.error || err?.message || String(err)
    toast(t('user.credClaimFail', { msg }))
  } finally {
    credBusy.value = ''
  }
}

const applyCwt = async () => {
  const address = host.currentAddress()
  credBusy.value = 'apply'
  try {
    await axios.post('/api/user/cwt-apply', { address })
    toast(t('user.credApplied'))
    await loadCredentialStatus(address)
  } catch (err) {
    toast(err?.response?.data?.error || t('user.credApplyFail'))
  } finally {
    credBusy.value = ''
  }
}

export function useUserCred() {
  return {
    credInfo,
    credApp,
    credBusy,
    credErr,
    credRetrying,
    credVerifiedBy,
    credNoDid,
    credPopupShown,
    credVcOpen,
    credVc,
    credVcConsistent,
    credVcLoading,
    credNeedsSync,
    credExpDays,
    copyText,
    toggleCredVc,
    resignSessionTo,
    loadCredentialStatus,
    retryCredential,
    sha256Hex,
    claimCredential,
    applyCwt,
    connected: host.connected,
  }
}
