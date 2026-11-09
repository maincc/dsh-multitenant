<template>
  <div class="mobile-container">
    <!-- Loading 状态 -->
    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">加载中...</div>
    </div>

    <!-- 数据加载完成后显示内容 -->
    <template v-else>
      <!-- 头部 -->
      <div class="ghead">
        <div class="row1">
          <div class="ttl">容器管理</div>
          <div class="avatar">{{ role === 'admin' ? '管' : '用' }}</div>
        </div>
        <div class="greet">查看容器状态与资源使用，管理你的专属 DSH 容器</div>
      </div>

      <!-- 主体内容 -->
      <div class="body">
        <!-- 子 tab 切换 -->
        <div class="sub-tabs">
          <button
            class="sub-tab"
            :class="{ active: cSub === 'info' }"
            @click="cSub = 'info'"
          >
            容器信息
          </button>
          <button
            class="sub-tab"
            :class="{ active: cSub === 'skills' }"
            @click="cSub = 'skills'; loadMySkills()"
          >
            技能插件
          </button>
          <button
            class="sub-tab"
            :class="{ active: cSub === 'env' }"
            @click="cSub = 'env'; loadEnvVars()"
          >
            环境现场
          </button>
        </div>

        <!-- 容器信息 tab -->
        <div v-show="cSub === 'info'">
          <!-- 容器信息卡片 -->
          <div class="card">
            <div class="kv">
              <span class="k">专属端口</span>
              <span class="v mono" style="font-weight: 700">{{ userInfo.port || '-' }}</span>
            </div>
            <div class="kv">
              <span class="k">当前配额</span>
              <span class="v">
                <span class="badge" :class="tierBadgeClass">{{ tierLabel }}</span>
              </span>
            </div>
            <div class="kv">
              <span class="k">容器状态</span>
              <span class="v">
                <span class="badge" :class="statusBadgeClass">{{ statusText }}</span>
              </span>
            </div>
          </div>

          <!-- 资源使用卡片 -->
          <div class="card">
            <div class="kv">
              <span class="k">CPU 使用率</span>
              <span class="v" style="font-weight: 700">{{ userInfo.stats?.cpu || '0%' }}</span>
            </div>
            <div class="kv" style="border: none; padding-bottom: 4px">
              <span class="k">内存使用</span>
              <span class="v" style="font-weight: 700">
                {{ userInfo.stats?.memory || '0MiB' }}
                <span style="color: #8a90a3; font-weight: 400">
                  ({{ userInfo.stats?.memoryPercent || '0%' }})
                </span>
              </span>
            </div>
            <div class="progress">
              <i :style="{ width: memoryPercent }"></i>
            </div>
          </div>

          <!-- 进入 DSH 卡片 -->
          <div class="card enter-card">
            <div class="ct">🚀 进入 DSH</div>
            <div class="cd">
              点击下方按钮进入你的专属 DSH 实例（每次进入需插件签名，用于运行匹配）
            </div>
            <div style="margin-top: 12px">
              <button class="btn btn-p" @click="enterDsh" :disabled="enteringDsh">
                {{ enteringDsh ? '正在进入...' : '打开 DSH Web UI' }}
              </button>
            </div>
          </div>

          <!-- 操作按钮 -->
          <div class="btn-row">
            <button class="btn btn-p" @click="restartDSH" :disabled="containerBooting">
              🔄 重启服务
            </button>
            <button
              class="btn btn-g"
              @click="stopContainer"
              :disabled="!connected || userInfo.status !== 'running'"
            >
              ■ 停止容器
            </button>
          </div>

          <!-- 危险操作 -->
          <button class="btn btn-r" @click="resetContainer">🗑 重置容器（删除数据）</button>

          <!-- 说明卡片 -->
          <div class="card">
            <div class="cd">
              <b style="color: #4b5162">重启服务：</b>
              安装插件后需重启 DSH 服务才能生效<br /><br />
              <b style="color: #4b5162">停止容器：</b>
              立即结束今日使用时长并保全剩余额度，数据保留，可随时重新启动。{{
                usageInfoLabel ? '今日已用 ' + usageInfoLabel : ''
              }}<br /><br />
              <b style="color: #4b5162">重置容器：</b>
              删除所有数据和配置，重新开始（不可恢复）
            </div>
          </div>
        </div>

        <!-- 技能插件 tab -->
        <div v-show="cSub === 'skills'">
          <div v-if="skillsLoading" class="loading-state">
            <div class="loading-spinner"></div>
            <div class="loading-text">加载技能数据...</div>
          </div>
          <template v-else>
            <!-- 已发布的技能 -->
            <div v-if="mySkills.published.length > 0" class="card">
              <div class="ct">📤 已发布的技能</div>
              <div v-for="skill in mySkills.published" :key="'p-' + skill.name" class="skill-item">
                <div class="skill-info">
                  <div class="skill-name">{{ skill.name }}</div>
                  <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
                </div>
                <button class="btn btn-sm btn-r" @click="unpublishSkill(skill.name)">
                  取消发布
                </button>
              </div>
            </div>

            <!-- 已安装的技能 -->
            <div v-if="mySkills.installed.length > 0" class="card">
              <div class="ct">📦 已安装的技能</div>
              <div v-for="skill in mySkills.installed" :key="'i-' + skill.name" class="skill-item">
                <div class="skill-info">
                  <div class="skill-name">{{ skill.name }}</div>
                  <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
                  <div v-if="skill.installedAt" class="skill-meta">
                    安装于 {{ new Date(skill.installedAt).toLocaleDateString() }}
                  </div>
                </div>
                <button class="btn btn-sm btn-r" @click="uninstallSkill(skill.name)">
                  卸载
                </button>
              </div>
            </div>

            <!-- 插件列表 -->
            <div class="card">
              <div class="ct">🔌 插件</div>
              <div v-if="mySkills.plugins.length === 0" class="empty-hint">
                暂无插件
              </div>
              <div v-for="plugin in mySkills.plugins" :key="'pl-' + plugin.name" class="skill-item">
                <div class="skill-info">
                  <div class="skill-name">
                    {{ plugin.name }}
                    <span v-if="plugin.version" class="badge b-purple">v{{ plugin.version }}</span>
                  </div>
                  <div class="skill-desc">{{ plugin.description || '暂无描述' }}</div>
                  <div class="skill-meta">
                    {{ plugin.kind === 'file' ? '文件' : '目录' }} · 
                    {{ plugin.fileCount || 0 }} 个文件 · 
                    {{ formatBytes(plugin.bytes || 0) }}
                  </div>
                </div>
              </div>
            </div>

            <!-- 空状态 -->
            <div v-if="mySkills.published.length === 0 && mySkills.installed.length === 0" class="card">
              <div class="empty-hint">
                暂无技能数据<br />
                你可以在技能市场中安装技能
              </div>
            </div>
          </template>
        </div>

        <!-- 环境现场 tab -->
        <div v-show="cSub === 'env'">
          <div v-if="envLoading" class="loading-state">
            <div class="loading-spinner"></div>
            <div class="loading-text">加载环境变量...</div>
          </div>
          <template v-else>
            <div v-if="envVars.length === 0" class="card">
              <div class="empty-hint">
                暂无环境变量<br />
                你可以在环境市场中配置环境变量
              </div>
            </div>
            <div v-else class="card">
              <div class="ct">🌍 环境变量</div>
              <div v-for="env in envVars" :key="env.name" class="env-item">
                <div class="env-name">{{ env.name }}</div>
                <div class="env-value">{{ env.value }}</div>
                <div v-if="env.description" class="env-desc">{{ env.description }}</div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import { requestAccounts, signMessage, getPublicKey } from '../../api/wallet.js'

