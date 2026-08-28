<template>
  <div class="skill-market">
    <div class="card">
      <div class="market-head">
        <h2>🏪 技能市场</h2>
        <div class="market-tools">
          <input v-model="keyword" class="search-input" placeholder="搜索技能名 / 描述…" />
          <button class="btn btn-secondary" :disabled="loading" @click="loadList">🔄 刷新</button>
        </div>
      </div>

      <div v-if="!ccdao" class="notice notice-error">
        ❌ 未检测到 CCDAO 插件，无法安装技能（浏览不受影响）。请先安装
        <a
          href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
          target="_blank"
          >CCDAO Connector</a
        >。
      </div>
      <div v-else-if="!connected" class="notice">
        💡 浏览无需登录；<strong>安装 / 下载</strong>需要钱包签名——请先到
        <router-link to="/user">用户中心</router-link> 连接钱包。
      </div>

      <div v-if="loading" class="config-loading">
        <div class="mini-spinner"></div>
        <span>正在获取技能列表…</span>
      </div>
      <div v-else-if="filtered.length === 0" class="hint">没有可用的共享技能</div>
      <div v-else class="skill-grid">
        <div v-for="s in filtered" :key="s.name" class="skill-card">
          <div class="skill-card-head">
            <strong>{{ s.name }}</strong>
            <span v-if="s.installed" class="badge badge-success">已安装</span>
            <span v-if="s.disableModelInvocation" class="badge badge-warning">仅用户侧</span>
          </div>
          <p class="skill-description">{{ s.description }}</p>
          <div class="skill-meta">
            <span>{{ shortAddress(s.sharer) }}</span>
            <span>{{ new Date(s.sharedAt).toLocaleDateString() }}</span>
            <span v-if="s.hasResources" class="badge badge-info">含资源</span>
          </div>
          <div class="skill-card-actions">
            <button class="btn btn-small" @click="openDetail(s.name)">预览</button>
            <a class="btn btn-small btn-secondary" :href="downloadUrl(s.name)" download>下载</a>
            <button
              class="btn btn-small btn-primary"
              :disabled="!connected || installing"
              @click="install(s.name)"
            >
              {{ s.installed ? '重新安装' : '安装' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 详情弹窗：安装前必须预览全文 -->
    <div v-if="detail || detailLoading" class="modal-mask" @click.self="closeDetail">
      <div v-if="detailLoading && !detail" class="modal-panel detail-panel">
        <div class="detail-head">
          <h3>技能详情</h3>
          <button class="btn btn-small" @click="closeDetail">✕</button>
        </div>
        <div class="config-loading">
          <div class="mini-spinner"></div>
          <span>正在获取技能详情…</span>
        </div>
      </div>
      <div v-else-if="detail" class="modal-panel detail-panel">
        <div class="detail-head">
          <h3>{{ detail.name }}</h3>
          <button class="btn btn-small" @click="closeDetail">✕</button>
        </div>
        <p class="skill-description">{{ detail.description }}</p>
        <p class="skill-meta">
          分享者 {{ detail.sharer }} · {{ new Date(detail.sharedAt).toLocaleString() }} · 哈希
          <code class="hash">{{ shortHash(detail.contentHash) }}</code>
          <span v-if="detail.disableModelInvocation" class="badge badge-warning"
            >仅用户侧可触发</span
          >
        </p>
        <div class="detail-body">
          <pre>{{ detail.body }}</pre>
        </div>
        <div class="detail-actions">
          <button
            class="btn btn-primary"
            :disabled="!connected || installing"
            @click="install(detail.name)"
          >
            {{ installing ? '安装中…' : detail.installed ? '重新安装' : '签名并安装' }}
          </button>
          <button class="btn btn-secondary" @click="closeDetail">关闭</button>
        </div>
        <p v-if="!connected && ccdao" class="hint">
          安装需要钱包签名：请先到 <router-link to="/user">用户中心</router-link> 连接钱包
        </p>
        <p class="hint hint-warn">
          ⚠️ 技能正文会注入模型上下文，安装前请确认内容可信；可核对上方内容哈希溯源。
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { skillsApi } from '../api/skills.js'
import { ccdaoAvailable, friendlyPluginError, signChallenge } from '../api/wallet.js'

const skills = ref([])
const keyword = ref('')
const loading = ref(true) // 初始即 loading：进入页面先显示"正在获取技能列表…"，避免空态闪现
const detail = ref(null)
const detailLoading = ref(false) // 详情拉取中的 loading（预览弹窗先出现、后填内容）
const installing = ref(false)
const connected = ref(Boolean(localStorage.getItem('swtc_address')))
const ccdao = ref(ccdaoAvailable())

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return skills.value
  return skills.value.filter(
    (s) => s.name.toLowerCase().includes(k) || (s.description || '').toLowerCase().includes(k),
  )
})

