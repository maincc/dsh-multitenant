<template>
  <div class="admin-panel">
    <!-- 无权限页面 -->
    <div v-if="notAdmin" class="card error-card">
      <h2>🚫 无权限访问</h2>
      <p>您当前连接的地址不是管理员</p>
      <p class="address-display">{{ currentAddress }}</p>
      <button class="btn btn-primary" @click="switchWallet">切换钱包</button>
    </div>

    <!-- 管理员登录 -->
    <div v-else-if="!isAdmin" class="card login-card">
      <h2>🔐 管理员登录</h2>
      <p>请使用管理员地址登录</p>

      <div v-if="!hasCCDAO" class="error">
        未检测到 CCDAO 插件
        <br />
        <a
          href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
          target="_blank"
        >
          点击安装 CCDAO Connector
        </a>
      </div>

      <div v-else>
        <div v-if="currentAddress" class="current-address">
          <p>当前地址：</p>
          <span class="address-display">{{ currentAddress }}</span>
        </div>
        <button class="btn btn-primary btn-large" @click="adminLogin" :disabled="logging">
          {{ logging ? '登录中...' : '使用 CCDAO 登录' }}
        </button>
        <div v-if="loginError" class="error" style="margin-top: 1rem">{{ loginError }}</div>
      </div>
    </div>

    <!-- 管理面板 -->
    <div v-else>
      <!-- 当前管理员信息 -->
      <div class="card admin-info-card">
        <div class="admin-info">
          <div class="admin-label">👤 当前地址：</div>
          <div class="admin-address">{{ currentAddress || currentAdminAddress }}</div>
          <button class="btn btn-small btn-danger" @click="logout">退出登录</button>
        </div>
      </div>

      <div class="card">
        <h2>📊 系统概览</h2>
        <div class="stats-grid">
          <div class="stat-card">
            <h3>总用户数</h3>
            <div class="value">{{ stats.totalUsers }}</div>
          </div>
          <div class="stat-card">
            <h3>运行中</h3>
            <div class="value">{{ stats.runningUsers }}</div>
          </div>
          <div class="stat-card">
            <h3>基础配额</h3>
            <div class="value">{{ stats.tierCounts[1] || 0 }}</div>
          </div>
          <div class="stat-card">
            <h3>增强配额</h3>
            <div class="value">{{ stats.tierCounts[2] || 0 }}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>👥 用户列表</h2>
        <div v-if="loading" class="loading">加载中...</div>
        <div v-else-if="error" class="error">{{ error }}</div>
        <table v-else>
          <thead>
            <tr>
              <th>SWTC 地址</th>
              <th>端口</th>
              <th>配额</th>
              <th>状态</th>
              <th>内存使用</th>
              <th>空闲时间</th>
              <th>角色</th>
              <th>操作</th>
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
                <span v-if="user.isAdmin" class="badge badge-success">管理员</span>
                <span v-else class="badge badge-info">普通用户</span>
              </td>
              <td>
                <button
                  class="btn btn-primary"
                  @click="upgradeUser(user.address, user.tier + 1)"
                  :disabled="user.tier >= 3"
                >
                  升级
                </button>
                <button
                  class="btn btn-success"
                  @click="downgradeUser(user.address, user.tier - 1)"
                  :disabled="user.tier <= 1"
                >
                  降级
                </button>
                <button
                  v-if="!user.isAdmin"
                  class="btn btn-warning"
                  @click="promoteUser(user.address)"
                >
                  提权
                </button>
                <a :href="`http://127.0.0.1:${user.port}/`" target="_blank" class="btn btn-info">
                  访问
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>⚙️ 配额配置</h2>
        <table>
          <thead>
            <tr>
              <th>层级</th>
              <th>内存</th>
              <th>CPU</th>
              <th>进程数</th>
              <th>Swap</th>
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
              <td>{{ limits.cpus }} 核</td>
              <td>{{ limits.pids }}</td>
              <td>{{ limits.memorySwap }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import axios from 'axios'

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
let dataRefreshInterval = null

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
        alert('钱包已断开连接，已退出管理面板')
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

        // 检查新地址是否是管理员
        try {
          const res = await axios.post('/api/admin/login', { address: newAddress })
          if (res.data.ok) {
            currentAdminAddress.value = newAddress
            isAdmin.value = true
            notAdmin.value = false
            await fetchData()
            alert(`已切换到管理员：${newAddress.slice(0, 10)}...`)
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
          console.error('[AdminPanel] 验证新地址失败:', err)
        }
      }
    })
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
      throw new Error('未获取到账户')
    }

    // 统一转小写
    const address = accounts[0].toLowerCase()
    currentAddress.value = address

    // 直接调用登录 API，后端会检查是否是管理员
    const res = await axios.post('/api/admin/login', { address })
    if (res.data.ok) {
      // 是管理员，登录成功
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
      loginError.value = err.response?.data?.error || '登录失败：' + err.message
    }
  } finally {
    logging.value = false
  }
}

const switchWallet = () => {
  // 提示用户切换钱包
  alert('请在 CCDAO 插件中切换到管理员地址')
}

const logout = () => {
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
    error.value = '加载数据失败: ' + err.message
  } finally {
    loading.value = false
  }
}

const upgradeUser = async (address, tier) => {
  if (tier > 3) return
  try {
    await axios.post(`/api/upgrade/${address}`, { tier })
    await fetchData()
    alert('升级成功！')
  } catch (err) {
    alert('升级失败: ' + (err.response?.data?.error || err.message))
  }
}

const downgradeUser = async (address, tier) => {
  if (tier < 1) return
  try {
    await axios.post(`/api/upgrade/${address}`, { tier })
    await fetchData()
    alert('降级成功！')
  } catch (err) {
    alert('降级失败: ' + (err.response?.data?.error || err.message))
  }
}

const promoteUser = async (address) => {
  if (!confirm(`确定要将 ${address.slice(0, 10)}... 提升为管理员吗？`)) return
  try {
    await axios.post(`/api/admin/promote/${address}`)
    await fetchData()
    alert('提权成功！')
  } catch (err) {
    alert('提权失败: ' + (err.response?.data?.error || err.message))
  }
}

const tierBadge = (tier) => {
  const map = { 1: 'badge-info', 2: 'badge-warning', 3: 'badge-success' }
  return map[tier] || 'badge-info'
}

const statusBadge = (status) => {
  const map = { running: 'badge-success', stopped: 'badge-warning', destroyed: 'badge-danger' }
  return map[status] || 'badge-info'
}

const statusText = (status) => {
  const map = { running: '运行中', stopped: '已停止', destroyed: '已销毁' }
  return map[status] || status
}

const formatIdle = (ms) => {
  if (ms < 60000) return `${Math.floor(ms / 1000)}秒`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}分钟`
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}小时`
  return `${(ms / 86400000).toFixed(1)}天`
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
</style>