const loading = ref(true)
const enteringDsh = ref(false)
const userInfo = ref({
  address: '',
  port: '',
  tier: '',
  tierLabel: '',
  status: '',
  stats: null,
})
const role = ref('user')
const connected = ref(false)
const containerBooting = ref(false)
const usageInfo = ref(null)

// 子 tab 状态
const cSub = ref('info') // 'info' | 'skills' | 'env'

// 技能数据
const mySkills = ref({
  published: [],
  installed: [],
  plugins: [],
})
const skillsLoading = ref(false)

// 环境变量数据
const envVars = ref([])
const envLoading = ref(false)

const memoryPercent = computed(() => {
  return userInfo.value.stats?.memoryPercent || '0%'
})

const tierBadgeClass = computed(() => {
  const tier = userInfo.value.tier
  if (tier === 'basic' || tier === 'T1') return 'b-purple'
  if (tier === 'enhanced' || tier === 'T2') return 'b-orange'
  if (tier === 'performance' || tier === 'T3') return 'b-green'
  return 'b-purple'
})

const tierLabel = computed(() => {
  return userInfo.value.tierLabel || '基础'
})

const statusBadgeClass = computed(() => {
  const status = userInfo.value.status
  if (status === 'running') return 'b-green'
  if (status === 'stopped') return 'b-red'
  if (status === 'creating') return 'b-orange'
  return 'b-red'
})

