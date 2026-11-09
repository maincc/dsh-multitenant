<template>
  <!-- 未登录状态 -->
  <div v-if="!isLoggedIn" class="mobile-home login-state">
    <div class="login-card">
      <div class="login-icon">🔐</div>
      <h2 class="login-title">欢迎使用 DSH</h2>
      <p class="login-desc">请先连接钱包以继续使用</p>
      <button class="login-btn" @click="goToLogin">连接钱包</button>
    </div>
  </div>

  <!-- 已登录状态 -->
  <div v-else class="mobile-home">
    <!-- 顶部头部区域 -->
    <div class="ghead">
      <div class="row1">
        <div class="ttl">DSH 控制台</div>
        <div class="avatar">{{ role === 'admin' ? '管' : '用' }}</div>
      </div>
      <div class="greet">
        {{ role === 'admin' ? '管理员' : '用户' }} · 已连接
        <span class="greet-hint">｜每 300s 自动刷新</span>
      </div>
      <div class="addr-chip" @click="copyAddress">
        <span class="addr-icon">🔑</span>
        <span class="addr-text">{{ shortAddr }}</span>
        <span class="addr-act">退出</span>
      </div>
    </div>

    <!-- 主体内容 -->
    <div class="body">
      <!-- Docker 状态横幅 -->
      <div class="docker-banner">
        <span class="pulse"></span>
        <div class="docker-info">
          <div class="docker-label">Docker 状态</div>
          <div class="docker-value">{{ containerStatus ? '运行中' : '未启动' }}</div>
        </div>
        <span class="docker-icon">🐳</span>
      </div>

      <!-- 统计卡片 -->
      <div class="stat2">
        <div class="stat">
          <div class="sl">总用户数</div>
          <div class="sv">{{ stats.totalUsers || 0 }}</div>
        </div>
        <div class="stat alt">
          <div class="sl">运行中</div>
          <div class="sv">{{ stats.running || 0 }}</div>
        </div>
        <div class="stat alt">
          <div class="sl">基础配额</div>
          <div class="sv">{{ stats.tier1 || 0 }}</div>
        </div>
        <div class="stat">
          <div class="sl">增强配额</div>
          <div class="sv">{{ stats.tier2 || 0 }}</div>
        </div>
      </div>

      <!-- 快捷管理（仅管理员显示） -->
      <div v-if="role === 'admin'" class="sec-t">快捷管理</div>
      <div v-if="role === 'admin'" class="card">
        <div class="qgrid">
          <div class="qitem" @click="$router.push('/user?tab=adm:users')">
            <div class="qi" style="background: #efecff">👥</div>
            <span>用户管理</span>
          </div>
          <div class="qitem" @click="$router.push('/user?tab=adm:quota')">
            <div class="qi" style="background: #eaf0ff">📊</div>
            <span>配额配置</span>
          </div>
          <div class="qitem" @click="$router.push('/user?tab=adm:monitor')">
            <div class="qi" style="background: #e6f7ee">📈</div>
            <span>资源监控</span>
          </div>
          <div class="qitem" @click="$router.push('/user?tab=adm:version')">
            <div class="qi" style="background: #fff4e3">🏷️</div>
            <span>DSH 版本</span>
          </div>
          <div class="qitem" @click="$router.push('/user?tab=adm:model')">
            <div class="qi" style="background: #efecff">🤖</div>
            <span>模型配置</span>
          </div>
          <div class="qitem" @click="$router.push('/user?tab=adm:approval')">
            <div class="qi" style="background: #fdecec">🛡️</div>
            <span>凭证审批</span>
          </div>
          <div class="qitem" @click="$router.push('/user?tab=adm:env-approval')">
            <div class="qi" style="background: #eaf0ff">🗂️</div>
            <span>环境审批</span>
          </div>
          <div class="qitem" @click="$router.push('/user?tab=account')">
            <div class="qi" style="background: #e6f7ee">🪪</div>
            <span>我的凭证</span>
          </div>
        </div>
      </div>

      <!-- 孤儿数据清理（仅管理员显示） -->
      <div v-if="role === 'admin'" class="card">
        <div class="ct">🧹 孤儿数据清理</div>
        <div class="cd">扫描并清理无人使用的残留数据卷（不影响任何在用用户与运行中的容器）</div>
        <button class="btn btn-p" @click="scanOrphanVolumes">扫描孤儿卷</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import axios from 'axios'

const router = useRouter()
const address = ref('')
const role = ref('user')
const containerStatus = ref(null)
const isLoggedIn = ref(false)
const stats = ref({
  totalUsers: 0,
  running: 0,
  tier1: 0,
  tier2: 0,
})

const shortAddr = computed(() => {
  const a = address.value
  return a ? `${a.slice(0, 12)}…${a.slice(-4)}` : ''
})

