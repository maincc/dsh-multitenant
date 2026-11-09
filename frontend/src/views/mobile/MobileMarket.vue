<template>
  <div class="mobile-market">
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
          <div class="ttl">技能市场</div>
          <div class="avatar">{{ role === 'admin' ? '管' : '用' }}</div>
        </div>
        <div class="greet">浏览和安装技能，扩展你的 DSH 能力</div>
      </div>

      <!-- 主体内容 -->
      <div class="body">
        <!-- 顶级分类切换 -->
        <div class="tab-group">
          <button
            class="tab-group-btn"
            :class="{ active: marketCategory === 'skills' }"
            @click="marketCategory = 'skills'"
          >
            🧩 技能市场
          </button>
          <button
            class="tab-group-btn"
            :class="{ active: marketCategory === 'env' }"
            @click="marketCategory = 'env'"
          >
            🌍 环境市场
          </button>
        </div>

        <!-- 技能市场 -->
        <template v-if="marketCategory === 'skills'">
          <!-- 子 tab 组 -->
          <div class="sub-tab-group">
            <button
              class="sub-tab-btn"
              :class="{ active: activeTab === 'market' }"
              @click="switchTab('market')"
            >
              市场
            </button>
            <button
              class="sub-tab-btn"
              :class="{ active: activeTab === 'mine' }"
              @click="switchTab('mine')"
            >
              我的技能
            </button>
          </div>

        <!-- 市场 Tab -->
        <div v-if="activeTab === 'market'" class="tab-content">
          <!-- CCDAO 插件未安装提示 -->
          <div v-if="!ccdao" class="notice notice-error">
            请安装 CCDAO Connector 浏览器插件以使用技能市场功能。
            <a
              href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
              target="_blank"
              rel="noopener noreferrer"
              class="notice-link"
            >
              点击下载安装
            </a>
          </div>
          
          <!-- 未连接钱包提示 -->
          <div v-else-if="!connected" class="notice notice-info">
            您可以浏览技能市场，但安装和下载需要连接钱包。
            <router-link to="/user" class="notice-link">前往连接</router-link>
          </div>

          <!-- 搜索框和刷新按钮 -->
          <div class="search-box">
            <div class="search-row">
              <input v-model="keyword" type="text" class="search-input" placeholder="搜索技能..." />
              <button class="btn btn-sm btn-outline" @click="loadMarketSkills" :disabled="loading">
                刷新
              </button>
            </div>
          </div>

          <div v-if="loading" class="loading-state">
            <div class="loading-spinner"></div>
            <div class="loading-text">加载中...</div>
          </div>
          <div v-else-if="filteredSkills.length === 0" class="empty-state">
            <div class="empty-icon">🎯</div>
            <div class="empty-text">暂无可用技能</div>
          </div>
          <div v-else class="skill-list">
            <div v-for="skill in filteredSkills" :key="skill.name" class="skill-card">
              <div class="skill-info">
                <div class="skill-name">
                  {{ skill.name }}
                  <span v-if="skill.installed" class="badge b-green">已安装</span>
                  <span v-if="skill.disableModelInvocation" class="badge b-orange">仅用户触发</span>
                </div>
                <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
                <div class="skill-meta">
                  <span class="meta-item">👤 {{ shortAddress(skill.sharer) }}</span>
                  <span class="meta-item">📅 {{ formatDate(skill.sharedAt) }}</span>
                  <span v-if="skill.hasResources" class="badge b-blue">包含资源</span>
                </div>
              </div>
              <div class="skill-actions">
                <button class="btn btn-sm btn-outline" @click="viewDetail(skill.name)">预览</button>
                <a class="btn btn-sm btn-outline" :href="downloadUrl(skill.name)" download>下载</a>
                <button
                  class="btn btn-sm btn-p"
                  @click="installSkill(skill)"
                  :disabled="!connected || installing"
                >
                  {{ skill.installed ? '重新安装' : '安装' }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 我的技能 Tab -->
        <div v-else-if="activeTab === 'mine'" class="tab-content">
          <div v-if="mySkillsLoading" class="loading-state">
            <div class="loading-spinner"></div>
            <div class="loading-text">加载中...</div>
          </div>
          <template v-else>
            <div
              v-if="mySkills.published.length === 0 && mySkills.installed.length === 0"
              class="empty-state"
            >
              <div class="empty-icon">🧩</div>
              <div class="empty-text">你还没有安装或发布任何技能</div>
            </div>
            <template v-else>
              <!-- 已发布的技能 -->
              <div v-if="mySkills.published.length > 0" class="section">
                <div class="section-title">📤 已发布的技能</div>
                <div class="skill-list">
                  <div
                    v-for="skill in mySkills.published"
                    :key="'p-' + skill.name"
                    class="skill-card"
                  >
                    <div class="skill-info">
                      <div class="skill-name">{{ skill.name }}</div>
                      <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
                    </div>
                    <span class="badge b-purple">已发布</span>
                  </div>
                </div>
              </div>

              <!-- 已安装的技能 -->
              <div v-if="mySkills.installed.length > 0" class="section">
                <div class="section-title">📦 已安装的技能</div>
                <div class="skill-list">
                  <div
                    v-for="skill in mySkills.installed"
                    :key="'i-' + skill.name"
                    class="skill-card"
                  >
                    <div class="skill-info">
                      <div class="skill-name">{{ skill.name }}</div>
                      <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
                      <div v-if="skill.installedAt" class="skill-meta">
                        安装于 {{ formatDate(skill.installedAt) }}
                      </div>
                    </div>
                    <span class="badge b-green">已安装</span>
                  </div>
                </div>
              </div>
            </template>
          </template>
        </div>
        </template>

        <!-- 环境市场 -->
        <template v-else-if="marketCategory === 'env'">
          <MobileEnvMarket />
        </template>
      </div>
    </template>

    <!-- 详情弹窗 -->
    <div v-if="showDetail || detailLoading" class="modal-mask" @click.self="closeDetail">
      <div class="modal-panel">
        <div v-if="detailLoading && !detailSkill.name" class="modal-body">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <div class="loading-text">加载详情中...</div>
          </div>
        </div>
        <template v-else>
          <div class="modal-head">
            <h3>{{ detailSkill.name }}</h3>
            <button class="close-btn" @click="closeDetail">✕</button>
          </div>
          <div class="modal-body">
            <p class="detail-desc">{{ detailSkill.description }}</p>
            <div class="detail-meta">
              <div>👤 发布者：{{ shortAddress(detailSkill.sharer) }}</div>
              <div>📅 发布时间：{{ formatDate(detailSkill.sharedAt) }}</div>
              <div v-if="detailSkill.contentHash">🔒 内容哈希：{{ shortHash(detailSkill.contentHash) }}</div>
              <div v-if="detailSkill.disableModelInvocation" class="badge b-orange">仅用户触发</div>
            </div>
            <div class="detail-content">
              <pre>{{ detailSkill.body }}</pre>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline" @click="closeDetail">关闭</button>
            <a class="btn btn-outline" :href="downloadUrl(detailSkill.name)" download>下载</a>
            <button class="btn btn-p" @click="installSkill(detailSkill)" :disabled="installing">
              {{ detailSkill.installed ? '重新安装' : '安装' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import { skillsApi } from '../../api/skills.js'
import { signChallenge, ccdaoAvailable, watchAccountsChanged, friendlyPluginError } from '../../api/wallet.js'
import MobileEnvMarket from './MobileEnvMarket.vue'

const loading = ref(true)
const role = ref('user')
const marketCategory = ref('skills') // skills / env
const activeTab = ref('market')
const keyword = ref('')
const skills = ref([])
const mySkills = ref({
  published: [],
  installed: [],
})
const mySkillsLoading = ref(false)
const installing = ref(false)
const connected = ref(false)
const ccdao = ref(false)

// 账户监听解绑函数
let unbindAccounts = null

// 详情弹窗
const showDetail = ref(false)
const detailLoading = ref(false)
const detailSkill = ref({})

const filteredSkills = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return skills.value
  return skills.value.filter(
    (s) => s.name.toLowerCase().includes(k) || (s.description || '').toLowerCase().includes(k),
  )
})

function shortAddress(addr) {
  return addr ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : ''
}

function shortHash(hash) {
  return hash ? `${hash.slice(0, 12)}...` : ''
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString()
}

function downloadUrl(name) {
  return skillsApi.downloadUrl(name)
}

function switchTab(tab) {
  activeTab.value = tab
  // 切换到"我的技能" tab 时自动加载数据
  if (tab === 'mine' && connected.value) {
    loadMySkills()
  }
}

async function loadUserInfo() {
  try {
    const res = await axios.get('/api/user/credential-status')
    role.value = res.data.role || 'user'
  } catch (e) {
    console.error('加载用户信息失败:', e)
  }
}

async function loadMarketSkills() {
  loading.value = true
  try {
    const address = localStorage.getItem('swtc_address') || undefined
    const res = await skillsApi.list(address)
    skills.value = res.skills || []
  } catch (e) {
    console.error('加载市场技能失败:', e)
  } finally {
    loading.value = false
  }
}

async function loadMySkills() {
  mySkillsLoading.value = true
  try {
    const address = localStorage.getItem('swtc_address')
    if (!address) return
    const res = await skillsApi.mineView(address)
    mySkills.value = {
      published: res.published || [],
      installed: res.installed || [],
    }
  } catch (e) {
    console.error('加载我的技能失败:', e)
  } finally {
    mySkillsLoading.value = false
  }
}

async function viewDetail(name) {
  showDetail.value = true
  detailLoading.value = true
  detailSkill.value = {}
  try {
    const res = await skillsApi.detail(name)
    detailSkill.value = res.skill || {}
  } catch (e) {
    console.error('加载技能详情失败:', e)
    alert('加载详情失败: ' + friendlyPluginError(e))
    closeDetail()
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  showDetail.value = false
  detailLoading.value = false
  detailSkill.value = {}
}

async function installSkill(skill) {
  if (!connected.value) {
    alert('请先连接钱包')
    return
  }

  // 详细的风险确认
  const publisher = skill.sharer ? shortAddress(skill.sharer) : '未知'
  const autoLine = skill.modelAutoInvoke 
    ? '此技能可以被模型自动调用' 
    : '此技能只能由用户手动触发'
  
  const confirmMsg = `确定要安装技能 "${skill.name}" 吗？\n\n` +
    `风险提示：技能来自第三方，可能存在安全风险\n` +
    `发布者：${publisher}\n` +
    `${autoLine}\n\n` +
    `是否继续安装？`

  if (!confirm(confirmMsg)) return

  installing.value = true
  try {
    const auth = await signChallenge()
    await skillsApi.install(auth, skill.name)
    alert(`技能 "${skill.name}" 安装成功！`)
    await loadMarketSkills()
    await loadMySkills()
    closeDetail()
  } catch (e) {
    console.error('安装技能失败:', e)
    alert('安装失败: ' + friendlyPluginError(e))
  } finally {
    installing.value = false
  }
}

onMounted(async () => {
  // 检测 CCDAO 插件和连接状态
  ccdao.value = ccdaoAvailable()
  connected.value = Boolean(localStorage.getItem('swtc_address'))
  
  // 监听账户变化
  unbindAccounts = watchAccountsChanged((accounts) => {
    const hasAccount = Boolean(accounts && accounts.length > 0)
    connected.value = hasAccount
    if (hasAccount) {
      loadMarketSkills()
      loadMySkills()
    }
  })
  
  try {
    await Promise.all([loadUserInfo(), loadMarketSkills()])
  } catch (e) {
    console.error('加载数据失败:', e)
  } finally {
    loading.value = false
  }
})

onUnmounted(() => {
  unbindAccounts?.()
  unbindAccounts = null
})
</script>

<style scoped>
.mobile-market {
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

/* 顶级 tab 组 */
.tab-group {
  display: flex;
  gap: 0;
  margin-bottom: 16px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
  overflow: hidden;
}

.tab-group-btn {
  flex: 1;
  padding: 14px;
  border: none;
  background: transparent;
  font-size: 15px;
  font-weight: 600;
  color: #8a90a3;
  cursor: pointer;
  transition: all 0.2s;
  border-bottom: 3px solid transparent;
}

.tab-group-btn.active {
  color: #6a72e8;
  background: #f0f4ff;
  border-bottom-color: #6a72e8;
}

/* 子 tab 组 */
.sub-tab-group {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  background: #f4f5fa;
  padding: 6px;
  border-radius: 10px;
}

.sub-tab-btn {
  flex: 1;
  padding: 10px;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #8a90a3;
  cursor: pointer;
  transition: all 0.2s;
}

.sub-tab-btn.active {
  background: #fff;
  color: #6a72e8;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}

/* Tab 内容 */
.tab-content {
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

/* 搜索框 */
.search-box {
  margin-bottom: 16px;
}

.search-row {
  display: flex;
  gap: 8px;
}

.search-input {
  flex: 1;
  padding: 12px 16px;
  border: 1px solid #e0e3eb;
  border-radius: 10px;
  font-size: 14px;
  background: #fff;
  transition: all 0.2s;
}

.search-input:focus {
  outline: none;
  border-color: #6a72e8;
  box-shadow: 0 0 0 3px rgba(106, 114, 232, 0.1);
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

/* 技能列表 */
.skill-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skill-card {
  background: #fff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-name {
  font-size: 15px;
  font-weight: 700;
  color: #20242f;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.skill-desc {
  font-size: 13px;
  color: #8a90a3;
  line-height: 1.5;
  margin-bottom: 8px;
}

.skill-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #b0b5c5;
  flex-wrap: wrap;
  align-items: center;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.skill-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 徽章 */
.badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.b-purple {
  background: #efecff;
  color: #6a72e8;
}

.b-green {
  background: #e6f7ee;
  color: #1fa05c;
}

.b-orange {
  background: #fff4e3;
  color: #e8930c;
}

.b-blue {
  background: #e6f0ff;
  color: #3b82f6;
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

.btn-p {
  background: linear-gradient(135deg, #6a72e8 0%, #9b8cf5 100%);
  color: #fff;
  box-shadow: 0 4px 12px rgba(106, 114, 232, 0.3);
}

.btn-outline {
  background: #fff;
  color: #6a72e8;
  border: 1px solid #6a72e8;
}

.btn-sm {
  padding: 8px 16px;
  font-size: 13px;
}

.btn:active:not(:disabled) {
  transform: scale(0.98);
}

/* 分区 */
.section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 16px;
  font-weight: 700;
  color: #20242f;
  margin-bottom: 12px;
}

/* 详情弹窗 */
.modal-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-panel {
  background: #fff;
  border-radius: 16px;
  max-width: 500px;
  width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px;
  border-bottom: 1px solid #eceef4;
}

.modal-head h3 {
  font-size: 18px;
  font-weight: 700;
  color: #20242f;
  margin: 0;
}

.close-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: #f4f5fa;
  border-radius: 8px;
  font-size: 18px;
  cursor: pointer;
  transition: all 0.2s;
}

.close-btn:hover {
  background: #e0e3eb;
}

.modal-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.detail-desc {
  font-size: 14px;
  color: #4b5162;
  line-height: 1.6;
  margin-bottom: 16px;
}

.detail-meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: #8a90a3;
  margin-bottom: 16px;
  padding: 12px;
  background: #f4f5fa;
  border-radius: 8px;
}

.detail-content {
  background: #f4f5fa;
  border-radius: 8px;
  padding: 16px;
  overflow-x: auto;
}

.detail-content pre {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.modal-footer {
  display: flex;
  gap: 12px;
  padding: 20px;
  border-top: 1px solid #eceef4;
}

.modal-footer .btn {
  flex: 1;
}
</style>
