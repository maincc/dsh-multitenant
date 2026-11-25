<!-- 资源监控 tab（P3 拆分自 AdminPanel）。stats 由壳 fetchData 下发；
     精确扫描结果经 disk-scan 事件回壳合并（props 单向流，判例 58 防线）。 -->
<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from '../../composables/useDialog'
import { shortAddress, formatBytes } from '../../utils/format.js'
import { tierBadge, statusBadge, fmtTime, makeStatusText } from './shared.js'
import { adminOpsApi } from '../../api/adminOps.js'
import AdminTabHead from './AdminTabHead.vue'

const props = defineProps({
  users: { type: Array, default: () => [] },
  stats: { type: Object, default: () => ({}) },
  loading: { type: Boolean, default: false },
  refreshIntervalMs: { type: Number, default: 15000 },
})
const emit = defineEmits(['refresh', 'disk-scan'])

const { t } = useI18n()
const statusText = makeStatusText(t)

const diskScanning = ref(false)
/** 手动触发精确扫描：du 实测每个租户卷真实占用（O(n)，管理员按需调用） */
const runDiskScan = async () => {
  if (diskScanning.value) return
  diskScanning.value = true
  try {
    const res = await adminOpsApi.diskScan()
    // 扫描结果直接合并进本地 stats，避免等待下一次轮询
    const { scanned, volumes } = res
    // props 不可变：合并动作回壳（mergeDiskScan），组件只报告扫描结果
    if (scanned) emit('disk-scan', res)
    toast(t('admin.diskScanDone', { n: volumes?.length ?? 0 }))
  } catch (err) {
    toast(t('admin.diskScanFail', { err: err.response?.data?.error || err.message }))
  } finally {
    diskScanning.value = false
  }
}

/** KB → 人类可读容量（如 "52.2 GB"） */
const fmtDisk = (kb) => {
  const b = Number(kb)
  if (!Number.isFinite(b) || b <= 0) return '-'
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} TB`
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} GB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} MB`
  return `${kb} KB`
}

/** 宿主磁盘使用率样式 */
const usagePctClass = (pct) => {
  const n = Number.parseFloat(String(pct ?? ''))
  if (!Number.isFinite(n)) return ''
  if (n >= 80) return 'mem-pct-high'
  if (n >= 60) return 'mem-pct-warn'
  return 'mem-pct-ok'
}

/** 内存占比样式：达到自动升级阈值（80%）时高亮警示 */
const memPctClass = (pct) => {
  const n = Number.parseFloat(String(pct ?? ''))
  if (!Number.isFinite(n)) return ''
  if (n >= 80) return 'mem-pct-high'
  if (n >= 60) return 'mem-pct-warn'
  return 'mem-pct-ok'
}

/** Docker 存储类型 → 中文名 */
const dockerTypeLabel = (name) => {
  const map = {
    Images: t('admin.diskTypeImages'),
    Containers: t('admin.diskTypeContainers'),
    'Local Volumes': t('admin.diskTypeLocalVolumes'),
    'Build Cache': t('admin.diskTypeBuildCache'),
  }
  return map[name] || name
}

/** 解析 docker 大小字符串（"101.3kB" / "602.1MB" / "1.2GB"）→ 字节数 */
const parseSize = (s) => {
  const m = String(s ?? '')
    .trim()
    .match(/^([\d.]+)\s*([kKmMgGtT]?)[bB]?$/)
  if (!m) return 0
  const n = Number.parseFloat(m[1])
  const unit = (m[2] || '').toLowerCase()
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit] || 1
  return n * mult
}

/** 实测值与引擎口径差异高亮：偏差 ≥2 倍标黄，≥10 倍标红（提示引擎口径失真） */
const actualSizeClass = (engineSize, actualBytes) => {
  const engine = parseSize(engineSize)
  const actual = Number(actualBytes)
  if (!engine || !Number.isFinite(actual) || actual <= 0) return ''
  const ratio = actual / engine
  if (ratio >= 10) return 'mem-pct-high'
  if (ratio >= 2) return 'mem-pct-warn'
  return 'mem-pct-ok'
}

/** 按地址查租户数据卷大小（volume 名形如 dsh-data-swtc-<address>） */
const volumeSize = (address) => {
  const volumes = props.stats.resource?.disk?.volumes
  if (!Array.isArray(volumes) || !address) return '-'
  const hit = volumes.find((v) => v.volume === `dsh-data-swtc-${address}`)
  if (!hit) return '-'
  // 有 du 实测值优先展示（真实占用），否则回退引擎口径
  return hit.sizeActual ? formatBytes(hit.sizeActual) : hit.size
}
</script>

