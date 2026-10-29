<template>
  <div class="env-page">
    <!-- 定格是什么：三句大白话（货架上给挑东西的人看） -->
    <div v-if="mode !== 'mine'" class="env-what">
      <b>{{ $t('env.whatTitle') }}</b>
      <ul>
        <li>{{ $t('env.whatP1') }}</li>
        <li>{{ $t('env.whatP2') }}</li>
        <li>{{ $t('env.whatP3') }}</li>
      </ul>
    </div>

    <!-- 当前来源条（我的现场） -->
    <div v-if="mode !== 'market'" class="env-current">
      <span class="env-current-label">{{ $t('env.currentSource') }}</span>
      <template v-if="current?.fromTemplate">
        <span class="badge badge-info">{{
          $t('env.fromTemplate', {
            name: current.fromTemplate.name,
            author: shortAddr(current.fromTemplate.author),
          })
        }}</span>
        <button class="btn btn-small btn-secondary" :disabled="busy" @click="revertNow">
          <span v-if="pending === 'revert'" class="btn-spin"></span>
          {{ pending === 'revert' ? $t('env.reverting') : $t('env.revertBtn') }}
        </button>
        <label class="env-clean-opt" :title="$t('env.revertCleanTip')">
          <input v-model="revertClean" type="checkbox" :disabled="busy" />
          {{ $t('env.revertCleanOpt') }}
        </label>
      </template>
      <span v-else-if="current?.image" class="badge badge-warning">{{
        $t('env.pinnedVersion')
      }}</span>
      <span v-else class="badge badge-success">{{ $t('env.platformDefault') }}</span>
    </div>

    <!-- 模板卡片列表 -->
    <template v-if="mode !== 'mine'">
      <h4 class="env-h4">{{ $t('env.marketTitle') }}</h4>
      <p v-if="!list.length" class="env-empty">{{ $t('env.empty') }}</p>
      <div class="env-grid">
        <div v-for="tpl in list" :key="tpl.id" class="env-card">
          <div class="env-card-head">
            <span class="env-card-name">{{ tpl.name }}</span>
            <span
              v-if="!tpl.scrubbed"
              class="badge badge-warning"
              :title="$t('env.unscrubbedTip')"
              >{{ $t('env.unscrubbed') }}</span
            >
          </div>
          <div class="env-card-meta">
            {{ $t('env.author') }} {{ shortAddr(tpl.author) }} · DSH {{ tpl.dshVersion }} ·
            {{ fmtBytes(tpl.sizeBytes) }}
          </div>
          <div class="env-card-intro">{{ tpl.intro || $t('env.noIntro') }}</div>
          <div class="env-card-actions">
            <button class="btn btn-small btn-secondary" :disabled="busy" @click="detailFor = tpl">
              {{ $t('env.detailBtn') }}
            </button>
            <button
              v-if="tpl.isMine"
              class="btn btn-small btn-secondary"
              :disabled="busy"
              :title="$t('env.unpublishConfirm')"
              @click="unpublishNow(tpl)"
            >
              {{ $t('env.unpublishBtn') }}
            </button>
            <button
              class="btn btn-small btn-primary"
              :disabled="busy || (expanded === tpl.id && !preview)"
              @click="togglePreview(tpl)"
            >
              <span v-if="pending === 'preview' && expanded === tpl.id" class="btn-spin"></span>
              {{
                pending === 'preview' && expanded === tpl.id
                  ? $t('env.previewing')
                  : expanded === tpl.id
                    ? $t('env.cancelBtn')
                    : current?.image === tpl.id
                      ? $t('env.alreadyUsing')
                      : $t('env.applyBtn')
              }}
            </button>
          </div>
          <!-- 确认面板：dryRun 预览（停机/冲突/承诺行）——数据全来自服务端，不美化 -->
          <div v-if="expanded === tpl.id" class="env-preview">
            <div v-if="!preview" class="env-muted">{{ $t('env.previewLoading') }}</div>
            <template v-else-if="preview && !preview.__fail">
              <ul class="env-notice-list">
                <li v-for="(n, i) in preview.notices || []" :key="'n' + i">{{ n }}</li>
                <li
                  v-if="preview.bundleApplied === false && preview.conflicts?.length"
                  class="env-danger"
                >
                  {{ $t('env.conflicts', { n: preview.conflicts.length }) }}
                  <div v-for="c in preview.conflicts" :key="c.p" class="env-conflict-item">
                    {{ c.p }}（{{ fmtBytes(c.size) }}）
                  </div>
                </li>
                <li v-if="preview.skillsPlanned?.length">
                  {{ $t('env.skillsPlanned', { list: preview.skillsPlanned.join('、') }) }}
                </li>
              </ul>
              <p class="env-promise">{{ $t('env.promiseLine') }}</p>
              <button class="btn btn-small btn-primary" :disabled="busy" @click="applyForReal(tpl)">
                <span v-if="pending === 'apply'" class="btn-spin"></span>
                {{
                  pending === 'apply'
                    ? $t('env.applying')
                    : $t('env.confirmApply', { name: tpl.name })
                }}
              </button>
            </template>
          </div>
        </div>
      </div>
    </template>

    <!-- 我的模板（作者可见全状态，驳回理由回传） -->
    <template v-if="mode !== 'market' && drafts.length">
      <h4 class="env-h4">{{ $t('env.mineTitle') }}</h4>
      <div v-for="d in drafts" :key="d.id" class="env-mine-row">
        <span class="env-card-name">{{ d.name }}</span>
        <span
          class="badge"
          :class="
            d.status === 'revoked'
              ? 'badge-warning'
              : d.status === 'rejected'
                ? 'badge-danger'
                : 'badge-info'
          "
          >{{ $t('env.status.' + d.status) }}</span
        >
        <span class="env-muted">{{ $t('env.usedBy', { n: d.pinnedByCount }) }}</span>
        <button
          v-if="d.status === 'draft'"
          class="btn btn-small btn-secondary"
          :disabled="busy"
          @click="resubmit(d)"
        >
          {{ $t('env.resubmitBtn') }}
        </button>
        <div v-if="d.status === 'rejected' && d.rejectReason" class="env-reject-reason">
          {{ $t('env.rejectReason', { reason: d.rejectReason }) }}
        </div>
      </div>
    </template>

    <!-- 定格入口（四态：套来的环境要先回退 / 故障≠无资格 / CWT 墙 / 可定格） -->
    <div v-if="mode !== 'market'" class="env-freeze-zone">
      <template v-if="!wz.active">
        <div v-if="elig.status === 'ok' && elig.onTemplate" class="env-wall">
          <div class="env-wall-title">{{ $t('env.onTplTitle') }}</div>
          <div class="env-wall-why">
            {{ $t('env.onTplWhy', { name: elig.onTemplate.name }) }}
          </div>
          <div class="env-wall-steps">{{ $t('env.onTplGo') }}</div>
        </div>
        <div v-else-if="elig.status === 'error'" class="env-wall">
          <div class="env-wall-title">{{ $t('env.eligFailTitle') }}</div>
          <div class="env-wall-why">{{ elig.msg }}</div>
          <div class="env-wall-steps">
            <button
              class="btn btn-small btn-secondary"
              :disabled="busy"
              @click="loadFreezeEligibility"
            >
              {{ $t('env.eligRetry') }}
            </button>
          </div>
        </div>
        <div v-else-if="elig.status === 'denied'" class="env-wall">
          <div class="env-wall-title">{{ $t('env.wallTitle') }}</div>
          <div class="env-wall-why">{{ $t('env.wallWhy') }}</div>
          <div class="env-wall-safe">{{ $t('env.wallNoLock') }}</div>
          <div class="env-wall-steps">{{ $t('env.wallSteps') }}</div>
        </div>
        <template v-else-if="elig.status === 'ok'">
          <button
            class="btn btn-primary"
            :disabled="!canFreeze || busy || elig.containerRunning === false"
            @click="openWizard"
          >
            {{ $t('env.freezeBtn') }}
          </button>
          <p v-if="!canFreeze && !loadingInv" class="env-muted">{{ $t('env.needCwt') }}</p>
          <p v-else-if="canFreeze && elig.containerRunning === false" class="env-muted">
            {{ $t('env.needRunning') }}
          </p>
        </template>
      </template>
    </div>

    <!-- 详情弹窗：先看清商品再动手（技能详情先例：安装前必须能看全） -->
    <div v-if="detailFor" class="modal-mask" @click.self="detailFor = null">
      <div class="modal-panel detail-panel">
        <div class="detail-head">
          <h3>{{ detailFor.name }}</h3>
          <button class="btn btn-small" @click="detailFor = null">✕</button>
        </div>
        <div class="env-card-meta">
          {{ $t('env.author') }} {{ shortAddr(detailFor.author) }} · DSH
          {{ detailFor.dshVersion }} · {{ fmtBytes(detailFor.sizeBytes) }} ·
          {{ new Date(detailFor.createdAt).toLocaleString() }} ·
          {{ $t('env.detailUsers', { n: detailFor.pinnedByCount }) }}
          <span v-if="!detailFor.scrubbed" class="badge badge-warning">{{
            $t('env.unscrubbed')
          }}</span>
        </div>
        <p class="env-card-intro">{{ detailFor.intro || $t('env.noIntro') }}</p>
        <div class="detail-cols">
          <div>
            <b>{{ $t('env.dSkills') }}</b>
            <ul v-if="detailFor.include.skills.length">
              <li v-for="n in detailFor.include.skills" :key="n">{{ n }}</li>
            </ul>
            <span v-else class="env-muted">{{ $t('env.dNone') }}</span>
          </div>
          <div>
            <b>{{ $t('env.dPlugins') }}</b>
            <ul v-if="detailFor.include.plugins.length">
              <li v-for="n in detailFor.include.plugins" :key="n">{{ n }}</li>
            </ul>
            <span v-else class="env-muted">{{ $t('env.dNone') }}</span>
            <div class="env-muted">
              {{
                $t('env.dBundle', {
                  files: detailFor.bundleFiles,
                  size: fmtBytes(detailFor.bundleBytes),
                })
              }}
            </div>
          </div>
          <div>
            <b>{{ $t('env.dFolders') }}</b>
            <ul v-if="detailFor.include.folders.length">
              <li v-for="n in detailFor.include.folders" :key="n">{{ n }}</li>
            </ul>
            <span v-else class="env-muted">{{ $t('env.dNone') }}</span>
          </div>
        </div>
        <p class="env-muted">{{ $t('env.dPromise') }}</p>
        <div class="detail-actions">
          <button class="btn btn-primary" :disabled="busy" @click="detailToApply">
            <span v-if="pending === 'preview'" class="btn-spin"></span>
            {{
              pending === 'preview'
                ? $t('env.previewing')
                : current?.image === detailFor.id
                  ? $t('env.alreadyUsing')
                  : $t('env.applyBtn')
            }}
          </button>
          <button class="btn btn-secondary" @click="detailFor = null">
            {{ $t('env.cancelBtn') }}
          </button>
        </div>
      </div>
    </div>

    <!-- ================= 定格向导（对齐 docs/env-template-wizard.md 六步） ================= -->
    <div v-if="wz.active && mode !== 'market'" class="env-wizard">
      <div class="env-wz-head">
        <span
          v-for="(s, i) in ['name', 'pick', 'confirm']"
          :key="s"
          class="env-wz-step"
          :class="{ on: wzStep === s, done: stepOrder(s) < stepOrder(wzStep) }"
        >
          {{ $t('env.wizard.' + s) }}
        </span>
        <button class="btn btn-small btn-secondary env-wz-exit" @click="exitWizard">
          {{ $t('env.exitWizard') }}
        </button>
      </div>

      <!-- 1 起名 -->
      <template v-if="wzStep === 'name'">
        <label class="env-label">{{ $t('env.nameLabel') }}</label>
        <input
          v-model.trim="wz.displayName"
          class="env-input"
          maxlength="60"
          :placeholder="$t('env.namePh')"
        />
        <label class="env-label">{{ $t('env.introLabel') }}</label>
        <textarea
          v-model.trim="wz.intro"
          class="env-textarea"
          maxlength="300"
          rows="2"
          :placeholder="$t('env.introPh')"
        />
        <p class="env-muted">{{ $t('env.draftNotice') }}</p>
        <button class="btn btn-primary" :disabled="!wz.displayName" @click="loadInventory">
          {{ $t('env.nextBtn') }}
        </button>
      </template>

      <!-- 2 勾选 -->
      <template v-else-if="wzStep === 'pick'">
        <div v-if="wz.invLoading" class="env-muted">{{ $t('env.invLoading') }}</div>
        <template v-else>
          <div class="env-pick-block">
            <div class="env-pick-title">{{ $t('env.col.software') }}</div>
            <div class="env-muted">{{ $t('env.col.softwareNote') }}</div>
          </div>
          <div class="env-pick-block" v-if="wz.inv?.skills?.length">
            <div class="env-pick-title">
              {{ $t('env.col.skills', { n: wz.inv.skills.length }) }}
            </div>
            <label v-for="sk in wz.inv.skills" :key="sk.name" class="env-check">
              <input type="checkbox" v-model="wz.skills" :value="sk.name" /> {{ sk.name }}
              <span class="env-muted">{{ fmtBytes(sk.size) }}</span>
            </label>
            <div class="env-muted">{{ $t('env.skillsFollowNote') }}</div>
          </div>
          <div class="env-pick-block" v-if="wz.inv?.plugins?.length">
            <div class="env-pick-title">
              {{ $t('env.col.plugins', { n: wz.inv.plugins.length }) }}
            </div>
            <label v-for="pl in wz.inv.plugins" :key="pl.name" class="env-check">
              <input type="checkbox" v-model="wz.plugins" :value="pl.name" /> {{ pl.name }}
              <span class="env-muted">{{ fmtBytes(pl.size) }} · {{ pl.sha8 }}</span>
            </label>
            <div class="env-danger env-small">{{ $t('env.pluginsWarn') }}</div>
          </div>
          <div class="env-pick-block">
            <div class="env-pick-title">{{ $t('env.col.folders') }}</div>
            <p v-if="!wz.workspace.length" class="env-muted">{{ $t('env.noWorkspace') }}</p>
            <label v-for="w in wz.workspace" :key="w.name" class="env-check">
              <input type="checkbox" v-model="wz.folders" :value="w.name" /> {{ w.name }}
              <span class="env-muted">{{ fmtBytes(w.sizeBytes) }}</span>
            </label>
            <div class="env-danger env-small">{{ $t('env.workspaceWarn') }}</div>
          </div>
          <div class="env-pick-block env-forbid">
            <div class="env-pick-title">{{ $t('env.col.denied') }}</div>
            <div class="env-muted">{{ $t('env.deniedNote') }}</div>
          </div>
          <div class="env-pick-total">
            {{
              $t('env.bundleTotal', {
                size: fmtBytes(totalBundleBytes),
                n: wz.plugins.length,
                cap: '200 MB',
              })
            }}
          </div>
          <div class="env-wz-nav">
            <button class="btn btn-secondary" @click="wzStep = 'name'">
              {{ $t('env.backBtn') }}
            </button>
            <button
              class="btn btn-primary"
              :disabled="wz.previewLoading || wz.invLoading"
              @click="runPreview"
            >
              {{ $t('env.nextBtn') }}
            </button>
          </div>
        </template>
      </template>

      <!-- 3 预览与知情 -->
      <template v-else-if="wzStep === 'confirm'">
        <div v-if="wz.previewLoading" class="env-muted">{{ $t('env.previewLoading') }}</div>
        <template v-else-if="wz.preview">
          <ul class="env-notice-list">
            <li v-for="(st, i) in wz.preview.steps || []" :key="'s' + i">{{ i + 1 }}. {{ st }}</li>
          </ul>
          <ul class="env-notice-list env-warn-list">
            <li v-for="(n, i) in wz.preview.notices || []" :key="'n' + i">{{ n }}</li>
          </ul>
          <p class="env-muted">
            {{
              $t('env.quotaUsed', { used: wz.preview.quota?.used, limit: wz.preview.quota?.limit })
            }}
          </p>
          <label class="env-check env-consent">
            <input type="checkbox" v-model="wz.consent" />
            {{
              $t('env.consentLine', {
                skills: wz.skills.length,
                plugins: wz.plugins.length,
                folders: wz.folders.length,
              })
            }}
          </label>
          <div class="env-wz-nav">
            <button class="btn btn-secondary" :disabled="wz.running" @click="wzStep = 'pick'">
              {{ $t('env.backBtn') }}
            </button>
            <button class="btn btn-primary" :disabled="!wz.consent || wz.running" @click="doFreeze">
              <span v-if="wz.running" class="btn-spin"></span>
              {{ wz.running ? $t('env.freezing') : $t('env.freezeGo') }}
            </button>
          </div>
        </template>
      </template>

      <!-- 执行中/完成 -->
      <template v-else-if="wzStep === 'run'">
        <div v-if="wz.running" class="env-muted env-spinner">{{ $t('env.running') }}</div>
        <template v-else-if="wz.result">
          <div class="env-done">{{ $t('env.freezeDone', { name: wz.displayName }) }}</div>
          <p class="env-muted">{{ wz.result.notice }}</p>
          <button class="btn btn-primary" @click="exitWizard(true)">
            {{ $t('env.backToList') }}
          </button>
        </template>
        <template v-else>
          <div class="env-danger">{{ wz.error || $t('env.freezeFailed') }}</div>
          <p class="env-muted">{{ $t('env.containerBackNote') }}</p>
          <button class="btn btn-secondary" @click="wzStep = 'confirm'">
            {{ $t('env.retryBtn') }}
          </button>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup>