function copyAddress() {
  if (address.value) {
    navigator.clipboard.writeText(address.value)
    alert('地址已复制到剪贴板')
  }
}

function goToLogin() {
  router.push('/user')
}

async function scanOrphanVolumes() {
  alert('正在扫描孤儿数据卷…')
}

async function checkLoginStatus() {
  try {
    const res = await axios.get('/api/user/credential-status')
    isLoggedIn.value = true
    address.value = res.data.address || ''
    role.value = res.data.role || 'user'
  } catch (e) {
    if (e.response?.status === 401) {
      isLoggedIn.value = false
    } else {
      console.error('检查登录状态失败:', e)
    }
  }
}

async function loadContainerStatus() {
  if (!isLoggedIn.value || !address.value) return
  try {
    const res = await axios.get(`/connect-status?address=${encodeURIComponent(address.value)}`)
    containerStatus.value = res.data
  } catch (e) {
    console.error('加载容器状态失败:', e)
  }
}

async function loadStats() {
  if (!isLoggedIn.value || role.value !== 'admin') return
  try {
    // TODO: 从后端获取统计数据
    stats.value = {
      totalUsers: 11,
      running: 2,
      tier1: 11,
      tier2: 0,
    }
  } catch (e) {
    console.error('加载统计数据失败:', e)
  }
}

onMounted(async () => {
  await checkLoginStatus()
  if (isLoggedIn.value) {
    await loadContainerStatus()
    await loadStats()
  }
})
</script>

<style scoped>
.mobile-home {
  min-height: 100vh;
  background: #f4f5fa;
}

/* 未登录状态 */
.mobile-home.login-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.login-card {
  background: #fff;
  border-radius: 16px;
  padding: 40px 32px;
  text-align: center;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
  max-width: 320px;
  width: 100%;
}

.login-icon {
  font-size: 64px;
  margin-bottom: 20px;
}

.login-title {
  font-size: 20px;
  font-weight: 700;
  color: #20242f;
  margin-bottom: 12px;
}

.login-desc {
  font-size: 14px;
  color: #8a90a3;
  margin-bottom: 24px;
  line-height: 1.6;
}

.login-btn {
  width: 100%;
  padding: 14px 24px;
  background: linear-gradient(135deg, #6a72e8 0%, #9b8cf5 100%);
  color: #fff;
  border: none;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(106, 114, 232, 0.3);
  transition: all 0.2s;
}

.login-btn:active {
  transform: scale(0.98);
  box-shadow: 0 2px 8px rgba(106, 114, 232, 0.3);
}

/* 顶部头部 */
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
  font-size: 14px;
  margin-bottom: 12px;
}

.greet-hint {
  opacity: 0.6;
}

.addr-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.2s;
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

/* 主体内容 */
.body {
  padding: 16px;
}

/* Docker 状态横幅 */
.docker-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  background: linear-gradient(135deg, #1fa05c 0%, #2bb56a 100%);
  border-radius: 14px;
  padding: 14px 16px;
  color: #fff;
  margin-bottom: 16px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
}

.pulse {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.docker-info {
  flex: 1;
}

.docker-label {
  font-size: 11px;
  opacity: 0.85;
}

.docker-value {
  font-size: 15px;
  font-weight: 700;
}

.docker-icon {
  font-size: 22px;
}

/* 统计卡片 */
.stat2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}

.stat {
  background: #fff;
  border-radius: 14px;
  padding: 14px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
}

.stat.alt {
  background: #f6f7fb;
}

.sl {
  font-size: 11px;
  color: #8a90a3;
  margin-bottom: 6px;
}

.sv {
  font-size: 24px;
  font-weight: 700;
  color: #20242f;
}

/* 区块标题 */
.sec-t {
  font-size: 13px;
  font-weight: 600;
  color: #4b5162;
  margin-bottom: 10px;
  padding-left: 2px;
}

/* 卡片 */
.card {
  background: #fff;
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
  margin-bottom: 16px;
}

/* 快捷管理网格 */
.qgrid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.qitem {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  transition: transform 0.2s;
}

.qitem:active {
  transform: scale(0.95);
}

.qi {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
}

.qitem span {
  font-size: 11px;
  color: #4b5162;
  font-weight: 500;
}

/* 孤儿清理卡片 */
.ct {
  font-size: 14px;
  font-weight: 700;
  color: #20242f;
  margin-bottom: 8px;
}

.cd {
  font-size: 12px;
  color: #8a90a3;
  line-height: 1.6;
  margin-bottom: 12px;
}

.btn {
  padding: 10px 20px;
  border: none;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-p {
  background: linear-gradient(135deg, #f0a132, #e8930c);
  color: #fff;
  box-shadow: 0 4px 12px rgba(240, 161, 50, 0.3);
}

.btn:active {
  transform: scale(0.98);
}
</style>
