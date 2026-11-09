<template>
  <div class="mobile-approvals">
    <!-- Loading 状态 -->
    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">加载中...</div>
    </div>

    <template v-else>
      <!-- 头部 -->
      <div class="ghead">
        <div class="row1">
          <div class="ttl">审批中心</div>
          <div class="avatar">管</div>
        </div>
        <div class="greet">管理各类审批申请</div>
      </div>

      <!-- 主体内容 -->
      <div class="body">
        <!-- 审批类型切换 -->
        <div class="type-tabs">
          <button
            class="type-tab"
            :class="{ active: approvalType === 'cwt' }"
            @click="switchType('cwt')"
          >
            CWT 申请
            <span v-if="pendingCount > 0" class="tab-dot"></span>
          </button>
          <button
            class="type-tab"
            :class="{ active: approvalType === 'env' }"
            @click="switchType('env')"
          >
            环境模板
            <span v-if="draftCount > 0" class="tab-dot"></span>
          </button>
        </div>

        <!-- CWT 申请 -->
        <template v-if="approvalType === 'cwt'">
          <!-- 状态筛选 -->
          <div class="filter-bar">
            <button
              v-for="status in statuses"
              :key="status.key"
              class="filter-btn"
              :class="{ active: currentStatus === status.key }"
              @click="switchStatus(status.key)"
            >
              {{ status.label }}
            </button>
          </div>

          <!-- 申请列表 -->
          <div v-if="applications.length === 0" class="empty-state">
            <div class="empty-icon">📋</div>
            <div class="empty-text">暂无{{ currentStatusLabel }}的申请</div>
          </div>

          <div v-else class="app-list">
            <div v-for="app in applications" :key="app._id" class="app-card">
              <div class="app-info">
                <div class="app-address">
                  {{ shortAddress(app.addressDisplay || app.address) }}
                </div>
                <div class="app-time">提交于 {{ formatDate(app.submittedAt) }}</div>
                <div v-if="app.decidedAt" class="app-decided">
                  {{ statusLabel(app.status) }}于 {{ formatDate(app.decidedAt) }}
                </div>
                <div v-if="app.rejectReason" class="app-reason">
                  拒绝原因：{{ app.rejectReason }}
                </div>
              </div>
              <div class="app-actions">
                <span class="badge" :class="statusClass(app.status)">
                  {{ statusLabel(app.status) }}
                </span>
                <div v-if="app.status === 'pending'" class="action-btns">
                  <button
                    class="btn btn-sm btn-green"
                    @click="approveApp(app)"
                    :disabled="busy === app._id"
                  >
                    {{ busy === app._id ? '处理中...' : '批准' }}
                  </button>
                  <button
                    class="btn btn-sm btn-red"
                    @click="rejectApp(app)"
                    :disabled="busy === app._id"
                  >
                    拒绝
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 分页 -->
          <div v-if="total > 10" class="pagination">
            <button class="btn btn-sm btn-outline" :disabled="offset === 0" @click="prevPage">
              上一页
            </button>
            <span class="page-info"
              >{{ offset + 1 }}-{{ Math.min(offset + 10, total) }} / {{ total }}</span
            >
            <button
              class="btn btn-sm btn-outline"
              :disabled="offset + 10 >= total"
              @click="nextPage"
            >
              下一页
            </button>
          </div>
        </template>

        <!-- 环境模板 -->
        <template v-else-if="approvalType === 'env'">
          <!-- 状态筛选 -->
          <div class="filter-bar">
            <button
              v-for="status in envStatuses"
              :key="status.key"
              class="filter-btn"
              :class="{ active: currentEnvStatus === status.key }"
              @click="switchEnvStatus(status.key)"
            >
              {{ status.label }}
            </button>
          </div>

          <!-- 模板列表 -->
          <div v-if="environments.length === 0" class="empty-state">
            <div class="empty-icon">🌍</div>
            <div class="empty-text">暂无{{ currentEnvStatusLabel }}的模板</div>
          </div>

          <div v-else class="app-list">
            <div v-for="env in environments" :key="env._id" class="app-card">
              <div class="app-info">
                <div class="app-address">
                  {{ env.name }}
                </div>
                <div class="app-time">来源：{{ shortAddress(env.sourceAddr) }}</div>
                <div class="app-time">大小：{{ formatBytes(env.sizeBytes) }}</div>
                <div v-if="env.createdAt" class="app-time">
                  创建于 {{ formatDate(env.createdAt) }}
                </div>
                <div v-if="env.rejectReason" class="app-reason">
                  拒绝原因：{{ env.rejectReason }}
                </div>
              </div>
              <div class="app-actions">
                <span class="badge" :class="envStatusClass(env.status)">
                  {{ envStatusLabel(env.status) }}
                </span>
                <div v-if="env.status === 'draft'" class="action-btns">
                  <button
                    class="btn btn-sm btn-green"
                    @click="publishEnv(env)"
                    :disabled="busy === env._id"
                  >
                    {{ busy === env._id ? '处理中...' : '发布' }}
                  </button>
                  <button
                    class="btn btn-sm btn-red"
                    @click="rejectEnv(env)"
                    :disabled="busy === env._id"
                  >
                    驳回
                  </button>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import { requestAccounts, signMessage, getPublicKey } from '../../api/wallet.js'
