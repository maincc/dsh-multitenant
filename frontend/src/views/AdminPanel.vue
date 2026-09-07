<template>
  <div class="admin-panel">
    <!-- 无权限页面 -->
    <div v-if="notAdmin" class="card error-card">
      <h2>{{ $t('admin.noAccess') }}</h2>
      <p>{{ $t('admin.noAccessHint') }}</p>
      <p class="address-display">{{ currentAddress }}</p>
      <button class="btn btn-primary" @click="switchWallet">{{ $t('admin.switchWallet') }}</button>
    </div>

    <!-- 管理员登录 -->
    <div v-else-if="!isAdmin" class="card login-card">
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

    <!-- 管理面板 -->
    <div v-else>
      <!-- 当前管理员信息 -->
      <div class="card admin-info-card">
        <div class="admin-info">
          <div class="admin-label">{{ $t('admin.currentAdminLabel') }}</div>
          <div class="admin-address">{{ currentAddress || currentAdminAddress }}</div>
          <button class="btn btn-small btn-danger" @click="logout">{{ $t('admin.logout') }}</button>
        </div>
      </div>

      <!-- Docker 状态指示器 -->
      <div class="card docker-status-card" :class="dockerAvailable ? 'docker-ok' : 'docker-error'">
        <div class="docker-status">
          <div class="status-icon">{{ dockerAvailable ? '' : '' }}</div>
          <div class="status-info">
            <div class="status-label">{{ $t('admin.dockerStatus') }}</div>
            <div class="status-text">
              {{ dockerAvailable ? $t('admin.running') : $t('admin.notRunning') }}
            </div>
          </div>
          <div v-if="!dockerAvailable" class="status-hint">{{ $t('admin.dockerHint') }}</div>
        </div>
      </div>

      <!-- 合并重复地址按钮 -->
      <div class="card merge-card">
        <div class="merge-info">
          <div class="merge-icon">🔧</div>
          <div class="merge-text">
            <div class="merge-label">{{ $t('admin.mergeTitle') }}</div>
            <div class="merge-hint">{{ $t('admin.mergeHint') }}</div>
          </div>
          <button class="btn btn-warning" @click="mergeDuplicates">
            {{ $t('admin.mergeBtn') }}
          </button>
        </div>
      </div>

      <div class="card">
        <h2>{{ $t('admin.overview') }}</h2>
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
      </div>

      <div class="card">
        <h2>{{ $t('admin.userList') }}</h2>
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
                  :href="webUrl(user.port)"
                  target="_blank"
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
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>{{ $t('admin.tierConfig') }}</h2>
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

      <div class="card">
        <h2>{{ $t('admin.cwtManage') }}</h2>
        <p>{{ $t('admin.cwtManageHint') }}</p>

        <h3>{{ $t('admin.cwtPending') }}</h3>
        <div v-if="cwtLoading" class="config-loading">
          <span>{{ $t('admin.cwtLoading') }}</span>
        </div>
        <table v-else-if="cwtApplications.length">
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

        <h3>{{ $t('admin.cwtRegistry') }}</h3>
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

        <h3>{{ $t('admin.cwtRecords') }}</h3>
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
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

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

// 租户 DSH 实例地址：用当前访问入口页的 host 拼端口（不再硬编码 127.0.0.1）
const webUrl = (port) => `http://${window.location.hostname}:${port}/`

const checkCCDAO = () => {
  hasCCDAO.value = typeof window.ccdao !== 'undefined'
}

