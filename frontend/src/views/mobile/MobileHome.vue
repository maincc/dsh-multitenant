<template>
  <div class="mobile-home">
    <!-- Loading 状态 -->
    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">加载中...</div>
    </div>

    <!-- 数据加载完成后显示内容 -->
    <template v-else>
      <!-- 顶部头部区域 -->
      <div class="ghead">
        <div class="row1">
          <div class="ttl">DSH 控制台</div>
          <div class="avatar">{{ role === 'admin' ? '管' : '用' }}</div>
        </div>
        <div class="greet">
          {{ role === 'admin' ? '管理员' : '用户' }} · 已连接
          <span class="greet-hint">｜每 {{ refreshSec }}s 自动刷新</span>
        </div>
        <!-- T7 治错位（2026-11-10）：原文案"退出"但行为是复制——文案改如实"复制"；
             真退出落点在"我的"tab（MobileMe） -->
        <div class="addr-chip" @click="copyAddress">
          <span class="addr-icon">🔑</span>
          <span class="addr-text">{{ shortAddr }}</span>
          <span class="addr-act">复制</span>
        </div>
      </div>

      <!-- 主体内容 -->
      <div class="body">
        <!-- Docker 状态横幅 -->
        <div class="docker-banner">
          <span class="pulse"></span>
          <div class="docker-info">
            <div class="docker-label">Docker 状态</div>
            <div class="docker-value">{{ containerStatus ? '运行中' : '未启动' }}</div>
          </div>
          <span class="docker-icon">🐳</span>
        </div>

        <!-- 统计卡片（数据源 /api/stats 为管理端点：普通用户不摆零值假数据） -->
        <div v-if="role === 'admin'" class="stat2">
          <div class="stat">
            <div class="sl">总用户数</div>
            <div class="sv">{{ stats.totalUsers || 0 }}</div>
          </div>
          <div class="stat alt">
            <div class="sl">运行中</div>
            <div class="sv">{{ stats.running || 0 }}</div>
          </div>
          <div class="stat alt">
            <div class="sl">基础配额</div>
            <div class="sv">{{ stats.tier1 || 0 }}</div>
          </div>
          <div class="stat">
            <div class="sl">增强配额</div>
            <div class="sv">{{ stats.tier2 || 0 }}</div>
          </div>
        </div>

        <!-- 快捷管理（仅管理员显示） -->
        <div v-if="role === 'admin'" class="sec-t">快捷管理</div>
        <div v-if="role === 'admin'" class="card">
          <div class="qgrid">
            <div class="qitem" @click="$router.push('/user?tab=adm:users')">
              <div class="qi" style="background: var(--m-purple-soft)">👥</div>
              <span>用户管理</span>
            </div>
            <div class="qitem" @click="$router.push('/user?tab=adm:quota')">
              <div class="qi" style="background: #eaf0ff">📊</div>
              <span>配额配置</span>
            </div>
            <div class="qitem" @click="$router.push('/user?tab=adm:monitor')">
              <div class="qi" style="background: var(--m-green-soft)">📈</div>
              <span>资源监控</span>
            </div>
            <div class="qitem" @click="$router.push('/user?tab=adm:version')">
              <div class="qi" style="background: var(--m-amber-soft)">🏷️</div>
              <span>DSH 版本</span>
            </div>
            <div class="qitem" @click="$router.push('/user?tab=model')">
              <div class="qi" style="background: var(--m-purple-soft)">🤖</div>
              <span>模型配置</span>
            </div>
            <div class="qitem" @click="$router.push('/user?tab=adm:approval')">
              <div class="qi" style="background: var(--m-danger-soft)">🛡️</div>
              <span>凭证审批</span>
            </div>
            <div class="qitem" @click="$router.push('/user?tab=adm:env-approval')">
              <div class="qi" style="background: #eaf0ff">🗂️</div>
              <span>环境审批</span>
            </div>
            <div class="qitem" @click="$router.push('/user?tab=account')">
              <div class="qi" style="background: var(--m-green-soft)">🪪</div>
              <span>我的凭证</span>
            </div>
          </div>
        </div>

        <!-- 孤儿数据清理（仅管理员显示；与桌面 AdminPanel 同闸：会话判权 + 删除当场签名） -->
        <div v-if="role === 'admin'" class="card">
          <div class="ct">🧹 孤儿数据清理</div>
          <div class="cd">扫描并清理无人使用的残留数据卷（不影响任何在用用户与运行中的容器）</div>
          <button class="btn btn-p" @click="scanOrphanVolumes" :disabled="orphanScanning">
            {{ orphanScanning ? '扫描中…' : '扫描孤儿卷' }}
          </button>
          <div v-if="orphanNotice" class="orphan-notice">{{ orphanNotice }}</div>
          <div v-if="orphanVolumes.length" class="orphan-list">
            <div v-for="v in orphanVolumes" :key="v" class="orphan-item">{{ v }}</div>
          </div>
          <button
            v-if="orphanVolumes.length"
            class="btn btn-danger"
            style="margin-top: 12px"
            @click="cleanupOrphanVolumes"
            :disabled="orphanCleaning"
          >
            {{ orphanCleaning ? '清理中…' : `清理 ${orphanVolumes.length} 个孤儿卷` }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import { askConfirm, toast } from '../../composables/useDialog'
import { signAdminOperation } from '../../api/adminSign.js'
import { shortAddress } from '../../utils/format.js'

const loading = ref(true)
const address = ref('')
const role = ref('user')
const containerStatus = ref(null)
const stats = ref({
  totalUsers: 0,
  running: 0,
  tier1: 0,
  tier2: 0,
})

// 自动刷新节拍（T6 修复：原"每 300s"是假文案、无 timer）。默认 15s 与桌面/红点
// 节拍同源——管理员在场时读 /api/stats 的 uiConfig.refreshIntervalMs 真值重建定时器
// （AdminPanel 同款通道），改 config.json 重启服务即生效、无需重 build 前端。
const intervalMs = ref(15000)
const refreshSec = computed(() => Math.round(intervalMs.value / 1000))

// 孤儿数据卷（T6 修复：原扫描按钮只弹 alert 空壳）。口径对齐桌面 AdminPanel：
// GET 列孤儿只判会话；批量删卷不可逆 → askConfirm 明细 + cleanup-orphan-volumes
// 当场签名（服务端只删 签署清单∩仍是孤儿 交集）
const orphanVolumes = ref([])
const orphanScanning = ref(false)
const orphanCleaning = ref(false)
const orphanNotice = ref('')

const shortAddr = computed(() => shortAddress(address.value, { head: 12, empty: '' }))

function copyAddress() {
  if (address.value) {
    navigator.clipboard.writeText(address.value)
    toast('地址已复制到剪贴板')
  }
}

async function scanOrphanVolumes() {
  orphanScanning.value = true
  orphanNotice.value = ''
  try {
    const res = await axios.get('/api/admin/orphan-volumes')
    orphanVolumes.value = res.data.orphanVolumes || []
    orphanNotice.value = orphanVolumes.value.length
      ? `发现 ${orphanVolumes.value.length} 个孤儿数据卷`
      : '未发现孤儿数据卷'
  } catch (e) {
    toast(`扫描失败：${e.response?.data?.error || e.message}`)
  } finally {
    orphanScanning.value = false
  }
}

async function cleanupOrphanVolumes() {
  if (!orphanVolumes.value.length || orphanCleaning.value) return
  await askConfirm({
    message: `确认删除 ${orphanVolumes.value.length} 个孤儿数据卷？删除后数据不可恢复`,
    details: [...orphanVolumes.value],
    danger: true,
    confirmLabel: `删除 ${orphanVolumes.value.length} 个卷`,
    run: async () => {
      orphanCleaning.value = true
      try {
        // 单一快照：签名清单与 POST body 必须同源——分两次展开时，钱包弹窗等待
        // 期间列表若变化会造成服务端 binding 校验不过（拒签方向正确但白费一次签名）
        const snapshot = [...orphanVolumes.value]
        const headers = await signAdminOperation('cleanup-orphan-volumes', { volumes: snapshot })
        const res = await axios.post(
          '/api/admin/cleanup-orphan-volumes',
          { volumes: snapshot },
          { headers },
        )
        const { removed = [], failed = [], skipped = [] } = res.data || {}
        const parts = [`已删除 ${removed.length} 个，失败 ${failed.length} 个`]
        if (skipped.length) parts.push(`跳过 ${skipped.length} 个（已被重新认领）`)
        orphanNotice.value = parts.join('，')
        toast(orphanNotice.value)
        // 列表只剩删除失败的（与桌面同款收口）
        orphanVolumes.value = (failed || []).map((f) => f.name)
      } catch (e) {
        toast(`清理失败：${e.response?.data?.error || e.message}`)
      } finally {
        orphanCleaning.value = false
      }
    },
  })
}

async function loadUserInfo() {
  try {
    const res = await axios.get('/api/user/credential-status')
    address.value = res.data.address || ''
    role.value = res.data.role || 'user'
  } catch (e) {
    console.error('加载用户信息失败:', e)
  }
}

async function loadContainerStatus() {
  if (!address.value) return
  try {
    const res = await axios.get(`/connect-status?address=${encodeURIComponent(address.value)}`)
    containerStatus.value = res.data
  } catch (e) {
    console.error('加载容器状态失败:', e)
  }
}

async function loadStats() {
  if (role.value !== 'admin') return
  try {
    const res = await axios.get('/api/stats')
    const d = res.data || {}
    stats.value = {
      totalUsers: d.totalUsers ?? 0,
      running: d.runningUsers ?? 0,
      tier1: d.tierCounts?.[1] ?? 0,
      tier2: d.tierCounts?.[2] ?? 0,
    }
    // 节拍交还后端真值（3s 下限防配疯；变了就重建定时器，AdminPanel 同款）
    const iv = Number(d.uiConfig?.refreshIntervalMs)
    if (Number.isFinite(iv) && iv >= 3000 && iv !== intervalMs.value) {
      intervalMs.value = iv
      startTimer()
    }
  } catch (e) {
    console.error('加载统计数据失败:', e)
  }
}

// ---- 定时器：页面可见才打表，回前台先刷一次再续表（红点节拍器同纪律） ----
let timer = null
function startTimer() {
  stopTimer()
  timer = setInterval(silentRefresh, intervalMs.value)
}
function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
async function silentRefresh() {
  await loadUserInfo()
  await Promise.all([loadContainerStatus(), loadStats()])
}
function onVisibility() {
  if (document.hidden) stopTimer()
  else {
    silentRefresh()
    startTimer()
  }
}

onMounted(async () => {
  try {
    // 先加载用户信息（其他数据依赖 address）
    await loadUserInfo()

    // 并行加载容器状态和统计数据
    await Promise.all([loadContainerStatus(), loadStats()])
  } catch (e) {
    console.error('加载数据失败:', e)
  } finally {
    loading.value = false
  }
  document.addEventListener('visibilitychange', onVisibility)
  if (!document.hidden) startTimer()
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  stopTimer()
})
</script>

<style scoped>
.mobile-home {
  min-height: 100vh;
  background: var(--m-bg);
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
  border-top-color: var(--m-primary);
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
  color: var(--m-muted);
}

/* 顶部头部 */
.ghead {
  background: linear-gradient(135deg, var(--m-primary) 0%, var(--m-primary-2) 100%);
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
  font-size: 14px;
  margin-bottom: 12px;
}

.greet-hint {
  opacity: 0.6;
}

.addr-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.2s;
}

