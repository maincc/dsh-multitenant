<template>
  <div class="admin-panel" :class="{ embedded }">
    <!-- 无权限页面 -->
    <div v-if="notAdmin" class="state-card">
      <h2>{{ $t('admin.noAccess') }}</h2>
      <p>{{ $t('admin.noAccessHint') }}</p>
      <p class="address-display">{{ currentAddress }}</p>
      <button class="btn btn-primary" @click="switchWallet">{{ $t('admin.switchWallet') }}</button>
    </div>

    <!-- 管理员登录 -->
    <div v-else-if="!isAdmin" class="state-card">
      <h2>{{ $t('admin.loginTitle') }}</h2>
      <p>{{ $t('admin.loginHint') }}</p>

      <div v-if="!hasCCDAO" class="error">
        {{ $t('admin.noCcdao') }}
        <br />
        <a
          href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ $t('admin.installCcdao') }}
        </a>
      </div>

      <div v-else>
        <div v-if="currentAddress" class="current-address">
          <p>{{ $t('admin.currentAddress') }}</p>
          <span class="address-display">{{ currentAddress }}</span>
        </div>
        <button class="btn btn-primary btn-large" @click="adminLogin" :disabled="logging">
          {{ logging ? $t('admin.logging') : $t('admin.loginWithCcdao') }}
        </button>
        <div v-if="loginError" class="error" style="margin-top: 1rem">{{ loginError }}</div>
      </div>
    </div>

    <!-- 系统管理：左侧栏 + 右侧内容（与 React 原型稿一致） -->
    <div v-else class="gate-shell">
      <!-- 左侧栏：内嵌态不渲染（管理页签已并入用户中心左栏，v1.5 验收反馈①） -->
      <aside v-if="!embedded" class="gate-sidebar">
        <div class="sidebar-card">
          <nav class="sidebar-nav">
            <button
              v-for="tab in adminTabs"
              :key="tab.key"
              class="sidebar-item"
              :class="{ active: activeTab === tab.key }"
              @click="activeTab = tab.key"
            >
              <span class="sidebar-icon" v-html="tab.icon"></span>
              <span>{{ tab.label }}</span>
              <span
                v-if="badgeFor(tab.key)"
                class="tab-dot"
                :title="$t('admin.pendingTip', { n: badgeFor(tab.key) })"
              ></span>
            </button>
          </nav>
        </div>
      </aside>

      <!-- 右侧内容 -->
      <section class="gate-content">
        <!-- ════════ 系统概览 ════════ -->
        <div v-if="activeTab === 'overview'" class="tab-content">
          <AdminTabOverview
            :stats="stats"
            :current-address="currentAddress"
            :current-admin-address="currentAdminAddress"
            :docker-available="dockerAvailable"
            :refresh-interval-ms="refreshIntervalMs"
            @refresh="refreshNow(true)"
          />
        </div>

        <!-- ════════ 用户管理 ════════ -->
        <div v-else-if="activeTab === 'users'" class="tab-content">
          <AdminTabUsers
            :users="users"
            :tiers="tiers"
            :loading="loading"
            :error="error"
            :refresh-interval-ms="refreshIntervalMs"
            @refresh="refreshNow(true)"
          />
        </div>

        <!-- ════════ 配额配置（只读） ════════ -->
        <div v-else-if="activeTab === 'quota'" class="tab-content">
          <AdminTabQuota
            :tiers="tiers"
            :loading="loading"
            :refresh-interval-ms="refreshIntervalMs"
            @refresh="refreshNow(true)"
          />
        </div>

        <!-- ════════ 资源监控 ════════ -->
        <div v-else-if="activeTab === 'monitor'" class="tab-content">
          <AdminTabMonitor
            :users="users"
            :stats="stats"
            :loading="loading"
            :refresh-interval-ms="refreshIntervalMs"
            @refresh="refreshNow(true)"
            @disk-scan="mergeDiskScan"
          />
        </div>

        <!-- ════════ DSH 版本管理 ════════ -->
        <div v-else-if="activeTab === 'envtpl'" class="tab-content">
          <AdminTabHead
            :title="$t('admin.tabDsh')"
            :hint="$t('admin.dshHint')"
            :loading="loading"
            :interval-ms="refreshIntervalMs"
            @refresh="refreshNow(true)"
          />
          <EnvTemplatesAdmin />
        </div>
        <div v-else-if="activeTab === 'dsh'" class="tab-content">
          <AdminTabDsh @refresh="refreshNow(true)" />
        </div>

        <!-- ════ v1.4 CWT 解除限制申请审批 ════ -->
        <div v-else-if="activeTab === 'cred'" class="tab-content">
          <AdminTabCred />
        </div>
      </section>
    </div>

    <!-- 「更新」执行中的居中遮罩：让"正在执行"有明确反馈 -->
    <div v-if="dshUpdateBusy" class="dsh-overlay" role="alertdialog" aria-busy="true">
      <div class="dsh-overlay-card">
        <span class="dsh-spinner dsh-spinner-lg"></span>
        <h4 class="dsh-overlay-title">
          {{
            dshUpdate.kind === 'batch' ? $t('admin.dshUpdatingBatch') : $t('admin.dshUpdatingOne')
          }}
        </h4>
        <p v-if="dshUpdate.address" class="dsh-overlay-addr">
          <code class="addr-tip" :data-full="dshUpdate.address">{{
            shortAddress(dshUpdate.address)
          }}</code>
        </p>
        <p v-if="dshUpdate.phase" class="dsh-overlay-phase">→ {{ dshUpdate.phase }}</p>
        <p v-if="dshUpdate.kind === 'batch'" class="dsh-overlay-count">
          {{ dshApply.completed }} / {{ dshApply.total }}
        </p>
        <p class="dsh-overlay-hint">{{ $t('admin.dshUpdateHint') }}</p>
        <button
          v-if="dshUpdate.kind === 'single'"
          class="btn btn-small dsh-overlay-dismiss"
          @click="dshUpdate.kind = null"
        >
          {{ $t('admin.dshUpdateHide') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { askConfirm, toast } from '../composables/useDialog'
import { ref, computed, onMounted, onUnmounted, watch, provide } from 'vue'
import { useAdminBadges, startAdminBadges, stopAdminBadges } from '../composables/useAdminBadges'
// 红点判数入口（模板侧 badgeFor 引用此解构——只 import 不解构=运行时 TypeError，上一版踩中自修）
const { badgeFor, syncCredCount, refreshCred } = useAdminBadges()
import axios from 'axios'
import { adminStatusApi } from '../api/adminStatus.js'
import { useI18n } from 'vue-i18n'
import { buildAdminTabs } from '../admin-tabs'
import AdminTabHead from '../components/admin/AdminTabHead.vue'
import AdminTabQuota from '../components/admin/AdminTabQuota.vue'
import { bindAdminCredHost } from '../composables/useAdminCred.js'
import { bindDshHost, cleanupDsh, useAdminDsh } from '../composables/useAdminDsh.js'
import AdminTabUsers from '../components/admin/AdminTabUsers.vue'
import AdminTabMonitor from '../components/admin/AdminTabMonitor.vue'
import AdminTabOverview from '../components/admin/AdminTabOverview.vue'
import AdminTabCred from '../components/admin/AdminTabCred.vue'
import AdminTabDsh from '../components/admin/AdminTabDsh.vue'
import {
  tierBadge as sharedTierBadge,
  statusBadge,
  fmtTime,
  makeStatusText,
} from '../components/admin/shared.js'
import EnvTemplatesAdmin from '../components/EnvTemplatesAdmin.vue'
import {
  requestAccounts,
  signMessage,
  getPublicKey,
  watchAccountsChanged,
  friendlyPluginError,
} from '../api/wallet.js'
import { signAdminOperation as signAdminCore } from '../api/adminSign.js'
import { formatBytes, shortAddress } from '../utils/format.js'

const { t } = useI18n()

// v1.5 刀5C/用户验收①：可被用户中心内嵌挂载（源码不合并，同一组件两用）。
// embedded=true 时不渲染自带侧栏——管理页签由用户中心左栏统一驱动（externalTab 传子页
// key，与用户 tab 平级并列，消灭"系统管理"嵌套壳）。登录会话（user_session
// 单源，判例 2026-10-30）的钱包签名登录
// **照旧要**（刀2B 安全模型一字不松：tab 可见=凭证判权，可操作=会话+当场签名）。
const props = defineProps({
  embedded: { type: Boolean, default: false },
  externalTab: { type: String, default: '' },
})

// ---- 侧栏导航（页签定义与用户中心共享：admin-tabs.js） ----
const activeTab = ref(props.embedded && props.externalTab ? props.externalTab : 'overview')
watch(
  () => props.externalTab,
  (v) => {
    if (props.embedded && v) activeTab.value = v
  },
)
const adminTabs = buildAdminTabs(t)

const users = ref([])
const stats = ref({ totalUsers: 0, runningUsers: 0, tierCounts: {} })
const tiers = ref({})
const loading = ref(true)
const error = ref(null)
const isAdmin = ref(false)
const notAdmin = ref(false)
const logging = ref(false)
const loginError = ref(null)
const hasCCDAO = ref(false)
const currentAdminAddress = ref(null)
const currentAddress = ref(null)
const dockerAvailable = ref(false)

/**
 * 本地已构建的版本行（来自 /versions 的 localTags）。
 * 注意：latest 是移动标签、不指向某个具体版本，界面里单独由「总体镜像」呈现，
 * 这里只列具体版本，避免同一镜像因为两个 tag 出现两行造成误解。
 */

/** 把字节数格式化成人类可读（后端只给字节，避免在两端各写一套单位逻辑） */

/** 短地址显示（前 6 + … + 后 4），表格里避免撑爆 */

/** 镜像 ID 只留前 12 位（sha256: 前缀太长） */

// 最高配额等级（随 tier 配置动态变化，不硬编码 3）
const maxTier = computed(() => {
  const keys = Object.keys(tiers.value || {})
    .map(Number)
    .filter(Number.isFinite)
  return keys.length ? Math.max(...keys) : 3
})

let dataRefreshInterval = null
/** 上次拉取时间：切 tab 时做 1 秒节流，避免狂点 tab 打爆后端 */
let lastFetchAt = 0
/** 自动刷新间隔（毫秒）：后端 /api/stats 的 uiConfig 下发，默认 15 秒。
 *  想改成 5 分钟只需改 config.json 的 admin.refreshIntervalMs 并重启服务。 */
const refreshIntervalMs = ref(15000)

/** 停止轮询
 *  ⚠️ 事故复盘（2026-10 审计 P0）：这里曾写成 `stopPolling()`（调用自身、
 *  没有 clearInterval）——源码运行是无限递归 RangeError（onMounted 被 catch 吞掉后
 *  把合法管理员误判成"无权限"页）；生产 bundle 被压缩器折叠成空函数，登出/切账户/
 *  离开页面都停不掉 15 秒轮询，且每次 startPolling 叠加一个新定时器。 */
const stopPolling = () => {
  if (dataRefreshInterval) {
    clearInterval(dataRefreshInterval)
    dataRefreshInterval = null
  }
}

/**
 * 启动轮询：间隔取 refreshIntervalMs；定时器内再判一次 document.hidden，
 * 页面在后台时不空转（回到前台会有 visibilitychange 立即补一次）。
 */
const startPolling = () => {
  stopPolling()
  dataRefreshInterval = setInterval(() => {
    if (!document.hidden) fetchData()
  }, refreshIntervalMs.value)
}

/** 立即刷新（手动按钮 / 切 tab / 回到前台）；force 跳过服务端 3 秒短缓存 */
const refreshNow = async (force = false) => {
  lastFetchAt = Date.now()
  await fetchData(force)
}
// 账户监听解绑函数（wallet.js watchAccountsChanged 返回），卸载时调用避免重复监听
let unbindAccounts = null

const checkCCDAO = () => {
  hasCCDAO.value = typeof window.ccdao !== 'undefined'
}

// 账户变化统一处理（事件/轮询共用）：
// 地址切换 → 先做无痕管理员预检（不弹签名）→ 是管理员才签名换会话；
// 不是管理员 → 立即显示无权限页（notAdmin），绝不滞留系统管理页。
const handleAccountsChanged = async (accounts, source = 'unknown') => {
  console.log(`[AdminPanel] 检测到账户变化(${source}):`, accounts)

  if (!accounts || accounts.length === 0) {
    // 用户断开连接
    toast(t('admin.walletDisconnected'))
    isAdmin.value = false
    notAdmin.value = false
    currentAdminAddress.value = null
    currentAddress.value = null
    stopPolling()
    return
  }

  const pluginAddress = accounts[0] // 保留原始大小写！swtc_signMessage 的 accounts.includes 是大小写敏感严格匹配
  const newAddress = pluginAddress.toLowerCase()
  currentAddress.value = newAddress

  if (newAddress !== currentAdminAddress.value) {
    console.log(`[AdminPanel] 地址切换：${currentAdminAddress.value} -> ${newAddress}`)

    // 第一步：无痕预检（/api/admin/check 只查名单，不需要签名）
    // 先确认新地址在不在管理员名单里，避免对普通地址也弹签名窗
    let isAdminUser = false
    try {
      isAdminUser = (await adminStatusApi.check(newAddress)).isAdmin
    } catch {
      /* 预检失败走签名兜底 */
    }

    if (!isAdminUser) {
      // 新地址不是管理员 → 直接无权限页（不弹签名、不刷新数据）
      console.log(`[AdminPanel] 新地址 ${newAddress.slice(0, 10)}... 不是管理员，显示无权限`)
      notAdmin.value = true
      isAdmin.value = false
      currentAdminAddress.value = null
      stopPolling()
      return
    }

    // 第二步：是管理员 → 重新钱包签名登录换会话（会话与地址绑定，P0-1）
    // 注意：signLogin 必须传【原始大小写】pluginAddress，传小写会被插件拒绝签名
    try {
      const res = await signLogin(pluginAddress)
      if (res.data.ok) {
        const address = res.data.address
        currentAdminAddress.value = address
        isAdmin.value = true
        notAdmin.value = false
        await fetchData()
        toast(t('admin.switchedAdmin', { addr: `${address.slice(0, 10)}...` }))
      } else {
        // 签名通过但后端判定无权限
        notAdmin.value = true
        isAdmin.value = false
        currentAdminAddress.value = null
        stopPolling()
      }
    } catch (err) {
      if (err.response?.status === 403) {
        // 新地址不是管理员，显示无权限页面
        notAdmin.value = true
        isAdmin.value = false
        currentAdminAddress.value = null
        stopPolling()
      } else {
        // 其他错误（如签名被拒/网络）：给用户明确反馈，不静默
        console.error('[AdminPanel] 验证新地址失败:', err)
        const msg = err.response?.data?.error || err.message
        loginError.value = t('admin.loginFail', { err: msg })
        toast(t('admin.loginFail', { err: msg }))
      }
    }
  }
}

// 监听账户变化事件（三通道兼容，共用 api/wallet.js 的 watchAccountsChanged）
const setupAccountChangeListener = () => {
  if (!hasCCDAO.value) return
  console.log('[AdminPanel] 设置账户监听器（三通道兼容）...')
  unbindAccounts = watchAccountsChanged(handleAccountsChanged)
}

const checkDockerStatus = async () => {
  try {
    const res = await axios.get('/api/docker/status')
    dockerAvailable.value = res.data.available
  } catch (err) {
    dockerAvailable.value = false
  }
}

const checkAdmin = async () => {
  try {
    isAdmin.value = (await adminStatusApi.check()).isAdmin
  } catch (err) {
    isAdmin.value = false
  }
}

/**
 * 钱包签名登录（security-hardening-plan P0-1）：
 * 领取一次性挑战 → 插件 signMessage 签名 → 提交验签换随机会话。
 * @param {string} pluginAddress 插件当前账户【保留原始大小写】！
 *   （插件 swtc_signMessage 的 accounts.includes 是大小写敏感严格匹配，
 *    只有 requestAccounts 原样返回的字符串才能通过；后端自行 normalize）
 */
const signLogin = async (pluginAddress) => {
  // 1. 领取挑战（地址传小写，后端 normalize 后校验管理员名单）
  const chalRes = await axios.post('/api/admin/challenge', {
    address: pluginAddress.toLowerCase(),
  })
  // 服务端下发 message = 用途绑定消息（`dsh-multitenant|login|<地址>|<nonce>` 的 hex）。
  // 必须签 message 而不是 nonce：否则为其它用途（连容器/网关校验/技能市场）取得的
  // 签名也能在登录处兑现 —— 那正是本次安全加固要堵的链。
  const { nonce, message } = chalRes.data
  // 2. 插件对 **message** 签名 + 取公钥（都用原始大小写地址）
  const signature = await signMessage(pluginAddress, message)
  const publicKey = await getPublicKey(pluginAddress)
  // 3. 提交登录（签名验明身份 + 地址归属 → 签发服务端会话）
  return axios.post('/api/admin/login', {
    address: pluginAddress,
    nonce,
    signature,
    publicKey,
  })
}

/**
 * 破坏性操作的当场钱包签名（P0 加固）。
 *
 * 背景：登录会话 token 是 12 小时有效的 bearer token（user_session 单源），只做查表不验签；而平台
 * 会把浏览器 cookie 原样转发进租户容器（`path=/` 的 cookie 不按端口隔离），
 * 所以"管理员访问过的租户"能拿到它并重放。钱包侧（改配置 / 装 skill / 进容器）
 * 本来就是**每次操作当场签一个一次性 nonce**，这里把那套样板搬到管理侧。
 *
 * 与登录签名的区别：签的不是裸 nonce，而是 `` `${nonce}|${binding}` ``，
 * binding 由**服务端**从 (operation, payload) 推导（客户端无法影响），
 * 因此"签了 A 却执行 B"会被后端拒绝。
 *
 * @param {string} operation 操作名（后端白名单）
 * @param {object} payload   会改变行为的入参（含目标 address）
 * @returns {Promise<object>} 可直接展开进 axios config 的 headers
 */
// P3 孪生收敛（2026-11-10）：challenge→sign→材料校验→三头 的权威流程唯 ../api/adminSign.js
// 一支（旧本地全装拷贝退役，判例 58 孪生面漂移根治）。此处只留桌面本地关注：
// hasCCDAO 前置闸 + 钱包≠会话预检（opts.sessionAddress 注入）+ friendlyPluginError 包装。
const signAdminOperation = async (operation, payload) => {
  if (!hasCCDAO.value) {
    throw new Error(t('admin.signNeedsWallet'))
  }
  try {
    return await signAdminCore(operation, payload, {
      sessionAddress: currentAddress.value,
      t,
    })
  } catch (err) {
    throw new Error(friendlyPluginError(err))
  }
}

// ---- v1.4 CWT 解除限制申请审批 ----

/* ── v1.5 管理员任免（名册=配发政策面；判权骑 admin 凭证，5A 后端编排） ── */

// promoteAdmin（任免名册的任命输入口）已退役（2026-10-23 用户拍板去双入口）：
// 任命=「用户管理」行内 promoteUser；名册块转只读审计视图。
// 从未开过容器的地址不在用户列表=系统里尚不存在该用户，本就不该提前任命。

const adminLogin = async () => {
  if (!hasCCDAO.value) return
  logging.value = true
  loginError.value = null
  try {
    // 插件原始大小写地址（用于签名）；展示用小写
    const pluginAddress = await requestAccounts()
    currentAddress.value = pluginAddress.toLowerCase()

    // 钱包签名登录（challenge → signMessage → 会话）
    const res = await signLogin(pluginAddress)
    if (res.data.ok) {
      // 是管理员，登录成功
      const address = res.data.address // 后端 normalize 后的小写地址
      isAdmin.value = true
      notAdmin.value = false
      currentAdminAddress.value = address
      await fetchData()

      // 启动数据刷新（间隔由 refreshIntervalMs 决定，默认 15 秒）
      startPolling()
    }
  } catch (err) {
    if (err.response?.status === 403) {
      // 不是管理员，显示无权限页面
      notAdmin.value = true
      isAdmin.value = false
      loginError.value = null
    } else {
      loginError.value = err.response?.data?.error || t('admin.loginFail', { err: err.message })
    }
  } finally {
    logging.value = false
  }
}

const switchWallet = () => {
  // 提示用户切换钱包
  toast(t('admin.switchWalletHint'))
}

const logout = async () => {
  // 后端吊销会话（P0-1）
  try {
    await axios.post('/api/admin/logout')
  } catch {
    // 忽略吊销失败（本地强制登出）
  }
  isAdmin.value = false
  currentAdminAddress.value = null
  stopPolling()
}

const fetchData = async (force = false) => {
  try {
    loading.value = true
    const [usersRes, statsRes] = await Promise.all([
      // force=1：绕过服务端短缓存（手动刷新/写操作后拿到的必须是最新）
      axios.get(force ? '/api/users?force=1' : '/api/users'),
      axios.get('/api/stats'),
    ])
    // 间隔由后端下发：改 config.json 后重启服务即生效，无需重新构建前端
    const iv = Number(statsRes.data?.uiConfig?.refreshIntervalMs)
    if (Number.isFinite(iv) && iv >= 3000 && iv !== refreshIntervalMs.value) {
      refreshIntervalMs.value = iv
      if (dataRefreshInterval) startPolling() // 间隔变了 → 用新间隔重建定时器
    }
    users.value = usersRes.data.users
    tiers.value = usersRes.data.tiers
    stats.value = statsRes.data
    error.value = null
  } catch (err) {
    error.value = t('admin.loadFail', { err: err.message })
  } finally {
    loading.value = false
  }
}

/** 手动触发精确扫描：du 实测每个租户卷真实占用（O(n)，管理员按需调用） */

const tierBadge = sharedTierBadge
const statusText = makeStatusText(t)

/** 内存占比样式：达到自动升级阈值（80%）时高亮警示 */

/** KB → 人类可读容量（如 "52.2 GB"） */

/** 宿主磁盘使用率样式 */

/** Docker 存储类型 → 中文名 */

/** 解析 docker 大小字符串（"101.3kB" / "602.1MB" / "1.2GB"）→ 字节数 */

/** 字节数 → 人类可读（如 "2.4 MB"） */

/** 实测值与引擎口径差异高亮：偏差 ≥2 倍标黄，≥10 倍标红（提示引擎口径失真） */

/** 按地址查租户数据卷大小（volume 名形如 dsh-data-swtc-<address>） */

const getCurrentAddress = async () => {
  if (!hasCCDAO.value) return
  try {
    const pluginAddress = await requestAccounts()
    currentAddress.value = pluginAddress.toLowerCase()
  } catch (err) {
    console.error('[AdminPanel] 获取当前地址失败:', err)
  }
}

/** 精确扫描结果回壳合并（AdminTabMonitor 的 disk-scan 事件） */
bindAdminCredHost({
  sign: (op, payload) => signAdminOperation(op, payload),
  refresh: (force) => fetchData(force),
})

// 升级全屏遮罩留壳（跨 tab 可见语义）；状态取 useAdminDsh 单例
const { dshUpdate, dshApply, dshUpdateBusy } = useAdminDsh()

bindDshHost({
  sign: (op, payload) => signAdminOperation(op, payload),
  refresh: (force) => fetchData(force),
})

const mergeDiskScan = ({ scanned, volumes, preciseScannedAt }) => {
  if (scanned && stats.value.resource?.disk) {
    stats.value.resource.disk.volumes = volumes
    stats.value.resource.disk.preciseScannedAt = preciseScannedAt
  }
}

// 子 tab 组件的壳层单例注入口（签名包装/数据刷新/撤销管理员——判例 58：全域唯此一支）
provide('adminSign', signAdminOperation)
provide('adminRefresh', (force) => fetchData(force))
provide('adminLogout', logout)
onMounted(async () => {
  checkCCDAO()

  // 检查 Docker 状态
  await checkDockerStatus()

  // 获取当前地址
  if (hasCCDAO.value) {
    await getCurrentAddress()
    // 设置账户变化监听器
    setupAccountChangeListener()

    // 检查当前地址是否是管理员
    if (currentAddress.value) {
      try {
        const ck = await adminStatusApi.check(currentAddress.value)
        if (ck.isAdmin) {
          // 当前地址是管理员，检查 cookie session
          await checkAdmin()
          if (isAdmin.value) {
            await fetchData()
            startPolling()
          } else {
            // cookie 无效，需要重新登录
            notAdmin.value = false
            isAdmin.value = false
          }
        } else {
          // 当前地址不是管理员，显示无权限页面
          notAdmin.value = true
          isAdmin.value = false
        }
      } catch (err) {
        console.error('[AdminPanel] 检查管理员权限失败:', err)
        notAdmin.value = true
        isAdmin.value = false
      }
    }
  } else {
    // 没有 CCDAO 插件，显示登录页面
    await checkAdmin()
  }
})

// 切 tab → 立即拉一次（1 秒节流，避免狂点侧栏把后端打爆）。
// 轮询间隔若被调长（例如 5 分钟），这一步保证「切过去看到的就是新的」。
watch(activeTab, () => {
  if (Date.now() - lastFetchAt > 1000) refreshNow()
  // DSH tab 数据随组件 onMounted 自拉（useAdminDsh 单例跨 tab 保活）
})

// 回到前台 → 立即补一次；后台由 startPolling 的定时器判断跳过
const onVisibilityChange = () => {
  if (!document.hidden && isAdmin.value) refreshNow()
}
onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange))

