<template>
  <div class="mobile-home">
    <!-- 顶部渐变头部 -->
    <div class="home-header">
      <div class="welcome-card">
        <div class="welcome-text">
          <div class="greeting">{{ greeting }}</div>
          <div class="address">{{ shortAddr }}</div>
        </div>
        <div class="role-badge" :class="role">
          {{ role === 'admin' ? '管理员' : '用户' }}
        </div>
      </div>
    </div>

    <!-- 快捷操作 -->
    <div class="quick-actions">
      <div class="action-item" @click="$router.push('/mobile/container')">
        <div class="action-icon">📦</div>
        <div class="action-label">容器管理</div>
      </div>
      <div class="action-item" @click="$router.push('/mobile/skills')">
        <div class="action-icon">🎯</div>
        <div class="action-label">技能市场</div>
      </div>
      <div class="action-item" @click="$router.push('/mobile/approvals')">
        <div class="action-icon">✅</div>
        <div class="action-label">审批中心</div>
      </div>
      <div class="action-item" @click="$router.push('/mobile/me')">
        <div class="action-icon">👤</div>
        <div class="action-label">我的</div>
      </div>
    </div>

    <!-- 容器状态卡片 -->
    <div class="card" v-if="containerStatus">
      <div class="card-header">
        <div class="card-title">容器状态</div>
        <div class="status-badge" :class="containerStatus.status">
          {{ statusText(containerStatus.status) }}
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-label">内存</div>
          <div class="stat-value">{{ containerStatus.memory || '-' }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">CPU</div>
          <div class="stat-value">{{ containerStatus.cpu || '-' }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">磁盘</div>
          <div class="stat-value">{{ containerStatus.disk || '-' }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">运行时间</div>
          <div class="stat-value">{{ containerStatus.uptime || '-' }}</div>
        </div>
      </div>
    </div>

    <!-- 管理员功能入口 -->
    <div class="card" v-if="role === 'admin'">
      <div class="card-header">
        <div class="card-title">管理功能</div>
      </div>
      <div class="admin-links">
        <router-link to="/mobile/admin/users" class="admin-link">
          <span class="link-icon">👥</span>
          <span class="link-text">用户管理</span>
          <span class="link-arrow">›</span>
        </router-link>
        <router-link to="/mobile/admin/quota" class="admin-link">
          <span class="link-icon">⚙️</span>
          <span class="link-text">配额配置</span>
          <span class="link-arrow">›</span>
        </router-link>
        <router-link to="/mobile/admin/monitor" class="admin-link">
          <span class="link-icon">📊</span>
          <span class="link-text">资源监控</span>
          <span class="link-arrow">›</span>
        </router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'

const address = ref('')
const role = ref('user')
const containerStatus = ref(null)

const shortAddr = computed(() => {
  const a = address.value
  return a ? `${a.slice(0, 12)}…${a.slice(-4)}` : ''
})

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
})

function statusText(status) {
  const map = {
    running: '运行中',
    stopped: '已停止',
    creating: '创建中',
    unknown: '未知',
  }
  return map[status] || status
}

async function loadUserInfo() {
  try {
    const res = await axios.get('/api/user/credential-status')
    address.value = res.data.address || ''
    role.value = res.data.role || 'user'
  } catch (e) {
    console.error('加载用户信息失败:', e)
  }
}

async function loadContainerStatus() {
  if (!address.value) return
  try {
    const res = await axios.get(`/connect-status?address=${encodeURIComponent(address.value)}`)
    containerStatus.value = res.data
  } catch (e) {
    console.error('加载容器状态失败:', e)
  }
}

onMounted(async () => {
  await loadUserInfo()
  await loadContainerStatus()
})
</script>

<style scoped>
.mobile-home {
  padding: 0 0 20px;
}

.home-header {
  background: linear-gradient(135deg, #6a72e8 0%, #9b8cf5 100%);
  padding: 20px 16px 24px;
  margin-bottom: 16px;
}

.welcome-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.welcome-text {
  color: #fff;
}

.greeting {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 4px;
}

.address {
  font-size: 13px;
  opacity: 0.9;
  font-family: 'SF Mono', Monaco, monospace;
}

.role-badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}

.role-badge.admin {
  background: rgba(255, 255, 255, 0.3);
}

.quick-actions {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  padding: 0 16px;
  margin-bottom: 16px;
}

.action-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 8px;
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  cursor: pointer;
  transition: transform 0.2s;
}

.action-item:active {
  transform: scale(0.95);
}

.action-icon {
  font-size: 32px;
}

.action-label {
  font-size: 12px;
  color: #4b5162;
  font-weight: 500;
}

.card {
  background: #fff;
  margin: 0 16px 16px;
  padding: 16px;
  border-radius: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: #20242f;
}

.status-badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.status-badge.running {
  background: #e6f7ee;
  color: #1fa05c;
}

.status-badge.stopped {
  background: #fdecec;
  color: #e5484d;
}

.status-badge.creating {
  background: #fff4e3;
  color: #e8930c;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-label {
  font-size: 12px;
  color: #8a90a3;
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
  color: #20242f;
}

.admin-links {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.admin-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: #f4f5fa;
  border-radius: 12px;
  text-decoration: none;
  transition: background 0.2s;
}

.admin-link:active {
  background: #eceef4;
}

.link-icon {
  font-size: 20px;
}

.link-text {
  flex: 1;
  font-size: 14px;
  color: #20242f;
  font-weight: 500;
}

.link-arrow {
  font-size: 20px;
  color: #8a90a3;
}
</style>
