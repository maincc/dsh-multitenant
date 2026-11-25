<!-- DSH 版本管理 tab（P3 拆分自 AdminPanel，最大一刀：512 行模板 + 46 件域声明）。
     域状态在 useAdminDsh 单例（构建/批量切 tab 保活）；升级全屏遮罩留壳。
     进入自拉状态/镜像；任务在跑则续表；停表只在页面卸载（cleanupDsh）。 -->
<script setup>
import { onMounted } from 'vue'
import { shortAddress, formatBytes } from '../../utils/format.js'
import { fmtTime } from './shared.js'
import AdminTabHead from './AdminTabHead.vue'
import { useAdminDsh } from '../../composables/useAdminDsh.js'

const {
  dshStatus,
  dshStatusLoading,
  dshError,
  dshVersions,
  dshVersionsLoading,
  dshVersionsError,
  dshIncludePrerelease,
  dshSelectedVersion,
  dshBuild,
  dshApply,
  dshApplyResults,
  dshImages,
  dshImagesLoading,
  dshImagesError,
  dshSelecting,
  dshTargetImage,
  dshAvailableImages,
  pruneItems,
  pruneableItems,
  pruneableBytes,
  pruneInfoIncomplete,
  dshPrune,
  selectedImageIds,
  allVersionOptions,
  versionIsLocal,
  needsApply,
  targetImageFor,
  loadDshStatus,
  loadDshImages,
  loadDshVersions,
  stopDshPolling,
  anyDshTaskRunning,
  finishBatchUpdate,
  startDshPolling,
  toggleSelectAllImages,
  pruneImages,
  selectPlatformImage,
  setTargetImage,
  applyOne,
  applyAllStale,
  previewApplyOne,
  previewApplyAll,
  startImageUpgrade,
  formatTime,
  shortImageId,
} = useAdminDsh()

defineEmits(['refresh'])

onMounted(() => {
  loadDshStatus().catch(() => {})
  loadDshImages().catch(() => {})
  if (anyDshTaskRunning()) startDshPolling()
})
</script>