const statusText = computed(() => {
  const status = userInfo.value.status
  if (status === 'running') return '● 运行中'
  if (status === 'stopped') return '● 已停止'
  if (status === 'creating') return '● 创建中'
  return '● 未知'
})

const usageInfoLabel = computed(() => {
  const u = usageInfo.value
  if (!u) return ''
  if (!u.enabled) return '无限制'
  if (u.exempt) return '豁免'
  return `${u.usedMinutes} / ${u.dailyMinutes} 分钟`
})

// 连接钱包并建立会话（与 PC 版 connectWithOwnership 保持一致）
async function connectWithOwnership(action = null) {
  try {
    // 1. 请求钱包账户（获取当前地址）
    const pluginAddress = await requestAccounts()
    
    // 2. 领取挑战（用插件地址）
    const chalRes = await fetch(`/connect-challenge?address=${encodeURIComponent(pluginAddress)}`)
    const challenge = await chalRes.json()
    const nonce = challenge.nonce
    const message = challenge.message
    if (!nonce || !message) {
      throw new Error(challenge.error || '领取连接挑战失败，请重试')
    }
    
    // 3. 钱包签名
    const signature = await signMessage(pluginAddress, message)
    const publicKey = await getPublicKey(pluginAddress)
    
    // 4. 带签名访问 /connect，建立会话（用插件地址，与 PC 版一致）
    const params = new URLSearchParams({
      address: pluginAddress,
      nonce,
      signature,
      publicKey,
      format: 'json',
    })
    
    // 如果指定了 action，添加到参数中
    if (action) {
      params.append('action', action)
    }
    
    const cRes = await fetch(`/connect?${params}`)
    return { res: cRes, address: pluginAddress }
  } catch (err) {
    console.error('连接失败:', err)
    throw err
  }
}

// 检查并建立登录会话
async function ensureLogin() {
  console.log('[MobileContainer] ensureLogin - 检查会话状态')
  try {
    // 先检查是否已有有效会话
    const sessionRes = await axios.get('/api/user/session-info')
    console.log('[MobileContainer] 会话检查结果:', sessionRes.data)
    if (sessionRes.data?.address) {
      console.log('[MobileContainer] 已有有效会话，地址:', sessionRes.data.address)
      return { success: true, address: sessionRes.data.address }
    }
  } catch (e) {
    console.log('[MobileContainer] 会话查询失败，需要登录:', e.response?.status)
  }
  
  // 没有有效会话，调用钱包登录
  console.log('[MobileContainer] 开始调用钱包登录...')
  try {
    const { res, address } = await connectWithOwnership('login')
    console.log('[MobileContainer] 登录响应:', res.status, '地址:', address)
    return { success: res.status === 200, address }
  } catch (err) {
    console.error('[MobileContainer] 登录失败:', err)
    alert('登录失败: ' + (err.message || '未知错误'))
    return { success: false, address: null }
  }
}

async function loadUserInfo() {
  try {
    // 确保已登录（建立会话）
    const { success, address } = await ensureLogin()
    if (!success || !address) {
      console.error('登录失败，无法加载容器信息')
      return
    }

    // 获取角色信息
    const credRes = await axios.get('/api/user/credential-status')
    role.value = credRes.data.role || 'user'

    // 获取容器信息（使用登录时确定的地址）
    const containerRes = await axios.get(`/api/user/${address}`)
    userInfo.value = {
      address: address,
      port: containerRes.data.port || '',
      tier: containerRes.data.tier || 'basic',
      tierLabel: containerRes.data.tierLabel || '基础',
      status: containerRes.data.status || 'unknown',
      stats: containerRes.data.stats || null,
    }
    connected.value = true
  } catch (e) {
    console.error('加载用户信息失败:', e)
  }
}

