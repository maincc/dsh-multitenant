<!-- 凭证管理 tab（P3 拆分自 AdminPanel）：CWT 审批队列 + 凭证台账 + 任免名册。
     域状态与动作全在 useAdminCred 单例（与 AdminTabUsers 的 demoteAdmin 同源）。 -->
<script setup>
import { onMounted } from 'vue'
import { useAdminCred } from '../../composables/useAdminCred.js'
import { shortAddress } from '../../utils/format.js'
import { fmtTime } from './shared.js'

const {
  cwtApps,
  cwtTotal,
  cwtStatusFilter,
  cwtLoading,
  cwtBusy,
  credRows,
  credTotal,
  credKind,
  credQ,
  credLoading,
  rosterAddrs,
  rosterHistory,
  rosterLoading,
  rosterBusy,
  loadCwtApps,
  setCwtStatus,
  cwtOffset,
  cwtPage,
  loadCredRows,
  setCredKind,
  credOffset,
  credPage,
  loadRoster,
  demoteAdmin,
  approveCwt,
  rejectCwt,
} = useAdminCred()

// cwtOffset/credOffset 驱动翻页（cwtPage 内部改），模板只读 total 与 filter
onMounted(() => {
  loadCwtApps()
  loadCredRows()
  loadRoster()
})
</script>

