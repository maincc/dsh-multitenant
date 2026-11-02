<template>
  <div class="env-admin">
    <div class="enva-bar">
      <div class="enva-filters">
        <button
          v-for="f in FILTERS"
          :key="f"
          class="btn btn-small"
          :class="filter === f ? 'btn-primary' : 'btn-secondary'"
          @click="setFilter(f)"
        >
          {{ $t('env.status.' + f) }}
        </button>
      </div>
      <button class="btn btn-small btn-primary" @click="openCommitDialog">
        {{ $t('env.admin.commitBtn') }}
      </button>
    </div>

    <p v-if="!rows.length" class="enva-muted">{{ $t('env.admin.empty') }}</p>
    <div v-for="t2 in rows" :key="t2._id" class="enva-row" :class="{ open: openedId === t2._id }">
      <div class="enva-head" @click="toggle(t2)">
        <span class="enva-name">{{ t2.name || t2.slug }}</span>
        <span
          v-if="dupOf(t2)"
          class="badge badge-warning"
          :title="$t('env.dupNameTip', { n: dupOf(t2) })"
          >{{ $t('env.dupName', { n: dupOf(t2) }) }}</span
        >
        <span class="badge" :class="badgeCls(t2.status)">{{ $t('env.status.' + t2.status) }}</span>
        <span class="enva-meta"
          >{{ shortAddr(t2.sourceAddr) }} · {{ fmtBytes(t2.sizeBytes) }} ·
          {{ $t('env.usedBy', { n: (t2.pinnedBy || []).length }) }} ·
          {{ (t2.createdAt || '').slice(0, 10) }}</span
        >
        <span class="enva-meta enva-scan" v-if="t2.hasScan">
          <span v-if="t2.secretCount" class="enva-danger">{{
            $t('env.admin.secretsN', { n: t2.secretCount })
          }}</span>
          <span v-else-if="t2.hitCount" class="enva-warn">{{
            $t('env.admin.hitsN', { n: t2.hitCount })
          }}</span>
          <span v-else class="enva-ok">{{ $t('env.admin.scanClean') }}</span>
        </span>
      </div>
      <!-- 审件抽屉：作者面/镜像层/随行包/检测报告 四段（数据全来自账本详情端点） -->
      <div v-if="openedId === t2._id" class="enva-detail">
        <div v-if="!detail" class="enva-muted">{{ $t('env.loadingDetail') }}</div>
        <template v-else>
          <div class="enva-cols">
            <div class="enva-col">
              <div class="enva-col-title">{{ $t('env.admin.authorCol') }}</div>
              <div class="enva-kv">
                <b>{{ $t('env.author') }}</b
                >{{ detail.sourceAddr }}
              </div>
              <div class="enva-kv"><b>slug</b>{{ detail.slug }}</div>
              <div class="enva-kv">
                <b>digest</b><code>{{ (detail.imageId || '').slice(0, 19) }}…</code>
              </div>
              <div class="enva-kv">
                <b>{{ $t('env.baseVersion') }}</b
                >{{ detail.dshVersion }} ·
                {{ detail.scrubbed ? $t('env.scrubbedY') : $t('env.scrubbedN') }}
              </div>
              <div v-if="detail.rejectReason" class="enva-danger">
                {{ $t('env.rejectReason', { reason: detail.rejectReason }) }}
              </div>
              <div class="enva-actions">
                <button
                  v-if="detail.status === 'draft'"
                  class="btn btn-small btn-primary"
                  :disabled="busy || rejecting"
                  @click="publish(detail)"
                >
                  {{ $t('env.admin.publishBtn') }}
                </button>
                <button
                  v-if="detail.status === 'draft'"
                  class="btn btn-small btn-secondary enva-danger-btn"
                  :disabled="busy || rejecting"
                  @click="rejecting = { on: !rejecting?.on, reason: '' }"
                >
                  {{ $t('env.admin.rejectBtn') }}
                </button>
                <button
                  v-if="detail.status === 'published' || detail.status === 'unlisted'"
                  class="btn btn-small btn-secondary enva-danger-btn"
                  :disabled="busy"
                  @click="revoke(detail)"
                >
                  {{ $t('env.admin.revokeBtn') }}
                </button>
                <button
                  class="btn btn-small btn-secondary"
                  :disabled="busy"
                  @click="rescan(detail)"
                >
                  {{ $t('env.admin.rescanBtn') }}
                </button>
              </div>
              <div v-if="rejecting?.on" class="enva-reject-form">
                <textarea
                  v-model.trim="rejecting.reason"
                  class="enva-input"
                  rows="2"
                  maxlength="500"
                  :placeholder="$t('env.admin.rejectPh')"
                />
                <div class="enva-actions">
                  <button class="btn btn-small btn-secondary" @click="rejecting = null">
                    {{ $t('env.cancelBtn') }}
                  </button>
                  <button
                    class="btn btn-small btn-danger enva-confirm-danger"
                    :disabled="!rejecting.reason || busy"
                    @click="rejectFlow(detail, rejecting.reason)"
                  >
                    {{ $t('env.admin.rejectConfirmBtn') }}
                  </button>
                </div>
              </div>
            </div>
            <div class="enva-col">
              <div class="enva-col-title">
                {{ $t('env.admin.manifestCol', { n: (detail.manifest || []).length }) }}
              </div>
              <div class="enva-scroll">
                <div v-for="(m, i) in detail.manifest || []" :key="i" class="enva-line">
                  {{ m }}
                </div>
              </div>
            </div>
            <div class="enva-col">
              <div class="enva-col-title">
                {{
                  $t('env.admin.bundleCol', {
                    n: (detail.bundle?.files || []).length,
                    size: fmtBytes(detail.bundle?.bytes || 0),
                  })
                }}
              </div>
              <div
                v-if="detail.provenance && Object.keys(detail.provenance).length"
                class="enva-prov"
              >
                <div class="env-muted env-small">{{ $t('env.provDeclared') }}</div>
                <span
                  v-for="(v, k) in detail.provenance"
                  :key="k"
                  class="badge enva-prov-badge"
                  :title="v.url || ''"
                  >{{ k }} · {{ $t(provKey(v)) }}</span
                >
              </div>
              <div v-if="!detail.bundle" class="enva-muted">{{ $t('env.admin.noBundle') }}</div>
              <template v-else>
                <div class="enva-scroll enva-files">
                  <div
                    v-for="f in detail.bundle.files"
                    :key="f.p"
                    class="enva-line"
                    :class="{ hitline: hitFiles.has(f.p) }"
                  >
                    {{ f.p }}
                    <span class="enva-muted"
                      >{{ fmtBytes(f.size) }} · {{ (f.sha256 || '').slice(0, 8) }}</span
                    >
                  </div>
                </div>
                <div v-if="detail.scan?.secrets?.length" class="enva-danger">
                  {{ $t('env.admin.secretBanner') }}
                  <div v-for="(x, i) in detail.scan.secrets" :key="'sec' + i" class="enva-line">
                    ✗ {{ x.file }}:{{ x.line }}（{{ x.kind }}）
                  </div>
                </div>
                <div
                  v-for="(h, i) in detail.scan?.hits || []"
                  :key="'hit' + i"
                  class="enva-line enva-warn"
                >
                  ⚠ {{ h.file }}:{{ h.line }} {{ h.hint }}
                  <span class="enva-muted">{{ h.snippet }}</span>
                </div>
                <div v-if="detail.scan" class="enva-muted enva-small">
                  {{ $t('env.admin.scanHonesty') }}
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 代格对话框：保守默认——不勾任何随行内容（管理员不该替别人决定公开什么） -->
    <div v-if="cd.open" class="enva-modal" @click.self="cd.open = false">
      <div class="enva-modal-box">
        <h4>{{ $t('env.admin.commitBtn') }}</h4>
        <label class="enva-label">{{ $t('env.admin.targetAddr') }}</label>
        <input v-model.trim="cd.address" class="enva-input" placeholder="jga…" />
        <label class="enva-label">slug</label>
        <input
          v-model.trim="cd.slug"
          class="enva-input"
          maxlength="41"
          placeholder="stock-trader"
        />
        <label class="enva-label">{{ $t('env.nameLabel') }}</label>
        <input v-model.trim="cd.displayName" class="enva-input" maxlength="60" />
        <label class="enva-label">{{ $t('env.introLabel') }}</label>
        <input v-model.trim="cd.intro" class="enva-input" maxlength="300" />
        <p class="enva-muted">{{ $t('env.admin.conservativeNote') }}</p>
        <div v-if="cd.preview" class="enva-preview">
          <ul class="enva-ul">
            <li v-for="(n, i) in cd.preview.notices || []" :key="i">{{ n }}</li>
          </ul>
        </div>
        <div class="enva-actions">
          <button class="btn btn-small btn-secondary" @click="cd.open = false">
            {{ $t('env.cancelBtn') }}
          </button>
          <button
            class="btn btn-small btn-primary"
            :disabled="!cdValid || cd.running"
            @click="cdGo()"
          >
            {{ cd.dryDone ? $t('env.freezeGo') : $t('env.previewFirst') }}
          </button>
        </div>
        <div v-if="cd.error" class="enva-danger">{{ cd.error }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 环境模板·管理面（审核工作台 + 代格）。审核动作全部当场钱包签名
 * （signAdminOperation 同款 challenge 流程）；报告数据出自账本详情端点。
 */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import { toast, askConfirm } from '../composables/useDialog'
import { requestAccounts, signMessage, getPublicKey } from '../api/wallet'

const { t } = useI18n()
const PROV_KEYS = {
  self: 'env.provSelf',
  github: 'env.provGithub',
  official: 'env.provOfficial',
  other: 'env.provOther',
}
const provKey = (p) => (p && PROV_KEYS[p.kind]) || 'env.provNone'
const FILTERS = ['all', 'draft', 'published', 'unlisted', 'revoked', 'rejected']
const all = ref([])
const filter = ref('all')
const openedId = ref('')
const detail = ref(null)
const busy = ref(false)
const rejecting = ref(null)
const cd = ref({
  open: false,
  address: '',
  slug: '',
  displayName: '',
  intro: '',
  preview: null,
  dryDone: false,
  running: false,
  error: '',
})

const rows = computed(
  () =>
    all.value
      .filter((e) => filter.value === 'all' || e.status === filter.value)
      .map((e) => ({ ...e })), // 计数列（hasScan/secretCount/hitCount）由服务端列表给足
)
const hitFiles = computed(() => new Set((detail.value?.scan?.hits || []).map((h) => h.file)))
const cdValid = computed(() => cd.value.address && /^[a-z0-9][a-z0-9-]{1,40}$/.test(cd.value.slug))

async function load() {
  const res = await axios.get('/api/admin/environments')
  all.value = res.data.environments || []
}
onMounted(() => load().catch((e) => toast(errMsg(e))))
const errMsg = (e) => e?.response?.data?.error || e?.message || 'error'
const shortAddr = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '—')
const fmtBytes = (n) =>
  !n
    ? '0 B'
    : n >= 1073741824
      ? `${(n / 1073741824).toFixed(1)} GB`
      : n >= 1048576
        ? `${(n / 1048576).toFixed(0)} MB`
        : `${(n / 1024).toFixed(0)} KB`