onMounted(() => {
  startAdminBadges()
})
onUnmounted(() => {
  stopAdminBadges()
})
// ↑红点节拍收线；下方为本面板既有清理逻辑
onUnmounted(() => {
  // 清理定时器与监听
  stopPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  cleanupDsh()
  // 解绑账户监听（避免组件重挂载后重复监听）
  unbindAccounts?.()
  unbindAccounts = null
})
</script>

<style scoped>
.admin-panel {
  height: 100%;
  display: flex;
  animation: fadeIn 0.3s;
}
/* 内嵌态（v1.5 系统管理 tab）：不撑满整页高度，随内容生长 */
.admin-panel.embedded {
  height: auto;
  min-height: 480px;
}

/* ─── 磁盘扫描（租户卷区块） ─── */

/* ════ 状态卡片（noAccess / login） ════ */

.state-card h2 {
  font-size: 1.4rem;
  margin-bottom: 1rem;
  color: var(--text-main);
}

.state-card p {
  color: var(--text-muted);
  margin-bottom: 2rem;
}

.error-card h2 {
  color: var(--danger);
}

.address-display {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: var(--bg-page);
  padding: 0.5rem 0.75rem;
  border-radius: 10px;
  word-break: break-all;
  margin-bottom: 2rem;
  display: block;
  font-size: 0.85rem;
  color: var(--text-body);
}