import { useAdminBadges, refreshIfWatching } from '../../composables/useAdminBadges.js'

const { badgeFor } = useAdminBadges()

const loading = ref(true)
const approvalType = ref('cwt') // 'cwt' | 'env'

// 使用 composable 的红点数据
const pendingCount = computed(() => badgeFor('cred'))
const draftCount = computed(() => badgeFor('envtpl'))

// CWT 申请相关
const applications = ref([])
const total = ref(0)
const offset = ref(0)
const currentStatus = ref('pending')
const busy = ref('')

const statuses = [
  { key: 'pending', label: '待审批' },
  { key: 'approved', label: '已批准' },
  { key: 'rejected', label: '已拒绝' },
]

const currentStatusLabel = ref('待审批')

// 环境模板相关
const environments = ref([])
const currentEnvStatus = ref('draft')

const envStatuses = [
  { key: 'draft', label: '待审核' },
  { key: 'published', label: '已发布' },
  { key: 'rejected', label: '已驳回' },
]

const currentEnvStatusLabel = ref('待审核')

function shortAddress(addr) {
  return addr ? `${addr.slice(0, 10)}…${addr.slice(-4)}` : ''
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleString()
}

function statusLabel(status) {
  const labels = {
    pending: '待审批',
    approved: '已批准',
    rejected: '已拒绝',
  }
  return labels[status] || status
}

function statusClass(status) {
  const classes = {
    pending: 'b-orange',
    approved: 'b-green',
    rejected: 'b-red',
  }
  return classes[status] || ''
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
}

function envStatusLabel(status) {
  const labels = {
    draft: '待审核',
    published: '已发布',
    rejected: '已驳回',
    revoked: '已撤销',
  }
  return labels[status] || status
}

function envStatusClass(status) {
  const classes = {
    draft: 'b-orange',
    published: 'b-green',
    rejected: 'b-red',
    revoked: 'b-gray',
  }
  return classes[status] || ''
}

function switchType(type) {
  approvalType.value = type
  if (type === 'cwt') {
    loadApplications()
  } else if (type === 'env') {
    loadEnvironments()
  }
}

async function loadApplications() {
  loading.value = true
  try {
    const res = await axios.get('/api/admin/cwt-applications', {
      params: {
        status: currentStatus.value,
        limit: 10,
        offset: offset.value,
      },
    })
    applications.value = res.data.applications || []
    total.value = res.data.total || 0
  } catch (e) {
    console.error('加载申请列表失败:', e)
    alert('加载失败: ' + (e.response?.data?.error || e.message))
  } finally {
    loading.value = false
  }
}

