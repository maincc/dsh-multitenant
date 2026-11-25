<template>
  <div class="user-center">
    <!-- 加载页面 -->
    <div v-if="loading" class="state-card loading-card">
      <div class="loading-spinner">
        <div class="spinner"></div>
      </div>
      <h2>{{ loadingTitle }}</h2>
      <p class="loading-message">{{ loadingMessage }}</p>
      <div class="loading-progress">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: loadingProgress + '%' }"></div>
        </div>
        <span class="progress-text">{{ loadingProgress }}%</span>
      </div>
    </div>

    <!-- 连接钱包页面（桌面专属 2026-11-10：判例·挂机跌落报障——这张全屏卡曾顶掉
         整个移动壳，底部 tab 跟着消失；且它让手机"装 Chrome 扩展"，移动端无从点击。
         移动失联不再换卡：壳常驻，自动回落「我的」tab 用 MobileMe 登录面板恢复。） -->
    <div v-else-if="!connected && !isMobile" class="state-card connect-card">
      <h2>{{ $t('user.connectTitle') }}</h2>
      <p>{{ $t('user.connectHint') }}</p>

      <div v-if="!hasCCDAO" class="error">
        {{ $t('user.noCcdao') }}
        <br />
        <a
          href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ $t('user.installCcdao') }}
        </a>
      </div>

      <button v-else class="btn btn-primary btn-large" @click="connectWallet">
        {{ $t('user.connectBtn') }}
      </button>
    </div>

    <!-- 等待队列页面（桌面专属，同连接卡：移动壳不许被全屏卡顶掉——tab 常驻是
         2026-11-10 报障定下的移动端铁律；移动排队进度由 MobileMe/容器 tab 自述） -->
    <div v-else-if="waiting && !isMobile" class="state-card waiting-card">
      <div class="waiting-icon">⏳</div>
      <h2>{{ $t('user.waitingTitle') }}</h2>
      <p class="waiting-message">{{ $t('user.waitingMsg1') }}</p>
      <p class="waiting-message">{{ $t('user.waitingMsg2') }}</p>

      <div class="queue-info">
        <div class="queue-item">
          <span class="queue-label">{{ $t('user.queuePos') }}</span>
          <span class="queue-value">{{ $t('user.queuePosValue', { n: queuePosition }) }}</span>
        </div>
        <div class="queue-item">
          <span class="queue-label">{{ $t('user.queueTotal') }}</span>
          <span class="queue-value">{{ $t('user.queueTotalValue', { n: queueTotal }) }}</span>
        </div>
        <div class="queue-item">
          <span class="queue-label">{{ $t('user.waitTime') }}</span>
          <span class="queue-value">{{ waitingTime }}</span>
        </div>
      </div>

      <div class="waiting-progress">
        <div class="spinner"></div>
        <span>{{ $t('user.waitCleanup') }}</span>
      </div>

      <button class="btn btn-secondary" @click="cancelWaiting">{{ $t('user.cancelWait') }}</button>
    </div>

    <!-- 用户信息页面：左侧栏 + 右侧内容（与 React 原型稿一致） -->
    <!-- 移动端布局：底部 Tab 导航 -->
    <div v-else-if="isMobile" class="mobile-shell">
      <!-- 移动端内容区 -->
      <div class="mobile-content">
        <!-- 首页 -->
        <div v-if="mobileTab === 'home'" class="mobile-page">
          <MobileHome />
        </div>
        <!-- 容器 -->
        <div v-else-if="mobileTab === 'container'" class="mobile-page">
          <MobileContainer
            :initial-sub="containerInitialSub"
            @sub-consumed="containerInitialSub = ''"
          />
        </div>
        <!-- 技能市场 -->
        <div v-else-if="mobileTab === 'skills'" class="mobile-page">
          <MobileMarket />
        </div>
        <!-- 审批 -->
        <div v-else-if="mobileTab === 'approvals'" class="mobile-page">
          <MobileApprovals />
        </div>
        <!-- 我的（P1 落地 2026-11-10：登录/退出+配额+v1.4 凭证，替换原占位） -->
        <div v-else-if="mobileTab === 'me'" class="mobile-page">
          <MobileMe />
        </div>
      </div>

      <!-- 底部 Tab 导航 -->
      <nav class="mobile-tabbar">
        <button
          class="tab-item"
          :class="{ active: mobileTab === 'home' }"
          @click="mobileTab = 'home'"
        >
          <div class="tab-icon">🏠</div>
          <div class="tab-label">首页</div>
        </button>
        <button
          class="tab-item"
          :class="{ active: mobileTab === 'container' }"
          @click="mobileTab = 'container'"
        >
          <div class="tab-icon">📦</div>
          <div class="tab-label">容器</div>
        </button>
        <button
          class="tab-item"
          :class="{ active: mobileTab === 'skills' }"
          @click="mobileTab = 'skills'"
        >
          <div class="tab-icon">🏪</div>
          <div class="tab-label">市场</div>
        </button>
        <!-- B3（2026-11-10）：审批是管理面，普通用户从装配层移除（桌面侧栏同款基调，
             不再靠后端 403 兜底） -->
        <button
          v-if="role === 'admin'"
          class="tab-item"
          :class="{ active: mobileTab === 'approvals' }"
          @click="mobileTab = 'approvals'"
        >
          <div class="tab-icon">
            ✅
            <span v-if="approvalCount > 0" class="tab-dot"></span>
          </div>
          <div class="tab-label">审批</div>
        </button>
        <button class="tab-item" :class="{ active: mobileTab === 'me' }" @click="mobileTab = 'me'">
          <div class="tab-icon">👤</div>
          <div class="tab-label">我的</div>
        </button>
      </nav>
    </div>

    <!-- 桌面端布局：左侧栏 + 右侧内容 -->
    <div v-else class="gate-shell">
      <!-- 左侧栏 -->
      <aside class="gate-sidebar">
        <div class="sidebar-card">
          <!-- 钱包摘要 -->
          <div class="wallet-summary">
            <span class="live-dot"></span>
            <span class="wallet-label">{{ $t('user.connected') }}</span>
            <code class="wallet-short addr-tip" :data-full="displayAddr">{{ shortAddrText }}</code>
          </div>
          <!-- 导航项（v1.5：管理员页签与用户页签同侧栏并列，中间一条"管理"分组线） -->
          <nav class="sidebar-nav">
            <template v-for="tab in sidebarTabs" :key="tab.key || 'div-' + tab.label">
              <div v-if="tab.divider" class="sidebar-divider">{{ tab.label }}</div>
              <button
                v-else
                class="sidebar-item"
                :class="{ active: activeTab === tab.key }"
                @click="activeTab = tab.key"
              >
                <span class="sidebar-icon" v-html="tab.icon"></span>
                <span>{{ tab.label }}</span>
                <span
                  v-if="badgeFor(tab.subKey)"
                  class="tab-dot"
                  :title="$t('admin.pendingTip', { n: badgeFor(tab.subKey) })"
                ></span>
                <!-- 后台自动拉起指示：容器 tab 右侧小转圈（完成/失败即消失，弹窗收尾） -->
                <span
                  v-if="tab.key === 'container' && containerBooting"
                  class="spin"
                  :title="$t('user.tabBooting')"
                ></span>
              </button>
            </template>
          </nav>
        </div>
      </aside>

      <!-- 右侧内容 -->
      <section class="gate-content">
        <!-- ════════ 账户信息 ════════ -->
        <div v-if="activeTab === 'account'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('user.myAccount') }}</h4>
            <p class="tab-hint">{{ $t('user.accountHint') }}</p>
          </div>
          <div class="stat-rows">
            <div class="stat-row">
              <span class="stat-label">{{ $t('user.swtcAddress') }}</span>
              <code class="stat-value mono addr-tip" :data-full="displayAddr">{{
                shortAddrText
              }}</code>
            </div>
            <!-- v1.5 验收反馈③：账号详情区分管理员/普通用户（判权来自服务端活验证 role） -->
            <div class="stat-row">
              <span class="stat-label">{{ $t('user.roleLabel') }}</span>
              <span
                class="badge"
                :class="role === 'admin' ? 'badge-danger' : 'badge-info'"
                style="align-self: center"
              >
                {{ role === 'admin' ? $t('user.roleAdmin') : $t('user.roleUser') }}
              </span>
            </div>
          </div>

          <UserTabCredential />
        </div>

        <!-- ════════ 模型配置 ════════ -->
        <div v-else-if="activeTab === 'model'" class="tab-content">
          <UserTabModel />
        </div>

        <!-- ════════ 容器管理 ════════ -->
        <div v-else-if="activeTab === 'container'" class="tab-content">
          <UserTabContainer :initial-sub="containerInitialSub" :market-cat="marketCat" />
        </div>

        <!-- ════════ 我的技能 ════════ -->
        <!-- ════════ v1.5 管理员页签（验收反馈①：与用户页签平级并列，无嵌套壳）════════
             role='admin'（官网活验证属实）才装配；内嵌复用独立版 AdminPanel（源码不合并，
             同一组件两用：externalTab 驱动子页、自带侧栏隐藏）。操作仍要登录会话+当场签名
             签名——tab 可见=凭证判权，可操作=会话+钱包双门禁（刀2B 模型一字不松） -->
        <div v-else-if="isSystemTab" class="tab-content admin-embed">
          <AdminPanel embedded :external-tab="systemSubTab" />
        </div>

        <div v-else class="tab-content">
          <div class="action-buttons">
            <button
              class="btn btn-small"
              :class="marketCat === 'skills' ? 'btn-primary' : 'btn-secondary'"
              @click="marketCat = 'skills'"
            >
              {{ $t('env.catSkills') }}
            </button>
            <button
              class="btn btn-small"
              :class="marketCat === 'env' ? 'btn-primary' : 'btn-secondary'"
              @click="marketCat = 'env'"
            >
              {{ $t('env.catEnv') }}
            </button>
          </div>
          <SkillMarket v-if="marketCat === 'skills'" embedded external-tab="market" />
          <EnvTemplatesUser v-if="marketCat === 'env'" mode="market" />
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { askConfirm, toast } from '../composables/useDialog'
import { useIsMobile } from '../composables/useIsMobile.js'
import { bindUserCredHost, useUserCred } from '../composables/useUserCred.js'
import { bindUserModelHost, useUserModel } from '../composables/useUserModel.js'
import { bindUserContainerHost, useUserContainer } from '../composables/useUserContainer.js'
import { bindUserSkillsHost, useUserSkills } from '../composables/useUserSkills.js'
import UserTabCredential from '../components/user/UserTabCredential.vue'
import UserTabModel from '../components/user/UserTabModel.vue'
import UserTabContainer from '../components/user/UserTabContainer.vue'
import { ref, onMounted, onUnmounted, computed, watch, defineAsyncComponent } from 'vue'
import { useAdminBadges, startAdminBadges, stopAdminBadges } from '../composables/useAdminBadges'
const { badgeFor } = useAdminBadges()
// 红点节拍起停的组件侧凭证：防角色状态反复刷新叠加引用计数（起一次=守一次）
let badgesStarted = false
import axios from 'axios'
import { userSessionApi } from '../api/userSession.js'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { skillsApi } from '../api/skills.js'
import { sha256Hex as sha256HexFallback } from '../utils/sha256.js'
import AdminPanel from './AdminPanel.vue'
import EnvTemplatesUser from '../components/EnvTemplatesUser.vue'
// T5 移动 chunk 拆分（2026-11-10）：五个移动组件按 isMobile 条件渲染，改 defineAsyncComponent
// 懒加载——桌面首屏 chunk 不再打包移动全量（~数百行），移动侧单独异步包。切换首帧由
// 各组件自带 loading spinner 兜底（无感）；判权/签名链与同步 import 逐字节一致，仅装载时机变。
const MobileHome = defineAsyncComponent(() => import('./mobile/MobileHome.vue'))
const MobileContainer = defineAsyncComponent(() => import('./mobile/MobileContainer.vue'))
const MobileMarket = defineAsyncComponent(() => import('./mobile/MobileMarket.vue'))
const MobileApprovals = defineAsyncComponent(() => import('./mobile/MobileApprovals.vue'))
const MobileMe = defineAsyncComponent(() => import('./mobile/MobileMe.vue'))
// B2 清理（2026-11-10）：MobileSkills 系孤儿组件（import 未挂载，且其无签名 API 与后端
// 签名要求分叉）。P2 移动发布链路改在 MobileContainer 另建（走 signChallenge+skillsApi
// 真签名口径），旧孤儿文件已于 P2 删除——双实现收敛完毕，不再留"暂留"尾巴。
import SkillMarket from './SkillMarket.vue'
import { buildAdminTabs } from '../admin-tabs'
import {
  requestAccounts,
  signMessage,
  getPublicKey,
  signFileBytes,
  getIpfsPublicKey,
  watchAccountsChanged,
  friendlyPluginError,
} from '../api/wallet.js'
import { signConnectPlugin, buildConnectUrl } from '../api/connect.js'
import { formatBytes, shortAddress } from '../utils/format.js'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

