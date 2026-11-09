<template>
  <div class="mobile-env-market">
    <!-- Loading 状态 -->
    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">加载中...</div>
    </div>

    <template v-else>
      <!-- 环境市场介绍 -->
      <div class="env-intro">
        <div class="intro-title">什么是环境市场？</div>
        <ul class="intro-list">
          <li>环境是预配置的 DSH 运行环境快照</li>
          <li>包含技能、插件、环境变量等完整配置</li>
          <li>一键应用，快速切换不同的工作环境</li>
        </ul>
      </div>

      <!-- 当前环境状态 -->
      <div v-if="current" class="current-env">
        <div class="current-label">当前环境</div>
        <template v-if="current.fromTemplate">
          <div class="current-info">
            <span class="current-name">{{ current.fromTemplate.name }}</span>
            <span class="current-author">来自 {{ shortAddr(current.fromTemplate.author) }}</span>
          </div>
          <button class="btn btn-sm btn-outline" @click="revertEnv" :disabled="busy">
            回退默认
          </button>
        </template>
        <template v-else-if="current.image">
          <div class="current-info">
            <span class="current-name">固定版本</span>
            <span class="current-author">{{ current.image }}</span>
          </div>
        </template>
        <template v-else>
          <div class="current-info">
            <span class="current-name">平台默认</span>
          </div>
        </template>
      </div>

      <!-- 环境模板列表 -->
      <div class="section-title">🏪 可用环境</div>
      
      <div v-if="list.length === 0" class="empty-state">
        <div class="empty-icon">🌍</div>
        <div class="empty-text">暂无可用环境</div>
      </div>
      
      <div v-else class="env-list">
        <div v-for="tpl in list" :key="tpl.id" class="env-card">
          <div class="env-info">
            <div class="env-name">
              {{ tpl.name }}
              <span v-if="tpl.isMine" class="badge b-purple">我的</span>
              <span v-if="!tpl.scrubbed" class="badge b-orange">未清洗</span>
            </div>
            <div class="env-meta">
              <span>👤 {{ shortAddr(tpl.author) }}</span>
              <span>📦 {{ fmtBytes(tpl.sizeBytes) }}</span>
              <span>🔧 DSH {{ tpl.dshVersion }}</span>
            </div>
            <div class="env-desc">{{ tpl.intro || '暂无介绍' }}</div>
          </div>
          <div class="env-actions">
            <button class="btn btn-sm btn-outline" @click="viewDetail(tpl)">详情</button>
            <button
              v-if="tpl.isMine"
              class="btn btn-sm btn-outline"
              @click="unpublishEnv(tpl)"
              :disabled="busy"
            >
              下架
            </button>
            <button
              class="btn btn-sm btn-p"
              @click="applyEnv(tpl)"
              :disabled="busy || current?.image === tpl.id"
            >
              {{ current?.image === tpl.id ? '使用中' : '应用' }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 详情弹窗 -->
    <div v-if="detailFor" class="modal-mask" @click.self="closeDetail">
      <div class="modal-panel">
        <div class="modal-head">
          <h3>{{ detailFor.name }}</h3>
          <button class="close-btn" @click="closeDetail">✕</button>
        </div>
        <div class="modal-body">
          <div class="detail-meta">
            <div>👤 作者：{{ shortAddr(detailFor.author) }}</div>
            <div>📅 创建时间：{{ new Date(detailFor.createdAt).toLocaleString() }}</div>
            <div>📦 大小：{{ fmtBytes(detailFor.sizeBytes) }}</div>
            <div>🔧 DSH 版本：{{ detailFor.dshVersion }}</div>
            <div>👥 使用人数：{{ detailFor.pinnedByCount }}</div>
          </div>
          <div class="detail-section">
            <div class="section-label">简介</div>
            <div class="section-content">{{ detailFor.intro || '暂无介绍' }}</div>
          </div>
          <div class="detail-section">
            <div class="section-label">包含技能</div>
            <div v-if="detailFor.include.skills.length" class="tag-list">
              <span v-for="s in detailFor.include.skills" :key="s" class="tag">{{ s }}</span>
            </div>
            <div v-else class="empty-hint">无</div>
          </div>
          <div class="detail-section">
            <div class="section-label">包含插件</div>
            <div v-if="detailFor.include.plugins.length" class="tag-list">
              <span v-for="p in detailFor.include.plugins" :key="p" class="tag">{{ p }}</span>
            </div>
            <div v-else class="empty-hint">无</div>
          </div>
          <div class="detail-section">
            <div class="section-label">包含文件夹</div>
            <div v-if="detailFor.include.folders.length" class="tag-list">
              <span v-for="f in detailFor.include.folders" :key="f" class="tag">{{ f }}</span>
            </div>
            <div v-else class="empty-hint">无</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" @click="closeDetail">关闭</button>
          <button
            class="btn btn-p"
            @click="applyEnv(detailFor)"
            :disabled="busy || current?.image === detailFor.id"
          >
            {{ current?.image === detailFor.id ? '使用中' : '应用此环境' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'

const loading = ref(true)
const busy = ref(false)
const list = ref([])
const current = ref(null)
const detailFor = ref(null)

function shortAddr(addr) {
  return addr ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : ''
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

async function loadList() {
  try {
    const address = localStorage.getItem('swtc_address') || undefined
    const res = await axios.get('/api/env/templates', { params: { address } })
    list.value = res.data.templates || []
  } catch (e) {
    console.error('加载环境列表失败:', e)
  }
}

async function loadCurrent() {
  try {
    const res = await axios.get('/api/env/current')
    current.value = res.data
  } catch (e) {
    console.error('加载当前环境失败:', e)
  }
}

function viewDetail(tpl) {
  detailFor.value = tpl
}

function closeDetail() {
  detailFor.value = null
}

async function applyEnv(tpl) {
  if (!confirm(`确定要应用环境 "${tpl.name}" 吗？\n\n这将重置你的容器环境，应用此环境的配置。`)) return
  
  busy.value = true
  try {
    await axios.post(`/api/env/apply/${tpl.id}`)
    alert(`环境 "${tpl.name}" 应用成功！`)
    await loadCurrent()
    closeDetail()
  } catch (e) {
    console.error('应用环境失败:', e)
    alert('应用失败: ' + (e.response?.data?.error || e.message))
  } finally {
    busy.value = false
  }
}

async function revertEnv() {
  if (!confirm('确定要回退到默认环境吗？')) return
  
  busy.value = true
  try {
    await axios.post('/api/env/revert')
    alert('已回退到默认环境')
    await loadCurrent()
  } catch (e) {
    console.error('回退环境失败:', e)
    alert('回退失败: ' + (e.response?.data?.error || e.message))
  } finally {
    busy.value = false
  }
}

async function unpublishEnv(tpl) {
  if (!confirm(`确定要下架环境 "${tpl.name}" 吗？`)) return
  
  busy.value = true
  try {
    await axios.delete(`/api/env/templates/${tpl.id}`)
    alert('已下架')
    await loadList()
  } catch (e) {
    console.error('下架失败:', e)
    alert('下架失败: ' + (e.response?.data?.error || e.message))
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    await Promise.all([loadList(), loadCurrent()])
  } catch (e) {
    console.error('加载数据失败:', e)
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.mobile-env-market {
  padding: 0;
}

/* 环境介绍 */
.env-intro {
  background: #f0f4ff;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}

.intro-title {
  font-size: 14px;
  font-weight: 700;
  color: #4b5162;
  margin-bottom: 8px;
}

.intro-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  color: #6b7280;
  line-height: 1.6;
}

.intro-list li {
  margin-bottom: 4px;
}

/* 当前环境 */
.current-env {
  background: #fff;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.current-label {
  font-size: 12px;
  color: #8a90a3;
  margin-bottom: 4px;
}

.current-info {
  flex: 1;
}

.current-name {
  font-size: 15px;
  font-weight: 700;
  color: #20242f;
  display: block;
  margin-bottom: 4px;
}

.current-author {
  font-size: 12px;
  color: #8a90a3;
}

/* 分区标题 */
.section-title {
  font-size: 16px;
  font-weight: 700;
  color: #20242f;
  margin-bottom: 12px;
}

/* 环境列表 */
.env-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.env-card {
  background: #fff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
}

.env-info {
  margin-bottom: 12px;
}

.env-name {
  font-size: 15px;
  font-weight: 700;
  color: #20242f;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.env-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #8a90a3;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.env-desc {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.5;
}

.env-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
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

.detail-section {
  margin-bottom: 16px;
}

.section-label {
  font-size: 14px;
  font-weight: 600;
  color: #4b5162;
  margin-bottom: 8px;
}

.section-content {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.6;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag {
  padding: 4px 12px;
  background: #f0f4ff;
  color: #6a72e8;
  border-radius: 12px;
  font-size: 12px;
}

.empty-hint {
  font-size: 13px;
  color: #b0b5c5;
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
