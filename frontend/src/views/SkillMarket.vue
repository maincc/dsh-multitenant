<template>
  <div class="skill-market">
    <!-- 左侧栏（与 React 原型稿一致） -->
    <aside class="gate-sidebar">
      <div class="sidebar-card">
        <nav class="sidebar-nav">
          <button
            v-for="tab in marketTabs"
            :key="tab.key"
            class="sidebar-item"
            :class="{ active: marketTab === tab.key }"
            @click="switchTab(tab.key)"
          >
            <span class="sidebar-icon" v-html="tab.icon"></span>
            <span>{{ tab.label }}</span>
          </button>
        </nav>
      </div>
    </aside>

    <!-- 右侧内容 -->
    <section class="gate-content">
      <!-- ════════ 技能市场 ════════ -->
      <div v-if="marketTab === 'market'" class="tab-content">
        <div class="tab-head">
          <h4>{{ $t('skills.marketTitle') }}</h4>
          <p class="tab-hint">{{ $t('skills.marketHint') }}</p>
        </div>
        <div class="market-tools">
          <input
            v-model="keyword"
            class="search-input"
            :placeholder="$t('skills.searchPlaceholder')"
          />
          <button class="btn btn-secondary" :disabled="loading" @click="loadList">
            {{ $t('skills.refresh') }}
          </button>
        </div>

        <div v-if="!ccdao" class="notice notice-error">
          {{ $t('skills.noCcdao') }}
          <a
            href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
            target="_blank"
            rel="noopener noreferrer"
            >CCDAO Connector</a
          >{{ $t('skills.noCcdaoTail') }}
        </div>
        <div v-else-if="!connected" class="notice">
          {{ $t('skills.browseNoLogin') }} <strong>{{ $t('skills.installDownload') }}</strong
          >{{ $t('skills.browseNeedSig') }}
          <router-link to="/user">{{ $t('common.nav.user') }}</router-link>
          {{ $t('skills.browseConnectTail') }}
        </div>

        <div v-if="loading" class="config-loading">
          <div class="mini-spinner"></div>
          <span>{{ $t('skills.loadingList') }}</span>
        </div>
        <div v-else-if="filtered.length === 0" class="hint">{{ $t('skills.empty') }}</div>
        <div v-else class="skill-grid">
          <div v-for="s in filtered" :key="s.name" class="skill-card">
            <div class="skill-card-head">
              <strong>{{ s.name }}</strong>
              <span v-if="s.installed" class="badge badge-success">{{
                $t('skills.installed')
              }}</span>
              <span v-if="s.disableModelInvocation" class="badge badge-warning">{{
                $t('skills.userOnlyBadge')
              }}</span>
            </div>
            <p class="skill-description">{{ s.description }}</p>
            <div class="skill-meta">
              <span class="skill-sharer" :title="s.sharer">{{ shortAddress(s.sharer) }}</span>
              <span>{{ new Date(s.sharedAt).toLocaleDateString() }}</span>
              <span v-if="s.hasResources" class="badge badge-info">{{
                $t('skills.hasResources')
              }}</span>
            </div>
            <div class="skill-card-actions">
              <button class="btn btn-small" @click="openDetail(s.name)">
                {{ $t('skills.preview') }}
              </button>
              <a class="btn btn-small btn-secondary" :href="downloadUrl(s.name)" download>{{
                $t('skills.download')
              }}</a>
              <button
                class="btn btn-small btn-primary"
                :disabled="!connected || installing"
                @click="install(s.name)"
              >
                {{ s.installed ? $t('skills.reinstall') : $t('skills.install') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ════════ 我的技能 ════════ -->
      <div v-else class="tab-content">
        <div class="tab-head">
          <h4>{{ $t('skills.tabMine') }}</h4>
          <p class="tab-hint">{{ $t('skills.mineHint') }}</p>
        </div>

        <div v-if="mineLoading" class="config-loading">
          <div class="mini-spinner"></div>
          <span>{{ $t('skills.loadingList') }}</span>
        </div>
        <template v-else>
          <div v-if="mineData.published.length > 0" class="skill-subsection">
            <h4>{{ $t('skills.minePublished') }}</h4>
            <div v-for="s in mineData.published" :key="'p-' + s.name" class="skill-row">
              <div class="skill-row-main">
                <strong>{{ s.name }}</strong>
                <span class="skill-desc">{{ s.description || '' }}</span>
              </div>
              <span class="badge badge-info">{{ $t('skills.minePublishedTag') }}</span>
            </div>
          </div>
          <div v-if="mineData.installed.length > 0" class="skill-subsection">
            <h4>{{ $t('skills.mineInstalled') }}</h4>
            <div v-for="s in mineData.installed" :key="'i-' + s.name" class="skill-row">
              <div class="skill-row-main">
                <strong>{{ s.name }}</strong>
                <span class="skill-desc">{{ s.description || '' }}</span>
              </div>
              <span v-if="s.hasUpdate" class="badge badge-warning">{{
                $t('skills.hasUpdate')
              }}</span>
            </div>
          </div>
          <div
            v-if="mineData.published.length === 0 && mineData.installed.length === 0"
            class="mine-empty"
          >
            <span class="mine-empty-icon">🧩</span>
            <p>{{ $t('skills.mineEmpty') }}</p>
            <router-link to="/user" class="btn btn-primary">{{
              $t('skills.mineManageLink')
            }}</router-link>
          </div>
          <p class="hint">{{ $t('skills.mineManageHint') }}</p>
        </template>
      </div>
    </section>

    <!-- 详情弹窗：安装前必须预览全文 -->
    <div v-if="detail || detailLoading" class="modal-mask" @click.self="closeDetail">
      <div v-if="detailLoading && !detail" class="modal-panel detail-panel">
        <div class="detail-head">
          <h3>{{ $t('skills.detailTitle') }}</h3>
          <button class="btn btn-small" @click="closeDetail">✕</button>
        </div>
        <div class="config-loading">
          <div class="mini-spinner"></div>
          <span>{{ $t('skills.loadingDetail') }}</span>
        </div>
      </div>
      <div v-else-if="detail" class="modal-panel detail-panel">
        <div class="detail-head">
          <h3>{{ detail.name }}</h3>
          <button class="btn btn-small" @click="closeDetail">✕</button>
        </div>
        <p class="skill-description">{{ detail.description }}</p>
        <p class="skill-meta">
          {{
            $t('skills.detailMeta', {
              sharer: detail.sharer,
              date: new Date(detail.sharedAt).toLocaleString(),
            })
          }}{{ $t('skills.detailHash') }}
          <code class="hash" :title="detail.contentHash || ''">{{
            shortHash(detail.contentHash)
          }}</code>
          <span v-if="detail.disableModelInvocation" class="badge badge-warning">{{
            $t('skills.userOnlyTrigger')
          }}</span>
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
            {{
              installing
                ? $t('skills.installing')
                : detail.installed
                  ? $t('skills.reinstall')
                  : $t('skills.signInstall')
            }}
          </button>
          <button class="btn btn-secondary" @click="closeDetail">{{ $t('skills.close') }}</button>
        </div>
        <p v-if="!connected && ccdao" class="hint">
          {{ $t('skills.needConnectA') }}
          <router-link to="/user">{{ $t('common.nav.user') }}</router-link>
          {{ $t('skills.needConnectB') }}
        </p>
        <p class="hint hint-warn">{{ $t('skills.detailWarn') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { skillsApi } from '../api/skills.js'
import {
  ccdaoAvailable,
  friendlyPluginError,
  signChallenge,
  watchAccountsChanged,
} from '../api/wallet.js'

const { t } = useI18n()

// ---- 侧栏导航（与 React 原型稿一致） ----
const marketTab = ref('market')
const marketTabs = [
  {
    key: 'market',
    label: t('skills.tabMarket'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
  },
  {
    key: 'mine',
    label: t('skills.tabMine'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
  },
]

const switchTab = (key) => {
  marketTab.value = key
  if (key === 'mine') loadMine()
}

const skills = ref([])
const keyword = ref('')
const loading = ref(true) // 初始即 loading：进入页面先显示"正在获取技能列表…"，避免空态闪现
const detail = ref(null)
const detailLoading = ref(false) // 详情拉取中的 loading（预览弹窗先出现、后填内容）
const installing = ref(false)
const connected = ref(Boolean(localStorage.getItem('swtc_address')))
const ccdao = ref(ccdaoAvailable())
// 账户监听解绑函数（卸载时调用）
let unbindAccounts = null

// ---- 我的技能（个人视图，无需签名） ----
const mineLoading = ref(false)
const mineData = ref({ published: [], installed: [] })

const loadMine = async () => {
  const address = localStorage.getItem('swtc_address')
  if (!address || mineLoading.value) return
  mineLoading.value = true
  try {
    const res = await skillsApi.mineView(address)
    mineData.value = {
      published: res.published || [],
      installed: res.installed || [],
    }
  } catch (err) {
    console.warn('[skills] 加载我的技能失败（忽略）:', err)
  } finally {
    mineLoading.value = false
  }
}

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
    alert(t('skills.errList', { err: friendlyPluginError(err) }))
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
    alert(t('skills.errDetail', { err: friendlyPluginError(err) }))
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
    alert(t('skills.errNotConnected'))
    return
  }

  // P0-4 供应链边界：安装前确认 + 风险提示
  const isDetail = detail.value?.name === name
  const target = (isDetail ? detail.value : skills.value.find((s) => s.name === name)) || {}
  const autoLine = target.modelAutoInvoke ? t('skills.confirmAutoYes') : t('skills.confirmAutoNo')
  const publisher = target.sharer ? shortAddress(target.sharer) : t('skills.unknown')
  const confirmed = confirm(
    `${t('skills.confirmTitle', { name })}\n\n` +
      `${t('skills.confirmRisk')}\n` +
      `${t('skills.confirmPublisher', { publisher })}\n\n` +
      `${autoLine}\n\n` +
      t('skills.confirmAsk'),
  )
  if (!confirmed) return

  installing.value = true
  try {
    const auth = await signChallenge()
    await skillsApi.install(auth, name)
    alert(t('skills.okInstalled', { name }))
    detail.value = null
    detailLoading.value = false
    await loadList()
  } catch (err) {
    alert(t('skills.errInstall', { err: friendlyPluginError(err) }))
  } finally {
    installing.value = false
  }
}

onMounted(() => {
  ccdao.value = ccdaoAvailable()
  loadList()
  // 钱包地址切换：同步"已连接"状态并按新地址刷新技能列表（与用户中心共用监听通道）
  unbindAccounts = watchAccountsChanged((accounts) => {
    const hasAccount = Boolean(accounts && accounts.length > 0)
    connected.value = hasAccount
    if (hasAccount) loadList()
  })
})

onUnmounted(() => {
  unbindAccounts?.()
  unbindAccounts = null
})
</script>

<style scoped>
.skill-market {
  height: 100%;
  display: flex;
  gap: 1rem;
  padding: 1.25rem;
  align-items: stretch;
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

/* ─── 左侧栏 ─── */
.gate-sidebar {
  width: 176px;
  flex-shrink: 0;
}

.sidebar-card {
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
  padding: 0.5rem;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding-top: 0.25rem;
}

.sidebar-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.75rem;
  border: none;
  background: transparent;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s;
}

.sidebar-item:hover {
  background: #f8fafc;
  color: #475569;
}

.sidebar-item.active {
  background: #eef0f8;
  color: #6b7bdb;
}

.sidebar-icon {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.sidebar-icon :deep(svg) {
  display: block;
}

/* ─── 右侧内容卡 ─── */
.gate-content {
  flex: 1;
  min-width: 0;
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
  padding: 1.5rem;
  overflow-y: auto;
}

.tab-content {
  animation: fadeIn 0.25s;
}

.tab-head h4 {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
  margin-bottom: 0.125rem;
}

.tab-hint {
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.6;
  margin-bottom: 1rem;
}

.market-tools {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 1rem;
}

.search-input {
  padding: 0.5rem 0.75rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  font-size: 0.9rem;
  width: 240px;
  box-sizing: border-box;
  outline: none;
  color: #1e293b;
  background: #fff;
}

.search-input:focus {
  border-color: #6b7bdb;
  box-shadow: 0 0 0 3px rgba(107, 123, 219, 0.15);
}

.notice {
  padding: 0.75rem 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
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

/* ─── 我的技能 ─── */
.skill-subsection {
  margin-top: 1rem;
}

.skill-subsection h4 {
  font-size: 0.95rem;
  color: #334155;
  margin: 0 0 0.5rem;
}

.skill-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid #f1f5f9;
  border-radius: 10px;
  margin-bottom: 0.5rem;
  background: #f8fafc;
}

.skill-row-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.skill-row-main strong {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9rem;
}

.skill-desc {
  font-size: 0.8rem;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mine-empty {
  text-align: center;
  padding: 2.5rem 0;
}

.mine-empty-icon {
  font-size: 2.5rem;
  display: block;
  margin-bottom: 0.5rem;
}

.mine-empty p {
  color: #94a3b8;
  font-size: 0.9rem;
  margin-bottom: 1rem;
}

/* ─── 详情弹窗 ─── */
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
  border-radius: 16px;
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
  background: #f8fafc;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  border: 1px solid #f1f5f9;
}

.detail-body {
  flex: 1;
  overflow: auto;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
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

.hint {
  font-size: 0.875rem;
  color: #64748b;
  line-height: 1.6;
}

/* 分享者缩写地址：悬停显示完整地址 */
.skill-sharer[title] {
  cursor: help;
}

.hash[title] {
  cursor: help;
}
</style>