<template>
  <div>
    <div class="tab-head">
      <div class="tab-head-text">
        <h4>{{ $t('admin.credTabTitle') }}</h4>
        <p class="tab-hint">{{ $t('admin.credTabHint') }}</p>
      </div>
    </div>
    <div class="filter-row">
      <button
        v-for="s in ['pending', 'approved', 'rejected']"
        :key="s"
        class="btn btn-small"
        :class="cwtStatusFilter === s ? 'btn-primary' : 'btn-secondary'"
        @click="setCwtStatus(s)"
      >
        {{ $t('admin.credStatus_' + s) }}
      </button>
      <span class="badge badge-info">{{ $t('admin.credTotal', { n: cwtTotal }) }}</span>
      <button class="btn btn-small" :disabled="cwtLoading" @click="loadCwtApps">
        {{ $t('admin.refresh') }}
      </button>
    </div>
    <div v-if="cwtLoading" class="loading">{{ $t('admin.loading') }}</div>
    <div v-else class="table-scroll">
      <table class="cred-table">
        <thead>
          <tr>
            <th>{{ $t('admin.colAddress') }}</th>
            <th>{{ $t('admin.credColSubmitted') }}</th>
            <th>{{ $t('admin.credColStatus') }}</th>
            <th>{{ $t('admin.colOps') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!cwtApps.length">
            <td colspan="4">{{ $t('admin.credEmpty') }}</td>
          </tr>
          <tr v-for="app in cwtApps" :key="app._id">
            <td>
              <span class="address addr-tip" :data-full="app.addressDisplay || app.address"
                >{{ (app.addressDisplay || app.address).slice(0, 10) }}...</span
              >
            </td>
            <td>{{ fmtTime(app.submittedAt) }}</td>
            <td>
              <span
                class="badge"
                :class="
                  app.status === 'pending'
                    ? 'badge-warning'
                    : app.status === 'approved'
                      ? 'badge-success'
                      : 'badge-info'
                "
                >{{ $t('admin.credStatus_' + app.status) }}</span
              >
              <span v-if="app.decidedAt" class="dsh-ver-unknown">{{ fmtTime(app.decidedAt) }}</span>
            </td>
            <td>
              <div v-if="app.status === 'pending'" class="ops-cell">
                <button class="btn btn-success" :disabled="!!cwtBusy" @click="approveCwt(app)">
                  {{ $t('admin.credApprove') }}
                </button>
                <button class="btn" :disabled="!!cwtBusy" @click="rejectCwt(app)">
                  {{ $t('admin.credReject') }}
                </button>
              </div>
              <span v-else>-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="ops-cell" style="margin-top: 0.75rem">
      <button class="btn btn-small" :disabled="cwtOffset === 0" @click="cwtPage(-1)">
        {{ $t('admin.credPrev') }}
      </button>
      <button class="btn btn-small" :disabled="cwtOffset + 10 >= cwtTotal" @click="cwtPage(1)">
        {{ $t('admin.credNext') }}
      </button>
    </div>

    <div class="tab-head" style="margin-top: 1.75rem">
      <div class="tab-head-text">
        <h4>{{ $t('admin.ledgerTitle') }}</h4>
        <p class="tab-hint">{{ $t('admin.ledgerHint') }}</p>
      </div>
    </div>
    <div class="filter-row">
      <button
        v-for="k in ['all', 'did', 'cwt', 'admin']"
        :key="k"
        class="btn btn-small"
        :class="credKind === k ? 'btn-primary' : 'btn-secondary'"
        @click="setCredKind(k)"
      >
        {{ $t('admin.ledgerKind_' + k) }}
      </button>
      <input
        v-model="credQ"
        class="search-input"
        :placeholder="$t('admin.ledgerSearchPh')"
        @keyup.enter="setCredKind(credKind)"
      />
      <span class="badge badge-info">{{ $t('admin.credTotal', { n: credTotal }) }}</span>
      <button class="btn btn-small" :disabled="credLoading" @click="loadCredRows">
        {{ $t('admin.refresh') }}
      </button>
    </div>
    <div v-if="credLoading" class="loading">{{ $t('admin.loading') }}</div>
    <div v-else class="table-scroll">
      <table class="cred-table">
        <thead>
          <tr>
            <th>{{ $t('admin.colAddress') }}</th>
            <th>{{ $t('admin.ledgerColKind') }}</th>
            <th>{{ $t('admin.ledgerColState') }}</th>
            <th>{{ $t('admin.ledgerColSource') }}</th>
            <th>{{ $t('admin.ledgerColIssued') }}</th>
            <th>{{ $t('admin.ledgerColVc') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!credRows.length">
            <td colspan="6">{{ $t('admin.ledgerEmpty') }}</td>
          </tr>
          <tr v-for="c in credRows" :key="c.address">
            <td>
              <span class="address addr-tip" :data-full="c.addressDisplay || c.address"
                >{{ (c.addressDisplay || c.address).slice(0, 10) }}...</span
              >
            </td>
            <td>
              <!-- 三类卡制式：管理凭证是独立第三类（isAdmin=台账 roles 事实），
                         不并入解限 CWT——两者权限语义完全不同 -->
              <span
                class="badge"
                :class="
                  c.isAdmin ? 'badge-danger' : c.kind === 'cwt' ? 'badge-success' : 'badge-info'
                "
                >{{ $t('admin.ledgerCard_' + (c.isAdmin ? 'admin' : c.kind)) }}</span
              >
            </td>
            <td>
              <span
                class="badge"
                :class="c.state === 'claimed' ? 'badge-success' : 'badge-warning'"
                >{{ $t('admin.ledgerState_' + c.state) }}</span
              >
            </td>
            <td>{{ $t('admin.ledgerSrc_' + c.source) }}</td>
            <td>
              {{ fmtTime(c.issuedAt) }}
              <span v-if="c.claimedAt" class="dsh-ver-unknown"
                >{{ $t('admin.ledgerClaimedAt') }} {{ fmtTime(c.claimedAt) }}</span
              >
              <span v-if="c.expiresAt" class="dsh-ver-unknown"
                >{{ $t('admin.ledgerExpiresAt') }} {{ fmtTime(c.expiresAt) }}</span
              >
            </td>
            <td>
              <span v-if="c.vcId" class="addr-tip" :data-full="c.vcId">{{
                '#' + (c.vcId.split('#')[1] || c.vcId)
              }}</span>
              <span v-else>-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="ops-cell" style="margin-top: 0.75rem">
      <button class="btn btn-small" :disabled="credOffset === 0" @click="credPage(-1)">
        {{ $t('admin.credPrev') }}
      </button>
      <button class="btn btn-small" :disabled="credOffset + 10 >= credTotal" @click="credPage(1)">
        {{ $t('admin.credNext') }}
      </button>
    </div>

    <div class="tab-head" style="margin-top: 1.75rem">
      <div class="tab-head-text">
        <h4>{{ $t('admin.rosterTitle') }}</h4>
        <p class="tab-hint">{{ $t('admin.rosterHint') }}</p>
      </div>
    </div>
    <div class="filter-row">
      <!-- 任命/撤销操作已统一收敛到「用户管理」行内按钮（2026-10-23 用户拍板
                 去双入口）；本块转为现任名册只读审计视图 -->
      <button class="btn btn-small" :disabled="rosterLoading" @click="loadRoster">
        {{ $t('admin.refresh') }}
      </button>
    </div>
    <div v-if="rosterLoading" class="loading">{{ $t('admin.loading') }}</div>
    <div v-else class="table-scroll">
      <table class="cred-table">
        <thead>
          <tr>
            <th>{{ $t('admin.colAddress') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rosterAddrs.length">
            <td>{{ $t('admin.rosterEmpty') }}</td>
          </tr>
          <tr v-for="a in rosterAddrs" :key="a">
            <td>
              <span class="address addr-tip" :data-full="a"
                >{{ a.slice(0, 12) }}…{{ a.slice(-4) }}</span
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="rosterHistory.length" style="margin-top: 0.75rem">
      <p class="hint">{{ $t('admin.rosterHistoryTitle') }}</p>
      <div v-for="(h, i) in rosterHistory.slice(0, 8)" :key="i" class="hint">
        {{ fmtTime(h.timestamp) }} · {{ $t('admin.rosterAct_' + h.action) }}
        <span v-if="h.address" class="addr-tip" :data-full="h.address"
          >{{ h.address.slice(0, 12) }}…</span
        >
        <span v-if="h.operator">（by {{ h.operator.slice(0, 10) }}…）</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cwt-empty {
  color: var(--text-faint);
  padding: 0.6rem 0;
  font-size: 0.875rem;
}

.cwt-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.cwt-list-head h4 {
  margin: 0;
}

.cwt-filter {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  color: var(--text-muted);
}

.cwt-filter select {
  -webkit-appearance: none;
  appearance: none;
  padding: 0.25rem 1.5rem 0.25rem 0.45rem; /* 文字左右等距：左侧=0.45rem，右侧=箭头让位后的0.45rem */
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: var(--surface-white)
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='7' viewBox='0 0 10 7'><path d='M1 1l4 4 4-4' fill='none' stroke='%2364748b' stroke-width='1.6' stroke-linecap='round'/></svg>")
    no-repeat right 0.5rem center;
  font-size: 0.82rem;
  color: var(--text-body);
}

.cwt-filter select:focus {
  outline: none;
  border-color: var(--brand);
  box-shadow: 0 0 0 2px rgba(64, 126, 255, 0.15);
}

.cwt-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-top: 0.6rem;
  flex-wrap: wrap;
}

.cwt-page-info {
  font-size: 0.82rem;
  color: var(--text-muted);
}

.cwt-more-hint {
  color: var(--text-faint);
}

.cwt-page-btns {
  display: flex;
  gap: 0.4rem;
}

.cwt-token-preview {
  margin-top: 0.4rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.72rem;
  background: var(--bg-page);
  border-radius: 8px;
  padding: 0.4rem;
  word-break: break-all;
  max-width: 420px;
  border: 1px solid var(--surface-soft);
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.table-scroll {
  overflow-x: auto;
}

.cred-table th,
.cred-table td {
  white-space: nowrap;
}
</style>
