<template>
  <div class="mobile-me">
    <!-- Loading 状态 -->
    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">加载中...</div>
    </div>

    <template v-else>
      <!-- 头部 -->
      <div class="ghead">
        <div class="row1">
          <div class="ttl">我的</div>
          <div class="avatar">{{ !sessionAddr ? '—' : role === 'admin' ? '管' : '用' }}</div>
        </div>
        <div class="greet">
          {{ roleLabel }}
          <span class="greet-hint">｜<span class="link" @click="refresh">刷新</span></span>
        </div>
        <div class="addr-chip" @click="copyAddress">
          <span class="addr-icon">🔑</span>
          <span class="addr-text">{{ shortAddr }}</span>
          <span class="addr-act">复制</span>
        </div>
      </div>

      <div class="body">
        <!-- ① 钱包未连：如实指引（移动壳进入时插件多半已连，此为兜底态） -->
        <div v-if="!walletAddr && !sessionAddr" class="card">
          <div class="ct">🔌 未检测到钱包</div>
          <div class="cd">
            登录与凭证领取需要 CCDAO 钱包（浏览器插件或 JDID WebView）。连接后下拉本页重试。
          </div>
          <button class="btn btn-p" @click="refresh">重新检测</button>
        </div>

        <!-- ② 切号防线：钱包账户 ≠ 会话主人（桌面同款：绝不把他人凭证/角色当自己的展示） -->
        <div v-else-if="addrMismatch" class="card">
          <div class="ct">🔀 钱包已切换账户</div>
          <div class="cd">
            当前钱包账户与登录会话不是同一地址。为避免展示他人凭证，本页已暂停读数——请重新签名登录。
          </div>
          <button class="btn btn-p" @click="doWalletLogin" :disabled="loginBusy">
            {{ loginBusy ? '签名确认中...' : '重新登录' }}
          </button>
        </div>

        <!-- ③ 有钱包无会话：登录引导（/connect?action=login 同款用途，纯登录不建容器） -->
        <div v-else-if="!sessionAddr" class="card">
          <div class="ct">🪪 尚未登录</div>
          <div class="cd">用钱包签名换取登录会话，凭证与配额读数需要先登录。</div>
          <button class="btn btn-p" @click="doWalletLogin" :disabled="loginBusy">
            {{ loginBusy ? '签名确认中...' : '钱包登录' }}
          </button>
        </div>

        <!-- ④ 已登录主体 -->
        <template v-else>
          <!-- 配额/用量卡 -->
          <div class="card">
            <div class="ct">📊 今日配额</div>
            <template v-if="usage && usage.enabled">
              <div v-if="unlimited" class="unlimited-row">
                <span class="badge b-purple">CWT 解限 · 不限时</span>
                <div class="cd" style="margin: 8px 0 0">
                  今日已用 {{ usage.usedMinutes ?? 0 }} 分钟
                </div>
              </div>
              <template v-else>
                <div class="kv">
                  <span class="k">今日已用</span>
                  <span class="v">{{ usage.usedMinutes ?? 0 }} 分钟</span>
                </div>
                <div class="kv">
                  <span class="k">每日上限</span>
                  <span class="v">{{ usage.dailyMinutes }} 分钟</span>
                </div>
                <div class="kv" style="border: none; padding-bottom: 4px">
                  <span class="k">剩余</span>
                  <span class="v">{{ usage.remainingMinutes ?? 0 }} 分钟</span>
                </div>
                <div class="progress">
                  <i :style="{ width: usagePct + '%' }"></i>
                </div>
              </template>
            </template>
            <div v-else-if="usage" class="cd" style="margin: 0">限时策略未启用，可自由使用。</div>
            <div v-else class="cd" style="margin: 0">用量数据暂未取到（容器不存在或未起）。</div>
          </div>

          <!-- 凭证卡（v1.4 互斥单卡：一人一张现行卡，kind 即身份） -->
          <div v-if="credential" class="card">
            <div class="ct">
              🎫 我的凭证
              <span class="badge" :class="stateBadge">{{
                credential.state === 'claimed' ? '已领取' : '待领取'
              }}</span>
            </div>
            <div class="kv">
              <span class="k">类型</span>
              <span class="v">
                <span class="badge" :class="credKind === 'cwt' ? 'b-orange' : 'b-purple'">{{
                  kindLabel
                }}</span>
                <span v-if="isAdmin" class="badge b-green" style="margin-left: 6px">管理凭证</span>
              </span>
            </div>
            <div v-if="credential.expiresAt" class="kv">
              <span class="k">到期</span>
              <span class="v" :class="{ warn: expDays !== null && expDays <= 30 }">
                {{ credential.expiresAt.slice(0, 10) }}
                <span v-if="expDays !== null" style="color: var(--m-muted)"
                  >（{{ expDays > 0 ? `${expDays} 天后` : '已过期' }}，登录时自动续发）</span
                >
              </span>
            </div>
            <div
              v-if="credential.onChain && credential.state === 'claimed'"
              class="kv"
              style="border: none"
            >
              <span class="k">链上状态</span>
              <span class="v">
                <span class="badge" :class="credNeedsSync ? 'b-red' : 'b-green'">{{
                  onChainLabel
                }}</span>
              </span>
            </div>

            <!-- 动作区（与桌面同闸同端点）。2026-11-11 用户要求"申请 CWT 解限/
                 查看凭证本体等宽等高"：全部收进 flex 行（.cred-actions），
                 flex:1 平分宽度、stretch 拉平高度；一行挤不下整颗换行（仍等宽）。
                 审核中徽章随行居中；驳回原因出行动到行外。 -->
            <div class="cred-actions">
              <button
                v-if="credential.state === 'assigned' || credNeedsSync"
                class="btn btn-p"
                @click="claimCredential"
                :disabled="credBusy === 'claim'"
              >
                {{
                  credBusy === 'claim'
                    ? '领取中...'
                    : credential.state === 'assigned'
                      ? '领取凭证'
                      : '同步凭证（存链跟上档案）'
                }}
              </button>
              <button
                v-if="
                  credKind === 'did' &&
                  credential.state === 'claimed' &&
                  (!credApp || credApp.status === 'rejected')
                "
                class="btn btn-p"
                @click="applyCwt"
                :disabled="credBusy === 'apply'"
              >
                {{
                  credBusy === 'apply'
                    ? '提交中...'
                    : credApp
                      ? '重新申请 CWT 解限'
                      : '申请 CWT 解限（不限时）'
                }}
              </button>
              <!-- 凭证本体查看（holder 防线与桌面同款：卡主≠本页地址即拒显） -->
              <button
                v-if="credential.state === 'claimed'"
                class="btn btn-ghost"
                @click="toggleCredVc"
                :disabled="credVcLoading"
              >
                {{ credVcOpen ? '收起凭证 JSON' : '查看凭证本体' }}
              </button>
              <span v-if="credApp && credApp.status === 'pending'" class="badge b-orange">
                CWT 审核中
              </span>
            </div>
            <div v-if="credApp && credApp.status === 'rejected' && credApp.reviewNote" class="cd">
              上次被驳回：{{ credApp.reviewNote }}
            </div>
            <pre v-if="credVcOpen && credVc" class="vc-json">{{
              JSON.stringify(credVc, null, 2)
            }}</pre>
            <div v-if="credVcOpen && !credVcConsistent" class="cd" style="margin-top: 6px">
              ⚠️ 档案里的卡是旧副本，建议点上方"同步凭证"。
            </div>
          </div>
          <div v-else-if="credErr" class="card">
            <div class="ct">🎫 凭证读数失败</div>
            <div class="cd">{{ credErr }}</div>
            <button class="btn btn-p" @click="refresh">重试</button>
          </div>

          <!-- 退出登录（T7：真退出落点在此；Home 的地址 chip 已改"复制"不再挂错行为） -->
          <button class="btn btn-ghost logout-btn" @click="doLogout">退出登录</button>
        </template>
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * 移动端"我的"tab（P1）：登录/退出 + 今日配额 + v1.4 凭证领取/CWT 申请。
 * 口径全部对齐桌面 UserCenter account 页签的孪生实现（endpoint/参数/防线逐字照抄）；
 * 刻意精简掉的是移动非必需件：档案弹窗轰炸节流、切号自动重签单飞器（改为显式
 * "重新登录"按钮）、凭证展示全量文案——防线语义不减（切号即停读数）。
 */
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import {
  requestAccounts,
  signMessage,
  getPublicKey,
  signFileBytes,
  getIpfsPublicKey,
} from '../../api/wallet.js'
import { sha256Hex as sha256HexFallback } from '../../utils/sha256.js'
import { toast, askConfirm } from '../../composables/useDialog'

