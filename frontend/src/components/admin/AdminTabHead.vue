<!-- 管理端 tab 页头（P3 Tier C 前置基建）：标题+提示+自动刷新按钮。
     六处同构页头收编单源；样式在 gate-skeleton.css（.admin-panel 限定）。
     intervalMs 为 0/缺省 时不渲染刷新区（cred tab 即此形）。 -->
<script setup>
defineProps({
  title: { type: String, required: true },
  hint: { type: String, default: '' },
  hintWarn: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  intervalMs: { type: Number, default: 0 },
})
defineEmits(['refresh'])
</script>

<template>
  <div class="tab-head">
    <div class="tab-head-text">
      <h4>{{ title }}</h4>
      <p v-if="hint" class="tab-hint">{{ hint }}</p>
      <p v-if="hintWarn" class="tab-hint tab-hint-warn">{{ hintWarn }}</p>
    </div>
    <div v-if="intervalMs" class="tab-head-actions">
      <span class="refresh-hint">{{
        $t('admin.refreshAuto', { n: Math.round(intervalMs / 1000) })
      }}</span>
      <button class="btn btn-small" :disabled="loading" @click="$emit('refresh')">
        {{ loading ? $t('admin.loading') : $t('admin.refresh') }}
      </button>
    </div>
  </div>
</template>
