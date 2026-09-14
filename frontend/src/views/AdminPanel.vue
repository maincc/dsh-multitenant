<template>
  <div class="admin-panel">
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

    <!-- 管理面板：左侧栏 + 右侧内容（与 React 原型稿一致） -->
    <div v-else class="gate-shell">
      <!-- 左侧栏 -->
      <aside class="gate-sidebar">
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
            </button>
          </nav>
        </div>
      </aside>

      <!-- 右侧内容 -->
      <section class="gate-content">
        <!-- ════════ 系统概览 ════════ -->
        <div v-if="activeTab === 'overview'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('admin.tabOverview') }}</h4>
            <p class="tab-hint">{{ $t('admin.overviewHint') }}</p>
          </div>

          <!-- 当前管理员信息 -->
          <div class="admin-info-card">
            <div class="admin-info">
              <div class="admin-label">{{ $t('admin.currentAdminLabel') }}</div>
              <code class="admin-address">{{ currentAddress || currentAdminAddress }}</code>
              <button class="btn btn-small btn-danger" @click="logout">
                {{ $t('admin.logout') }}
              </button>
            </div>
          </div>

          <!-- Docker 状态指示器 -->
          <div class="docker-status-card" :class="dockerAvailable ? 'docker-ok' : 'docker-error'">
            <div class="docker-status">
              <div class="status-icon"></div>
              <div class="status-info">
                <div class="status-label">{{ $t('admin.dockerStatus') }}</div>
                <div class="status-text">
                  {{ dockerAvailable ? $t('admin.running') : $t('admin.notRunning') }}
                </div>
              </div>
              <div v-if="!dockerAvailable" class="status-hint">{{ $t('admin.dockerHint') }}</div>
            </div>
          </div>

          <!-- 系统统计 -->
          <div class="stats-grid">
            <div class="stat-card">
              <h3>{{ $t('admin.statTotal') }}</h3>
              <div class="value">{{ stats.totalUsers }}</div>
            </div>
            <div class="stat-card">
              <h3>{{ $t('admin.running') }}</h3>
              <div class="value">{{ stats.runningUsers }}</div>
            </div>
            <div class="stat-card">
              <h3>{{ $t('admin.statTier1') }}</h3>
              <div class="value">{{ stats.tierCounts[1] || 0 }}</div>
            </div>
            <div class="stat-card">
              <h3>{{ $t('admin.statTier2') }}</h3>
              <div class="value">{{ stats.tierCounts[2] || 0 }}</div>
            </div>
          </div>

          <!-- 孤儿数据卷清理 -->
          <div class="sub-section">
            <h4>{{ $t('admin.orphanTitle') }}</h4>
            <p class="tab-hint">{{ $t('admin.orphanHint') }}</p>
            <div class="action-buttons">
              <button class="btn btn-warning" @click="scanOrphanVolumes" :disabled="orphanScanning">
                {{ orphanScanning ? $t('admin.orphanScanning') : $t('admin.orphanScanBtn') }}
              </button>
              <button
                v-if="orphanVolumes.length > 0"
                class="btn btn-danger"
                @click="cleanupOrphanVolumes"
              >
                {{ $t('admin.orphanCleanBtn', { n: orphanVolumes.length }) }}
              </button>
            </div>
            <div v-if="orphanNotice" class="orphan-notice">{{ orphanNotice }}</div>
            <ul v-if="orphanVolumes.length > 0" class="orphan-list">
              <li v-for="v in orphanVolumes" :key="v" class="orphan-item">
                <span class="orphan-name">{{ v }}</span>
              </li>
            </ul>
          </div>
        </div>

        <!-- ════════ 用户管理 ════════ -->
        <div v-else-if="activeTab === 'users'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('admin.tabUsers') }}</h4>
            <p class="tab-hint">{{ $t('admin.userListHint') }}</p>
          </div>
          <div v-if="loading" class="loading">{{ $t('admin.loading') }}</div>
          <div v-else-if="error" class="error">{{ error }}</div>
          <table v-else>
            <thead>
              <tr>
                <th>{{ $t('admin.colAddress') }}</th>
                <th>{{ $t('admin.colPort') }}</th>
                <th>{{ $t('admin.colTier') }}</th>
                <th>{{ $t('admin.colStatus') }}</th>
                <th>{{ $t('admin.colMem') }}</th>
                <th>{{ $t('admin.colIdle') }}</th>
                <th>{{ $t('admin.colRole') }}</th>
                <th>{{ $t('admin.colOps') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in users" :key="user.address">
                <td>
                  <span class="address">{{ user.address.slice(0, 10) }}...</span>
                </td>
                <td>{{ user.port }}</td>
                <td>
                  <span class="badge" :class="tierBadge(user.tier)">
                    {{ user.tierLabel }}
                  </span>
                </td>
                <td>
                  <span class="badge" :class="statusBadge(user.status)">
                    {{ statusText(user.status) }}
                  </span>
                </td>
                <td>
                  <div v-if="user.stats">
                    {{ user.stats.memoryPercent }}
                    <div class="progress-bar">
                      <div class="progress-fill" :style="{ width: user.stats.memoryPercent }"></div>
                    </div>
                  </div>
                  <span v-else>-</span>
                </td>
                <td>{{ formatIdle(user.idle) }}</td>
                <td>
                  <span v-if="user.isAdmin" class="badge badge-success">{{
                    $t('admin.roleAdmin')
                  }}</span>
                  <span v-else class="badge badge-info">{{ $t('admin.roleUser') }}</span>
                </td>
                <td>
                  <div class="ops-cell">
                    <button
                      class="btn btn-primary"
                      @click="upgradeUser(user.address, user.tier + 1)"
                      :disabled="
                        user.tier >= 3 || user.status === 'destroyed' || user.status === 'unknown'
                      "
                    >
                      {{ $t('admin.upgrade') }}
                    </button>
                    <button
                      class="btn btn-success"
                      @click="downgradeUser(user.address, user.tier - 1)"
                      :disabled="
                        user.tier <= 1 || user.status === 'destroyed' || user.status === 'unknown'
                      "
                    >
                      {{ $t('admin.downgrade') }}
                    </button>
                    <button
                      v-if="!user.isAdmin"
                      class="btn btn-warning"
                      @click="promoteUser(user.address)"
                      :disabled="user.status === 'destroyed' || user.status === 'unknown'"
                    >
                      {{ $t('admin.promote') }}
                    </button>
                    <a
                      v-if="user.status === 'running'"
                      href="#"
                      @click.prevent="openTenant(user.address)"
                      rel="noopener noreferrer"
                      class="btn btn-info"
                    >
                      {{ $t('admin.visit') }}
                    </a>
                    <button
                      v-if="user.status === 'running'"
                      class="btn btn-warning"
                      @click="forceStopUser(user.address)"
                      :title="$t('admin.forceStopTitle')"
                    >
                      {{ $t('admin.forceStop') }}
                    </button>
                    <button
                      v-if="user.status === 'stopped' || user.status === 'destroyed'"
                      class="btn btn-danger"
                      @click="deleteVolume(user.address)"
                      :title="$t('admin.deleteDataTitle')"
                    >
                      {{ $t('admin.deleteData') }}
                    </button>
                    <button
                      v-if="user.status === 'destroyed' || user.status === 'unknown'"
                      class="btn btn-danger"
                      @click="removeUser(user.address)"
                      :title="$t('admin.removeTitle')"
                    >
                      {{ $t('admin.remove') }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- ════════ 配额配置 ════════ -->
        <div v-else-if="activeTab === 'quota'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('admin.tabQuota') }}</h4>
            <p class="tab-hint">{{ $t('admin.tierConfigHint') }}</p>
          </div>
          <table>
            <thead>
              <tr>
                <th>{{ $t('admin.colTierLevel') }}</th>
                <th>{{ $t('admin.colMemory') }}</th>
                <th>{{ $t('admin.colCpu') }}</th>
                <th>{{ $t('admin.colPids') }}</th>
                <th>{{ $t('admin.colSwap') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(limits, tier) in tiers" :key="tier">
                <td>
                  <span class="badge" :class="tierBadge(Number(tier))">
                    {{ limits.label }}
                  </span>
                </td>
                <td>{{ limits.memory }}</td>
                <td>{{ limits.cpus }} {{ $t('admin.cpuUnit') }}</td>
                <td>{{ limits.pids }}</td>
                <td>{{ limits.memorySwap }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- ════════ CWT 授权 ════════ -->
        <div v-else class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('admin.tabCwt') }}</h4>
            <p class="tab-hint">{{ $t('admin.cwtManageHint') }}</p>
          </div>

          <div v-if="cwtLoading" class="config-loading">
            <span>{{ $t('admin.cwtLoading') }}</span>
          </div>

          <div class="sub-section">
            <h4>{{ $t('admin.cwtPending') }}</h4>
            <table v-if="cwtApplications.length">
              <thead>
                <tr>
                  <th>{{ $t('admin.colUsr') }}</th>
                  <th>{{ $t('admin.colAddress') }}</th>
                  <th>{{ $t('admin.colAlg') }}</th>
                  <th>{{ $t('admin.colSubmitted') }}</th>
                  <th>{{ $t('admin.colVerify') }}</th>
                  <th>{{ $t('admin.colOps') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="app in cwtApplications" :key="app.id">
                  <td>{{ app.parsed?.usr || '-' }}</td>
                  <td class="cwt-mono">{{ shortAddr(app.parsed?.address) }}</td>
                  <td>{{ app.parsed?.alg || '-' }}</td>
                  <td>{{ fmtTime(app.submittedAt) }}</td>
                  <td>
                    <span class="badge" :class="app.sigOk ? 'badge-success' : 'badge-danger'">
                      {{ app.sigOk ? $t('admin.sigOk') : $t('admin.sigFail') }}
                    </span>
                  </td>
                  <td>
                    <template v-if="app.status === 'pending'">
                      <button
                        class="btn btn-small btn-success"
                        :disabled="cwtBusy"
                        @click="approveCwt(app.id)"
                      >
                        {{ $t('admin.approve') }}
                      </button>
                      <button
                        class="btn btn-small btn-danger"
                        :disabled="cwtBusy"
                        @click="rejectCwt(app.id)"
                      >
                        {{ $t('admin.reject') }}
                      </button>
                    </template>
                    <span
                      v-else
                      class="badge"
                      :class="app.status === 'approved' ? 'badge-success' : 'badge-info'"
                    >
                      {{ app.status }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="cwt-empty">{{ $t('admin.noPending') }}</div>
          </div>

          <div class="sub-section">
            <h4>{{ $t('admin.cwtRegistry') }}</h4>
            <table v-if="cwtRegistry.length">
              <thead>
                <tr>
                  <th>{{ $t('admin.colUsr') }}</th>
                  <th>{{ $t('admin.colAddress') }}</th>
                  <th>{{ $t('admin.colStatus') }}</th>
                  <th>{{ $t('admin.colApprovedAt') }}</th>
                  <th>{{ $t('admin.colOps') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in cwtRegistry" :key="entry.address">
                  <td>{{ entry.usr }}</td>
                  <td class="cwt-mono">{{ shortAddr(entry.address) }}</td>
                  <td>
                    <span
                      class="badge"
                      :class="entry.status === 'approved' ? 'badge-success' : 'badge-danger'"
                    >
                      {{ entry.status }}
                    </span>
                  </td>
                  <td>{{ fmtTime(entry.approvedAt) }}</td>
                  <td>
                    <button
                      v-if="entry.status === 'approved'"
                      class="btn btn-small btn-danger"
                      :disabled="cwtBusy"
                      @click="revokeCwt(entry.address)"
                    >
                      {{ $t('admin.revoke') }}
                    </button>
                    <span v-else-if="entry.revokedAt"
                      >{{ fmtTime(entry.revokedAt) }} {{ $t('admin.revokedSuffix') }}</span
                    >
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="cwt-empty">{{ $t('admin.noRegistry') }}</div>
          </div>

          <div class="sub-section">
            <h4>{{ $t('admin.cwtRecords') }}</h4>
            <table v-if="cwtRecords.length">
              <thead>
                <tr>
                  <th>{{ $t('admin.colAction') }}</th>
                  <th>{{ $t('admin.colUsr') }}</th>
                  <th>{{ $t('admin.colAddress') }}</th>
                  <th>{{ $t('admin.colTime') }}</th>
                  <th>{{ $t('admin.colBy') }}</th>
                  <th>{{ $t('admin.colToken') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(rec, i) in cwtRecords" :key="i">
                  <td>
                    <span class="badge" :class="actionBadge(rec.action)">{{ rec.action }}</span>
                  </td>
                  <td>{{ rec.usr || '-' }}</td>
                  <td class="cwt-mono">{{ shortAddr(rec.address) }}</td>
                  <td>{{ fmtTime(rec.at) }}</td>
                  <td class="cwt-mono">{{ shortAddr(rec.by) }}</td>
                  <td>
                    <button v-if="rec.token" class="btn btn-small" @click="toggleToken(i)">
                      {{ expandedToken === i ? $t('admin.collapse') : $t('admin.view') }}
                    </button>
                    <div v-if="expandedToken === i" class="cwt-token-preview">
                      {{ rec.token }}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="cwt-empty">{{ $t('admin.noRecords') }}</div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import { useI18n } from 'vue-i18n'
import { requestAccounts, signMessage, getPublicKey, watchAccountsChanged } from '../api/wallet.js'

const { t } = useI18n()

// ---- 侧栏导航（与 React 原型稿一致） ----
const activeTab = ref('overview')
const adminTabs = [
  {
    key: 'overview',
    label: t('admin.tabOverview'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  },
  {
    key: 'users',
    label: t('admin.tabUsers'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  },
  {
    key: 'quota',
    label: t('admin.tabQuota'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  },
  {
    key: 'cwt',
    label: t('admin.tabCwt'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  },
]

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
// CWT 授权管理（M1）
const cwtApplications = ref([])
const cwtRegistry = ref([])
const cwtRecords = ref([])
const cwtLoading = ref(false)
const cwtBusy = ref(false)
const expandedToken = ref(null)
let dataRefreshInterval = null
// 账户监听解绑函数（wallet.js watchAccountsChanged 返回），卸载时调用避免重复监听
let unbindAccounts = null

// 租户 DSH 实例地址：用当前访问入口页的 host 拼端口（不再硬编码 127.0.0.1）
// 注：网关方案下不再直接拼 URL —— 打开租户需先取一次性 gateway_ticket（见 openTenant）
const webUrl = (port) => `http://${window.location.hostname}:${port}/`

/**
 * 管理员代开租户容器：后端生成一次性 gateway_ticket（管理员会话授权），
 * 浏览器打开该 URL 首跳即换取租户会话并放行（后续请求无需再带 ticket）。
 */
const openTenant = async (address) => {
  try {
    const res = await axios.get(`/api/admin/tenant-url?address=${encodeURIComponent(address)}`)
    if (res.data.url) {
      window.open(res.data.url, '_blank', 'noopener')
      return
    }
    alert(t('admin.openFail', { err: res.data.error || res.status }))
  } catch (err) {
    const msg = err.response?.data?.error || err.message
    alert(t('admin.openFail', { err: msg }))
  }
}

const checkCCDAO = () => {
  hasCCDAO.value = typeof window.ccdao !== 'undefined'
}

// 账户变化统一处理（事件/轮询共用）：
// 地址切换 → 先做无痕管理员预检（不弹签名）→ 是管理员才签名换会话；
// 不是管理员 → 立即显示无权限页（notAdmin），绝不滞留管理面板。
const handleAccountsChanged = async (accounts, source = 'unknown') => {
  console.log(`[AdminPanel] 检测到账户变化(${source}):`, accounts)

  if (!accounts || accounts.length === 0) {
    // 用户断开连接
    alert(t('admin.walletDisconnected'))
    isAdmin.value = false
    notAdmin.value = false
    currentAdminAddress.value = null
    currentAddress.value = null
    if (dataRefreshInterval) {
      clearInterval(dataRefreshInterval)
      dataRefreshInterval = null
    }
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
      const checkRes = await axios.get('/api/admin/check', { params: { address: newAddress } })
      isAdminUser = checkRes.data.isAdmin
    } catch {
      /* 预检失败走签名兜底 */
    }

    if (!isAdminUser) {
      // 新地址不是管理员 → 直接无权限页（不弹签名、不刷新数据）
      console.log(`[AdminPanel] 新地址 ${newAddress.slice(0, 10)}... 不是管理员，显示无权限`)
      notAdmin.value = true
      isAdmin.value = false
      currentAdminAddress.value = null
      if (dataRefreshInterval) {
        clearInterval(dataRefreshInterval)
        dataRefreshInterval = null
      }
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
        alert(t('admin.switchedAdmin', { addr: `${address.slice(0, 10)}...` }))
      } else {
        // 签名通过但后端判定无权限
        notAdmin.value = true
        isAdmin.value = false
        currentAdminAddress.value = null
        if (dataRefreshInterval) {
          clearInterval(dataRefreshInterval)
          dataRefreshInterval = null
        }
      }
    } catch (err) {
      if (err.response?.status === 403) {
        // 新地址不是管理员，显示无权限页面
        notAdmin.value = true
        isAdmin.value = false
        currentAdminAddress.value = null
        if (dataRefreshInterval) {
          clearInterval(dataRefreshInterval)
          dataRefreshInterval = null
        }
      } else {
        // 其他错误（如签名被拒/网络）：给用户明确反馈，不静默
        console.error('[AdminPanel] 验证新地址失败:', err)
        const msg = err.response?.data?.error || err.message
        loginError.value = t('admin.loginFail', { err: msg })
        alert(t('admin.loginFail', { err: msg }))
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
    const res = await axios.get('/api/admin/check')
    isAdmin.value = res.data.isAdmin
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
  const nonce = chalRes.data.nonce
  // 2. 插件对 nonce 签名 + 取公钥（都用原始大小写地址）
  const signature = await signMessage(pluginAddress, nonce)
  const publicKey = await getPublicKey(pluginAddress)
  // 3. 提交登录（签名验明身份 + 地址归属 → 签发服务端会话）
  return axios.post('/api/admin/login', {
    address: pluginAddress,
    nonce,
    signature,
    publicKey,
  })
}

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

      // 启动数据刷新（每 10 秒刷新一次）
      if (dataRefreshInterval) {
        clearInterval(dataRefreshInterval)
      }
      dataRefreshInterval = setInterval(fetchData, 10000)
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
  alert(t('admin.switchWalletHint'))
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
  if (dataRefreshInterval) {
    clearInterval(dataRefreshInterval)
    dataRefreshInterval = null
  }
}

// ---- 孤儿数据卷（扫描 + 清理） ----
const orphanVolumes = ref([])
const orphanScanning = ref(false)
const orphanNotice = ref('')

const scanOrphanVolumes = async () => {
  orphanScanning.value = true
  orphanNotice.value = ''
  try {
    const res = await axios.get('/api/admin/orphan-volumes')
    orphanVolumes.value = res.data.orphanVolumes || []
    orphanNotice.value = orphanVolumes.value.length
      ? t('admin.orphanFound', { n: orphanVolumes.value.length })
      : t('admin.orphanNone')
  } catch (err) {
    alert(t('admin.orphanScanFail', { err: err.response?.data?.error || err.message }))
  } finally {
    orphanScanning.value = false
  }
}

const cleanupOrphanVolumes = async () => {
  if (!orphanVolumes.value.length) return
  if (!confirm(t('admin.orphanConfirm', { n: orphanVolumes.value.length }))) return
  try {
    const res = await axios.post('/api/admin/cleanup-orphan-volumes')
    const { removed, failed } = res.data
    orphanNotice.value = t('admin.orphanCleaned', {
      ok: removed.length,
      fail: failed.length,
    })
    // 刷新列表：剩下的就是删除失败的
    orphanVolumes.value = (failed || []).map((f) => f.name)
  } catch (err) {
    alert(t('admin.orphanCleanFail', { err: err.response?.data?.error || err.message }))
  }
}

const fetchData = async () => {
  try {
    loading.value = true
    const [usersRes, statsRes] = await Promise.all([
      axios.get('/api/users'),
      axios.get('/api/stats'),
    ])
    users.value = usersRes.data.users
    tiers.value = usersRes.data.tiers
    stats.value = statsRes.data
    error.value = null
  } catch (err) {
    error.value = t('admin.loadFail', { err: err.message })
  } finally {
    loading.value = false
  }
  // CWT 数据跟随主刷新（登录成功、定时刷新、操作后刷新均自动带上）
  fetchCwtData()
}

// ---------- CWT 授权管理（M1） ----------

const shortAddr = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '-')
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '-')
const actionBadge = (action) =>
  ({ approve: 'badge-success', reject: 'badge-warning', revoke: 'badge-danger' })[action] ||
  'badge-info'
const toggleToken = (i) => {
  expandedToken.value = expandedToken.value === i ? null : i
}

const fetchCwtData = async () => {
  try {
    cwtLoading.value = true
    const [apps, reg, recs] = await Promise.all([
      axios.get('/api/admin/cwt/applications'),
      axios.get('/api/admin/cwt/registry'),
      axios.get('/api/admin/cwt/records'),
    ])
    cwtApplications.value = apps.data.applications || []
    cwtRegistry.value = reg.data.registry || []
    cwtRecords.value = recs.data.records || []
  } catch (err) {
    console.error('加载 CWT 数据失败:', err)
  } finally {
    cwtLoading.value = false
  }
}

const approveCwt = async (id) => {
  if (!confirm(t('admin.confirmApprove'))) return
  cwtBusy.value = true
  try {
    await axios.post(`/api/admin/cwt/applications/${id}/approve`)
    alert(t('admin.approvedOk'))
    await fetchData()
  } catch (err) {
    alert(t('admin.approveFail', { err: err.response?.data?.error || err.message }))
  } finally {
    cwtBusy.value = false
  }
}

const rejectCwt = async (id) => {
  if (!confirm(t('admin.confirmReject'))) return
  cwtBusy.value = true
  try {
    await axios.post(`/api/admin/cwt/applications/${id}/reject`)
    alert(t('admin.rejectedOk'))
    await fetchData()
  } catch (err) {
    alert(t('admin.rejectFail', { err: err.response?.data?.error || err.message }))
  } finally {
    cwtBusy.value = false
  }
}

const revokeCwt = async (address) => {
  if (!confirm(t('admin.confirmRevoke', { addr: `${address.slice(0, 8)}…` }))) return
  cwtBusy.value = true
  try {
    await axios.post(`/api/admin/cwt/registry/${address}/revoke`)
    alert(t('admin.revokedOk'))
    await fetchData()
  } catch (err) {
    alert(t('admin.revokeFail', { err: err.response?.data?.error || err.message }))
  } finally {
    cwtBusy.value = false
  }
}

const upgradeUser = async (address, tier) => {
  if (tier > 3) return
  try {
    await axios.post(`/api/upgrade/${address}`, { tier })
    await fetchData()
    alert(t('admin.upgradeOk'))
  } catch (err) {
    alert(t('admin.upgradeFail', { err: err.response?.data?.error || err.message }))
  }
}

const downgradeUser = async (address, tier) => {
  if (tier < 1) return
  try {
    await axios.post(`/api/upgrade/${address}`, { tier })
    await fetchData()
    alert(t('admin.downgradeOk'))
  } catch (err) {
    alert(t('admin.downgradeFail', { err: err.response?.data?.error || err.message }))
  }
}

const removeUser = async (address) => {
  const port = users.value.find((u) => u.address === address)?.port
  if (!confirm(t('admin.confirmRemove', { addr: `${address.slice(0, 10)}...`, port }))) return

  // 是否保留数据卷：确定=保留（留档/审计），取消=连同数据一起删除（彻底清除）
  const keepVolume = confirm(t('admin.confirmRemoveKeepVolume'))

  try {
    await axios.post(`/api/user/${address}/remove`, null, {
      params: keepVolume ? { keepVolume: 1 } : {},
    })
    await fetchData()
    alert(keepVolume ? t('admin.removedOkKeepVolume') : t('admin.removedOk'))
  } catch (err) {
    alert(t('admin.removeFail', { err: err.response?.data?.error || err.message }))
  }
}

const forceStopUser = async (address) => {
  if (!confirm(t('admin.confirmForceStop', { addr: `${address.slice(0, 10)}...` }))) return

  try {
    await axios.post(`/api/admin/force-stop/${address}`)
    await fetchData()
    alert(t('admin.forceStoppedOk'))
  } catch (err) {
    alert(t('admin.forceStopFail', { err: err.response?.data?.error || err.message }))
  }
}

const deleteVolume = async (address) => {
  if (!confirm(t('admin.confirmDeleteVolume', { addr: `${address.slice(0, 10)}...` }))) return

  if (!confirm(t('admin.confirmDeleteVolume2'))) return

  try {
    await axios.post(`/api/admin/delete-volume/${address}`)
    await fetchData()
    alert(t('admin.volumeDeletedOk'))
  } catch (err) {
    alert(t('admin.removeFail', { err: err.response?.data?.error || err.message }))
  }
}

const promoteUser = async (address) => {
  if (!confirm(t('admin.confirmPromote', { addr: `${address.slice(0, 10)}...` }))) return
  try {
    await axios.post(`/api/admin/promote/${address}`)
    await fetchData()
    alert(t('admin.promoteOk'))
  } catch (err) {
    alert(t('admin.promoteFail', { err: err.response?.data?.error || err.message }))
  }
}

const tierBadge = (tier) => {
  const map = { 1: 'badge-info', 2: 'badge-warning', 3: 'badge-success' }
  return map[tier] || 'badge-info'
}

const statusBadge = (status) => {
  const map = {
    running: 'badge-success',
    stopped: 'badge-warning',
    destroyed: 'badge-danger',
    unknown: 'badge-secondary',
  }
  return map[status] || 'badge-info'
}

const statusText = (status) => {
  const map = {
    running: t('admin.statusRunning'),
    stopped: t('admin.statusStopped'),
    destroyed: t('admin.statusDestroyed'),
    unknown: t('admin.statusUnknown'),
  }
  return map[status] || status
}

const formatIdle = (ms) => {
  if (ms < 60000) return `${Math.floor(ms / 1000)}${t('admin.secUnit')}`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}${t('admin.minUnit')}`
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}${t('admin.hourUnit')}`
  return `${(ms / 86400000).toFixed(1)}${t('admin.dayUnit')}`
}

const getCurrentAddress = async () => {
  if (!hasCCDAO.value) return
  try {
    const pluginAddress = await requestAccounts()
    currentAddress.value = pluginAddress.toLowerCase()
  } catch (err) {
    console.error('[AdminPanel] 获取当前地址失败:', err)
  }
}

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
        const res = await axios.get('/api/admin/check', {
          params: { address: currentAddress.value },
        })
        if (res.data.isAdmin) {
          // 当前地址是管理员，检查 cookie session
          await checkAdmin()
          if (isAdmin.value) {
            await fetchData()
            dataRefreshInterval = setInterval(fetchData, 10000)
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

onUnmounted(() => {
  // 清理定时器
  if (dataRefreshInterval) {
    clearInterval(dataRefreshInterval)
    dataRefreshInterval = null
  }
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

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ════ 状态卡片（noAccess / login） ════ */
.state-card {
  margin: auto;
  width: min(540px, calc(100% - 2rem));
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
  text-align: center;
  padding: 3rem 2rem;
}

.state-card h2 {
  font-size: 1.4rem;
  margin-bottom: 1rem;
  color: #1e293b;
}

.state-card p {
  color: #64748b;
  margin-bottom: 2rem;
}

.error-card h2 {
  color: #dc2626;
}

.address-display {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: #f8fafc;
  padding: 0.5rem 0.75rem;
  border-radius: 10px;
  word-break: break-all;
  margin-bottom: 2rem;
  display: block;
  font-size: 0.85rem;
  color: #334155;
}

.btn-large {
  padding: 0.75rem 2rem;
  font-size: 1.05rem;
}

.btn-small {
  padding: 0.25rem 0.75rem;
  font-size: 0.85rem;
  margin-left: 0.5rem;
}

.current-address {
  margin-bottom: 1.5rem;
}

.current-address p {
  color: #64748b;
  margin-bottom: 0.5rem;
  font-size: 0.9rem;
}

/* ════ 主界面：左侧栏 + 右侧内容（与 React 原型稿一致） ════ */
.gate-shell {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 1rem;
  padding: 1.25rem;
  align-items: stretch;
}

.gate-sidebar {
  width: 176px;
  flex-shrink: 0;
}

.sidebar-card {
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
  padding: 0.5rem;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding-top: 0.25rem;
}

.sidebar-item {
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
  color: #64748b;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s;
}

.sidebar-item:hover {
  background: #f8fafc;
  color: #475569;
}

.sidebar-item.active {
  background: #eef0f8;
  color: #6b7bdb;
}

.sidebar-icon {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.sidebar-icon :deep(svg) {
  display: block;
}

/* ─── 右侧内容卡 ─── */
.gate-content {
  flex: 1;
  min-width: 0;
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
  padding: 1.5rem;
  overflow-y: auto;
}

.tab-content {
  animation: fadeIn 0.25s;
}

.tab-head h4 {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
  margin-bottom: 0.125rem;
}

.tab-hint {
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.6;
  margin-bottom: 1rem;
}

.sub-section {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid #f8fafc;
}

.sub-section h4 {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
  margin-bottom: 0.25rem;
}

/* ─── 管理员信息卡 ─── */
.admin-info-card {
  background: linear-gradient(135deg, #6b7bdb 0%, #6c69c2 100%);
  color: white;
  border-radius: 12px;
  padding: 0.875rem 1.25rem;
  margin-bottom: 1rem;
}

.admin-info {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.admin-label {
  font-weight: 600;
  font-size: 0.95rem;
  flex-shrink: 0;
}

.admin-address {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: rgba(255, 255, 255, 0.2);
  padding: 0.4rem 0.875rem;
  border-radius: 8px;
  flex: 1;
  font-size: 0.85rem;
  word-break: break-all;
}

.admin-info .btn-danger {
  color: white;
  border-color: rgba(255, 255, 255, 0.4);
  background: rgba(255, 255, 255, 0.12);
  margin-left: 0;
}

.admin-info .btn-danger:hover {
  background: rgba(255, 255, 255, 0.22);
}

/* ─── Docker 状态 ─── */
.docker-status-card {
  padding: 0.875rem 1.25rem;
  border-radius: 12px;
  margin-bottom: 1rem;
  transition: all 0.3s;
  color: white;
}

.docker-status-card.docker-ok {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
}

.docker-status-card.docker-error {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
}

.docker-status {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.status-icon {
  font-size: 1.5rem;
}

.status-info {
  flex: 1;
}

.status-label {
  font-weight: 600;
  font-size: 0.85rem;
  opacity: 0.9;
}

.status-text {
  font-size: 1.05rem;
  font-weight: 700;
}

.status-hint {
  font-size: 0.85rem;
  opacity: 0.9;
  margin-top: 0.25rem;
  flex: 1;
  text-align: right;
}

/* ─── 操作按钮行 ─── */
.action-buttons {
  display: flex;
  gap: 0.75rem;
  margin: 1rem 0;
  flex-wrap: wrap;
}

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

.ops-cell {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
  align-items: center;
}

.ops-cell .btn {
  margin-right: 0;
  padding: 0.25rem 0.625rem;
  font-size: 0.8rem;
}

.badge-secondary {
  background: #64748b;
  color: white;
}

/* ─── CWT 授权管理 ─── */
.cwt-mono {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.82rem;
}

.cwt-empty {
  color: #94a3b8;
  padding: 0.6rem 0;
  font-size: 0.875rem;
}

.cwt-token-preview {
  margin-top: 0.4rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.72rem;
  background: #f8fafc;
  border-radius: 8px;
  padding: 0.4rem;
  word-break: break-all;
  max-width: 420px;
  border: 1px solid #f1f5f9;
}

/* ─── 孤儿数据卷 ─── */
.orphan-notice {
  margin-top: 0.6rem;
  font-size: 0.85rem;
  color: #475569;
}

.orphan-list {
  margin-top: 0.6rem;
  list-style: none;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;
}

.orphan-item {
  padding: 0.25rem 0.4rem;
  border-bottom: 1px dashed #f1f5f9;
}

.orphan-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  word-break: break-all;
}
</style>