async function loadUsageInfo() {
  try {
    const res = await axios.get('/api/user/credential-status')
    const address = res.data.address
    if (!address) return

    // 使用 PC 端的端点
    const usageRes = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)
    usageInfo.value = usageRes.data.usage || null
  } catch (e) {
    console.error('加载使用信息失败:', e)
  }
}

async function enterDsh() {
  if (!userInfo.value.port) {
    alert('容器未启动')
    return
  }
  
  enteringDsh.value = true
  try {
    console.log('[MobileContainer] enterDsh - 开始建立会话...')
    // 先建立会话（不传 action，让后端返回容器 URL）
    const { res, address } = await connectWithOwnership()
    console.log('[MobileContainer] enterDsh - 响应状态:', res.status, '地址:', address)
    
    if (res.status === 200) {
      const data = await res.json()
      console.log('[MobileContainer] enterDsh - 响应数据:', data)
      if (data?.url) {
        // 打开后端返回的 URL（已包含会话信息）
        window.open(data.url, '_blank', 'noopener')
        return
      }
      alert(data?.message || data?.error || '进入 DSH 失败：未返回 URL')
      return
    }
    
    if (res.status === 302) {
      const loc = res.headers.get('location')
      console.log('[MobileContainer] enterDsh - 302 重定向到:', loc)
      if (loc) {
        window.open(loc, '_blank', 'noopener')
      }
      return
    }
    
    if (res.status === 202) {
      const data = await res.json()
      alert(data.message || data.error || '资源不足，请等待')
      return
    }
    
    alert('进入 DSH 失败: HTTP ' + res.status)
  } catch (err) {
    console.error('[MobileContainer] enterDsh 失败:', err)
    alert('进入 DSH 失败: ' + (err.message || '未知错误'))
  } finally {
    enteringDsh.value = false
  }
}

async function restartDSH() {
  if (!confirm('确定要重启 DSH 服务吗？')) return

  containerBooting.value = true
  try {
    const address = userInfo.value.address
    await axios.post(`/api/user/${address}/restart`)
    alert('重启指令已下发，服务将稍后恢复')
    // 重新加载容器信息
    setTimeout(() => {
      loadUserInfo()
    }, 3000)
  } catch (e) {
    console.error('重启失败:', e)
    alert('重启失败: ' + (e.response?.data?.error || e.message))
  } finally {
    containerBooting.value = false
  }
}

async function stopContainer() {
  if (!confirm('确定要停止容器吗？今日使用时长将结束，数据保留。')) return

  try {
    const address = userInfo.value.address
    await axios.post(`/api/user/${address}/stop`)
    alert('容器已停止，时长保留')
    // 重新加载容器信息
    setTimeout(() => {
      loadUserInfo()
    }, 2000)
  } catch (e) {
    console.error('停止失败:', e)
    alert('停止失败: ' + (e.response?.data?.error || e.message))
  }
}

async function resetContainer() {
  if (!confirm('⚠️ 确认重置容器？将删除所有数据和配置，不可恢复！')) return

  try {
    const address = userInfo.value.address
    const res = await axios.post(`/api/user/${address}/reset`)
    alert('重置请求已提交')
    // 如果返回了新 URL，打开它
    if (res.data?.url) {
      window.open(res.data.url, '_blank')
    }
    // 重新加载容器信息
    setTimeout(() => {
      loadUserInfo()
    }, 3000)
  } catch (e) {
    console.error('重置失败:', e)
    alert('重置失败: ' + (e.response?.data?.error || e.message))
  }
}

onMounted(async () => {
  try {
    await Promise.all([loadUserInfo(), loadUsageInfo()])
  } catch (e) {
    console.error('加载数据失败:', e)
  } finally {
    loading.value = false
  }
})

// 加载技能数据
async function loadMySkills() {
  skillsLoading.value = true
  try {
    const res = await axios.get('/api/skills/mine')
    mySkills.value = {
      published: res.data.published || [],
      installed: res.data.installed || [],
      plugins: res.data.plugins || [],
    }
  } catch (e) {
    console.error('加载技能数据失败:', e)
  } finally {
    skillsLoading.value = false
  }
}

// 加载环境变量
async function loadEnvVars() {
  envLoading.value = true
  try {
    const res = await axios.get('/api/env/mine')
    envVars.value = res.data || []
  } catch (e) {
    console.error('加载环境变量失败:', e)
  } finally {
    envLoading.value = false
  }
}