const shortAddress = (addr) => (addr ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : '')
const shortHash = (h) => (h ? h.slice(0, 12) : '')

const loadList = async () => {
  loading.value = true
  try {
    const address = localStorage.getItem('swtc_address') || undefined
    const res = await skillsApi.list(address)
    skills.value = res.skills || []
    if (detail.value) {
      const cur = skills.value.find((s) => s.name === detail.value.name)
      if (cur) detail.value = { ...detail.value, installed: cur.installed }
    }
  } catch (err) {
    alert('加载技能列表失败：' + friendlyPluginError(err))
  } finally {
    loading.value = false
  }
}

const openDetail = async (name) => {
  // 先打开弹窗并显示 loading，数据到了再填充正文
  detail.value = null
  detailLoading.value = true
  try {
    const res = await skillsApi.detail(name)
    detail.value = res.skill
  } catch (err) {
    alert('加载详情失败：' + friendlyPluginError(err))
  } finally {
    detailLoading.value = false
  }
}

const closeDetail = () => {
  detail.value = null
  detailLoading.value = false
}

const downloadUrl = (name) => skillsApi.downloadUrl(name)

const install = async (name) => {
  if (!connected.value) {
    alert('请先在用户中心连接钱包后再安装')
    return
  }
  installing.value = true
  try {
    const auth = await signChallenge()
    await skillsApi.install(auth, name)
    alert(`技能 ${name} 安装成功，DSH 会话中可直接使用`)
    detail.value = null
    detailLoading.value = false
    await loadList()
  } catch (err) {
    alert('安装失败：' + friendlyPluginError(err))
  } finally {
    installing.value = false
  }
}

onMounted(() => {
  ccdao.value = ccdaoAvailable()
  loadList()
})
</script>

<style scoped>
.market-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.market-tools {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.search-input {
  padding: 0.5rem 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 0.9rem;
  width: 240px;
  box-sizing: border-box;
}

.notice {
  padding: 0.6rem 0.9rem;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #f8fafc;
  color: #475569;
  font-size: 0.9rem;
  margin-bottom: 1rem;
}

.notice-error {
  border-color: #fca5a5;
  background: #fef2f2;
  color: #b91c1c;
}

.skill-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.skill-card {
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  background: #fff;
}

.skill-card-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.skill-card-head strong {
  font-size: 1.05rem;
  color: #1e293b;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.skill-description {
  margin: 0;
  color: #475569;
  font-size: 0.9rem;
  line-height: 1.5;
  flex: 1;
}

.skill-meta {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  font-size: 0.78rem;
  color: #94a3b8;
  flex-wrap: wrap;
}

.skill-card-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal-panel {
  background: #fff;
  border-radius: 14px;
  padding: 1.5rem;
  max-width: 720px;
  width: calc(100% - 2rem);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}

.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.detail-head h3 {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.hash {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  background: #f1f5f9;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}

.detail-body {
  flex: 1;
  overflow: auto;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.detail-body pre {
  margin: 0;
  padding: 1rem;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  line-height: 1.6;
  color: #1e293b;
}

.detail-actions {
  display: flex;
  gap: 0.5rem;
}

.hint-warn {
  color: #92400e;
}
</style>