function switchStatus(status) {
  currentStatus.value = status
  offset.value = 0
  currentStatusLabel.value = statuses.find((s) => s.key === status)?.label || ''
  loadApplications()
}

function prevPage() {
  offset.value = Math.max(0, offset.value - 10)
  loadApplications()
}

function nextPage() {
  offset.value += 10
  loadApplications()
}

async function signAdminOperation(operation, payload) {
  // 获取钱包地址
  const pluginAddress = await requestAccounts()
  
  // 调用 challenge 接口
  const chalRes = await axios.post('/api/admin/challenge', {
    address: pluginAddress.toLowerCase(),
    operation,
    payload,
  })
  
  const { message, nonce } = chalRes.data
  
  // 签名
  const signature = await signMessage(pluginAddress, message)
  const publicKey = await getPublicKey(pluginAddress)
  
  const sigStr = typeof signature === 'string' ? signature : (signature?.signature ?? '')
  
  return {
    'x-admin-nonce': nonce,
    'x-admin-signature': sigStr,
    'x-admin-pubkey': publicKey,
  }
}

async function approveApp(app) {
  if (!confirm(`确定要批准地址 ${shortAddress(app.address)} 的 CWT 解限申请吗？`)) return

  busy.value = app._id
  try {
    const headers = await signAdminOperation('cwt/approve', {
      id: app._id,
      address: app.address,
    })
    await axios.post(
      `/api/admin/cwt-applications/${encodeURIComponent(app._id)}/approve`,
      {},
      { headers },
    )
    alert('已批准')
    await loadApplications()
    refreshIfWatching()
  } catch (e) {
    console.error('批准失败:', e)
    alert('批准失败: ' + (e.response?.data?.error || e.message))
  } finally {
    busy.value = ''
  }
}

async function rejectApp(app) {
  const reason = prompt('请输入拒绝原因（可选）：')
  if (reason === null) return // 用户取消

  busy.value = app._id
  try {
    const headers = await signAdminOperation('cwt/reject', {
      id: app._id,
      address: app.address,
    })
    await axios.post(
      `/api/admin/cwt-applications/${encodeURIComponent(app._id)}/reject`,
      { reason },
      { headers },
    )
    alert('已拒绝')
    await loadApplications()
    refreshIfWatching()
  } catch (e) {
    console.error('拒绝失败:', e)
    alert('拒绝失败: ' + (e.response?.data?.error || e.message))
  } finally {
    busy.value = ''
  }
}

// 环境模板相关函数
async function loadEnvironments() {
  loading.value = true
  try {
    const res = await axios.get('/api/admin/environments')
    const allEnvs = res.data.environments || []

    // 根据状态筛选
    environments.value = allEnvs.filter((env) => env.status === currentEnvStatus.value)
  } catch (e) {
    console.error('加载环境模板列表失败:', e)
    alert('加载失败: ' + (e.response?.data?.error || e.message))
  } finally {
    loading.value = false
  }
}

function switchEnvStatus(status) {
  currentEnvStatus.value = status
  currentEnvStatusLabel.value = envStatuses.find((s) => s.key === status)?.label || ''
  loadEnvironments()
}

async function publishEnv(env) {
  if (!confirm(`确定要发布环境模板 "${env.name}" 吗？`)) return

  busy.value = env._id
  try {
    const headers = await signAdminOperation('env-publish', { id: env._id })
    await axios.post('/api/admin/env-publish', { id: env._id }, { headers })
    alert('已发布')
    await loadEnvironments()
    refreshIfWatching()
  } catch (e) {
    console.error('发布失败:', e)
    alert('发布失败: ' + (e.response?.data?.error || e.message))
  } finally {
    busy.value = ''
  }
}