// 卸载技能
async function uninstallSkill(skillName) {
  if (!confirm(`确定要卸载技能 "${skillName}" 吗？`)) return
  
  try {
    await axios.post(`/api/skills/uninstall`, { name: skillName })
    alert('技能已卸载')
    await loadMySkills()
  } catch (e) {
    console.error('卸载技能失败:', e)
    alert('卸载失败: ' + (e.response?.data?.error || e.message))
  }
}

// 取消发布技能
async function unpublishSkill(skillName) {
  if (!confirm(`确定要取消发布技能 "${skillName}" 吗？`)) return
  
  try {
    await axios.post(`/api/skills/unpublish`, { name: skillName })
    alert('技能已取消发布')
    await loadMySkills()
  } catch (e) {
    console.error('取消发布失败:', e)
    alert('取消发布失败: ' + (e.response?.data?.error || e.message))
  }
}

// 格式化字节数
function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}
</script>

<style scoped>
.mobile-container {
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

/* 卡片 */
.card {
  background: #fff;
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
  margin-bottom: 16px;
}

.kv {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #eceef4;
}

.kv:last-child {
  border-bottom: none;
}

.k {
  font-size: 13px;
  color: #8a90a3;
}

.v {
  font-size: 14px;
  color: #20242f;
  font-weight: 500;
}

.mono {
  font-family: 'SF Mono', Monaco, monospace;
}

/* 徽章 */
.badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.b-purple {
  background: #efecff;
  color: #6a72e8;
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
  background: #fdecec;
  color: #e5484d;
}

/* 进度条 */
.progress {
  height: 6px;
  background: #eceef4;
  border-radius: 3px;
  overflow: hidden;
  margin-top: 8px;
}

.progress i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #6a72e8 0%, #9b8cf5 100%);
  transition: width 0.3s;
}

/* 进入 DSH 卡片 */
.enter-card {
  background: linear-gradient(135deg, #f0f1ff, #faf8ff);
}

.ct {
  font-size: 15px;
  font-weight: 700;
  color: #20242f;
  margin-bottom: 8px;
}

.cd {
  font-size: 12px;
  color: #8a90a3;
  line-height: 1.6;
}

/* 按钮 */
.btn {
  padding: 12px 20px;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  width: 100%;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-p {
  background: linear-gradient(135deg, #6a72e8 0%, #9b8cf5 100%);
  color: #fff;
  box-shadow: 0 4px 12px rgba(106, 114, 232, 0.3);
}

.btn-g {
  background: #e6f7ee;
  color: #1fa05c;
}

.btn-r {
  background: #fdecec;
  color: #e5484d;
  margin-bottom: 16px;
}

.btn:active:not(:disabled) {
  transform: scale(0.98);
}

/* 按钮行 */
.btn-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.btn-row .btn {
  flex: 1;
}

/* 子 tab 切换 */
.sub-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  background: #fff;
  padding: 8px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
}

.sub-tab {
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
}

.sub-tab.active {
  background: linear-gradient(135deg, #6a72e8 0%, #9b8cf5 100%);
  color: #fff;
  box-shadow: 0 2px 8px rgba(106, 114, 232, 0.3);
}

/* 技能列表项 */
.skill-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #eceef4;
  gap: 12px;
}

.skill-item:last-child {
  border-bottom: none;
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-name {
  font-size: 14px;
  font-weight: 600;
  color: #20242f;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.skill-desc {
  font-size: 12px;
  color: #8a90a3;
  line-height: 1.5;
  margin-bottom: 4px;
}

.skill-meta {
  font-size: 11px;
  color: #b0b5c5;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
  width: auto;
  white-space: nowrap;
}

/* 环境变量项 */
.env-item {
  padding: 12px 0;
  border-bottom: 1px solid #eceef4;
}

.env-item:last-child {
  border-bottom: none;
}

.env-name {
  font-size: 14px;
  font-weight: 600;
  color: #20242f;
  margin-bottom: 4px;
  font-family: 'SF Mono', Monaco, monospace;
}

.env-value {
  font-size: 13px;
  color: #6a72e8;
  word-break: break-all;
  margin-bottom: 4px;
}

.env-desc {
  font-size: 12px;
  color: #8a90a3;
  line-height: 1.5;
}

/* 空状态提示 */
.empty-hint {
  text-align: center;
  padding: 40px 20px;
  color: #8a90a3;
  font-size: 13px;
  line-height: 1.6;
}
</style>