.current-address {
  margin-bottom: 1.5rem;
}

.current-address p {
  color: var(--text-muted);
  margin-bottom: 0.5rem;
  font-size: 0.9rem;
}

/* ════ 主界面：左侧栏 + 右侧内容（与 React 原型稿一致） ════ */

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

/* ─── 右侧内容卡 ─── */

.tab-content {
  animation: fadeIn 0.25s;
}

/* ─── 资源监控（配额配置页） ─── */

/* ─── 磁盘监控（配额配置页） ─── */

/* ─── 磁盘扫描（租户卷区块） ─── */

.btn-disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ─── 管理员信息卡 ─── */
/* ─── Docker 状态 ─── */
/* ─── 操作按钮行 ─── */
table {
  font-size: 0.875rem;
}

.btn {
  margin-right: 0.375rem;
  text-decoration: none;
  display: inline-flex;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.badge-secondary {
  background: var(--text-muted);
  color: white;
}

/* ─── CWT 授权管理 ─── */

/* ─── CWT 申请列表：筛选头 + 分页 ─── */

/* ─── 孤儿数据卷 ─── */
/* ==========================================================================
   DSH 版本管理
   ========================================================================== */

.dsh-select:focus {
  outline: none;
  border-color: var(--brand);
  box-shadow: 0 0 0 2px rgba(64, 126, 255, 0.15);
}

/* 「更新」执行中的居中遮罩。
   目的：更新是同步长耗时操作（重建容器），必须让用户明确看到"正在执行"，
   而不是只有按钮变灰、无从判断是在跑还是卡死。 */
.dsh-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
}