// ---- 移动端检测（T3 收敛 2026-11-10：走全站单例，旧本地 ref+resize 监听已摘） ----
const isMobile = useIsMobile()
const mobileTab = ref('home') // home/container/skills/approvals/me
// 移动深链→容器子页签的一次性接力（applyMobileTabLink 写入，MobileContainer 挂载
// 消费后经 sub-consumed 清空——不清的话用户再点「容器」top tab 重挂载会误跳子页）
const containerInitialSub = ref('')

// ---- 移动深链消费（B1 修复 2026-11-10）----
// MobileHome 管理员 8 宫格 push 的 /user?tab=adm:* 过去只被桌面侧栏 activeTab 消费，
// 移动壳根本不读 query——八条快捷全成死链（全景报告 B1）。现在移动壳消费同款深链，
// 落定即清 query（同一条目重复点击可重放）。角色未定时先寄存、credential-status 回落后
// 消费——防把"还在查角色"误判成"不是管理员"。注意 roleSettled / mobileDeepLinkPending
// 与 initialTabApplied 同款刻意用裸非响应值（2026-10-23"裸布尔按 ref 用"判例在前）。
let roleSettled = false
let mobileDeepLinkPending = null

function applyMobileTabLink(s) {
  const str = String(s)
  const isAdm = str.startsWith('adm:') || str === 'system'
  if (isAdm && role.value !== 'admin') toast(t('user.adminEntryLocked'))
  else if (isAdm && /approval|cred|cwt|env/i.test(str)) mobileTab.value = 'approvals'
  else if (isAdm) toast('该管理功能移动端暂未提供，请在 PC 端使用')
  else if (str === 'account' || str === 'me') mobileTab.value = 'me'
  else if (str === 'market') mobileTab.value = 'skills'
  // 模型配置是**用户域**功能（桌面侧栏 key:'model' 人人可见；管理注册表 admin-tabs.js
  // 从未有 model——首页八宫格旧链 adm:model 是幻影键：移动 toast 谎称"PC 才有"，桌面
  // 直落空白页签）。2026-11-11 裁定模型配置上移动端后，此处正链为 tab=model：
  // 落容器 tab 并穿透到「模型配置」子页签（initial-sub 一次性消费，见 MobileContainer）。
  else if (str === 'model') {
    mobileTab.value = 'container'
    containerInitialSub.value = 'model'
  } else if (['home', 'container', 'skills', 'approvals'].includes(str)) mobileTab.value = str
  router.replace({ query: {} })
}