const badgeCls = (st) =>
  ({
    draft: 'badge-info',
    published: 'badge-success',
    unlisted: 'badge-warning',
    revoked: 'badge-warning',
    rejected: 'badge-danger',
    all: '',
  })[st] || 'badge-info'

// 同名×N 徽标（判例 57 补落裁定）：同作者同名"活着的"（待审/在架）≥2 时点名——
// 重新上架不触发上传侧的同名提醒，这个盲区由审核面徽标补上（提示不拦截）。
function dupOf(row) {
  // 死账不挂标（用户裁定）：已撤销/已驳回/已下架只是历史陈列，不该被同名标指着——
  // 数的时候只数活账，挂的时候也只往活账行上挂，两头同闸
  if (!['draft', 'pending', 'published'].includes(row.status)) return 0
  // 本仓真队列态是 'draft'（重新提交审核的字面，管理端只认它——pending 是幽灵态）：
  // 判数面必须含 draft，否则"两条同名一起待审"这一徽标最该响的场景永远哑火
  const live = all.value.filter((e) => ['draft', 'pending', 'published'].includes(e.status))
  const n = live.filter(
    (e) => e.sourceAddr === row.sourceAddr && (e.name || e.slug) === (row.name || row.slug),
  ).length
  return n > 1 ? n : 0
}

