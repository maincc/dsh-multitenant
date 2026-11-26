<!-- 配额配置 tab（P3 拆分自 AdminPanel，一刀一 commit）。
     纯只读：tiers 由壳层轮询下发，本组件不碰网络。 -->
<script setup>
import { computed } from 'vue'
import AdminTabHead from './AdminTabHead.vue'
import { tierBadge } from './shared.js'

const props = defineProps({
  tiers: { type: Object, default: () => ({}) },
  loading: { type: Boolean, default: false },
  refreshIntervalMs: { type: Number, default: 15000 },
})
defineEmits(['refresh'])

/**
 * 配额档位行（升序）。过滤非数字键：运维可能在 tiers 里加 comment 等说明键
 * （其他配置块都带 comment），这些不该被渲染成一档配额。
 */
const tierRows = computed(() =>
  Object.entries(props.tiers || {})
    .filter(([key]) => Number.isFinite(Number(key)))
    .map(([tier, limits]) => ({ tier: Number(tier), limits }))
    .sort((a, b) => a.tier - b.tier),
)
</script>

<template>
  <div>
    <AdminTabHead
      :title="$t('admin.tabQuota')"
      :hint="$t('admin.tierConfigHint')"
      :hint-warn="$t('admin.diskQuotaHint')"
      :loading="loading"
      :interval-ms="refreshIntervalMs"
      @refresh="$emit('refresh')"
    />
    <table>
      <thead>
        <tr>
          <th>{{ $t('admin.colTierLevel') }}</th>
          <th>{{ $t('admin.colTierLabel') }}</th>
          <th>{{ $t('admin.colMemory') }}</th>
          <th>{{ $t('admin.colCpu') }}</th>
          <th>{{ $t('admin.colPids') }}</th>
          <th>{{ $t('admin.colDiskLimit') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in tierRows" :key="row.tier">
          <td>
            <span class="badge" :class="tierBadge(row.tier)">T{{ row.tier }}</span>
          </td>
          <td>{{ row.limits.label }}</td>
          <td>{{ row.limits.memory }}</td>
          <td>{{ row.limits.cpus }} {{ $t('admin.cpuUnit') }}</td>
          <td>{{ row.limits.pids }}</td>
          <td>{{ row.limits.disk || '-' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
