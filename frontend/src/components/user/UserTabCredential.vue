<!-- 凭证卡（v1.5 三分：DID 普通 / CWT 解限 / 管理凭证，互斥单卡）——
     P3 拆分自 UserCenter account tab。状态动作走 useUserCred 单例；
     credInfo 由壳 handleAddressChange 拉取，此处纯消费。 -->
<script setup>
import { shortAddress } from '../../utils/format.js'
import { useUserCred } from '../../composables/useUserCred.js'

const {
  credInfo,
  credApp,
  credBusy,
  credErr,
  credRetrying,
  credVerifiedBy,
  credNoDid,
  credPopupShown,
  credVcOpen,
  credVc,
  credVcConsistent,
  credVcLoading,
  credNeedsSync,
  credExpDays,
  copyText,
  toggleCredVc,
  resignSessionTo,
  loadCredentialStatus,
  retryCredential,
  sha256Hex,
  claimCredential,
  applyCwt,
  connected,
} = useUserCred()
</script>

<template>
  <!-- ════ v1.4 凭证体系（v1.5 三分：DID 普通 / CWT 解限 / 管理凭证，互斥单卡） ════ -->
  <div v-if="credInfo" class="cred-card">
    <div class="cred-head">
      <span class="cred-title">{{ $t('user.credTitle') }}</span>
      <span
        class="badge"
        :class="
          credInfo.isAdmin
            ? 'badge-danger'
            : credInfo.kind === 'cwt'
              ? 'badge-success'
              : 'badge-info'
        "
      >
        {{
          credInfo.isAdmin
            ? $t('user.credKindAdmin')
            : credInfo.kind === 'cwt'
              ? $t('user.credKindCwt')
              : $t('user.credKindDid')
        }}
      </span>
      <span class="badge" :class="credInfo.state === 'claimed' ? 'badge-success' : 'badge-warning'">
        {{
          credInfo.state === 'claimed' ? $t('user.credStateClaimed') : $t('user.credStateAssigned')
        }}
      </span>
    </div>
    <p class="tab-hint">
      {{
        credInfo.isAdmin
          ? $t('user.credHintAdmin')
          : credInfo.kind === 'cwt'
            ? $t('user.credHintCwt')
            : $t('user.credHintDid')
      }}
    </p>

    <!-- 凭证明细：这张卡的关键字段（与平台档案登记册一致） -->
    <div class="cred-detail">
      <div class="stat-row">
        <span class="stat-label">{{ $t('user.credDVCId') }}</span>
        <span class="stat-value mono addr-tip" :data-full="credInfo.vcId || '—'">
          <span class="stat-clip">{{
            credInfo.vcId ? '#' + (credInfo.vcId.split('#')[1] || credInfo.vcId) : '—'
          }}</span>
          <button
            v-if="credInfo.vcId"
            class="copy-mini"
            :title="$t('user.credCopy')"
            @click="copyText(credInfo.vcId)"
          >
            📋
          </button>
        </span>
      </div>
      <div v-if="credInfo.profileDid" class="stat-row">
        <span class="stat-label">{{ $t('user.credDProfile') }}</span>
        <span class="stat-value mono addr-tip" :data-full="credInfo.profileDid">
          <span class="stat-clip">
            {{ credInfo.profileDid.slice(0, 18) }}…{{ credInfo.profileDid.slice(-6) }}
          </span>
          <button
            class="copy-mini"
            :title="$t('user.credCopy')"
            @click="copyText(credInfo.profileDid)"
          >
            📋
          </button>
        </span>
      </div>
      <div class="stat-row">
        <span class="stat-label">{{ $t('user.credDSource') }}</span>
        <span class="stat-value">{{ $t('user.credSrc_' + credInfo.source) }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">{{ $t('user.credDIssued') }}</span>
        <span class="stat-value">{{
          credInfo.issuedAt ? new Date(credInfo.issuedAt).toLocaleString() : '—'
        }}</span>
      </div>
      <div v-if="credInfo.claimedAt" class="stat-row">
        <span class="stat-label">{{ $t('user.credDClaimed') }}</span>
        <span class="stat-value">{{ new Date(credInfo.claimedAt).toLocaleString() }}</span>
      </div>
      <div v-if="credInfo.expiresAt" class="stat-row">
        <span class="stat-label">{{ $t('user.credDExpires') }}</span>
        <span
          class="stat-value"
          :class="{ 'cred-exp-warn': credExpDays !== null && credExpDays <= 30 }"
          >{{ new Date(credInfo.expiresAt).toLocaleDateString() }}
          <em v-if="credExpDays > 30">{{ $t('user.credExpLeft', { n: credExpDays }) }}</em>
          <em v-else-if="credExpDays > 0">{{ $t('user.credExpSoon') }}</em>
          <em v-else>{{ $t('user.credExpRenewing') }}</em></span
        >
      </div>
      <!-- 判权依据溯源（2026-10-23 定式"先跑档案，出错跑台账"）：让用户看见
                   本轮放行是档案活验背书、还是官网抖动下的台账兜底 -->
      <div v-if="credInfo.state === 'claimed' && credVerifiedBy" class="stat-row">
        <span class="stat-label">{{ $t('user.credDVerifiedBy') }}</span>
        <span class="stat-value">
          <span v-if="credVerifiedBy === 'archive'" class="badge badge-success">
            {{ $t('user.verifiedByArchive') }}
          </span>
          <span v-else class="badge badge-warning" :title="$t('user.verifiedByLedgerHint')">
            {{ $t('user.verifiedByLedger') }}
          </span>
        </span>
      </div>
      <div v-if="credInfo.state === 'claimed'" class="stat-row">
        <span class="stat-label">{{ $t('user.credDOnchain') }}</span>
        <span class="stat-value">
          <span
            v-if="credInfo.onChain && credInfo.onChain.status === 'ok'"
            class="badge badge-success"
            >{{ $t('user.credOnchainOk') }}</span
          >
          <span
            v-else-if="credInfo.onChain && credInfo.onChain.status === 'stale'"
            class="badge badge-warning"
            :title="credInfo.onChain.reason || ''"
            >{{ $t('user.credOnchainStale') }}</span
          >
          <span
            v-else-if="
              credInfo.onChain &&
              (credInfo.onChain.status === 'invalid' || credInfo.onChain.status === 'missing')
            "
            class="badge badge-warning"
            :title="credInfo.onChain.reason || ''"
            >{{ $t('user.credOnchainGone') }}</span
          >
          <span v-else class="badge badge-info">{{ $t('user.credOnchainPending') }}</span>
        </span>
      </div>
      <div v-if="credInfo.state === 'claimed'" class="stat-row">
        <span class="stat-label">{{ $t('user.credDBody') }}</span>
        <span class="stat-value">
          <button
            class="btn btn-small btn-secondary"
            :disabled="credVcLoading"
            @click="toggleCredVc"
          >
            {{ credVcOpen ? $t('user.credVcHide') : $t('user.credVcShow') }}
          </button>
        </span>
      </div>
    </div>
    <div v-if="credVcOpen" class="cred-vc-view">
      <div v-if="credVcOpen && credVc && !credVcConsistent" class="cred-nodid">
        <p class="cred-nodid-title">⚠️ {{ $t('user.credVcStaleTitle') }}</p>
        <p>{{ $t('user.credVcStaleBody') }}</p>
      </div>
      <div class="cred-vc-bar">
        <span class="stat-label">{{ $t('user.credVcTitle') }}</span>
        <button
          class="btn btn-small btn-secondary"
          :disabled="!credVc"
          @click="copyText(JSON.stringify(credVc, null, 2))"
        >
          {{ $t('user.credCopyJson') }}
        </button>
      </div>
      <div v-if="credVcLoading" class="loading">{{ $t('user.loading') }}</div>
      <pre v-else-if="credVc" class="cred-vc-json">{{ JSON.stringify(credVc, null, 2) }}</pre>
    </div>

    <!-- 无 DID 档案指引：先去生成，务必核对地址 -->
    <div v-if="credNoDid" class="cred-nodid">
      <p class="cred-nodid-title">⚠️ {{ $t('user.credNoDidTitle') }}</p>
      <p>
        {{ $t('user.credNoDidBody') }}
        <a :href="credNoDid.didGenUrl" target="_blank" rel="noopener" class="mono">{{
          credNoDid.didGenUrl
        }}</a>
      </p>
      <p class="cred-warn">
        {{ $t('user.credNoDidWarnPrefix') }}
        <code class="mono">{{ credNoDid.expectedAddress }}</code>
        {{ $t('user.credNoDidWarnSuffix') }}
      </p>
    </div>

    <div class="action-buttons">
      <button
        v-if="credInfo.state === 'assigned' || credNeedsSync"
        class="btn btn-primary"
        :disabled="credBusy === 'claim'"
        @click="claimCredential"
      >
        {{
          credBusy === 'claim'
            ? $t('user.credClaiming')
            : credInfo.state === 'assigned'
              ? $t('user.credClaimBtn')
              : $t('user.credSyncBtn')
        }}
      </button>
      <button
        v-if="
          credInfo.kind === 'did' &&
          credInfo.state === 'claimed' &&
          (!credApp || credApp.status === 'rejected')
        "
        class="btn btn-secondary"
        :disabled="credBusy === 'apply'"
        @click="applyCwt"
      >
        {{ credBusy === 'apply' ? $t('user.credApplying') : $t('user.credApplyBtn') }}
      </button>
      <span v-if="credApp && credApp.status === 'pending'" class="badge badge-warning">{{
        $t('user.credAppPending')
      }}</span>
    </div>
  </div>
  <!-- 凭证区占位态（用户反馈"凭证在哪"的兜底）：读取失败不再让整块静默消失——
               永远可见"发生了什么 + 一键重试"，与 credInfo 有值时的卡面互斥（v-if/v-else） -->
  <div v-else class="cred-card">
    <div class="cred-head">
      <span class="cred-title">{{ $t('user.credTitle') }}</span>
      <span class="badge badge-warning">{{ $t('user.credNotLoaded') }}</span>
    </div>
    <p class="tab-hint">
      {{
        credErr?.code === 'SESSION_MISMATCH'
          ? $t('user.credMismatchHint')
          : credErr?.status === 401
            ? $t('user.credExpiredHint')
            : $t('user.credNotLoadedHint')
      }}
    </p>
    <div class="action-buttons">
      <button
        class="btn btn-secondary"
        :disabled="!connected || credRetrying"
        @click="retryCredential"
      >
        {{ credRetrying ? $t('user.credRetrying') : $t('user.credRetry') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.cred-dot.ok {
  background: var(--success);
}

.cred-dot.missing {
  background: #ef4444;
}

.cwt-meta {
  color: var(--text-muted);
  font-size: 0.9rem;
  margin: 0.35rem 0;
}

.cwt-apply-form .btn {
  margin-top: 0.2rem;
}

.cred-card {
  margin-top: 1rem;
  padding: 1rem 1.25rem;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 0.75rem;
  background: var(--surface-2, #f9fafb);
}

.cred-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.cred-detail {
  margin: 0.5rem 0 0.75rem;
  padding: 0.25rem 0.75rem;
  background: var(--surface-1, rgba(127, 127, 127, 0.05));
  border-radius: 0.6rem;
}

.cred-vc-view {
  margin: -0.25rem 0 0.75rem;
}

.cred-vc-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.35rem;
}

.cred-exp-warn {
  color: #d97706;
}

.cred-exp-warn em {
  font-style: normal;
  font-size: 0.85em;
}

.cred-vc-json {
  max-height: 18rem;
  overflow: auto;
  padding: 0.75rem;
  background: var(--surface-1, #f3f4f6);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 0.6rem;
  font-size: 0.75rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
}

.cred-title {
  font-weight: 600;
  font-size: 1rem;
}

.cred-nodid {
  margin: 0.75rem 0;
  padding: 0.75rem 1rem;
  border: 1px solid var(--warning, #f59e0b);
  border-radius: 0.5rem;
  background: rgba(245, 158, 11, 0.08);
  font-size: 0.875rem;
}

.cred-nodid a {
  font-weight: 600;
  word-break: break-all;
}

.cred-nodid-title {
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.cred-warn {
  margin-top: 0.25rem;
  color: var(--danger, var(--danger));
  font-weight: 500;
}

.cred-warn code {
  word-break: break-all;
}
</style>