function setFilter(f) {
  filter.value = f
}
async function toggle(row) {
  if (openedId.value === row._id) {
    openedId.value = ''
    detail.value = null
    return
  }
  openedId.value = row._id
  detail.value = null
  try {
    const res = await axios.get(`/api/admin/environments/${encodeURIComponent(row._id)}`)
    detail.value = res.data.template || res.data
  } catch (e) {
    toast(errMsg(e))
  }
}

// —— 钱包签名（AdminPanel signAdminOperation 同款；会话地址校验由服务端把关） ——
async function signOp(operation, payload) {
  const pluginAddress = await requestAccounts()
  const chal = await axios.post('/api/admin/challenge', {
    address: pluginAddress.toLowerCase(),
    operation,
    payload,
  })
  const signature = await signMessage(pluginAddress, chal.data.message)
  const publicKey = await getPublicKey(pluginAddress)
  return {
    'x-admin-nonce': chal.data.nonce,
    'x-admin-signature': signature,
    'x-admin-pubkey': publicKey,
  }
}

async function publish(doc) {
  busy.value = true
  try {
    const headers = await signOp('env-publish', { id: doc._id })
    await axios.post('/api/admin/env-publish', { id: doc._id }, { headers })
    toast(t('env.admin.published'))
    await load()
    if (detail.value?._id === doc._id) detail.value = { ...detail.value, status: 'published' }
  } catch (e) {
    toast(errMsg(e))
  } finally {
    busy.value = false
  }
}
async function rejectFlow(doc, reason) {
  // 理由必填（服务端同款纪律）：空字符串直接不发——"默认理由"等于走过场
  if (!reason) return
  busy.value = true
  try {
    const headers = await signOp('env-reject', { id: doc._id })
    await axios.post('/api/admin/env-reject', { id: doc._id, reason }, { headers })
    toast(t('env.admin.rejected'))
    rejecting.value = null
    await load()
    if (detail.value?._id === doc._id)
      detail.value = { ...detail.value, status: 'rejected', rejectReason: reason }
  } catch (e) {
    toast(errMsg(e))
  } finally {
    busy.value = false
  }
}
async function revoke(doc) {
  const go = await askConfirm({
    message: t(
      // 已下架之物改判撤板=封死重提去路，措辞必须说清这一刀切的是什么
      doc.status === 'unlisted' ? 'env.admin.revokeUnlistedConfirm' : 'env.admin.revokeConfirm',
      {
        name: doc.displayName || doc.slug,
        n: (doc.pinnedBy || []).length,
      },
    ),
    confirmLabel: t('env.admin.revokeBtn'),
  })
  if (!go) return
  busy.value = true
  try {
    const headers = await signOp('env-revoke', { id: doc._id })
    const res = await axios.post('/api/admin/env-revoke', { id: doc._id }, { headers })
    toast(res.data.notice || t('env.admin.revoked'))
    await load()
  } catch (e) {
    toast(errMsg(e))
  } finally {
    busy.value = false
  }
}
async function rescan(doc) {
  busy.value = true
  try {
    const headers = await signOp('env-scan', { id: doc._id })
    const res = await axios.post('/api/admin/env-scan', { id: doc._id }, { headers })
    detail.value = { ...detail.value, scan: res.data.scan }
    toast(
      t('env.admin.rescanDone', {
        sec: res.data.scan?.secrets?.length || 0,
        hits: res.data.scan?.hits?.length || 0,
      }),
    )
    await load()
  } catch (e) {
    toast(errMsg(e))
  } finally {
    busy.value = false
  }
}