watch(
  () => route.query.tab,
  (q) => {
    if (!isMobile.value || !q) return
    if (!roleSettled) {
      mobileDeepLinkPending = String(q)
      return
    }
    applyMobileTabLink(String(q))
  },
)

// 计算待审批总数（环境模板 + CWT 申请）
const approvalCount = computed(() => badgeFor('envtpl') + badgeFor('cred'))

// ---- 侧栏导航（与 React 原型稿一致） ----
// 落地页 = 容器管理：多数操作（进入 DSH、启停、资源查看）都发生在这里，
// 账户信息只剩地址一项，不该默认挡在前面。
// v1.5 用户验收②修订：进用户中心**不再自动建容器**，容器可能不存在——
// 首屏停在"容器管理"会直面一片未就绪；改默认「账户信息」（凭证/角色第一眼看，反馈③）。
const activeTab = ref('account')
// 市场页签内品类（用户终审 IA）：市场=挑（技能/环境）；容器管理=经营（定格/显示/回退/技能装卸）
const marketCat = ref('skills')
// 容器管理页三段页签（info/skills/env）；默认容器信息=原第一屏
const cSub = ref('info')
// v1.5 刀5C：判权面（credential-status 的 role，服务端活验证 admin 凭证属实才为 'admin'）。
// tab 注册表按 role 装配——管理页签对普通用户不存在（数据面砍掉，不是 CSS 隐藏）；
// 对管理员则与用户页签**平级并列**（验收反馈①：消灭"系统管理"嵌套壳，同一侧栏）。
const role = ref('user')
const sidebarTabs = computed(() => {
  const tabs = [
    {
      key: 'account',
      label: t('user.tabAccount'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
    },
    {
      key: 'model',
      label: t('user.tabModel'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="17" r="4"/><path d="M10.6 13.4L21 3"/><path d="M19 5l2 2"/><path d="M15 9l2 2"/></svg>',
    },
    {
      key: 'container',
      label: t('user.tabContainer'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/></svg>',
    },
    {
      key: 'skills',
      label: t('user.tabSkills'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    },
  ]
  if (role.value === 'admin') {
    // 管理页签与用户页签同一侧栏并列（key 前缀 adm: 防碰撞；子页 key 见 subKey）
    tabs.push({ divider: true, label: t('user.adminGroup') })
    tabs.push(...buildAdminTabs(t, 'adm:'))
  }
  return tabs
})
const isSystemTab = computed(() => activeTab.value.startsWith('adm:'))
const systemSubTab = computed(() => (isSystemTab.value ? activeTab.value.slice(4) : 'overview'))
let initialTabApplied = false

const shortAddrText = computed(() => {
  const a = displayAddr.value
  return a ? `${a.slice(0, 12)}…${a.slice(-4)}` : ''
})

const connected = ref(false)
// 挂机跌落兜底（2026-11-10 报障"长时间不管底部 tab 消失"）：移动失联不再换全屏卡
// （模板两处 !isMobile），tab 壳常驻；失联瞬间自动回落「我的」——MobileMe 登录
// 面板是移动端唯一重登录门（桌面那张卡让手机装 Chrome 扩展，本来就点不动）。
watch(connected, (v) => {
  if (!v && isMobile.value) mobileTab.value = 'me'
})
const connecting = ref(false)
const hasCCDAO = ref(false)
const userInfo = ref({})
// 地址展示统一为钱包原始大小写形态（内部匹配/台账主键仍是小写，不动语义）
const pluginCaseAddr = ref(localStorage.getItem('swtc_plugin_case') || '')
const displayAddr = computed(
  () =>
    pluginCaseAddr.value || userInfo.value.address || localStorage.getItem('swtc_address') || '',
)
function rememberPluginCase(a) {
  if (a && typeof a === 'string' && /[A-Z]/.test(a)) {
    pluginCaseAddr.value = a
    localStorage.setItem('swtc_plugin_case', a)
  }
}

const { loadCredentialStatus, credInfo, credVc, credApp, credNoDid } = useUserCred()
const { items, fetchConfigStatus } = useUserModel()
const { autoBootContainer, containerBooting } = useUserContainer()
const { mineData, loadMine, loadContainerSkills } = useUserSkills()
bindUserCredHost({
  loginOnly,
  currentAddress,
  pluginCaseAddr,
  rememberPluginCase,
  connected,
})
const usageInfo = ref(null)
const waiting = ref(false)
const queuePosition = ref(0)
const queueTotal = ref(0)
const waitingSince = ref(0)

// ---- 每日使用时限展示（非 CWT 授权用户受每日分钟数限制）----
const usageInfoLabel = computed(() => {
  const u = usageInfo.value
  if (!u) return ''
  if (!u.enabled) return t('user.usageUnlimited')
  if (u.exempt) return t('user.usageExempt')
  return t('user.usageToday', { used: u.usedMinutes, total: u.dailyMinutes })
})

const loginAttempted = ref(false)
const walletLogin = async (address) => {
  const pluginAddress = await requestAccounts()
  rememberPluginCase(pluginAddress)
  const target =
    (address || '').toLowerCase() === pluginAddress.toLowerCase() ? address : pluginAddress
  const ch = await axios.post('/api/user/wallet-login-challenge', { address: target })
  const { nonce, message } = ch.data
  const signature = await signMessage(pluginAddress, message)
  const publicKey = await getPublicKey(pluginAddress)
  await axios.post('/api/user/wallet-login', {
    address: pluginAddress,
    nonce,
    signature,
    publicKey,
  })
  return pluginAddress
}

const fetchUsage = async (address) => {
  try {
    const cs = await userSessionApi.connectStatus(address)
    usageInfo.value = cs.usage || null
    // 隐私门分支（无 tier 字段）且还没试过 → 静默签名登录一次再刷新
    if (cs?.exists === true && !('tier' in cs) && !loginAttempted.value && address) {
      loginAttempted.value = true
      try {
        await walletLogin(address)
        await fetchUsage(address)
        loadCredentialStatus(address)
        return
      } catch {
        /* 保持"需要重新登录"提示，按钮手动兜底 */
      }
    }
  } catch {
    usageInfo.value = null
  }
}

/**
 * 钱包签名挑战-响应：先取插件当前账户 → 领 nonce → 插件签名 + 取公钥。
 *
 * 【挑战池按用途隔离】后端只在发放时的 purpose 池里消费，借错池必报
 * "挑战无效或已过期"——
 *   - 租户配置操作（保存/清除/重置/模型发现）→ 默认 '/api/user/config-challenge'
 *   - 技能操作（mine/import/unpublish/uninstall/publish）→ '/api/skills/challenge'
 *
 * 关键：签名对象必须用插件【当前选中的账户】，否则插件会以
 * "The requested account and/or method has not been authorized" 拒绝
 * （源码：swtc_signMessage 检查 accounts.includes(from)）。
 * 返回的 address 即插件当前账户，后续提交/清除都用它（写的是该账户自己的卷）。
 */
const signChallenge = async (challengeUrl = '/api/user/config-challenge') => {
  if (!window.ccdao || !window.ccdao.request) {
    throw new Error(t('user.errNoCcdao'))
  }
  // 1. 插件当前账户【保留原始大小写】！
  //    插件的 accounts.includes() 是大小写敏感严格匹配：把 jNDwRet... 转成
  //    jndwret... 再传回去会被判"未授权"(4100)。只有 requestAccounts 原样
  //    返回的字符串才能通过。后端 normalizeAddress 会自己转小写，无需担心。
  const pluginAddress = await requestAccounts()
  rememberPluginCase(pluginAddress)
  // 2. 领一次性挑战（响应含 message：服务端构造的用途绑定被签内容）
  const challengeRes = await axios.post(challengeUrl, { address: pluginAddress })
  const { nonce, message } = challengeRes.data
  // 3. 插件对 **message** 签名 + 取公钥（都用原始大小写地址）。
  //    签的是用途绑定消息（hex），不是裸 nonce —— 跨端点凭证混淆加固。
  const signature = await signMessage(pluginAddress, message)
  const publicKey = await getPublicKey(pluginAddress)
  return { address: pluginAddress, nonce, signature, publicKey }
}

/** 保存/清除成功后，把插件当前账户同步到页面与 localStorage */
const syncWalletAccount = async (address) => {
  const normalized = String(address).toLowerCase()
  localStorage.setItem('swtc_address', normalized)
  if (userInfo.value.address !== normalized) {
    userInfo.value = { ...userInfo.value, address: normalized }
    await fetchUserInfo(normalized)
  }
  fetchConfigStatus()
}

/**
 * 把 CCDAO 插件的未授权错误转成可操作的提示。
 * 插件对每个网站（origin）单独授权，且 swtc_signMessage 不会自动触发授权
 * （源码确认：signMessage 直接验签，无授权/解锁流程）。
 */

// 加载状态
const loading = ref(false)
const loadingTitle = ref('')
const loadingMessage = ref('')
const loadingProgress = ref(0)

// 等待时间计算
const waitingTime = computed(() => {
  if (!waitingSince.value) return t('user.waitZero')
  const ms = Date.now() - waitingSince.value
  if (ms < 60000) return t('user.waitSec', { n: Math.floor(ms / 1000) })
  if (ms < 3600000) return t('user.waitMin', { n: Math.floor(ms / 60000) })
  return t('user.waitHour', { n: (ms / 3600000).toFixed(1) })
})

const showLoading = (title, message, progress = 0) => {
  loading.value = true
  loadingTitle.value = title
  loadingMessage.value = message
  loadingProgress.value = progress
}

const hideLoading = () => {
  loading.value = false
}

const checkCCDAO = () => {
  hasCCDAO.value = typeof window.ccdao !== 'undefined'
}

// 账户变化处理（watchAccountsChanged 回调）
// 只处理「已连接过且地址真正变化」：首次连接由按钮/初始恢复流程负责，
// 避免与 connectWallet 竞态并发跑创建流程。
const handleAccountsChanged = async (accounts) => {
  console.log('[UserCenter] 检测到账户变化:', accounts)

  if (!accounts || accounts.length === 0) {
    // 用户断开连接
    localStorage.removeItem('swtc_address')
    connected.value = false
    userInfo.value = {}
    pluginCaseAddr.value = ''
    toast(t('user.walletDisconnected'))
    return
  }

  rememberPluginCase(accounts[0]) // 先记原始大小写（全界面地址展示以它为准）
  const newAddress = accounts[0].toLowerCase()
  const saved = localStorage.getItem('swtc_address')
  if (!saved || saved === newAddress) {
    console.log('[UserCenter] 账户未变化或尚未连接，忽略广播')
    return
  }
  // 切换钱包地址：立即吊销旧地址的门禁钥匙（user_session），
  // 防止旧 URL 凭旧 cookie 仍能进入（会话 2h/30min 也是兜底）
  console.log('[UserCenter] 钱包地址切换，吊销旧会话钥匙...')
  try {
    await userSessionApi.logout()
  } catch (err) {
    console.warn('[UserCenter] 吊销旧会话失败（非关键）:', err.message)
  }
  handleAddressChange(newAddress)
}

// 监听账户变化事件（三通道兼容，共用 api/wallet.js）
let unbindAccounts = null
const setupAccountChangeListener = () => {
  if (!hasCCDAO.value) {
    console.log('[UserCenter] CCDAO 插件未安装')
    return
  }
  console.log('[UserCenter] 设置账户监听器（三通道兼容）...')
  unbindAccounts = watchAccountsChanged(handleAccountsChanged)
}

/**
 * 确立「已连接」身份：**只要拿到钱包地址就算连上**，与容器是否可用、是否被限时无关。
 *
 * 背景（用户实测死循环）：模板里「连接钱包」卡片是 `v-else-if="!connected"`，
 * 而额度用完 / 排队时 `handleAddressChange` 会提前 return。若这些分支不把
 * `connected` 置真，页面就一直停在「连接钱包」卡片 —— 用户点一次弹一次
 * 「今日时长已用完」，弹完还停在连接钱包；而**解除限时的 CWT 验证 tab 恰恰在
 * `connected === true` 之后的主界面里**，于是永远进不去 → 永远无法自助解锁。
 *
 * `fetchUserInfo` 失败也不阻断：无会话时 `/api/user/:address` 会回脱敏壳
 * （只有 address/exists/status），有 address 就足够把界面（含 CWT tab）渲染出来。
 */
const establishConnected = async (address) => {
  try {
    await fetchUserInfo(address)
  } catch (err) {
    console.warn('[UserCenter] 建立已连接态时拉取用户信息失败（不阻断）:', err?.message)
  }
  if (!userInfo.value?.address) userInfo.value = { ...(userInfo.value || {}), address }
  connected.value = true
}

// ★v1.5 验收反馈②：登录与建容器解耦（后端 /connect action=login：验签+换 cookie，不 docker、
// 不过准入闸——准入闸只咬"进容器"，登录被咬会让过期凭证者进不了续发通道，死锁）。
// 会话有效且地址一致 → 免签名弹窗秒进；否则一次性签名登录。绝不调 ensureContainer。
const loginOnly = async (address) => {
  try {
    const s = await userSessionApi.sessionInfo()
    if (s?.address && String(s.address).toLowerCase() === String(address).toLowerCase()) return 'ok'
  } catch {
    /* 会话查询失败按"无会话"处理，走签名登录 */
  }
  try {
    const res = await connectWithOwnership(address, {
      action: 'login',
      title: t('user.loadingLogin'),
      progress: 35,
    })
    if (res.status === 200) return 'ok'
    const data = await res.json().catch(() => ({}))
    toast(data.error || t('user.loginFail', { err: res.status }))
    return 'denied'
  } catch (err) {
    toast(t('user.loginFail', { err: err?.message || err }))
    return 'denied'
  }
}

// 处理地址变化的通用函数
const handleAddressChange = async (newAddress, isInitialLoad = false) => {
  const oldAddress = localStorage.getItem('swtc_address')

  if (isInitialLoad) {
    console.log('[UserCenter] 初始加载，恢复地址:', newAddress)
  } else if (newAddress !== oldAddress) {
    console.log(`[UserCenter] 地址切换：${oldAddress} -> ${newAddress}`)
  } else {
    console.log('[UserCenter] 地址相同，但仍需检查容器状态')
  }

  // 地址真正变化时：立即清空上一个地址的全部用户数据并进入 loading，
  // 避免切换后短暂闪现上一个用户的共享/安装列表；
  // 也保证后续失败分支（额度用完/资源排队/异常）不会残留旧地址的页面与信息
  if (!isInitialLoad && newAddress !== oldAddress) {
    mineData.value = { published: [], installed: [], inContainer: [], plugins: null }
    mySkillsLoading.value = true
    userInfo.value = {}
    connected.value = false
    usageInfo.value = null
    // 2026-10 审计补：凭证与模型配置也是**按地址**的数据——切钱包瞬间把上一个
    // 地址的卡片/申请状态/模型条目留在屏上，既是误导（新地址显示"已领取"），
    // 也有把旧配置原样保存到新地址的串写风险。
    credInfo.value = null
    credVc.value = null
    credApp.value = null
    items.value = []
  }

  try {
    // 显示加载页面
    showLoading(t('user.loadingConnect'), t('user.loadingVerify'), 10)

    // ★v1.5 验收反馈②：进入用户中心 = **登录**，不再顺手建容器。
    // 签名换 cookie（/connect action=login，后端不碰 docker）→ 正常拉账户/凭证/角色。
    // 容器创建/启动是显式动作：容器管理页「启动容器」按钮（restartContainer→ensureContainer
    // 全状态机）或「进入 DSH」（enterDsh，自带创建+跳转）。管理员进来管理不再空转容器，
    // 普通用户也不再被"进来即计费起时限"绑架——启动时机还给用户。
    const loginState = await loginOnly(newAddress)
    if (loginState === 'denied') {
      // 换 cookie 失败（验签被拒/准入异常）→ 停在连接钱包卡片，loginOnly 已弹人话原因
      hideLoading()
      return
    }

    // 保存地址（即使是相同的地址也要保存，确保格式正确）
    localStorage.setItem('swtc_address', newAddress)

    // ★凭证/角色是"登录"这一动作的直接结论，不寄生在用户信息接口的分支里：
    //   先拉 credential-status（账户信息的凭证卡 + 管理 tab 判权），再补业务数据。
    //   （历史坑：fetchUserInfo 走 403/401 分支时早退，loadCredentialStatus 没被调，
    //   credInfo 空置 → 凭证卡整块"消失"——用户实测反馈即此。）
    await loadCredentialStatus(newAddress)

    // 身份已确立 → 进入已连接态（establishConnected 内部 fetchUserInfo 拉全量；
    // 其内部再调一次 loadCredentialStatus 属幂等刷新，无副作用）
    showLoading(t('user.loadingFetchInfo'), t('user.loadingAccountData'), 70)
    await establishConnected(newAddress)
    hideLoading()

    // 只在地址真正变化时才显示提示
    if (!isInitialLoad && newAddress !== oldAddress) {
      toast(t('user.switchedAddress', { addr: `${newAddress.slice(0, 10)}...` }))
    }

    // 切换/连接后刷新"我的技能"为当前地址的个人视图
    await loadMine()
  } catch (err) {
    console.error('[UserCenter] 处理地址失败:', err)
    hideLoading()
    if (!isInitialLoad) {
      toast(t('user.addressFail', { err: err.message }))
    }
  }
}

const connectWallet = async () => {
  if (!hasCCDAO.value) return

  connecting.value = true
  // 钱包弹窗请求账户期间先给反馈；后续 handleAddressChange 会覆盖进度继续展示
  showLoading(t('user.connecting'), t('user.loadingWalletConnect'), 5)
  try {
    const pluginAddress = await requestAccounts()
    rememberPluginCase(pluginAddress)
    // 统一转小写
    const address = pluginAddress.toLowerCase()
    console.log('[UserCenter] 连接钱包，地址:', address)

    // 使用通用处理函数
    await handleAddressChange(address)
  } catch (err) {
    console.error('[UserCenter] 连接失败:', err)
    toast(t('user.connectFail', { err: err.message }))
  } finally {
    connecting.value = false
    hideLoading()
  }
}

/**
 * 容器连接/创建（所有权签名 + 网关门禁会话）
 * - 总是走签名流程：后端验签通过后签发 user_session cookie，
 *   浏览器凭 cookie 才能通过租户网关（0.0.0.0:<port> → 127.0.0.1:<内部端口>）
 * - 流程：领取一次性挑战 → 插件签名（当前选中账户，原始大小写）→
 *   带 nonce/signature/publicKey 访问 /connect
 * - 签名账户必须与目标地址一致，否则后端验签会 403
 */
// 签名连接防重入：事件监听器/用户双击/自动恢复可能并发触发，
// 同一时刻只允许一次「请求账户 → 挑战 → 签名 → 建立连接」，
// 避免重复弹签名窗、重复创建容器。
let ownershipInFlight = false
const connectWithOwnership = async (address, opts = {}) => {
  // quiet=后台自动拉起（进入用户中心触发）：钱包签名弹窗照常（归属闸不放松），
  // 但不糊全屏 loading——用户可继续浏览，进度由容器 tab 的加载图标承担
  const quiet = !!opts.quiet
  if (ownershipInFlight) {
    console.warn('[UserCenter] 签名连接进行中，忽略重复请求')
    throw new Error(t('user.busy'))
  }
  ownershipInFlight = true
  // 首屏标题由调用方决定：主动「连接钱包/进入 DSH」显示"连接中"；
  // 创建容器场景（ensureContainer）显示"正在创建容器"，避免创建期间
  // UI 又跳回"连接钱包"页面（各阶段只有副标题在变）。
  const title = opts.title || t('user.connecting')
  const progress0 = opts.progress ?? 10
  try {
    // 阶段化 loading（每次 show 不 hide，由调用方统一 hideLoading）：
    // 覆盖"钱包弹窗请求账户 → 领取挑战 → 等待签名 → 建立连接"的每个耗时环节。
    // T4 收敛（2026-11-10）：requestAccounts→/connect-challenge→signMessage→getPublicKey
    // 的签名原语走 api/connect.js 唯一权威支（与 MobileContainer 同支，判例 58 漂移根治）；
    // 拼法记录（rememberPluginCase）与阶段 loading 经回调注入，语义与逐点时序同改造前。
    if (!quiet) showLoading(title, t('user.loadingVerify'), progress0)

    const core = await signConnectPlugin({
      onPluginAddress: rememberPluginCase,
      onPhase: (phase) => {
        if (quiet) return
        if (phase === 'challenge') {
          showLoading(title, t('user.loadingWalletConnect'), Math.max(progress0, 25))
        } else if (phase === 'sign') {
          showLoading(title, t('user.loadingSign'), Math.max(progress0, 45))
        }
      },
    })
    // 3) 带签名访问 /connect（已存在容器同样验签并发 cookie）
    // format=json：浏览器 fetch 的 redirect:manual 会把 302 包成 opaque (status 0)，
    // 取不到 location → 后端直接回 200 JSON {url}，前端 window.open。
    if (!quiet) showLoading(title, t('user.loadingEstablish'), Math.max(progress0, 70))
    // action=login（v1.5 反馈②）：只换 cookie 不建容器——签的仍是 CONNECT 用途同一消息，
    // 额外 query 不参与签名内容，防重放语义不变。
    const cRes = await fetch(buildConnectUrl(address, core, opts.action || null))
    return cRes
  } finally {
    ownershipInFlight = false
  }
}

/**
 * 「进入 DSH」：签名连接 → 302 后在浏览器新标签打开租户容器。
 * 必须先过签名（拿 user_session cookie），否则网关门禁 403。
 */
const enterDsh = async () => {
  const address = currentAddress()
  if (!address) {
    toast(t('user.errConnectFirst'))
    return
  }
  if (!window.ccdao) {
    toast(t('user.errNoAccount'))
    return
  }
  try {
    showLoading(t('user.connecting'))
    const res = await connectWithOwnership(address, { title: t('user.connecting') })
    hideLoading()
    // 200 JSON：后端已签发 user_session cookie，返回容器 url
    if (res.status === 200) {
      const data = await res.json()
      if (data?.url) {
        window.open(data.url, '_blank', 'noopener')
        return
      }
      toast(data?.message || data?.error || t('user.enterDshFail', { err: res.status }))
      return
    }
    if (res.status === 302) {
      const loc = res.headers.get('location')
      if (loc) {
        window.open(loc, '_blank', 'noopener')
      }
      return
    }
    if (res.status === 202) {
      const data = await res.json()
      toast(data.message || data.error || '资源不足，请等待')
      return
    }
    toast(t('user.enterDshFail', { err: res.status }))
  } catch (err) {
    hideLoading()
    toast(t('user.enterDshFail', { err: err.message || err }))
  }
}

// 最近一次 /connect 202 的后端提示（资源不足/额度用完），供上层展示
let lastConnect202Message = ''
const ensureContainer = async (address, opts = {}) => {
  // 先检查容器状态
  try {
    const statusRes = await userSessionApi.connectStatus(address)

    // 如果在等待队列中
    if (statusRes.status === 'waiting') {
      waiting.value = true
      queuePosition.value = statusRes.queuePosition
      queueTotal.value = statusRes.queueTotal
      waitingSince.value = statusRes.waitingSince
      // 开始轮询队列状态
      startQueuePolling(address)
      return 'waiting'
    }

    // 如果容器不存在或已销毁，创建新容器
    if (!statusRes.exists || statusRes.status === 'destroyed') {
      console.log('[UserCenter] 容器不存在，正在创建...')
      const connectRes = await connectWithOwnership(address, {
        title: t('user.loadingCreateContainer'),
        progress: 50,
        quiet: !!opts.quiet,
      })

      // 检查是否返回 202（资源不足 → 排队；额度用完 → 明确提示，不排队）
      if (connectRes.status === 202) {
        const data = await connectRes.json()
        lastConnect202Message = data.message || data.error || '资源不足，请等待'
        if (data.code === 'USAGE_LIMIT_REACHED') {
          console.warn('[flow] USAGE_LIMIT_REACHED:', lastConnect202Message)
          waiting.value = false
          return 'usage-limit'
        }
        waiting.value = true
        queuePosition.value = data.queuePosition
        queueTotal.value = 1 // 初始值，后续轮询会更新
        waitingSince.value = Date.now()
        startQueuePolling(address)
        return 'waiting'
      }

      // 等待容器就绪
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return 'created'
    }
    // 如果容器已停止，启动它
    else if (statusRes.status === 'stopped') {
      console.log('[UserCenter] 容器已停止，正在启动...')
      await connectWithOwnership(address, {
        title: t('user.loadingStartExisting'),
        progress: 50,
      })
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return 'started'
    }
    // 容器正在运行，无需操作
    else {
      console.log('[UserCenter] 容器正在运行')
      return 'running'
    }
  } catch (err) {
    console.error('[UserCenter] 检查容器状态失败:', err)
    // 如果检查失败，尝试直接创建容器
    const connectRes = await connectWithOwnership(address, {
      title: t('user.loadingCreateContainer'),
      progress: 50,
    })

    // 检查是否返回 202（资源不足 → 排队；额度用完 → 明确提示，不排队）
    if (connectRes.status === 202) {
      const data = await connectRes.json()
      lastConnect202Message = data.message || data.error || '资源不足，请等待'
      if (data.code === 'USAGE_LIMIT_REACHED') {
        console.warn('[flow] USAGE_LIMIT_REACHED:', lastConnect202Message)
        waiting.value = false
        return 'usage-limit'
      }
      waiting.value = true
      queuePosition.value = data.queuePosition
      queueTotal.value = 1
      waitingSince.value = Date.now()
      startQueuePolling(address)
      return 'waiting'
    }

    await new Promise((resolve) => setTimeout(resolve, 3000))
    return 'created'
  }
}

// 轮询队列状态
let queuePollingTimer = null
const startQueuePolling = (address) => {
  // 清除之前的轮询
  if (queuePollingTimer) {
    clearInterval(queuePollingTimer)
  }

  // 每 5 秒检查一次队列状态
  queuePollingTimer = setInterval(async () => {
    try {
      const statusRes = await userSessionApi.connectStatus(address)

      // 如果容器已创建成功
      if (statusRes.exists) {
        waiting.value = false
        if (queuePollingTimer) {
          clearInterval(queuePollingTimer)
          queuePollingTimer = null
        }
        // 重新加载用户信息
        await fetchUserInfo(address)
        connected.value = true
        return
      }

      // 更新队列信息
      if (statusRes.status === 'waiting') {
        queuePosition.value = statusRes.queuePosition
        queueTotal.value = statusRes.queueTotal
      }
    } catch (err) {
      console.error('[UserCenter] 轮询队列状态失败:', err)
    }
  }, 5000)
}

// 取消等待
const cancelWaiting = () => {
  waiting.value = false
  if (queuePollingTimer) {
    clearInterval(queuePollingTimer)
    queuePollingTimer = null
  }
  connected.value = false
  userInfo.value = {}
  // 断开即清凭证视图（防上一钱包的卡片残留给下一个地址）
  credInfo.value = null
  credApp.value = null
  credNoDid.value = null
}

const fetchUserInfo = async (address) => {
  // 门控 loading：仅当调用方没有在展示 loading 时才自己开/关，
  // 避免打断 handleAddressChange 的整体加载流程（它自己会 hide）
  const opened = !loading.value
  if (opened) showLoading(t('user.loadingFetchInfo'), t('user.loadingAccountData'), 80)
  try {
    const res = await userSessionApi.profile(address)
    // 未建档新用户空态：后端以 200+USER_NOT_FOUND 表达（根治浏览器网络层红字
    // 404；catch 里的 404 分支保留兼容旧服务端）。空态不发 usage/config 请求；
    // 装配必须先于 userInfo 落位——领取弹窗由装配触发，若后于容器管理块的
    // 档案加载完成，会被其"无档案→弹连接引导"时序顶掉（新用户首见弹窗不能丢）。
    if (res && res.code === 'USER_NOT_FOUND') {
      await loadCredentialStatus(address)
      userInfo.value = { address, status: 'none', exists: false }
      return
    }
    userInfo.value = res
    fetchUsage(address)
    fetchConfigStatus()
    loadCredentialStatus(address)
    // 进入即检容器态并后台拉起（每地址一次性；不 await——凭证装配不受牵制）
    void autoBootContainer(res)
  } catch (err) {
    // 403/404 是已知良性态（未连接/未建档空态），不再 error 级刷屏——
    // 真异常仍走 error（下面分支处理不到的情况）
    const benign = err.response?.status === 404 || err.response?.status === 403
    ;(benign ? console.info : console.error)(
      benign ? '[UserCenter] 用户信息空态/待解锁:' : '获取用户信息失败:',
      err,
    )

    // 如果是 400 错误，说明地址无效，清除 localStorage
    if (err.response?.status === 400) {
      console.warn('[UserCenter] 地址无效，清除 localStorage')
      localStorage.removeItem('swtc_address')
      connected.value = false
      userInfo.value = {}
      pluginCaseAddr.value = ''
      toast(t('user.invalidAddress'))
      return
    }

    // 403（会话无效/他人地址）：不打断、不弹错——签名连接后自动解锁
    if (err.response?.status === 403) {
      console.warn('[UserCenter] 用户信息需完成签名连接后解锁（403），请点击「进入 DSH」')
      return
    }

    // 401（2026-10 审计补）：user_session 过期/被吊销。吞进"重试"会把界面
    // 停在半连接的假象——明确回到未连接态，提示一键重连。
    if (err.response?.status === 401) {
      connected.value = false
      toast(t('user.sessionExpired'))
      return
    }

    // 404（v1.5 反馈②）：登录建档分离后，未启动过容器=无档案——**正常初始态**，
    // 不是错误：渲染"未创建"空态（容器管理页的「启动容器」按钮就是入口），不重试不弹错。
    // 凭证/角色不依赖容器，照常拉取（判权与卡面展示都挂在 credential-status 上）。
    if (err.response?.status === 404) {
      userInfo.value = { address, status: 'none', exists: false }
      loadCredentialStatus(address)
      return
    }

    // 如果获取失败，可能是容器刚创建，重试一次
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      userInfo.value = await userSessionApi.profile(address)
    } catch (err2) {
      console.error('重试获取用户信息失败:', err2)
    }
  } finally {
    if (opened) hideLoading()
  }
}

// ══ 进入用户中心·容器后台自动拉起（2026-10-23 用户拍板）══
// 检查容器态 → 未跑则后台启动（不糊页面，tab 挂加载图标）→ 完毕弹窗；
// 本来就在跑 → 直接弹窗告知。与 v1.5"进入不顺手建容器"的关系：当年痛点是
// **全屏 loading 阻断浏览**，这里改为后台化+图标化，签名仅 destroyed 重建
// 时按归属闸照常请求一次（闸口语义不放松）。每地址一次性，轮询/手动刷新不重复弹。
let autoBootFor = ''

const tierBadge = (tier) => {
  const map = { 1: 'badge-info', 2: 'badge-warning', 3: 'badge-success' }
  return map[tier] || 'badge-info'
}

const statusBadge = (status) => {
  const map = { running: 'badge-success', stopped: 'badge-warning', destroyed: 'badge-danger' }
  return map[status] || 'badge-info'
}

const statusText = (status) => {
  const map = {
    running: t('user.statusRunning'),
    stopped: t('user.statusStopped'),
    destroyed: t('user.statusDestroyed'),
    // v1.5 反馈②：登录不建容器后"未创建"是常态首屏，不该裸显 null/none
    none: t('user.statusNone'),
    null: t('user.statusNone'),
  }
  if (!status) return map.none
  return map[status] || status
}

bindUserModelHost({ signChallenge, currentAddress })
bindUserSkillsHost({ signChallenge, currentAddress, connected })
bindUserContainerHost({
  ensureContainer,
  showLoading,
  hideLoading,
  currentAddress,
  userInfo,
  fetchUserInfo,
  enterDsh,
})

onMounted(async () => {
  checkCCDAO()

  // 设置账户变化监听器
  if (hasCCDAO.value) {
    setupAccountChangeListener()
  }

  // 优先从 CCDAO 插件获取当前地址，而不是 localStorage
  if (hasCCDAO.value && window.ccdao && window.ccdao.request) {
    try {
      const pluginAddress = await requestAccounts()
      rememberPluginCase(pluginAddress)
      if (pluginAddress) {
        const currentAddress = pluginAddress.toLowerCase()
        console.log('[UserCenter] 从 CCDAO 获取当前地址:', currentAddress)

        // 比对 cookie 会话地址与插件当前地址：不一致说明钱包已切换
        // （旧 user_session 可能还有效）→ 吊销旧钥匙，防止旧容器 URL 仍可进
        try {
          const cookieAddr = (await userSessionApi.sessionInfo()).address
          if (cookieAddr && cookieAddr.toLowerCase() !== currentAddress) {
            console.log(
              `[UserCenter] 会话地址(${cookieAddr}) ≠ 插件地址(${currentAddress})，吊销旧钥匙`,
            )
            await userSessionApi.logout()
            toast(t('user.sessionMismatchRevoked'))
          }
        } catch (sessionErr) {
          console.warn('[UserCenter] 会话比对失败（非关键）:', sessionErr.message)
        }

        // 清除 localStorage 中的旧地址（如果有）
        const savedAddress = localStorage.getItem('swtc_address')
        if (savedAddress && savedAddress !== currentAddress) {
          console.log(`[UserCenter] 清除旧地址：${savedAddress} -> ${currentAddress}`)
          localStorage.removeItem('swtc_address')
        }

        // 使用当前地址
        await handleAddressChange(currentAddress, true)
      } else {
        // 没有账户，检查 localStorage
        const savedAddress = localStorage.getItem('swtc_address')
        if (savedAddress) {
          console.log('[UserCenter] CCDAO 无账户，使用 localStorage:', savedAddress)
          await handleAddressChange(savedAddress, true)
        }
      }
    } catch (err) {
      console.error('[UserCenter] 获取 CCDAO 账户失败:', err)

      // 降级：使用 localStorage
      const savedAddress = localStorage.getItem('swtc_address')
      if (savedAddress) {
        console.log('[UserCenter] 降级使用 localStorage:', savedAddress)
        await handleAddressChange(savedAddress, true)
      }
    }
  } else {
    // 没有 CCDAO，使用 localStorage
    const savedAddress = localStorage.getItem('swtc_address')
    if (savedAddress) {
      console.log('[UserCenter] 无 CCDAO，使用 localStorage:', savedAddress)
      await handleAddressChange(savedAddress, true)
    }
  }
  // 首帧失联落位（watcher 只管"连上过又掉"）：移动端开机即无会话 → 直接进
  // 「我的」亮登录面板，而不是对着一屏 '-' 的首页（2026-11-10 挂机报障）。
  // 置于 loadMine 前：connected 此刻已是终值，且不惧 loadMine 异常吞掉落位。
  if (!connected.value && isMobile.value) mobileTab.value = 'me'
  await loadMine()
})

let mineInFlight = null

watch(connected, (v) => {
  if (v) {
    loadMine()
    loadCredentialStatus(userInfo.value.address)
  }
})

onUnmounted(() => {
  stopAdminBadges()
  // 排队轮询是全局 interval：不随组件卸载停止的话，切走页面的用户仍在后台
  // 空转打接口（僵尸组件 setState），重挂载后新旧两条轮询并行（2026-10 审计）。
  if (queuePollingTimer) {
    clearInterval(queuePollingTimer)
    queuePollingTimer = null
  }
  // 解绑账户监听，避免组件重挂载后重复监听
  unbindAccounts?.()
  unbindAccounts = null
})
</script>

<style scoped>
/* 技能动作行：紧凑贴标题，别再让全局 action-buttons 的 1.25rem 上下大空档 */

/* 移动端布局 */
.mobile-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  background: #f4f5fa;
}

.mobile-content {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  width: 100%;
}

.mobile-page {
  min-height: 100%;
  width: 100%;
}

.mobile-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  background: var(--surface-white);
  margin: 16px;
  border-radius: 16px;
}

.placeholder-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.placeholder-text {
  font-size: 16px;
  font-weight: 600;
  color: #20242f;
  margin-bottom: 8px;
}

.placeholder-hint {
  font-size: 14px;
  color: #8a90a3;
}

.mobile-tabbar {
  display: flex;
  background: var(--surface-white);
  border-top: 1px solid #eceef4;
  padding: 8px 0 calc(8px + env(safe-area-inset-bottom));
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.05);
}