async function rejectEnv(env) {
  const reason = prompt('请输入驳回原因（必填）：')
  if (!reason) {
    alert('驳回原因不能为空')
    return
  }

  busy.value = env._id
  try {
    const headers = await signAdminOperation('env-reject', { id: env._id })
    await axios.post('/api/admin/env-reject', { id: env._id, reason }, { headers })
    alert('已驳回')
    await loadEnvironments()
    refreshIfWatching()
  } catch (e) {
    console.error('驳回失败:', e)
    alert('驳回失败: ' + (e.response?.data?.error || e.message))
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  loadApplications()
})
</script>

<style scoped>
.mobile-approvals {
  min-height: 100vh;
  background: #f4f5fa;
}

/* Loading 状态 */
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
  border-top-color: #6a72e8;
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
  color: #8a90a3;
}

/* 头部 */
.ghead {
  background: linear-gradient(135deg, #6a72e8 0%, #9b8cf5 100%);
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
  font-size: 13px;
  opacity: 0.9;
  line-height: 1.5;
}

/* 主体内容 */
.body {
  padding: 16px;
}

/* 审批类型切换 */
.type-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  background: #fff;
  padding: 8px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
}

.type-tab {
  flex: 1;
  padding: 12px;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  color: #8a90a3;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  position: relative;
}

.type-tab.active {
  background: linear-gradient(135deg, #6a72e8 0%, #9b8cf5 100%);
  color: #fff;
  box-shadow: 0 2px 8px rgba(106, 114, 232, 0.3);
}

/* 状态筛选 */
.filter-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  background: #fff;
  padding: 8px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
}

.filter-btn {
  flex: 1;
  padding: 10px;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  color: #8a90a3;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.filter-btn.active {
  background: linear-gradient(135deg, #6a72e8 0%, #9b8cf5 100%);
  color: #fff;
  box-shadow: 0 2px 8px rgba(106, 114, 232, 0.3);
}

.tab-dot {
  width: 8px;
  height: 8px;
  background: #ff4757;
  border-radius: 50%;
  display: inline-block;
  margin-left: 4px;
  vertical-align: middle;
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 60px 20px;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
}

.empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.empty-text {
  font-size: 14px;
  color: #8a90a3;
}

/* 申请列表 */
.app-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.app-card {
  background: #fff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
}

.app-info {
  margin-bottom: 12px;
}

.app-address {
  font-size: 15px;
  font-weight: 700;
  color: #20242f;
  margin-bottom: 6px;
  font-family: 'SF Mono', Monaco, monospace;
}

.app-time {
  font-size: 12px;
  color: #8a90a3;
  margin-bottom: 4px;
}

.app-decided {
  font-size: 12px;
  color: #6a72e8;
  margin-bottom: 4px;
}

.app-reason {
  font-size: 12px;
  color: #ff4757;
  margin-top: 8px;
  padding: 8px;
  background: #fff5f5;
  border-radius: 6px;
}

.app-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.action-btns {
  display: flex;
  gap: 8px;
}

/* 徽章 */
.badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.b-orange {
  background: #fff4e3;
  color: #e8930c;
}

.b-green {
  background: #e6f7ee;
  color: #1fa05c;
}

.b-red {
  background: #ffe6e6;
  color: #ff4757;
}

.b-gray {
  background: #f0f0f0;
  color: #8a90a3;
}

/* 按钮 */
.btn {
  padding: 10px 20px;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 8px 16px;
  font-size: 13px;
}

.btn-green {
  background: #1fa05c;
  color: #fff;
}

.btn-red {
  background: #ff4757;
  color: #fff;
}

.btn-outline {
  background: #fff;
  color: #6a72e8;
  border: 1px solid #6a72e8;
}

.btn:active:not(:disabled) {
  transform: scale(0.98);
}

/* 分页 */
.pagination {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
  padding: 16px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
}

.page-info {
  font-size: 13px;
  color: #8a90a3;
}
</style>