// —— 代格（保守默认全不带；先 dryRun 再执行） ——
function openCommitDialog() {
  cd.value = {
    open: true,
    address: '',
    slug: '',
    displayName: '',
    intro: '',
    preview: null,
    dryDone: false,
    running: false,
    error: '',
  }
}
async function cdGo() {
  // 两步流：先 dryRun 看步骤/警告，再钱包签名执行——代格默认全不带随行内容
  cd.value.running = true
  cd.value.error = ''
  try {
    const payload = {
      address: cd.value.address,
      slug: cd.value.slug,
      displayName: cd.value.displayName || cd.value.slug,
      intro: cd.value.intro,
      include: { skills: [], plugins: [], folders: [] }, // 代格保守默认：不替作者决定公开内容
    }
    if (!cd.value.dryDone) {
      const res = await axios.post('/api/admin/env-commit', { ...payload, dryRun: true })
      cd.value.preview = res.data
      cd.value.dryDone = true
      return
    }
    const headers = await signOp('env-commit', { address: payload.address, slug: payload.slug })
    const res = await axios.post('/api/admin/env-commit', payload, { headers })
    toast(t('env.admin.committed', { tag: res.data.template?.slug || payload.slug }))
    cd.value.open = false
    await load()
  } catch (e) {
    cd.value.error = errMsg(e)
  } finally {
    cd.value.running = false
  }
}
</script>