<template>
  <div>
    <AdminTabHead
      :title="$t('admin.tabMonitor')"
      :hint="$t('admin.monitorHint')"
      :loading="loading"
      :interval-ms="refreshIntervalMs"
      @refresh="$emit('refresh')"
    />

    <!-- 资源监控（M2：自动升级） -->
    <div class="sub-section">
      <h4>{{ $t('admin.monitorTitle') }}</h4>

      <!-- 监控配置卡 -->
      <div class="monitor-config">
        <div class="monitor-item">
          <span class="monitor-label">{{ $t('admin.monitorThreshold') }}</span>
          <span class="monitor-value"> {{ stats.resource?.autoUpgradeThreshold ?? 80 }}% </span>
        </div>
        <div class="monitor-item">
          <span class="monitor-label">{{ $t('admin.monitorInterval') }}</span>
          <span class="monitor-value">
            {{ ((stats.resource?.monitorIntervalMs ?? 30000) / 1000).toFixed(0) }}s
          </span>
        </div>
        <div class="monitor-item">
          <span class="monitor-label">{{ $t('admin.monitorCooldown') }}</span>
          <span class="monitor-value">
            {{ ((stats.resource?.autoUpgradeCooldownMs ?? 600000) / 60000).toFixed(0) }}min
          </span>
        </div>
        <div class="monitor-item">
          <span class="monitor-label">{{ $t('admin.monitorUpgraded') }}</span>
          <span class="monitor-value monitor-upgraded">
            {{ $t('admin.monitorUpgradedCount', { n: stats.resource?.autoUpgradeCount ?? 0 }) }}
          </span>
        </div>
      </div>

      <!-- 各容器资源一览 -->
      <h5 class="monitor-subtitle">{{ $t('admin.monitorUsersTitle') }}</h5>
      <p class="tab-hint">{{ $t('admin.monitorUsersHint') }}</p>
      <table v-if="users.length">
        <thead>
          <tr>
            <th>{{ $t('admin.monitorColAddress') }}</th>
            <th>{{ $t('admin.monitorColTier') }}</th>
            <th>{{ $t('admin.monitorColStatus') }}</th>
            <th>{{ $t('admin.monitorColMem') }}</th>
            <th>{{ $t('admin.monitorColMemPct') }}</th>
            <th>{{ $t('admin.monitorColCpu') }}</th>
            <th>{{ $t('admin.monitorColVolume') }}</th>
            <th>{{ $t('admin.monitorColUpgraded') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.address">
            <td class="cwt-mono addr-tip" :data-full="u.address">
              {{ shortAddress(u.address) }}
            </td>
            <td>
              <span class="badge" :class="tierBadge(u.tier)">
                {{ u.tierLabel }}
              </span>
            </td>
            <td>
              <span class="badge" :class="statusBadge(u.status)">
                {{ statusText(u.status) }}
              </span>
            </td>
            <td>{{ u.stats ? u.stats.memory : '-' }}</td>
            <td>
              <span v-if="u.stats" class="mem-pct" :class="memPctClass(u.stats.memoryPercent)">
                {{ u.stats.memoryPercent }}
              </span>
              <span v-else>-</span>
            </td>
            <td>{{ u.stats ? u.stats.cpu : '-' }}</td>
            <td>{{ volumeSize(u.address) }}</td>
            <td>
              <span v-if="u.lastAutoUpgradeAt" class="badge badge-success">
                {{ $t('admin.monitorUpgradedAt', { time: fmtTime(u.lastAutoUpgradeAt) }) }}
              </span>
              <span v-else class="monitor-never">{{ $t('admin.monitorNever') }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="monitor-empty">{{ $t('admin.monitorNoUsers') }}</div>
    </div>

    <!-- 磁盘监控 -->
    <div class="sub-section">
      <h4>{{ $t('admin.diskTitle') }}</h4>
      <p class="tab-hint">
        {{
          $t('admin.diskHint', {
            n: ((stats.resource?.diskCheckIntervalMs ?? 300000) / 60000).toFixed(0),
          })
        }}
      </p>

      <template v-if="stats.resource?.disk">
        <!-- 宿主磁盘 -->
        <h5 class="monitor-subtitle">{{ $t('admin.diskHostTitle') }}</h5>
        <div class="monitor-config">
          <div class="monitor-item">
            <span class="monitor-label">{{ $t('admin.diskTotal') }}</span>
            <span class="monitor-value">{{ fmtDisk(stats.resource.disk.host?.totalKB || 0) }}</span>
          </div>
          <div class="monitor-item">
            <span class="monitor-label">{{ $t('admin.diskUsed') }}</span>
            <span class="monitor-value">{{ fmtDisk(stats.resource.disk.host?.usedKB || 0) }}</span>
          </div>
          <div class="monitor-item">
            <span class="monitor-label">{{ $t('admin.diskAvailable') }}</span>
            <span class="monitor-value">{{
              fmtDisk(stats.resource.disk.host?.availableKB || 0)
            }}</span>
          </div>
          <div class="monitor-item">
            <span class="monitor-label">{{ $t('admin.diskUsage') }}</span>
            <span
              class="monitor-value"
              :class="usagePctClass(stats.resource.disk.host?.usePercent)"
              :title="stats.resource.disk.host?.path || ''"
            >
              {{ stats.resource.disk.host?.usePercent || '-' }}
              <!-- F3 低盘标记：后端 collectDiskUsage 按 maintenance.lowFreeBytes 判定 -->
              <span v-if="stats.resource.disk.host?.lowFree" class="mem-pct-high"
                >⚠ {{ $t('admin.diskLowFree') }}</span
              >
            </span>
          </div>
        </div>

        <!-- Docker 存储 -->
        <h5 class="monitor-subtitle">{{ $t('admin.diskDockerTitle') }}</h5>
        <table v-if="stats.resource.disk.docker?.items?.length">
          <thead>
            <tr>
              <th>{{ $t('admin.diskColType') }}</th>
              <th>{{ $t('admin.diskColSize') }}</th>
              <th>{{ $t('admin.diskColReclaimable') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in stats.resource.disk.docker.items" :key="item.name">
              <td>{{ dockerTypeLabel(item.name) }}</td>
              <td>{{ item.size }}</td>
              <td class="reclaimable-cell">{{ item.reclaimable }}</td>
            </tr>
          </tbody>
        </table>

        <!-- 租户数据卷 -->
        <div class="disk-vol-head">
          <h5 class="monitor-subtitle">{{ $t('admin.diskVolumesTitle') }}</h5>
          <button
            class="btn btn-small"
            :class="diskScanning ? 'btn-disabled' : 'btn-primary'"
            :disabled="diskScanning"
            @click="runDiskScan"
          >
            {{ diskScanning ? $t('admin.diskScanning') : $t('admin.diskScanBtn') }}
          </button>
        </div>
        <p class="tab-hint">{{ $t('admin.diskScanHint') }}</p>
        <table v-if="stats.resource.disk.volumes?.length">
          <thead>
            <tr>
              <th>{{ $t('admin.diskColVolume') }}</th>
              <th>{{ $t('admin.diskColVolSize') }}（{{ $t('admin.diskHostEngine') }}）</th>
              <th>{{ $t('admin.diskColVolSize') }}（{{ $t('admin.diskHostActual') }}）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in stats.resource.disk.volumes" :key="v.volume">
              <td class="cwt-mono">{{ v.volume.replace('dsh-data-swtc-', '…') }}</td>
              <td class="mem-pct-ok">{{ v.size }}</td>
              <td>
                <span v-if="v.sizeActual" :class="actualSizeClass(v.size, v.sizeActual)">
                  {{ formatBytes(v.sizeActual) }}
                </span>
                <span v-else class="monitor-never">-</span>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
      <div v-else class="monitor-empty">{{ $t('admin.diskNoData') }}</div>
    </div>
  </div>
</template>

<style scoped>
.monitor-config {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
  margin: 0.75rem 0 1.25rem;
  padding: 1rem 1.25rem;
  background: var(--bg-page);
  border: 1px solid var(--border-light);
  border-radius: 12px;
}

.monitor-item {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.monitor-label {
  font-size: 0.75rem;
  color: var(--text-faint);
}

.monitor-value {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-main);
}

.monitor-upgraded {
  color: var(--success);
}

.monitor-subtitle {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-body);
  margin: 1rem 0 0.25rem;
}

.mem-pct {
  font-weight: 600;
}

.mem-pct-ok {
  color: var(--success);
}

.mem-pct-warn {
  color: #f59e0b;
}

.mem-pct-high {
  color: #ef4444;
}

.monitor-never {
  color: var(--text-faint);
  font-size: 0.8rem;
}

.monitor-empty {
  padding: 1.25rem;
  text-align: center;
  color: var(--text-faint);
  font-size: 0.85rem;
  background: var(--bg-page);
  border: 1px dashed var(--border-light);
  border-radius: 12px;
}

.reclaimable-cell {
  color: #f59e0b;
  font-size: 0.8rem;
}

.disk-vol-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.disk-vol-head .monitor-subtitle {
  margin: 0.5rem 0 0;
}
</style>
