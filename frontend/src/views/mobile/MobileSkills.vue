<template>
  <div class="mobile-skills">
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
        <!-- Tab 切换 -->
        <div class="tab-bar">
          <button
            class="tab-btn"
            :class="{ active: activeTab === 'market' }"
            @click="activeTab = 'market'"
          >
            市场
          </button>
          <button
            class="tab-btn"
            :class="{ active: activeTab === 'mine' }"
            @click="activeTab = 'mine'"
          >
            我的技能
          </button>
          <button
            class="tab-btn"
            :class="{ active: activeTab === 'upload' }"
            @click="activeTab = 'upload'"
          >
            上传
          </button>
        </div>

        <!-- 市场 Tab -->
        <div v-if="activeTab === 'market'" class="tab-content">
          <div v-if="marketSkills.length === 0" class="empty-state">
            <div class="empty-icon">🎯</div>
            <div class="empty-text">暂无可用技能</div>
          </div>
          <div v-else class="skill-list">
            <div v-for="skill in marketSkills" :key="skill.name" class="skill-card">
              <div class="skill-info">
                <div class="skill-name">{{ skill.name }}</div>
                <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
                <div class="skill-meta">
                  <span class="meta-item">👤 {{ skill.sharer }}</span>
                  <span class="meta-item">📅 {{ formatDate(skill.sharedAt) }}</span>
                </div>
              </div>
              <button class="btn btn-p btn-sm" @click="installSkill(skill)">
                {{ skill.installed ? '重新安装' : '安装' }}
              </button>
            </div>
          </div>
        </div>

        <!-- 我的技能 Tab -->
        <div v-else-if="activeTab === 'mine'" class="tab-content">
          <div v-if="mySkills.length === 0" class="empty-state">
            <div class="empty-icon">🧩</div>
            <div class="empty-text">你还没有安装任何技能</div>
          </div>
          <div v-else class="skill-list">
            <div v-for="skill in mySkills" :key="skill.name" class="skill-card">
              <div class="skill-info">
                <div class="skill-name">{{ skill.name }}</div>
                <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
              </div>
              <span class="badge" :class="skill.type === 'published' ? 'b-green' : 'b-purple'">
                {{ skill.type === 'published' ? '已发布' : '已安装' }}
              </span>
            </div>
          </div>
        </div>

        <!-- 上传 Tab -->
        <div v-else-if="activeTab === 'upload'" class="tab-content">
          <div class="upload-card">
            <div class="upload-title">上传技能</div>
            <div class="upload-desc">
              分享你的技能给其他用户使用。技能将以文本格式上传，经过审核后发布到市场。
            </div>

            <div class="form-group">
              <label class="form-label">技能名称</label>
              <input
                v-model="uploadForm.name"
                type="text"
                class="form-input"
                placeholder="例如：my-awesome-skill"
              />
            </div>

            <div class="form-group">
              <label class="form-label">技能描述</label>
              <textarea
                v-model="uploadForm.description"
                class="form-textarea"
                placeholder="简要描述这个技能的功能..."
                rows="3"
              ></textarea>
            </div>

            <div class="form-group">
              <label class="form-label">技能内容</label>
              <textarea
                v-model="uploadForm.content"
                class="form-textarea mono"
                placeholder="粘贴技能内容（Markdown 格式）..."
                rows="10"
              ></textarea>
            </div>

            <button class="btn btn-p" @click="uploadSkill" :disabled="uploading">
              {{ uploading ? '上传中...' : '上传技能' }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'

const loading = ref(true)
const role = ref('user')
const activeTab = ref('market')
const marketSkills = ref([])
const mySkills = ref([])
const uploading = ref(false)

const uploadForm = ref({
  name: '',
  description: '',
  content: '',
})

function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString()
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
  try {
    const res = await axios.get('/api/skills/market')
    marketSkills.value = res.data || []
  } catch (e) {
    console.error('加载市场技能失败:', e)
  }
}

async function loadMySkills() {
  try {
    const res = await axios.get('/api/skills/mine')
    const data = res.data || {}
    mySkills.value = [
      ...(data.published || []).map((s) => ({ ...s, type: 'published' })),
      ...(data.installed || []).map((s) => ({ ...s, type: 'installed' })),
    ]
  } catch (e) {
    console.error('加载我的技能失败:', e)
  }
}

async function installSkill(skill) {
  if (!confirm(`确定要安装技能 "${skill.name}" 吗？`)) return

  try {
    await axios.post('/api/skills/install', { name: skill.name })
    alert(`技能 "${skill.name}" 安装成功！`)
    skill.installed = true
    await loadMySkills()
  } catch (e) {
    console.error('安装技能失败:', e)
    alert('安装失败: ' + (e.response?.data?.error || e.message))
  }
}

async function uploadSkill() {
  if (!uploadForm.value.name || !uploadForm.value.content) {
    alert('请填写技能名称和内容')
    return
  }

  if (!confirm('确定要上传这个技能吗？')) return

  uploading.value = true
  try {
    await axios.post('/api/skills/upload', {
      name: uploadForm.value.name,
      description: uploadForm.value.description,
      content: uploadForm.value.content,
    })
    alert('技能上传成功！')
    uploadForm.value = { name: '', description: '', content: '' }
    await loadMySkills()
  } catch (e) {
    console.error('上传技能失败:', e)
    alert('上传失败: ' + (e.response?.data?.error || e.message))
  } finally {
    uploading.value = false
  }
}

onMounted(async () => {
  try {
    await Promise.all([loadUserInfo(), loadMarketSkills(), loadMySkills()])
  } catch (e) {
    console.error('加载数据失败:', e)
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.mobile-skills {
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

/* Tab 切换 */
.tab-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  background: #fff;
  padding: 8px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
}

.tab-btn {
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

.tab-btn.active {
  background: linear-gradient(135deg, #6a72e8 0%, #9b8cf5 100%);
  color: #fff;
  box-shadow: 0 2px 8px rgba(106, 114, 232, 0.3);
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
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.skill-info {
  flex: 1;
}

.skill-name {
  font-size: 15px;
  font-weight: 700;
  color: #20242f;
  margin-bottom: 6px;
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
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
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

.btn-sm {
  padding: 8px 16px;
  font-size: 13px;
}

.btn:active:not(:disabled) {
  transform: scale(0.98);
}

/* 上传卡片 */
.upload-card {
  background: #fff;
  border-radius: 14px;
  padding: 20px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
}

.upload-title {
  font-size: 16px;
  font-weight: 700;
  color: #20242f;
  margin-bottom: 8px;
}

.upload-desc {
  font-size: 13px;
  color: #8a90a3;
  line-height: 1.6;
  margin-bottom: 20px;
}

.form-group {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #4b5162;
  margin-bottom: 6px;
}

.form-input,
.form-textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #e0e3eb;
  border-radius: 8px;
  font-size: 14px;
  color: #20242f;
  background: #fff;
  transition: all 0.2s;
}

.form-input:focus,
.form-textarea:focus {
  outline: none;
  border-color: #6a72e8;
  box-shadow: 0 0 0 3px rgba(106, 114, 232, 0.1);
}

.form-textarea {
  resize: vertical;
  font-family: inherit;
}

.form-textarea.mono {
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 13px;
}
</style>