.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  background: none;
  border: none;
  color: #8a90a3;
  cursor: pointer;
  transition: color 0.2s;
}

.tab-item.active {
  color: #6a72e8;
}

.tab-icon {
  font-size: 24px;
  position: relative;
}

.tab-dot {
  position: absolute;
  top: -2px;
  right: -6px;
  width: 10px;
  height: 10px;
  background: #ff4757;
  border-radius: 50%;
  border: 2px solid var(--surface-white);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.tab-label {
  font-size: 12px;
  font-weight: 500;
}

.user-center {
  height: 100%;
  display: flex;
  animation: fadeIn 0.3s;
}

/* ════ 状态卡片（loading / connect / waiting，居中显示） ════ */

.loading-card h2,
.connect-card h2,
.waiting-card h2 {
  font-size: 1.4rem;
  margin-bottom: 1rem;
  color: var(--text-main);
}

.loading-spinner {
  margin-bottom: 2rem;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 4px solid #eef0f8;
  border-top: 4px solid var(--brand-text);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.loading-message {
  color: var(--text-muted);
  margin-bottom: 2rem;
}

.loading-progress {
  max-width: 400px;
  margin: 0 auto;
}

.progress-text {
  font-size: 0.9rem;
  color: var(--text-muted);
}

.connect-card p {
  color: var(--text-muted);
  margin-bottom: 2rem;
}

.btn-small {
  padding: 0.25rem 0.75rem;
  font-size: 0.85rem;
  margin-left: 0.5rem;
}

/* ─── 等待队列 ─── */
.waiting-icon {
  font-size: 3.5rem;
  margin-bottom: 1rem;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.1);
  }
}