.addr-chip:active {
  background: rgba(255, 255, 255, 0.25);
}

.addr-icon {
  font-size: 16px;
}

.addr-text {
  flex: 1;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 12px;
}

.addr-act {
  font-size: 12px;
  opacity: 0.8;
  font-weight: 600;
}

/* 主体内容 */
.body {
  padding: 16px;
}

/* Docker 状态横幅 */
.docker-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  background: linear-gradient(135deg, var(--m-green) 0%, #2bb56a 100%);
  border-radius: 14px;
  padding: 14px 16px;
  color: #fff;
  margin-bottom: 16px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
}

.pulse {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.docker-info {
  flex: 1;
}

.docker-label {
  font-size: 11px;
  opacity: 0.85;
}

.docker-value {
  font-size: 15px;
  font-weight: 700;
}

.docker-icon {
  font-size: 22px;
}

/* 统计卡片 */
.stat2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}

.stat {
  background: #fff;
  border-radius: 14px;
  padding: 14px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
}

.stat.alt {
  background: #f6f7fb;
}

.sl {
  font-size: 11px;
  color: var(--m-muted);
  margin-bottom: 6px;
}

.sv {
  font-size: 24px;
  font-weight: 700;
  color: var(--m-ink);
}

/* 区块标题 */
.sec-t {
  font-size: 13px;
  font-weight: 600;
  color: var(--m-text);
  margin-bottom: 10px;
  padding-left: 2px;
}