/**
 * 环境模板·用户面（选用/回退/自助定格向导）——对接 PR1/③/2/3 全部端点。
 * 纪律：所有"将发生什么"的数据来自服务端 dryRun（前端不自己编停机秒数、
 * 不算冲突、不美化承诺）；勾选默认全不选；体积只展示服务端算好的数。
 */
import { ref, computed, onMounted } from 'vue'

// 一个组件两张脸（IA 重排：市场=逛与选用；容器管理=我的现场）：
//   mode='market' 货架段（讲解+模板卡片+dryRun 预览+选用）
//   mode='mine'   现场段（来源条+我的模板+定格区+向导）
//   默认 'both'   全量（独立路由/兼容）
const props = defineProps({ mode: { type: String, default: 'both' } })
const mode = props.mode
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import { toast, askConfirm } from '../composables/useDialog'

const { t } = useI18n()
const list = ref([])
const drafts = ref([])
const current = ref(null)
const canFreeze = ref(false)
const elig = ref({ status: 'loading', containerRunning: true, msg: '', onTemplate: null })
const loadingInv = ref(true)
const busy = ref(false)
// 中间态（用户验收：按了钮要有动静）：哪个动作在跑，对应按钮就转圈+说人话
const pending = ref('')
const expanded = ref('')
const preview = ref(null)