.waiting-card h2 {
  color: #92400e;
}

.waiting-message {
  color: #78350f;
  margin-bottom: 0.5rem;
  font-size: 1rem;
}

.queue-info {
  background: #fffbeb;
  border-radius: 12px;
  padding: 1.25rem;
  margin: 2rem 0;
  border: 1px solid #fde68a;
}

.queue-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 0;
  border-bottom: 1px solid #fef3c7;
}

.queue-item:last-child {
  border-bottom: none;
}

.queue-label {
  color: #92400e;
  font-size: 0.9rem;
}

.queue-value {
  color: #78350f;
  font-weight: 600;
  font-size: 1.05rem;
}

.waiting-progress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin: 2rem 0;
  color: #92400e;
}

.waiting-progress .spinner {
  width: 30px;
  height: 30px;
  border: 4px solid #fde68a;
  border-top: 4px solid #f59e0b;
}

/* ════ 主界面：左侧栏 + 右侧内容（与 React 原型稿一致） ════ */

.wallet-summary {
  padding: 0.75rem;
  margin-bottom: 0.25rem;
  border-bottom: 1px solid var(--surface-soft);
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
  animation: pulse 2s ease-in-out infinite;
}

.wallet-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--success);
}

.wallet-short {
  display: block;
  width: 100%;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-item {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.75rem;
  border: none;
  background: transparent;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  transition: var(--transition-fast);
}

/* v1.5 验收①：用户页签与管理页签同侧栏并列，中间一条"管理"分组细线 */
.sidebar-divider {
  margin: 0.85rem 0.75rem 0.4rem;
  padding-top: 0.6rem;
  border-top: 1px solid rgba(226, 232, 240, 0.9);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-faint);
  user-select: none;
}

