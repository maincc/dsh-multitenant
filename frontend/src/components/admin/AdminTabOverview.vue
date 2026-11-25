<!-- 系统概览 tab（P3 拆分自 AdminPanel）。会话域（logout）与签名经壳注入；
     孤儿卷域全自包含随组件走。 -->
<script setup>
import { ref, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast, askConfirm } from '../../composables/useDialog'

defineProps({
  stats: { type: Object, default: () => ({}) },
  currentAddress: { type: String, default: '' },
  currentAdminAddress: { type: String, default: '' },
  dockerAvailable: { type: Boolean, default: false },
  refreshIntervalMs: { type: Number, default: 15000 },
})
defineEmits(['refresh'])

const { t } = useI18n()
const signAdminOperation = inject('adminSign')
const logout = inject('adminLogout')

const orphanVolumes = ref([])
const orphanScanning = ref(false)
const orphanNotice = ref('')

const scanOrphanVolumes = async () => {
  orphanScanning.value = true
  orphanNotice.value = ''
  try {
    const res = await adminOpsApi.orphanVolumes()
    orphanVolumes.value = res.orphanVolumes || []
    orphanNotice.value = orphanVolumes.value.length
      ? t('admin.orphanFound', { n: orphanVolumes.value.length })
      : t('admin.orphanNone')
  } catch (err) {
    toast(t('admin.orphanScanFail', { err: err.response?.data?.error || err.message }))
  } finally {
    orphanScanning.value = false
  }
}
// ---- 孤儿数据卷（扫描 + 清理） ----
const cleanupOrphanVolumes = async () => {
  if (!orphanVolumes.value.length) return
  await askConfirm({
    message: t('admin.orphanConfirm', { n: orphanVolumes.value.length }),
    details: [...orphanVolumes.value],
    danger: true,
    confirmLabel: t('admin.orphanCleanBtn', { n: orphanVolumes.value.length }),
    run: async () => {
      try {
        // 批量删卷是不可逆操作 → 签名绑"删哪几个卷"（服务端只删 签署清单∩仍是孤儿 的交集）
        const headers = await signAdminOperation('cleanup-orphan-volumes', {
          volumes: [...orphanVolumes.value],
        })
        const res = await adminOpsApi.cleanupOrphan(orphanVolumes.value, headers)
        const { removed = [], failed = [], skipped = [] } = res || {}
        const parts = [t('admin.orphanCleaned', { ok: removed.length, fail: failed.length })]
        if (skipped.length) parts.push(t('admin.orphanSkipped', { n: skipped.length }))
        orphanNotice.value = parts.join('，')
        // 刷新列表：剩下的就是删除失败的
        orphanVolumes.value = (failed || []).map((f) => f.name)
      } catch (err) {
        toast(t('admin.orphanCleanFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}
</script>

<template>
  <div>
    <AdminTabHead
      :title="$t('admin.tabOverview')"
      :hint="$t('admin.overviewHint')"
      :loading="loading"
      :interval-ms="refreshIntervalMs"
      @refresh="$emit('refresh')"
    />

    <!-- 当前管理员信息 -->
    <div class="admin-info-card">
      <div class="admin-info">
        <div class="admin-label">{{ $t('admin.currentAdminLabel') }}</div>
        <code class="admin-address">{{ currentAddress || currentAdminAddress }}</code>
        <button class="btn btn-small btn-danger" @click="logout">
          {{ $t('admin.logout') }}
        </button>
      </div>
    </div>

    <!-- Docker 状态指示器 -->
    <div class="docker-status-card" :class="dockerAvailable ? 'docker-ok' : 'docker-error'">
      <div class="docker-status">
        <div class="status-icon"></div>
        <div class="status-info">
          <div class="status-label">{{ $t('admin.dockerStatus') }}</div>
          <div class="status-text">
            {{ dockerAvailable ? $t('admin.running') : $t('admin.notRunning') }}
          </div>
        </div>
        <div v-if="!dockerAvailable" class="status-hint">{{ $t('admin.dockerHint') }}</div>
      </div>
    </div>

    <!-- 系统统计 -->
    <div class="stats-grid">
      <div class="stat-card">
        <h3>{{ $t('admin.statTotal') }}</h3>
        <div class="value">{{ stats.totalUsers }}</div>
      </div>
      <div class="stat-card">
        <h3>{{ $t('admin.running') }}</h3>
        <div class="value">{{ stats.runningUsers }}</div>
      </div>
      <div class="stat-card">
        <h3>{{ $t('admin.statTier1') }}</h3>
        <div class="value">{{ stats.tierCounts[1] || 0 }}</div>
      </div>
      <div class="stat-card">
        <h3>{{ $t('admin.statTier2') }}</h3>
        <div class="value">{{ stats.tierCounts[2] || 0 }}</div>
      </div>
    </div>

    <!-- 孤儿数据卷清理 -->
    <div class="sub-section">
      <h4>{{ $t('admin.orphanTitle') }}</h4>
      <p class="tab-hint">{{ $t('admin.orphanHint') }}</p>
      <div class="action-buttons">
        <button class="btn btn-warning" @click="scanOrphanVolumes" :disabled="orphanScanning">
          {{ orphanScanning ? $t('admin.orphanScanning') : $t('admin.orphanScanBtn') }}
        </button>
        <button
          v-if="orphanVolumes.length > 0"
          class="btn btn-danger"
          @click="cleanupOrphanVolumes"
        >
          {{ $t('admin.orphanCleanBtn', { n: orphanVolumes.length }) }}
        </button>
      </div>
      <div v-if="orphanNotice" class="orphan-notice">{{ orphanNotice }}</div>
      <ul v-if="orphanVolumes.length > 0" class="orphan-list">
        <li v-for="v in orphanVolumes" :key="v" class="orphan-item">
          <span class="orphan-name">{{ v }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.admin-info-card {
  background: linear-gradient(135deg, var(--brand-text) 0%, #6c69c2 100%);
  color: white;
  border-radius: 12px;
  padding: 0.875rem 1.25rem;
  margin-bottom: 1rem;
}

.admin-info {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.admin-label {
  font-weight: 600;
  font-size: 0.95rem;
  flex-shrink: 0;
}

.admin-address {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: rgba(255, 255, 255, 0.2);
  padding: 0.4rem 0.875rem;
  border-radius: 8px;
  flex: 1;
  font-size: 0.85rem;
  word-break: break-all;
}

.admin-info .btn-danger {
  color: white;
  border-color: rgba(255, 255, 255, 0.4);
  background: rgba(255, 255, 255, 0.12);
  margin-left: 0;
}

.admin-info .btn-danger:hover {
  background: rgba(255, 255, 255, 0.22);
}

.docker-status-card {
  padding: 0.875rem 1.25rem;
  border-radius: 12px;
  margin-bottom: 1rem;
  transition: all 0.3s;
  color: white;
}

.docker-status-card.docker-ok {
  background: linear-gradient(135deg, var(--success) 0%, #059669 100%);
}

.docker-status-card.docker-error {
  background: linear-gradient(135deg, #ef4444 0%, var(--danger) 100%);
}

.docker-status {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.status-icon {
  font-size: 1.5rem;
}

.status-info {
  flex: 1;
}

.status-label {
  font-weight: 600;
  font-size: 0.85rem;
  opacity: 0.9;
}

.status-text {
  font-size: 1.05rem;
  font-weight: 700;
}

.status-hint {
  font-size: 0.85rem;
  opacity: 0.9;
  margin-top: 0.25rem;
  flex: 1;
  text-align: right;
}

.action-buttons {
  display: flex;
  gap: 0.75rem;
  margin: 1rem 0;
  flex-wrap: wrap;
}

.orphan-notice {
  margin-top: 0.6rem;
  font-size: 0.85rem;
  text-align: center;
  color: var(--text-secondary);
}

.orphan-list {
  margin-top: 0.6rem;
  list-style: none;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;
}

.orphan-item {
  padding: 0.25rem 0.4rem;
  border-bottom: 1px dashed var(--surface-soft);
}

.orphan-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  word-break: break-all;
}
</style>