const wz = ref({
  active: false,
  displayName: '',
  intro: '',
  inv: null,
  workspace: [],
  invLoading: false,
  preview: null,
  previewLoading: false,
  consent: false,
  running: false,
  result: null,
  error: '',
})
const wzStep = ref('name')
const steps = ['name', 'pick', 'confirm', 'run']
const stepOrder = (s) => steps.indexOf(s)

async function loadAll() {
  const res = await axios.get('/api/user/environments')
  list.value = res.data.environments || []
  drafts.value = res.data.myDrafts || []
  current.value = res.data.yourCurrent || null
}

async function loadFreezeEligibility() {
  loadingInv.value = true
  try {
    const res = await axios.post('/api/user/environment-inventory', {})
    canFreeze.value = !!res.data.canFreeze
    // 状态分道：ok 才信 canFreeze/运行态；denied 走拒绝卡；error 走故障卡+重试
    // ——错误归错原因=让用户去修没坏的东西（本地测试亲历的坑）
    elig.value = {
      status: 'ok',
      containerRunning: res.data.containerRunning !== false,
      onTemplate: res.data.onTemplate || null,
    }
  } catch (e) {
    const code = e?.response?.status
    elig.value = {
      status: code === 403 ? 'denied' : 'error',
      containerRunning: true,
      msg: e?.response?.data?.error || e?.message || 'error',
    }
    canFreeze.value = false
  } finally {
    loadingInv.value = false
  }
}
onMounted(() => {
  loadAll().catch((e) => toast(errMsg(e)))
  if (mode !== 'market') loadFreezeEligibility() // 货架面不摸定格资格（少一次探测）
})