/* v1.5 验收①：管理页签内嵌 AdminPanel——外层 tab-content 不再叠 padding，
   避免双层留白；AdminPanel(embedded) 自身不渲染侧栏，内容即全宽 */

/* ─── 右侧内容卡 ─── */

/* ─── 账户信息 ─── */

.stat-row:last-child {
  border-bottom: none;
}

/* 长值行（vcId/profileDid+复制按钮）：2026-10-23 实锤——.addr-tip[data-full] 全局
   overflow:visible（hover 提示不能被裁）把上面的省略号推翻，nowrap 长串+不可压缩的
   emoji 按钮一起撑破卡片边界。解法=职责拆分：外层宿主自然收窄成 flex 行，
   省略号交给内层 .stat-clip，按钮永不缩 */
.stat-value.addr-tip {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}

/* ─── 进入容器入口卡（容器管理顶部） ─── */

/* ════ 通用小组件 ════ */

/* ─── 模型配置 ─── */

/* ─── 我的技能 ─── */

/* ─── CWT 验证 ─── */

/* ─── 对话框 ─── */

.import-field input[type='text'],
.import-field select,

/* 下拉框自绘箭头：文字左右等距（原生箭头挤右侧会失衡） */




/* 缩写地址/镜像 ID：悬停立即弹出完整值。
   用自绘 tooltip 而不是原生 title —— 原生有约 1 秒延迟、样式不可控、不能选中。 */
/* 悬停提示是元素的 ::after 子节点：带 overflow:hidden 的省略号会把提示裁掉。
   凡承载 data-full 提示的元素一律不裁剪，短展示由 JS 头尾截取负责 */

/* ─── v1.4 凭证体系 ─── */
.spin {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  margin-left: auto;
  border: 2px solid rgba(107, 123, 219, 0.25);
  border-top-color: var(--brand-text);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.copy-mini:hover {
  opacity: 1;
}
</style>