.dsh-overlay-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  min-width: 280px;
  max-width: 420px;
  padding: 1.5rem 1.75rem;
  border-radius: 12px;
  background: var(--surface-white);
  box-shadow: 0 12px 40px rgba(15, 23, 42, 0.28);
  text-align: center;
}

.dsh-spinner-lg {
  width: 26px;
  height: 26px;
  border-width: 3px;
}

.dsh-overlay-title {
  margin: 0;
  font-size: 0.98rem;
  color: #0f172a;
}

.dsh-overlay-addr {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.dsh-overlay-phase {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: #1d4ed8;
}

.dsh-overlay-count {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: #1d4ed8;
}

.dsh-overlay-hint {
  margin: 0.15rem 0 0;
  font-size: 0.76rem;
  line-height: 1.5;
  color: var(--text-faint);
}

/* 步骤序号：把"版本 → 构建 → 总体镜像 → 租户镜像"这条链在视觉上串起来 */

/* "可清理"标记：与"在用/当前"形成对比，一眼能看出哪些是垃圾 */

/* 后门：万一请求真的挂死，用户不该只能强刷页面 */
.dsh-overlay-dismiss {
  margin-top: 0.35rem;
}

/* 租户实际在跑的 DSH 版本（主列表 + 镜像升级表共用） */

.dsh-badge-running {
  background: #dcfce7;
  color: #15803d;
}

.dsh-badge-stopped {
  background: var(--surface-soft);
  color: var(--text-muted);
}

.dsh-badge-ok {
  background: #dcfce7;
  color: #15803d;
}

/* 预览计划里的快照目录提示：会降级/不可用必须显眼，正常则弱化 */

/* 版本历史：镜像是否仍在本地 + 可清理项 */

/* 概括页头：左标题/提示，右自动刷新提示+刷新按钮（按钮跟随每个 tab 的概括区） */

/* 缩写地址/镜像 ID：悬停立即弹出完整值。
   用自绘 tooltip 而不是原生 title —— 原生有约 1 秒延迟、样式不可控、不能选中。 */
/* 提示 ::after 是子节点：任何 overflow:hidden 祖先（含自身省略号）都会裁掉它 */

/* v1.4 CWT 审批 tab */

/* 凭证审批三表（审批/签发台账/任免名册）数据行恒单行（2026-10-23 用户反馈
   "表格里数据换行"）：列内容不被压缩折行，放不下时容器横向滚动——宽度换给
   内嵌态的窄内容区也不破版 */
/* 台账搜索：大号胶囊 + 放大镜 + 聚焦光晕 */
/* cred-search/addr-input 制式已废（2026-10-23 三框统一）：台账与名册搜索框
   改用全局 .search-input（参照=技能市场原版），单一来源防漂移 */
</style>