<style scoped>
.enva-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.enva-filters {
  display: flex;
  gap: 6px;
}
.enva-row {
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 10px;
  margin-bottom: 8px;
}
.enva-row.open {
  border-color: var(--primary-color, #4a8df8);
}
.enva-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  flex-wrap: wrap;
}
.enva-name {
  font-weight: 600;
  font-size: 13px;
}
.enva-meta {
  font-size: 12px;
  opacity: 0.65;
}
.enva-scan {
  margin-left: auto;
}
.enva-detail {
  border-top: 1px dashed var(--border-color, rgba(255, 255, 255, 0.12));
  padding: 12px;
}
.enva-cols {
  display: grid;
  grid-template-columns: 240px 1fr 1fr;
  gap: 12px;
}
@media (max-width: 1100px) {
  .enva-cols {
    grid-template-columns: 1fr;
  }
}
.enva-col {
  min-width: 0;
}
.enva-col-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
  opacity: 0.85;
}
.enva-kv {
  font-size: 12px;
  padding: 2px 0;
  word-break: break-all;
}
.enva-kv b {
  opacity: 0.6;
  margin-right: 6px;
  font-weight: 500;
}
.enva-scroll {
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  border-radius: 8px;
  padding: 6px 8px;
}
.enva-line {
  font-size: 11px;
  font-family: ui-monospace, monospace;
  padding: 1px 0;
  word-break: break-all;
}
.hitline {
  background: rgba(217, 164, 65, 0.08);
}
.enva-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.enva-danger {
  color: var(--danger-color, #d96b6b);
  font-size: 12px;
}
/* 主行动钮与确认弹窗的红钮同款配方：实红底白字，暗底浅底都读得清 */
.enva-confirm-danger {
  background: #dc2626;
  border-color: #dc2626;
  color: #fff;
}
.enva-confirm-danger:hover:not(:disabled) {
  background: #b91c1c;
}
.enva-danger-btn {
  color: var(--danger-color, #d96b6b);
}
.enva-warn {
  color: var(--warn-color, #d9a441);
  font-size: 12px;
}
.enva-ok {
  color: var(--ok-color, #57b874);
  font-size: 12px;
}
.enva-muted {
  font-size: 12px;
  opacity: 0.6;
}
.enva-small {
  font-size: 11px;
}
.enva-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.enva-modal-box {
  width: min(460px, 92vw);
  background: var(--bg-elevated, #1d2129);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  padding: 16px;
}
.enva-label {
  display: block;
  font-size: 12px;
  opacity: 0.7;
  margin-top: 8px;
}
.enva-input {
  width: 100%;
  box-sizing: border-box;
  margin-top: 3px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
  background: transparent;
  color: inherit;
  font-size: 13px;
}
.enva-ul {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
}
.enva-reject-form {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.enva-preview {
  margin-top: 8px;
}
.badge-danger {
  color: #fff;
  background: rgba(217, 107, 107, 0.25);
  border: 1px solid rgba(217, 107, 107, 0.5);
}
</style>