/* 卡片 */
.card {
  background: #fff;
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
  margin-bottom: 16px;
}

/* 快捷管理网格 */
.qgrid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.qitem {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  transition: transform 0.2s;
}

.qitem:active {
  transform: scale(0.95);
}

.qi {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
}

.qitem span {
  font-size: 11px;
  color: var(--m-text);
  font-weight: 500;
}

/* 孤儿清理卡片 */
.ct {
  font-size: 14px;
  font-weight: 700;
  color: var(--m-ink);
  margin-bottom: 8px;
}

.cd {
  font-size: 12px;
  color: var(--m-muted);
  line-height: 1.6;
  margin-bottom: 12px;
}

.btn {
  padding: 10px 20px;
  border: none;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-p {
  background: linear-gradient(135deg, #f0a132, var(--m-amber));
  color: #fff;
  box-shadow: 0 4px 12px rgba(240, 161, 50, 0.3);
}

.btn:active {
  transform: scale(0.98);
}

.btn-danger {
  background: linear-gradient(135deg, var(--m-danger), #c53030);
  color: #fff;
  box-shadow: 0 4px 12px rgba(214, 69, 69, 0.3);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 孤儿卷扫描结果 */
.orphan-notice {
  font-size: 12px;
  color: var(--m-text);
  margin-top: 10px;
}

.orphan-list {
  margin-top: 10px;
  max-height: 160px;
  overflow-y: auto;
  border: 1px solid #edeff5;
  border-radius: 10px;
  padding: 6px 10px;
}

.orphan-item {
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 11px;
  color: var(--m-muted);
  padding: 4px 0;
  border-bottom: 1px dashed #edeff5;
  word-break: break-all;
}

.orphan-item:last-child {
  border-bottom: none;
}
</style>