// 监听账户变化事件
const setupAccountChangeListener = () => {
  if (!hasCCDAO.value) return

  // CCDAO 插件使用 ethereum 对象监听事件
  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on('swtcAccountsChanged', async (accounts) => {
      console.log('[AdminPanel] 检测到账户变化:', accounts)

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

      const newAddress = accounts[0].toLowerCase()
      currentAddress.value = newAddress

      if (newAddress !== currentAdminAddress.value) {
        console.log(`[AdminPanel] 地址切换：${currentAdminAddress.value} -> ${newAddress}`)

        // 新地址需要重新钱包签名登录（会话与地址绑定，P0-1）
        try {
          const res = await signLogin(newAddress)
          if (res.data.ok) {
            const address = res.data.address
            currentAdminAddress.value = address
            isAdmin.value = true
            notAdmin.value = false
            await fetchData()
            alert(t('admin.switchedAdmin', { addr: `${address.slice(0, 10)}...` }))
          } else {
            // 新地址不是管理员，显示无权限
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
            console.error('[AdminPanel] 验证新地址失败:', err)
          }
        }
      }
    })
  }
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
  const signature = await window.ccdao.request({
    method: 'swtc_signMessage',
    params: [pluginAddress, nonce],
  })
  const publicKey = await window.ccdao.request({
    method: 'swtc_getPublicKey',
    params: [pluginAddress],
  })
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
    const accounts = await window.ccdao.request({
      method: 'swtc_requestAccounts',
      params: [],
    })

    if (!accounts || accounts.length === 0) {
      throw new Error(t('admin.noAccounts'))
    }

    // 插件原始大小写地址（用于签名）；展示用小写
    const pluginAddress = accounts[0]
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

  try {
    await axios.post(`/api/user/${address}/remove`)
    await fetchData()
    alert(t('admin.removedOk'))
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
    const accounts = await window.ccdao.request({
      method: 'swtc_requestAccounts',
      params: [],
    })
    if (accounts && accounts.length > 0) {
      currentAddress.value = accounts[0].toLowerCase()
    }
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
  }
})
</script>

<style scoped>
.admin-panel {
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

.admin-info-card {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.admin-info {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.admin-label {
  font-weight: 600;
  font-size: 1.1rem;
}

.admin-address {
  font-family: monospace;
  background: rgba(255, 255, 255, 0.2);
  padding: 0.5rem 1rem;
  border-radius: 4px;
  flex: 1;
}

.btn-danger {
  background: #dc2626;
  color: white;
}

.btn-danger:hover {
  background: #b91c1c;
}

.docker-status-card {
  padding: 1rem 1.5rem;
  transition: all 0.3s;
}

.docker-status-card.docker-ok {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  color: white;
}

.docker-status-card.docker-error {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: white;
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
  font-size: 0.9rem;
  opacity: 0.9;
}

.status-text {
  font-size: 1.1rem;
  font-weight: 700;
}

.status-hint {
  font-size: 0.85rem;
  opacity: 0.9;
  margin-top: 0.25rem;
}

.login-card {
  text-align: center;
  padding: 3rem;
  max-width: 500px;
  margin: 2rem auto;
}

.login-card h2 {
  margin-bottom: 1rem;
}

.login-card p {
  color: #666;
  margin-bottom: 2rem;
}

.error-card {
  text-align: center;
  padding: 3rem;
  max-width: 500px;
  margin: 2rem auto;
}

.error-card h2 {
  margin-bottom: 1rem;
  color: #dc2626;
}

.error-card p {
  color: #666;
  margin-bottom: 1rem;
}

.address-display {
  font-family: monospace;
  background: #f3f4f6;
  padding: 0.5rem;
  border-radius: 4px;
  word-break: break-all;
  margin-bottom: 2rem;
}

.btn-large {
  padding: 0.75rem 2rem;
  font-size: 1.1rem;
}

table {
  font-size: 0.9rem;
}

.btn {
  margin-right: 0.5rem;
  text-decoration: none;
  display: inline-block;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-warning {
  background: #f59e0b;
  color: white;
}

.btn-warning:hover {
  background: #d97706;
}

.btn-info {
  background: #3b82f6;
  color: white;
}

.btn-info:hover {
  background: #2563eb;
}

.btn-danger {
  background: #dc2626;
  color: white;
}

.btn-danger:hover {
  background: #b91c1c;
}

.badge-secondary {
  background: #6b7280;
  color: white;
}

.current-address {
  margin-bottom: 1.5rem;
}

.current-address p {
  color: #666;
  margin-bottom: 0.5rem;
  font-size: 0.9rem;
}

.address-display {
  font-family: monospace;
  background: #f3f4f6;
  padding: 0.5rem;
  border-radius: 4px;
  word-break: break-all;
  display: block;
  font-size: 0.85rem;
}

/* ---- CWT 授权管理（M1） ---- */
.cwt-mono {
  font-family: monospace;
  font-size: 0.82rem;
}

.cwt-empty {
  color: #888;
  padding: 0.6rem 0;
  font-size: 0.9rem;
}

.cwt-token-preview {
  margin-top: 0.4rem;
  font-family: monospace;
  font-size: 0.72rem;
  background: #f3f4f6;
  border-radius: 4px;
  padding: 0.4rem;
  word-break: break-all;
  max-width: 420px;
}

.card h3 {
  margin-top: 1.2rem;
  margin-bottom: 0.4rem;
  font-size: 0.95rem;
  color: #444;
}
</style>