<template>
  <div>
    <AdminTabHead :title="$t('admin.tabDsh')" :hint="$t('admin.dshHint')" />

    <!-- 2026-10 审计：读失败必须在本 tab 内可见。此前写进全局 error，
               而横幅只挂在 users tab——dsh 表读挂了既看不见，还会串到别的
               tab 冒出不相关的错误 -->
    <div v-if="dshError" class="error">{{ dshError }}</div>

    <!-- 两层模型说明：镜像层 vs 租户层 -->
    <div class="dsh-model-card">
      <div class="dsh-model-step">
        <span class="dsh-step-no">1</span>
        <div>
          <strong>{{ $t('admin.dshLayerImage') }}</strong>
          <p>{{ $t('admin.dshLayerImageDesc') }}</p>
        </div>
      </div>
      <div class="dsh-model-step">
        <span class="dsh-step-no">2</span>
        <div>
          <strong>{{ $t('admin.dshLayerTenant') }}</strong>
          <p>{{ $t('admin.dshLayerTenantDesc') }}</p>
        </div>
      </div>
    </div>

    <!-- ① 本地版本列表：远端有哪些版本、哪些已经建成镜像 -->
    <div class="dsh-card">
      <div class="dsh-card-head">
        <h5>
          <span class="dsh-step">1</span>
          {{ $t('admin.dshStepVersions') }}
        </h5>
        <label class="dsh-check">
          <input v-model="dshIncludePrerelease" type="checkbox" @change="loadDshVersions" />
          {{ $t('admin.dshShowPrerelease') }}
        </label>
      </div>

      <p v-if="dshVersionsError" class="dsh-error">{{ dshVersionsError }}</p>

      <!-- 选中一个版本 → 构建镜像 -->
      <div class="dsh-row">
        <select v-model="dshSelectedVersion" class="dsh-select">
          <option value="">{{ $t('admin.dshSelectVersion') }}</option>
          <option v-for="v in allVersionOptions" :key="v.version" :value="v.version">
            {{ v.version }}{{ v.version === dshVersions.latest ? ' ★' : '' }}{{ v.local ? ' ✓' : ''
            }}{{ v.stable ? '' : ' ' + $t('admin.dshPreShort') }}
          </option>
        </select>
        <button class="btn btn-small" :disabled="dshVersionsLoading" @click="loadDshVersions(true)">
          {{ dshVersionsLoading ? $t('admin.loading') : $t('admin.dshRefreshVersions') }}
        </button>
        <span class="dsh-hint-small">
          {{ $t('admin.dshPrereleaseCount', { n: dshVersions.prereleaseCount ?? 0 }) }}
        </span>
      </div>

      <p class="dsh-hint-small">{{ $t('admin.dshVersionsHint') }}</p>

      <!-- 本地镜像钦定：机器上现存的任意租户镜像可直接选为平台默认
                 （不必先"构建"——覆盖 docker load 传入、历史遗留 tag 等场景）。
                 原先的"本地已构建的版本"表与它同源同形，已并入这里统一呈现。 -->
      <h6 class="dsh-subhead">
        {{ $t('admin.dshLocalImages') }}
        <span class="dsh-muted">（{{ dshImages.images.length }}）</span>
        <button class="btn btn-small" :disabled="dshImagesLoading" @click="loadDshImages">
          {{ dshImagesLoading ? $t('admin.loading') : $t('admin.refresh') }}
        </button>
      </h6>
      <!-- 先把"现在的总体镜像是谁"说明白（含"没有/读不出"两种状态）：
                 看不到现状却要对现状签名，是没有道理的交互 -->
      <p class="dsh-note">
        {{ $t('admin.dshCurrentDefault') }}：
        <template v-if="dshImages.defaultId">
          <code class="dsh-ver">{{ dshImages.defaultRef || dshImages.defaultId }}</code>
          <span class="dsh-muted">
            {{
              dshImages.defaultVersion
                ? `（${dshImages.defaultVersion}）`
                : `（${$t('admin.dshDefaultVersionUnknown')}）`
            }}
          </span>
        </template>
        <span v-else>{{ $t('admin.dshNoDefaultYet') }}</span>
      </p>
      <p v-if="dshImagesError" class="dsh-error">{{ dshImagesError }}</p>
      <table v-if="dshImages.images.length" class="dsh-table">
        <thead>
          <tr>
            <th>{{ $t('admin.dshColVersion') }}</th>
            <th>{{ $t('admin.dshImageRef') }}</th>
            <th>{{ $t('admin.dshBuiltAt') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="im in dshImages.images" :key="im.ref">
            <td>
              <code class="dsh-ver">{{ im.version }}</code>
              <span v-if="im.isDefault" class="dsh-ver-tag">
                {{ $t('admin.dshDefaultTag') }}
              </span>
            </td>
            <td>
              <code>{{ im.ref }}</code>
              <span class="dsh-muted"> {{ im.imageId }}</span>
            </td>
            <td class="dsh-muted">{{ im.createdAt || '—' }}</td>
            <td>
              <!-- 默认行没有动作：挂[默认]徽标的行"已经是"总体镜像，再给
                         一个"确认它是默认"的按钮属于自我重复。
                         未知态（latest 不存在）时没有任何一行有徽标，
                         于是每一行都是"设为平台默认"的出路——"不知道"与
                         "不能设置"在逻辑上互斥，不需要额外按钮来兜底。 -->
              <button
                v-if="!im.isDefault"
                class="btn btn-small"
                :disabled="!!dshSelecting"
                @click="selectPlatformImage(im)"
              >
                {{
                  dshSelecting === im.ref
                    ? $t('admin.dshSelecting')
                    : $t('admin.dshSelectAsDefault')
                }}
              </button>
              <span v-else class="dsh-muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!dshImagesLoading" class="dsh-note">{{ $t('admin.dshNoLocalImages') }}</p>
      <p class="dsh-hint-small">{{ $t('admin.dshLocalImagesHint') }}</p>
    </div>

    <!-- ② 构建版本镜像 -->
    <div class="dsh-card">
      <div class="dsh-card-head">
        <h5>
          <span class="dsh-step">2</span>
          {{ $t('admin.dshStepBuild') }}
        </h5>
      </div>
      <div class="dsh-row">
        <button
          class="btn btn-primary btn-small"
          :disabled="!dshSelectedVersion || dshBuild.running"
          @click="startImageUpgrade"
        >
          {{
            dshBuild.running
              ? $t('admin.dshBuilding', { version: dshBuild.version })
              : $t('admin.dshBuildImage')
          }}
        </button>
        <span v-if="!dshSelectedVersion" class="dsh-hint-small">
          {{ $t('admin.dshBuildPickVersion') }}
        </span>
      </div>

      <!-- 构建进度 -->
      <div v-if="dshBuild.running || dshBuild.finishedAt" class="dsh-progress">
        <div v-if="dshBuild.running" class="dsh-progress-running">
          <span class="dsh-spinner"></span>
          {{ $t('admin.dshBuilding', { version: dshBuild.version }) }}
        </div>
        <div v-else-if="dshBuild.ok" class="dsh-progress-ok">
          ✓ {{ $t('admin.dshBuildOk', { version: dshBuild.result?.version || '?' }) }}
        </div>
        <div v-else class="dsh-progress-fail">
          ✗ {{ $t('admin.dshBuildFail') }}: {{ dshBuild.error }}
        </div>
      </div>
    </div>

    <!-- ③ 总体镜像（全部租户共用的那个） -->
    <div class="dsh-card">
      <div class="dsh-card-head">
        <h5>
          <span class="dsh-step">3</span>
          {{ $t('admin.dshStepImage') }}
        </h5>
        <button class="btn btn-small" :disabled="dshStatusLoading" @click="loadDshStatus">
          {{ dshStatusLoading ? $t('admin.loading') : $t('admin.refresh') }}
        </button>
      </div>

      <div class="dsh-kv-grid">
        <div class="dsh-kv">
          <span class="dsh-kv-label">{{ $t('admin.dshImageVersion') }}</span>
          <code>
            {{ dshStatus.currentImageVersion || $t('admin.dshVersionUnknown') }}
          </code>
        </div>
        <div class="dsh-kv">
          <span class="dsh-kv-label">{{ $t('admin.dshLatestAvailable') }}</span>
          <code v-if="dshStatus.upgrade?.latest">{{ dshStatus.upgrade.latest }}</code>
          <span v-else class="dsh-muted">{{ dshStatus.upgrade?.reason || '—' }}</span>
        </div>
        <div class="dsh-kv">
          <span class="dsh-kv-label">{{ $t('admin.dshImageName') }}</span>
          <code>{{ dshStatus.image || '—' }}</code>
        </div>
        <div class="dsh-kv">
          <span class="dsh-kv-label">{{ $t('admin.dshStaleTenants') }}</span>
          <code :class="{ 'dsh-warn-text': dshStatus.staleTenants > 0 }">
            {{ dshStatus.staleTenants ?? 0 }}
          </code>
        </div>
        <div class="dsh-kv">
          <span class="dsh-kv-label">{{ $t('admin.dshLastBuild') }}</span>
          <code>{{ dshStatus.recorded ? formatTime(dshStatus.recorded.at) : '—' }}</code>
        </div>
      </div>

      <!-- 镜像版本落后提示：这是管理员最需要立刻看到的一句话 -->
      <p v-if="dshStatus.upgrade?.behind" class="dsh-alert">
        ⚠
        {{
          $t('admin.dshBehind', {
            current: dshStatus.currentImageVersion,
            latest: dshStatus.upgrade.latest,
          })
        }}
      </p>
      <p
        v-else-if="dshStatus.currentImageVersion && dshStatus.upgrade?.behind === false"
        class="dsh-ok-note"
      >
        ✓ {{ $t('admin.dshImageIsLatest') }}
      </p>
      <p v-if="!dshStatus.currentImageVersion" class="dsh-note">
        {{ $t('admin.dshVersionUnknownHint') }}
      </p>

      <p v-if="dshStatus.note" class="dsh-note">⚠ {{ dshStatus.note }}</p>
    </div>

    <!-- ④ 个别租户镜像：每个租户容器实际钉在哪个镜像上 -->
    <div class="dsh-card">
      <div class="dsh-card-head">
        <h5>
          <span class="dsh-step">4</span>
          {{ $t('admin.dshStepTenants') }}
        </h5>
        <div class="dsh-actions">
          <button
            class="btn btn-small"
            :disabled="dshApply.running || !dshStatus.staleTenants"
            @click="previewApplyAll"
          >
            {{ $t('admin.dshPreviewStale') }}
          </button>
          <button
            class="btn btn-warning btn-small"
            :disabled="dshApply.running || !dshStatus.staleTenants"
            @click="applyAllStale"
          >
            {{ $t('admin.dshApplyStale', { n: dshStatus.staleTenants ?? 0 }) }}
          </button>
        </div>
      </div>

      <p class="dsh-hint-small">{{ $t('admin.dshApplyHint') }}</p>

      <table v-if="dshStatus.tenants?.length" class="dsh-table">
        <thead>
          <tr>
            <th>{{ $t('admin.dshColAddress') }}</th>
            <th>{{ $t('admin.dshColStatus') }}</th>
            <th>{{ $t('admin.dshColVersion') }}</th>
            <th>{{ $t('admin.dshColImage') }}</th>
            <th>{{ $t('admin.dshColTarget') }}</th>
            <th>{{ $t('admin.dshColActions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in dshStatus.tenants" :key="t.address">
            <td>
              <code class="dsh-addr addr-tip" :data-full="t.address">{{
                shortAddress(t.address)
              }}</code>
            </td>
            <td>
              <span class="dsh-badge" :class="`dsh-badge-${t.containerStatus}`">
                {{ t.containerStatus }}
              </span>
            </td>
            <td>
              <code class="dsh-ver" :class="{ 'dsh-ver-stale': t.stale }">
                {{ t.dshVersion || '?' }}
              </code>
              <span v-if="t.stale" class="dsh-badge dsh-badge-stale dsh-ver-tag">
                {{ $t('admin.dshOutdated') }}
              </span>
            </td>
            <td>
              <code class="dsh-img addr-tip" :data-full="t.containerImageId || ''">{{
                shortImageId(t.containerImageId)
              }}</code>
              <div v-if="t.pinnedImage" class="dsh-pinned">
                {{ $t('admin.dshPinnedTo', { ref: t.pinnedImage }) }}
              </div>
            </td>
            <td class="dsh-pick-cell">
              <!-- 租户镜像选择：默认跟随平台最新（latest），也可钉到某个
                         已构建的版本（回滚 / 多版本并存） -->
              <select
                class="dsh-select dsh-select-sm"
                :value="dshTargetImage[t.address] ?? t.pinnedImage ?? ''"
                :disabled="dshApply.running"
                @change="setTargetImage(t.address, $event.target.value)"
              >
                <option value="">{{ $t('admin.dshFollowDefault') }}</option>
                <option v-for="im in dshAvailableImages" :key="im.ref" :value="im.ref">
                  {{ im.version }}
                </option>
              </select>
            </td>
            <td>
              <button
                class="btn btn-small"
                :disabled="dshApply.running"
                @click="previewApplyOne(t.address)"
              >
                {{ $t('admin.dshPreview') }}
              </button>
              <button
                class="btn btn-warning btn-small"
                :disabled="dshApply.running || !needsApply(t)"
                @click="applyOne(t.address)"
              >
                {{ $t('admin.dshApply') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="dsh-empty">{{ $t('admin.dshNoTenants') }}</p>

      <!-- 应用进度 / 结果 -->
      <div v-if="dshApply.running || dshApply.finishedAt" class="dsh-progress">
        <div v-if="dshApply.running" class="dsh-progress-running">
          <span class="dsh-spinner"></span>
          {{ $t('admin.dshApplying', { done: dshApply.completed, total: dshApply.total }) }}
        </div>
        <div v-else class="dsh-progress-ok">✓ {{ $t('admin.dshApplyDone') }}</div>
      </div>

      <ul v-if="dshApplyResults.length" class="dsh-result-list">
        <li v-for="(r, i) in dshApplyResults" :key="i" :class="r.ok ? 'ok' : 'fail'">
          <code class="addr-tip" :data-full="r.address">{{ shortAddress(r.address) }}</code>
          <span v-if="r.ok">
            <template v-if="r.dryRun">
              {{ $t('admin.dshPlan') }}: {{ shortImageId(r.fromImageId) }} →
              {{ shortImageId(r.toImageId) }} ({{ r.targetVersion }})
              <!-- 备份目录可写性必须在预览阶段可见：否则点「更新」才因
                         备份失败而中止（容器已停过一次），白白制造停机 -->
              <span v-if="r.backup && r.backupDirError" class="dsh-plan-warn">
                {{ $t('admin.dshBackupDirBad', { dir: r.backupDirError }) }}
              </span>
              <span v-else-if="r.backupDirFallback" class="dsh-plan-warn">
                ⚠
                {{
                  $t('admin.dshBackupDirFallback', {
                    from: r.backupDirFallback,
                    to: r.backupDir,
                  })
                }}
              </span>
              <span v-else-if="r.backupDir" class="dsh-plan-ok">
                · {{ $t('admin.dshBackupDir', { dir: r.backupDir }) }}
              </span>
            </template>
            <template v-else-if="r.skipped">
              {{ $t('admin.dshSkipped') }}: {{ r.reason }}
            </template>
            <template v-else>
              ✓ {{ r.dshVersion }} · {{ $t('admin.dshBackup') }}:
              {{ r.backupPath || '—' }}
            </template>
          </span>
          <span v-else class="dsh-fail-text">✗ {{ r.error }}</span>
        </li>
      </ul>
    </div>

    <!-- 版本历史（回退依据） -->
    <div v-if="dshStatus.history?.length" class="dsh-card">
      <div class="dsh-card-head">
        <h5>{{ $t('admin.dshHistory') }}</h5>
      </div>
      <p class="dsh-history-hint">{{ $t('admin.dshHistoryHint') }}</p>
      <ul class="dsh-history">
        <li v-for="(h, i) in [...dshStatus.history].reverse()" :key="i">
          <!-- 只有"在本地 + 非当前 + 无引用 + 无 tag"的历史构建才让勾选 -->
          <input
            v-if="h.removable"
            type="checkbox"
            class="dsh-hist-check"
            :value="h.imageId"
            v-model="selectedImageIds"
          />
          <span v-else class="dsh-hist-check-spacer"></span>
          <code>{{ h.version || '?' }}</code>
          <span class="dsh-muted addr-tip" :data-full="h.imageId || ''">{{
            shortImageId(h.imageId)
          }}</span>
          <!-- 关键：镜像是否还在本地。历史会保留每次构建，tag 只有一个，
                     旧构建会被覆盖成悬空镜像 —— 不标出来会误以为都能回滚 -->
          <span v-if="h.present" class="dsh-ver-tag">
            {{ $t('admin.dshImagePresent') }}
          </span>
          <span v-else class="dsh-ver-unknown">
            {{ $t('admin.dshImageGone') }}
          </span>
          <span v-if="h.present && h.sizeBytes" class="dsh-muted">
            {{ formatBytes(h.sizeBytes) }}
          </span>
          <span class="dsh-muted">{{ formatTime(h.at) }}</span>
          <span class="dsh-muted">{{ h.by }}</span>
          <span v-if="h.reason && h.reason !== 'not_local'" class="dsh-muted dsh-hist-reason">
            {{ $t(`admin.dshKeepReason_${h.reason}`) }}
          </span>
        </li>
      </ul>
    </div>

    <!-- 镜像占用与清理。
               必须**始终渲染**：早先只在"有可清理项"时才显示，结果镜像全都有 tag /
               正在用时，清理入口整个消失，用户以为没做这个功能。 -->
    <div class="dsh-card">
      <div class="dsh-card-head">
        <h5>{{ $t('admin.dshImages') }}</h5>
        <span v-if="pruneItems.length" class="dsh-muted dsh-reclaim">
          {{ $t('admin.dshReclaimable', { size: formatBytes(pruneableBytes) }) }}
        </span>
      </div>

      <p v-if="pruneInfoIncomplete" class="dsh-prune-warn">
        {{ $t('admin.dshPruneInfoIncomplete') }}
      </p>

      <ul class="dsh-history">
        <li v-for="im in pruneItems" :key="im.id">
          <input
            v-if="im.removable"
            type="checkbox"
            class="dsh-hist-check"
            :value="im.id"
            v-model="selectedImageIds"
          />
          <span v-else class="dsh-hist-check-spacer"></span>
          <code v-if="im.tag && im.tag !== '<none>'">{{ im.tag }}</code>
          <code v-else-if="im.historyVersion">
            {{ $t('admin.dshDanglingFrom', { version: im.historyVersion }) }}
          </code>
          <code v-else>{{ $t('admin.dshDangling') }}</code>
          <span class="dsh-muted addr-tip" :data-full="im.id || ''">{{ shortImageId(im.id) }}</span>
          <span class="dsh-muted">{{ formatBytes(im.sizeBytes) }}</span>
          <span v-if="im.isCurrent" class="dsh-ver-tag">
            {{ $t('admin.dshKeepReason_current') }}
          </span>
          <span v-else-if="im.used" class="dsh-ver-stale">
            {{ $t('admin.dshKeepReason_in_use') }}
            <template v-if="im.usedBy?.length">
              · {{ im.usedBy.map((c) => `${c.name}(${c.state})`).join(', ') }}
            </template>
          </span>
          <span v-else class="dsh-ver-ok">{{ $t('admin.dshCanRemove') }}</span>
        </li>
      </ul>

      <p v-if="!pruneItems.length" class="dsh-prune-msg">
        {{ $t('admin.dshNoImages') }}
      </p>

      <div class="dsh-prune-bar">
        <label class="dsh-muted">
          <input
            type="checkbox"
            :disabled="!pruneableItems.length"
            :checked="
              pruneableItems.length > 0 && selectedImageIds.length === pruneableItems.length
            "
            @change="toggleSelectAllImages"
          />
          {{
            pruneableItems.length
              ? $t('admin.dshSelectAllRemovable', { n: pruneableItems.length })
              : $t('admin.dshNothingToPrune')
          }}
        </label>
        <button
          class="btn btn-small dsh-prune-btn"
          :disabled="!selectedImageIds.length || dshPrune.running"
          @click="pruneImages"
        >
          {{ dshPrune.running ? $t('admin.dshPruning') : $t('admin.dshPruneImages') }}
        </button>
      </div>

      <p v-if="dshPrune.message" class="dsh-prune-msg">{{ dshPrune.message }}</p>
      <p class="dsh-history-hint">{{ $t('admin.dshPruneHint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.btn-small {
  padding: 0.25rem 0.75rem;
  font-size: 0.85rem;
  margin-left: 0.5rem;
}

.dsh-model-card {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.dsh-model-step {
  flex: 1 1 260px;
  display: flex;
  gap: 0.6rem;
  align-items: flex-start;
  padding: 0.75rem 0.9rem;
  background: var(--bg-page);
  border: 1px solid var(--border-light);
  border-radius: 8px;
}

.dsh-step-no {
  flex: 0 0 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--brand);
  color: var(--surface-white);
  font-size: 0.75rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dsh-model-step strong {
  display: block;
  font-size: 0.86rem;
  color: var(--text-main);
}

.dsh-model-step p {
  margin: 0.15rem 0 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--text-muted);
}

.dsh-card {
  background: var(--surface-white);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 1rem;
  margin-bottom: 1rem;
}

.dsh-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.dsh-card-head h5 {
  margin: 0;
  font-size: 0.92rem;
  color: var(--text-main);
}

.dsh-kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
}

.dsh-kv {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.dsh-kv-label {
  font-size: 0.75rem;
  color: var(--text-faint);
}

.dsh-kv code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
  color: var(--text-body);
  word-break: break-all;
}

.dsh-warn-text {
  color: #d97706 !important;
  font-weight: 600;
}

.dsh-note {
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.65rem;
  background: #fffbeb;
  border-left: 3px solid #f59e0b;
  border-radius: 4px;
  font-size: 0.78rem;
  line-height: 1.5;
  color: #92400e;
}

.dsh-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.dsh-select {
  flex: 1 1 220px;
  -webkit-appearance: none;
  appearance: none;
  padding: 0.35rem 1.7rem 0.35rem 0.55rem; /* 文字左右等距，右侧为箭头让位 */
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: var(--surface-white)
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='7' viewBox='0 0 10 7'><path d='M1 1l4 4 4-4' fill='none' stroke='%2364748b' stroke-width='1.6' stroke-linecap='round'/></svg>")
    no-repeat right 0.6rem center;
  font-size: 0.82rem;
  color: var(--text-body);
}

.dsh-check {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  color: var(--text-secondary);
  cursor: pointer;
}

.dsh-hint-small {
  margin: 0.6rem 0 0;
  font-size: 0.76rem;
  line-height: 1.5;
  color: var(--text-faint);
}

.dsh-error {
  margin: 0 0 0.6rem;
  padding: 0.5rem 0.65rem;
  background: #fef2f2;
  border-left: 3px solid #ef4444;
  border-radius: 4px;
  font-size: 0.78rem;
  color: #b91c1c;
}

.dsh-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.dsh-progress {
  margin-top: 0.75rem;
}

.dsh-progress-running,
.dsh-progress-ok,
.dsh-progress-fail {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  padding: 0.5rem 0.65rem;
  border-radius: 6px;
}

.dsh-progress-running {
  background: #eff6ff;
  color: #1d4ed8;
}

.dsh-progress-ok {
  background: #f0fdf4;
  color: #15803d;
}

.dsh-progress-fail {
  background: #fef2f2;
  color: #b91c1c;
}

.dsh-select-sm {
  padding: 0.15rem 0.3rem;
  font-size: 0.76rem;
  max-width: 11rem;
}

.dsh-pinned {
  margin-top: 0.15rem;
  font-size: 0.7rem;
  color: #1d4ed8;
}

.dsh-pick-cell {
  white-space: nowrap;
}

.dsh-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: 0.35rem;
  border-radius: 50%;
  background: #1d4ed8;
  color: var(--surface-white);
  font-size: 0.7rem;
  font-weight: 700;
  vertical-align: middle;
}

.dsh-subhead {
  margin: 0.85rem 0 0.35rem;
  font-size: 0.82rem;
  color: var(--text-body);
}

.dsh-ver-ok {
  font-size: 0.72rem;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  background: #dcfce7;
  color: #15803d;
  white-space: nowrap;
}

.dsh-prune-warn {
  margin: 0 0 0.5rem;
  padding: 0.45rem 0.6rem;
  border-radius: 6px;
  background: #fffbeb;
  color: #b45309;
  font-size: 0.76rem;
}

.dsh-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0.5rem;
  font-size: 0.82rem;
}

.dsh-table th {
  text-align: left;
  padding: 0.45rem 0.5rem;
  border-bottom: 1px solid var(--border-light);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-faint);
  white-space: nowrap;
}

.dsh-table td {
  padding: 0.5rem;
  border-bottom: 1px solid var(--surface-soft);
  vertical-align: middle;
}

.dsh-addr,
.dsh-img {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.dsh-ver-stale {
  color: #b45309;
  font-weight: 600;
}

.dsh-ver-tag {
  margin-left: 0.35rem;
}

.dsh-badge {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 500;
  white-space: nowrap;
}

.dsh-badge-stale {
  background: #fef3c7;
  color: #b45309;
}

.dsh-empty {
  margin: 0.5rem 0 0;
  font-size: 0.82rem;
  color: var(--text-faint);
}

.dsh-result-list,
.dsh-history {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
}

.dsh-result-list li {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  flex-wrap: wrap;
  padding: 0.4rem 0.55rem;
  border-radius: 6px;
  font-size: 0.8rem;
  margin-bottom: 0.3rem;
}

.dsh-result-list li.ok {
  background: #f0fdf4;
  color: #15803d;
}

.dsh-result-list li.fail {
  background: #fef2f2;
}

.dsh-fail-text {
  color: #b91c1c;
}

.dsh-plan-warn {
  color: #b45309;
  font-weight: 600;
}

.dsh-plan-ok {
  color: var(--text-muted);
}

.dsh-history-hint {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-faint);
}

.dsh-hist-check,
.dsh-hist-check-spacer {
  width: 14px;
  flex: 0 0 14px;
}

.dsh-hist-reason {
  font-size: 0.72rem;
}

.dsh-reclaim {
  font-weight: 600;
  color: #b45309;
}

.dsh-prune-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--border-light);
}

.dsh-prune-bar label {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.76rem;
  cursor: pointer;
}

.dsh-prune-btn {
  flex: 0 0 auto;
}

.dsh-prune-msg {
  margin: 0.5rem 0 0;
  font-size: 0.76rem;
  color: var(--text-secondary);
}

.dsh-history li {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--surface-soft);
  font-size: 0.8rem;
}

.dsh-muted {
  color: var(--text-faint);
}

.dsh-alert {
  margin: 0.75rem 0 0;
  padding: 0.55rem 0.7rem;
  background: #fef2f2;
  border-left: 3px solid #ef4444;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 500;
  line-height: 1.55;
  color: #b91c1c;
}

.dsh-ok-note {
  margin: 0.75rem 0 0;
  padding: 0.55rem 0.7rem;
  background: #f0fdf4;
  border-left: 3px solid #22c55e;
  border-radius: 4px;
  font-size: 0.8rem;
  line-height: 1.55;
  color: #15803d;
}
</style>