const errMsg = (e) => e?.response?.data?.error || e?.message || 'error'
const shortAddr = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '—')
const fmtBytes = (n) => {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < 3) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`
}

const detailFor = ref(null)
function detailToApply() {
  const tpl = detailFor.value
  detailFor.value = null
  if (tpl && current.value?.image !== tpl.id) togglePreview(tpl) // 展开该卡的选用预览
}

async function togglePreview(tpl) {
  if (expanded.value === tpl.id) {
    expanded.value = ''
    preview.value = null
    return
  }
  expanded.value = tpl.id
  preview.value = null
  busy.value = true
  pending.value = 'preview'
  try {
    const res = await axios.post('/api/user/environment/apply', { id: tpl.id, dryRun: true })
    preview.value = res.data
  } catch (e) {
    preview.value = { __fail: true }
    toast(errMsg(e))
    expanded.value = ''
  } finally {
    busy.value = false
    pending.value = ''
  }
}

async function applyForReal(tpl) {
  busy.value = true
  pending.value = 'apply'
  try {
    const res = await axios.post('/api/user/environment/apply', { id: tpl.id })
    expanded.value = ''
    preview.value = null
    const warns = []
    if (res.data.conflicts?.length)
      warns.push(t('env.appliedWithConflicts', { n: res.data.conflicts.length }))
    if (res.data.skillsFailed?.length)
      warns.push(
        t('env.skillsFailed', { list: res.data.skillsFailed.map((x) => x.name).join('、') }),
      )
    if (res.data.bundleError) warns.push(res.data.bundleError)
    ;(res.data.notices || []).forEach((n) => warns.push(n))
    toast(warns.length ? warns.join('；') : t('env.appliedOk'))
    await loadAll()
  } catch (e) {
    toast(errMsg(e))
  } finally {
    busy.value = false
    pending.value = ''
  }
}

async function resubmit(d) {
  busy.value = true
  try {
    await axios.post('/api/user/environment/submit', { id: d.id })
    toast(t('env.resubmitted'))
    await loadAll()
  } catch (e) {
    toast(errMsg(e))
  } finally {
    busy.value = false
  }
}

// 作者自助下架：published 回到草稿箱。下架≠删除——被引用之物不可物理删，
// 已在用的人（含作者自己）不受影响，只是市场不再展示、不再接受新的选用。
async function unpublishNow(tpl) {
  const go = await askConfirm({
    message: t('env.unpublishConfirm'),
    confirmLabel: t('env.unpublishBtn'),
  })
  if (!go) return
  busy.value = true
  try {
    const r = await axios.post('/api/user/environment/unpublish', { id: tpl.id })
    const n = r.data?.usingCount || 0
    toast(n ? t('env.unpublishedUsing', { n }) : t('env.unpublished'))
    detailFor.value = null
    await loadAll()
  } catch (e) {
    toast(errMsg(e))
  } finally {
    busy.value = false
  }
}

const revertClean = ref(false)

async function revertNow() {
  const go = await askConfirm({
    message: t('env.revertConfirm') + (revertClean.value ? ' ' + t('env.revertCleanOpt') : ''),
    confirmLabel: t('env.revertBtn'),
  })
  if (!go) return
  busy.value = true
  pending.value = 'revert'
  try {
    const r = await axios.post('/api/user/environment/revert', { alsoClean: revertClean.value })
    // 后端如实说明随行文件残留（只换镜像不删文件）——有则转告，无则原话
    toast(
      (r.data?.revertNote || t('env.reverted')) + (r.data?.cleanNote ? ' ' + r.data.cleanNote : ''),
    )
    await loadAll()
  } catch (e) {
    toast(errMsg(e))
  } finally {
    busy.value = false
    pending.value = ''
  }
}

// ---- 向导 ----
function openWizard() {
  wz.value = {
    active: true,
    displayName: '',
    intro: '',
    skills: [],
    plugins: [],
    folders: [],
    inv: null,
    workspace: [],
    invLoading: false,
    preview: null,
    previewLoading: false,
    consent: false,
    running: false,
    result: null,
    error: '',
  }
  wzStep.value = 'name'
}
function exitWizard(quiet) {
  wz.value.active = false
  if (!quiet) return
  loadAll().catch(() => {})
}
async function loadInventory() {
  wzStep.value = 'pick'
  wz.value.invLoading = true
  try {
    const res = await axios.post('/api/user/environment-inventory', {})
    wz.value.inv = res.data.inventory
    wz.value.workspace = res.data.workspace || []
  } catch (e) {
    toast(errMsg(e))
    wzStep.value = 'name'
  } finally {
    wz.value.invLoading = false
  }
}
async function runPreview() {
  wzStep.value = 'confirm'
  wz.value.previewLoading = true
  wz.value.preview = null
  try {
    const res = await axios.post('/api/user/environment-commit', { ...commitBody(), dryRun: true })
    wz.value.preview = res.data
  } catch (e) {
    toast(errMsg(e))
    wzStep.value = 'pick'
  } finally {
    wz.value.previewLoading = false
  }
}
function commitBody() {
  return {
    displayName: wz.value.displayName,
    intro: wz.value.intro,
    include: { skills: wz.value.skills, plugins: wz.value.plugins, folders: wz.value.folders },
  }
}
async function doFreeze() {
  wzStep.value = 'run'
  wz.value.running = true
  wz.value.result = null
  wz.value.error = ''
  try {
    const res = await axios.post('/api/user/environment-commit', commitBody())
    wz.value.result = res.data
  } catch (e) {
    wz.value.error = errMsg(e)
  } finally {
    wz.value.running = false
  }
}
const totalBundleBytes = computed(() => {
  const want = new Set(wz.value.plugins || [])
  return (wz.value.inv?.plugins || [])
    .filter((p) => want.has(p.name))
    .reduce((a, p) => a + p.size, 0)
})
</script>

<style scoped>
.env-page {
  padding: 4px 2px;
}
.env-h4 {
  margin: 18px 0 8px;
  font-size: 14px;
}
.env-current {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--bg-secondary, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
}
.env-current-label {
  font-size: 13px;
  opacity: 0.75;
}
/* 与市场技能卡同一副皮（用户验收：卡片统一；改这里请同步 SkillMarket 的
   .skill-card/.skill-card-head/.skill-meta/.skill-description/.skill-card-actions
   ——规格逐值镜像：280px 网格、无阴影无悬停、标题 1.05rem mono、meta 0.78rem 灰） */
.env-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}
.env-card {
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  background: #fff;
}
.env-card-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.env-card-name {
  font-size: 1.05rem;
  color: #1e293b;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.env-card-meta {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  font-size: 0.78rem;
  color: #94a3b8;
}
.env-card-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.env-card-intro {
  margin: 0;
  color: #475569;
  font-size: 0.9rem;
  line-height: 1.5;
  flex: 1;
}
.env-preview {
  border-top: 1px dashed var(--border-color, rgba(255, 255, 255, 0.12));
  margin-top: 6px;
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.env-notice-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
}
.env-warn-list li {
  color: var(--warn-color, #d9a441);
}
.env-promise {
  font-size: 12px;
  margin: 0;
  color: var(--ok-color, #57b874);
}
.env-conflict-item {
  font-size: 11px;
  opacity: 0.8;
  padding-left: 8px;
}
.env-danger {
  color: var(--danger-color, #d96b6b);
}
.env-small {
  font-size: 12px;
}
.env-muted {
  font-size: 12px;
  opacity: 0.65;
}
.env-empty {
  font-size: 13px;
  opacity: 0.6;
}
.env-mine-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  margin-bottom: 6px;
  font-size: 13px;
  flex-wrap: wrap;
}
.env-reject-reason {
  width: 100%;
  font-size: 12px;
  color: var(--danger-color, #d96b6b);
}
.env-freeze-zone {
  margin-top: 22px;
}
.env-premise {
  font-size: 12px;
  opacity: 0.8;
  margin: 8px 0 0;
}
.env-what {
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 10px;
  padding: 10px 14px;
  margin-bottom: 10px;
  background: var(--bg-secondary, rgba(255, 255, 255, 0.03));
}
.env-what b {
  font-size: 13px;
}
.env-what ul {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  opacity: 0.85;
  line-height: 1.7;
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
  border-radius: 16px;
  padding: 1.5rem;
  max-width: 720px;
  width: calc(100% - 2rem);
  max-height: 86vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  box-shadow: 0 20px 50px rgba(0, 0, 42, 0.25);
  color: #1e293b;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.detail-head h3 {
  margin: 0;
  color: #1e293b;
}
.detail-cols {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
  padding: 0.9rem 1rem;
  font-size: 0.9rem;
}
.detail-cols ul {
  margin: 0.35rem 0 0;
  padding-left: 1.1rem;
}
.detail-actions {
  display: flex;
  gap: 0.6rem;
  justify-content: flex-end;
}
.btn-spin {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  vertical-align: -1px;
  border: 2px solid rgba(255, 255, 255, 0.45);
  border-top-color: #fff;
  border-radius: 50%;
  animation: env-spin 0.8s linear infinite;
}
.env-card-actions .btn-secondary .btn-spin,
.env-current .btn-spin,
.btn-secondary .btn-spin {
  border-color: rgba(100, 116, 139, 0.35);
  border-top-color: #475569;
}
@keyframes env-spin {
  to {
    transform: rotate(360deg);
  }
}
.env-clean-opt {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  color: #64748b;
  cursor: pointer;
  user-select: none;
}
.env-wall {
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.env-wall-title {
  font-size: 14px;
  font-weight: 600;
}
.env-wall-why,
.env-wall-steps {
  font-size: 13px;
  line-height: 1.65;
  margin: 0;
}
.env-wall-safe {
  font-size: 13px;
  color: var(--ok-color, #57b874);
  margin: 0;
}
.env-wizard {
  margin-top: 14px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.env-wz-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.env-wz-step {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  opacity: 0.55;
}
.env-wz-step.on {
  opacity: 1;
  border-color: var(--primary-color, #4a8df8);
}
.env-wz-step.done {
  opacity: 0.85;
}
.env-wz-exit {
  margin-left: auto;
}
.env-label {
  display: block;
  font-size: 12px;
  opacity: 0.75;
  margin-top: 6px;
}
.env-input,
.env-textarea {
  width: 100%;
  box-sizing: border-box;
  margin-top: 4px;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
  background: transparent;
  color: inherit;
  font-size: 13px;
}
.env-pick-block {
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 10px;
  padding: 10px 12px;
}
.env-pick-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}
.env-check {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  padding: 3px 0;
  cursor: pointer;
}
.env-forbid {
  opacity: 0.75;
  background: rgba(255, 80, 80, 0.05);
}
.env-pick-total {
  font-size: 12px;
  opacity: 0.8;
}
.env-wz-nav {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.env-consent {
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
  border-radius: 8px;
  padding: 8px 10px;
}
.env-spinner {
  animation: envpulse 1.2s ease-in-out infinite;
}
@keyframes envpulse {
  50% {
    opacity: 0.35;
  }
}
.badge-danger {
  color: #fff;
  background: rgba(217, 107, 107, 0.25);
  border: 1px solid rgba(217, 107, 107, 0.5);
}
.env-done {
  font-size: 14px;
  color: var(--ok-color, #57b874);
}
</style>
