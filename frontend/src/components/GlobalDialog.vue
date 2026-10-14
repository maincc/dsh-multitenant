<template>
  <!-- 确认弹窗：无浏览器域名"假标题"行，正文第一句就是动作，明细可选 -->
  <div v-if="confirm.open" class="gd-mask" @click.self="settleConfirm(false)">
    <div class="gd-card" role="dialog" aria-modal="true">
      <p v-for="(line, i) in messageLines" :key="i" class="gd-msg" :class="{ 'gd-msg-sub': i > 0 }">
        {{ line }}
      </p>
      <ul v-if="opts && opts.details && opts.details.length" class="gd-details">
        <li v-for="(d, i) in opts.details" :key="i" class="gd-detail-item">{{ d }}</li>
      </ul>
      <div class="gd-actions">
        <button class="gd-btn" :disabled="busy" @click="settleConfirm(false)">
          {{ (opts && opts.cancelLabel) || $t('common.confirmCancel') }}
        </button>
        <button
          class="gd-btn"
          :class="opts && opts.danger ? 'gd-btn-danger' : 'gd-btn-primary'"
          :disabled="busy"
          @click="confirmWithRun"
        >
          <span v-if="busy" class="gd-spin"></span>
          {{
            busy
              ? $t('common.confirmBusy')
              : (opts && opts.confirmLabel) ||
                (opts && opts.danger ? $t('common.confirmDelete') : $t('common.confirmOk'))
          }}
        </button>
      </div>
    </div>
  </div>

  <!-- 轻提示栈：替代 alert（非阻塞，自动消失） -->
  <div class="gd-toasts">
    <transition-group name="gd-toast">
      <div v-for="t in toasts" :key="t.id" class="gd-toast" :class="'gd-toast-' + t.kind">
        {{ t.message }}
      </div>
    </transition-group>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { dialogState, settleConfirm, confirmWithRun } from '../composables/useDialog'

const confirm = computed(() => dialogState.confirm)
const busy = computed(() => confirm.value.busy)
const opts = computed(() => confirm.value.opts)
const toasts = computed(() => dialogState.toasts)
// 兼容旧 confirm 文案里的 \n 换行习惯：按行拆开，次级行弱化处理
const messageLines = computed(() => String((opts.value && opts.value.message) || '').split('\n'))

// Esc = 取消（与原生 confirm 行为一致；Enter 不绑定——危险操作不该回车就走）
function onKey(e) {
  if (e.key === 'Escape' && dialogState.confirm.open) settleConfirm(false)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
/* 遮罩与卡片形状沿用 SkillMarket 详情弹窗的既有语言（同一设计系） */
.gd-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
  padding: 1rem;
}
.gd-card {
  background: white;
  border-radius: 12px;
  padding: 1.25rem 1.5rem 1rem;
  width: 100%;
  max-width: 440px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.3);
}
.gd-msg {
  margin: 0;
  font-size: 14px;
  text-align: center;
  color: #0f172a;
  white-space: pre-wrap;
  word-break: break-word;
}
.gd-msg + .gd-msg,
.gd-msg-sub {
  color: #64748b;
  font-size: 12.5px;
  margin-top: 0.35rem;
}
.gd-details {
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.75rem;
  list-style: none;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  max-height: 180px;
  overflow-y: auto;
}
.gd-detail-item {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11.5px;
  color: #475569;
  padding: 0.12rem 0;
  word-break: break-all;
}
.gd-detail-item::before {
  content: '▸ ';
  color: #94a3b8;
}
.gd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.1rem;
}
.gd-btn {
  padding: 0.4rem 0.9rem;
  font-size: 13px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  color: #475569;
  cursor: pointer;
}
.gd-btn:hover {
  background: #f1f5f9;
}
.gd-btn:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}
.gd-btn-primary:disabled,
.gd-btn-danger:disabled {
  opacity: 0.8;
}
.gd-spin {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 6px;
  vertical-align: -2px;
  border: 2px solid rgba(255, 255, 255, 0.45);
  border-top-color: white;
  border-radius: 50%;
  animation: gd-spin 0.7s linear infinite;
}
@keyframes gd-spin {
  to {
    transform: rotate(360deg);
  }
}
.gd-btn-primary {
  background: #2563eb;
  border-color: #2563eb;
  color: white;
}
.gd-btn-primary:hover {
  background: #1d4ed8;
}
.gd-btn-danger {
  background: #dc2626;
  border-color: #dc2626;
  color: white;
}
.gd-btn-danger:hover {
  background: #b91c1c;
}
.gd-toasts {
  /* 屏幕顶部横居中（原生 alert 居中惯性 + toast 不遮挡操作流的折中） */
  position: fixed;
  top: 1.25rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  z-index: 3100;
  max-width: min(420px, calc(100vw - 2rem));
}
.gd-toast {
  padding: 0.55rem 0.9rem;
  border-radius: 10px;
  font-size: 13px;
  text-align: center;
  color: white;
  background: #334155;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.25);
  word-break: break-word;
}
.gd-toast-error {
  background: #dc2626;
}
.gd-toast-enter-active,
.gd-toast-leave-active {
  transition:
    opacity 0.25s,
    transform 0.25s;
}
.gd-toast-enter-from,
.gd-toast-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}
</style>