const loading = ref(true)
const sessionAddr = ref('')
const walletAddr = ref('')
const role = ref('user')
const credential = ref(null)
const credApp = ref(null)
const usage = ref(null)
const loginBusy = ref(false)
const credBusy = ref('')
const credErr = ref('')
// 钱包原始大小写拼法（与桌面同 localStorage 键，canonical 线索跨端一致）
const pluginCaseAddr = ref(localStorage.getItem('swtc_plugin_case') || '')

// 凭证本体查看态
const credVcOpen = ref(false)
const credVc = ref(null)
const credVcConsistent = ref(true)
const credVcLoading = ref(false)

const roleLabel = computed(() => {
  if (!sessionAddr.value) return walletAddr.value ? '钱包已连接 · 未登录' : '未连接钱包'
  return role.value === 'admin' ? '管理员 · 已登录' : '用户 · 已登录'
})
const shortAddr = computed(() => {
  const a = sessionAddr.value || walletAddr.value
  return a ? `${a.slice(0, 12)}…${a.slice(-4)}` : '未连接'
})
const addrMismatch = computed(
  () =>
    !!walletAddr.value &&
    !!sessionAddr.value &&
    walletAddr.value.toLowerCase() !== sessionAddr.value.toLowerCase(),
)
const credKind = computed(() => credential.value?.kind || 'did')
const isAdmin = computed(() => !!credential.value?.isAdmin)
const kindLabel = computed(() => (credKind.value === 'cwt' ? 'CWT 解除凭证' : 'DID 普通凭证'))
const stateBadge = computed(() => (credential.value?.state === 'claimed' ? 'b-green' : 'b-orange'))
const unlimited = computed(() => !!usage.value?.enabled && usage.value?.dailyMinutes == null)
const usagePct = computed(() => {
  if (!usage.value?.enabled || usage.value.dailyMinutes == null) return 0
  const l = usage.value.dailyMinutes || 1
  return Math.min(100, Math.round(((usage.value.usedMinutes || 0) / l) * 100))
})
const expDays = computed(() => {
  if (!credential.value?.expiresAt) return null
  return Math.ceil((new Date(credential.value.expiresAt).getTime() - Date.now()) / 864e5)
})
// 与桌面同款：claimed 且链上副本没跟上 → 给"同步"动作
const credNeedsSync = computed(() => {
  const c = credential.value
  return !!c && c.state === 'claimed' && ['stale', 'missing', 'invalid'].includes(c.onChain?.status)
})
const onChainLabel = computed(() => {
  const s = credential.value?.onChain?.status
  return s === 'ok'
    ? '链上一致'
    : s === 'stale'
      ? '档案落后'
      : s === 'missing'
        ? '链上缺档'
        : s === 'invalid'
          ? '验签异常'
          : s || '未核验'
})

function rememberPluginCase(a) {
  if (a) {
    pluginCaseAddr.value = a
    localStorage.setItem('swtc_plugin_case', a)
  }
}

async function sha256Hex(bytes) {
  // 桌面同款兜底：非安全上下文（局域网 http）无 crypto.subtle
  if (window.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  return sha256HexFallback(bytes)
}

function copyAddress() {
  const a = sessionAddr.value || walletAddr.value
  if (a) {
    navigator.clipboard?.writeText(a)
    toast('地址已复制到剪贴板')
  }
}

// —— 登录：/api/user/wallet-login-challenge → 签 message → wallet-login（桌面 walletLogin 逐字对齐） ——
async function doWalletLogin() {
  loginBusy.value = true
  try {
    const pluginAddress = await requestAccounts()
    rememberPluginCase(pluginAddress)
    const ch = await axios.post('/api/user/wallet-login-challenge', { address: pluginAddress })
    const { nonce, message } = ch.data
    const signature = await signMessage(pluginAddress, message)
    const publicKey = await getPublicKey(pluginAddress)
    await axios.post('/api/user/wallet-login', {
      address: pluginAddress,
      nonce,
      signature,
      publicKey,
    })
    localStorage.setItem('swtc_address', String(pluginAddress).toLowerCase())
    toast('登录成功')
    await loadAll()
  } catch (e) {
    toast(`登录失败：${e.response?.data?.error || e.message}`)
  } finally {
    loginBusy.value = false
  }
}

// —— 领取/同步凭证（桌面 claimCredential 逐字对齐：scaffold→文件签→upload，含 reissue 路） ——
async function claimCredential() {
  if (!window.ccdao && !window.ethereum) {
    toast('需要 CCDAO 钱包才能领取')
    return
  }
  credBusy.value = 'claim'
  try {
    const pluginAddress = await requestAccounts()
    rememberPluginCase(pluginAddress)
    if (!pluginAddress) {
      toast('未获取到钱包账户')
      return
    }
    const scfRes = await axios.post('/api/user/credential-scaffold', {
      canonicalAddress: pluginAddress,
    })
    const scf = scfRes.data || {}
    if (scf.alreadyClaimed) {
      toast('凭证已是现行卡，无需重复领取')
      await loadAll()
      return
    }
    if (scf.probeFailed) {
      // 档案瞬断≠没档案：只提示重试，不甩"去生成 DID"重指引（防误导，桌面同款分家）
      toast(scf.hint || '档案服务瞬断，请稍后重试')
      return
    }
    if (scf.noProfile) {
      toast(
        `需要先有官网 DID 档案（生成后核对地址：${String(scf.expectedAddress || pluginAddress).slice(0, 10)}…）`,
      )
      return
    }
    if (!scf.document) throw new Error(scf.error || '领取材料装配失败')
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
    toast(scf.reissue ? '已同步：档案副本跟上现行卡' : '领取成功，凭证已入档案')
    credVc.value = null
    credVcOpen.value = false
    await loadAll()
  } catch (e) {
    toast(`领取失败：${e.response?.data?.error || e.message}`)
  } finally {
    credBusy.value = ''
  }
}

async function applyCwt() {
  credBusy.value = 'apply'
  try {
    await axios.post('/api/user/cwt-apply', { address: sessionAddr.value })
    toast('CWT 解限申请已提交，等待管理员审批')
    await loadAll()
  } catch (e) {
    toast(e?.response?.data?.error || '申请提交失败')
  } finally {
    credBusy.value = ''
  }
}

// —— 凭证本体（桌面同款 holder 防线：卡主≠本页地址即拒显） ——
async function toggleCredVc() {
  credVcOpen.value = !credVcOpen.value
  if (!credVcOpen.value || credVc.value || credVcLoading.value) return
  credVcLoading.value = true
  try {
    const res = await axios.get('/api/user/credential-vc')
    const cred = res.data.credential
    const holder = String(cred?.id || cred?.credentialSubject?.id || '')
      .replace(/^did:swtc:/i, '')
      .split('#')[0]
    const mine = String(sessionAddr.value || '').toLowerCase()
    if (holder && mine && holder.toLowerCase() !== mine) {
      toast('凭证持卡人与当前会话不一致，已拒绝展示')
      credVcOpen.value = false
      return
    }
    credVc.value = cred
    credVcConsistent.value = res.data.consistent !== false
  } catch (e) {
    toast(`读取凭证本体失败：${e?.response?.data?.error || e.message}`)
    credVcOpen.value = false
  } finally {
    credVcLoading.value = false
  }
}

async function doLogout() {
  await askConfirm({
    message: '退出登录？凭证与容器不受影响，重新签名登录即可恢复读数。',
    confirmLabel: '退出',
    run: async () => {
      try {
        await axios.post('/api/user/logout')
        localStorage.removeItem('swtc_address')
        sessionAddr.value = ''
        credential.value = null
        credApp.value = null
        usage.value = null
        toast('已退出登录')
        await refresh()
      } catch (e) {
        toast(`退出失败：${e?.response?.data?.error || e.message}`)
      }
    },
  })
}

async function loadAll() {
  loading.value = true
  try {
    // ① 会话是谁：session-info（server 单源 user_session）
    try {
      const s = await axios.get('/api/user/session-info')
      sessionAddr.value = s.data?.address || ''
    } catch {
      sessionAddr.value = ''
    }
    // ② 钱包是谁：best-effort（未解锁/拒绝授权不拦页面）
    if (window.ccdao || window.ethereum) {
      try {
        walletAddr.value = (await requestAccounts()) || ''
        rememberPluginCase(walletAddr.value)
      } catch {
        walletAddr.value = ''
      }
    } else {
      walletAddr.value = ''
    }

    // ③ 切号防线：不一致就停读数（桌面"绝不把他人凭证当自己的"同款）
    if (addrMismatch.value) {
      credential.value = null
      credApp.value = null
      usage.value = null
      credErr.value = ''
      return
    }

    if (sessionAddr.value) {
      // ④ 判权 + 凭证：credential-status（canonical 拼法线索与桌面同键）
      try {
        const res = await axios.get('/api/user/credential-status', {
          params: { address: sessionAddr.value, canonical: pluginCaseAddr.value || undefined },
        })
        const d = res.data || {}
        credential.value = d.credential || null
        role.value = d.role || 'user'
        credErr.value = ''
      } catch (e) {
        credential.value = null
        credErr.value =
          e?.response?.status === 401
            ? '会话已过期，请重新登录'
            : `判权查询失败（${e?.response?.data?.error || e.message}）`
      }

      // ⑤ CWT 申请单：DID 已领取态才查（桌面同款条件）
      if (credential.value?.kind === 'did' && credential.value?.state === 'claimed') {
        try {
          const ar = await axios.get('/api/user/cwt-application', {
            params: { address: sessionAddr.value },
          })
          credApp.value = ar.data.application || null
        } catch {
          credApp.value = null
        }
      } else {
        credApp.value = null
      }

      // ⑥ 今日配额：connect-status.usage
      try {
        const c = await axios.get(
          `/connect-status?address=${encodeURIComponent(sessionAddr.value)}`,
        )
        usage.value = c.data?.usage || null
      } catch {
        usage.value = null
      }
    }
  } finally {
    loading.value = false
  }
}

function refresh() {
  return loadAll()
}

onMounted(loadAll)
</script>

<style scoped>
.mobile-me {
  min-height: 100vh;
  background: var(--m-bg);
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  gap: 16px;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(106, 114, 232, 0.2);
  border-top-color: var(--m-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.loading-text {
  font-size: 14px;
  color: var(--m-muted);
}

.ghead {
  background: linear-gradient(135deg, var(--m-primary) 0%, var(--m-primary-2) 100%);
  padding: 20px 16px 24px;
  color: #fff;
}

.row1 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.ttl {
  font-size: 18px;
  font-weight: 700;
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
}

.greet {
  font-size: 14px;
  margin-bottom: 12px;
}

.greet-hint {
  opacity: 0.7;
}

.link {
  text-decoration: underline;
  cursor: pointer;
}

.addr-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  padding: 10px 12px;
  cursor: pointer;
}

.addr-chip:active {
  background: rgba(255, 255, 255, 0.25);
}

.addr-icon {
  font-size: 16px;
}

.addr-text {
  flex: 1;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 12px;
}

.addr-act {
  font-size: 12px;
  opacity: 0.8;
  font-weight: 600;
}

.body {
  padding: 16px;
}

.card {
  background: #fff;
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
  margin-bottom: 16px;
}

.ct {
  font-size: 14px;
  font-weight: 700;
  color: var(--m-ink);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.cd {
  font-size: 12px;
  color: var(--m-muted);
  line-height: 1.6;
  margin-bottom: 8px;
}

.kv {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #f2f3f8;
  font-size: 13px;
}

.kv .k {
  color: var(--m-muted);
}

.kv .v {
  color: var(--m-ink);
  font-weight: 600;
}

.kv .v.warn {
  color: #d69e2e;
}

.badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 999px;
}

.b-purple {
  background: var(--m-purple-soft);
  color: var(--m-primary);
}

.b-green {
  background: var(--m-green-soft);
  color: var(--m-green);
}

.b-orange {
  background: var(--m-amber-soft);
  color: var(--m-amber-strong);
}

.b-red {
  background: var(--m-danger-soft);
  color: var(--m-danger);
}

.progress {
  height: 8px;
  background: var(--m-track);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 8px;
}

.progress i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--m-primary), var(--m-primary-2));
  border-radius: 999px;
  transition: width 0.4s;
}

.btn {
  padding: 10px 16px;
  border: none;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-p {
  background: linear-gradient(135deg, var(--m-primary), var(--m-primary-2));
  color: #fff;
  box-shadow: 0 4px 12px rgba(106, 114, 232, 0.3);
}

.btn-ghost {
  background: #f2f3f8;
  color: var(--m-text);
}

/* 凭证动作行：按钮 flex:1 basis 0 平分宽度（两颗就各半、三颗就各三之一，
   永远等宽）；align-items 默认 stretch 等高；长文案在钮内折行不撑歪邻座 */
.cred-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.cred-actions .btn {
  flex: 1 1 0;
  min-width: 0;
}

.cred-actions .badge {
  flex: 0 0 auto;
  align-self: center;
}

.logout-btn {
  width: 100%;
  color: var(--m-danger);
}

.vc-json {
  margin-top: 10px;
  max-height: 260px;
  overflow: auto;
  background: #f6f7fb;
  border-radius: 10px;
  padding: 10px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--m-text);
  white-space: pre-wrap;
  word-break: break-all;
}

.unlimited-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
