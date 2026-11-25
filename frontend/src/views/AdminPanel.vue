<template>
  <div class="admin-panel" :class="{ embedded }">
    <!-- 无权限页面 -->
    <div v-if="notAdmin" class="state-card">
      <h2>{{ $t('admin.noAccess') }}</h2>
      <p>{{ $t('admin.noAccessHint') }}</p>
      <p class="address-display">{{ currentAddress }}</p>
      <button class="btn btn-primary" @click="switchWallet">{{ $t('admin.switchWallet') }}</button>
    </div>

    <!-- 管理员登录 -->
    <div v-else-if="!isAdmin" class="state-card">
      <h2>{{ $t('admin.loginTitle') }}</h2>
      <p>{{ $t('admin.loginHint') }}</p>

      <div v-if="!hasCCDAO" class="error">
        {{ $t('admin.noCcdao') }}
        <br />
        <a
          href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ $t('admin.installCcdao') }}
        </a>
      </div>

      <div v-else>
        <div v-if="currentAddress" class="current-address">
          <p>{{ $t('admin.currentAddress') }}</p>
          <span class="address-display">{{ currentAddress }}</span>
        </div>
        <button class="btn btn-primary btn-large" @click="adminLogin" :disabled="logging">
          {{ logging ? $t('admin.logging') : $t('admin.loginWithCcdao') }}
        </button>
        <div v-if="loginError" class="error" style="margin-top: 1rem">{{ loginError }}</div>
      </div>
    </div>

    <!-- 系统管理：左侧栏 + 右侧内容（与 React 原型稿一致） -->
    <div v-else class="gate-shell">
      <!-- 左侧栏：内嵌态不渲染（管理页签已并入用户中心左栏，v1.5 验收反馈①） -->
      <aside v-if="!embedded" class="gate-sidebar">
        <div class="sidebar-card">
          <nav class="sidebar-nav">
            <button
              v-for="tab in adminTabs"
              :key="tab.key"
              class="sidebar-item"
              :class="{ active: activeTab === tab.key }"
              @click="activeTab = tab.key"
            >
              <span class="sidebar-icon" v-html="tab.icon"></span>
              <span>{{ tab.label }}</span>
              <span
                v-if="badgeFor(tab.key)"
                class="tab-dot"
                :title="$t('admin.pendingTip', { n: badgeFor(tab.key) })"
              ></span>
            </button>
          </nav>
        </div>
      </aside>

      <!-- 右侧内容 -->
      <section class="gate-content">
        <!-- ════════ 系统概览 ════════ -->
        <div v-if="activeTab === 'overview'" class="tab-content">
          <AdminTabOverview
            :stats="stats"
            :current-address="currentAddress"
            :current-admin-address="currentAdminAddress"
            :docker-available="dockerAvailable"
            :refresh-interval-ms="refreshIntervalMs"
            @refresh="refreshNow(true)"
          />
        </div>

        <!-- ════════ 用户管理 ════════ -->
        <div v-else-if="activeTab === 'users'" class="tab-content">
          <AdminTabUsers
            :users="users"
            :tiers="tiers"
            :loading="loading"
            :error="error"
            :refresh-interval-ms="refreshIntervalMs"
            @refresh="refreshNow(true)"
          />
        </div>

        <!-- ════════ 配额配置（只读） ════════ -->
        <div v-else-if="activeTab === 'quota'" class="tab-content">
          <AdminTabQuota
            :tiers="tiers"
            :loading="loading"
            :refresh-interval-ms="refreshIntervalMs"
            @refresh="refreshNow(true)"
          />
        </div>

        <!-- ════════ 资源监控 ════════ -->
        <div v-else-if="activeTab === 'monitor'" class="tab-content">
          <AdminTabMonitor
            :users="users"
            :stats="stats"
            :loading="loading"
            :refresh-interval-ms="refreshIntervalMs"
            @refresh="refreshNow(true)"
            @disk-scan="mergeDiskScan"
          />
        </div>

        <!-- ════════ DSH 版本管理 ════════ -->
        <div v-else-if="activeTab === 'envtpl'" class="tab-content">
          <AdminTabHead
            :title="$t('admin.tabDsh')"
            :hint="$t('admin.dshHint')"
            :loading="loading"
            :interval-ms="refreshIntervalMs"
            @refresh="refreshNow(true)"
          />
          <EnvTemplatesAdmin />
        </div>
        <div v-else-if="activeTab === 'dsh'" class="tab-content">
          <AdminTabHead :title="$t('admin.credTabTitle')" :hint="$t('admin.credTabHint')" />

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
                  {{ v.version }}{{ v.version === dshVersions.latest ? ' ★' : ''
                  }}{{ v.local ? ' ✓' : '' }}{{ v.stable ? '' : ' ' + $t('admin.dshPreShort') }}
                </option>
              </select>
              <button
                class="btn btn-small"
                :disabled="dshVersionsLoading"
                @click="loadDshVersions(true)"
              >
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
                <span class="dsh-muted addr-tip" :data-full="im.id || ''">{{
                  shortImageId(im.id)
                }}</span>
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

        <!-- ════ v1.4 CWT 解除限制申请审批 ════ -->
        <div v-else-if="activeTab === 'cred'" class="tab-content">
          <AdminTabCred />
        </div>
      </section>
    </div>

    <!-- 「更新」执行中的居中遮罩：让"正在执行"有明确反馈 -->
    <div v-if="dshUpdateBusy" class="dsh-overlay" role="alertdialog" aria-busy="true">
      <div class="dsh-overlay-card">
        <span class="dsh-spinner dsh-spinner-lg"></span>
        <h4 class="dsh-overlay-title">
          {{
            dshUpdate.kind === 'batch' ? $t('admin.dshUpdatingBatch') : $t('admin.dshUpdatingOne')
          }}
        </h4>
        <p v-if="dshUpdate.address" class="dsh-overlay-addr">
          <code class="addr-tip" :data-full="dshUpdate.address">{{
            shortAddress(dshUpdate.address)
          }}</code>
        </p>
        <p v-if="dshUpdate.phase" class="dsh-overlay-phase">→ {{ dshUpdate.phase }}</p>
        <p v-if="dshUpdate.kind === 'batch'" class="dsh-overlay-count">
          {{ dshApply.completed }} / {{ dshApply.total }}
        </p>
        <p class="dsh-overlay-hint">{{ $t('admin.dshUpdateHint') }}</p>
        <button
          v-if="dshUpdate.kind === 'single'"
          class="btn btn-small dsh-overlay-dismiss"
          @click="dshUpdate.kind = null"
        >
          {{ $t('admin.dshUpdateHide') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { askConfirm, toast } from '../composables/useDialog'
import { ref, computed, onMounted, onUnmounted, watch, provide } from 'vue'
import { useAdminBadges, startAdminBadges, stopAdminBadges } from '../composables/useAdminBadges'
// 红点判数入口（模板侧 badgeFor 引用此解构——只 import 不解构=运行时 TypeError，上一版踩中自修）
const { badgeFor, syncCredCount, refreshCred } = useAdminBadges()
import axios from 'axios'
import { useI18n } from 'vue-i18n'
import { buildAdminTabs } from '../admin-tabs'
import AdminTabHead from '../components/admin/AdminTabHead.vue'
import AdminTabQuota from '../components/admin/AdminTabQuota.vue'
import { bindAdminCredHost } from '../composables/useAdminCred.js'
import AdminTabUsers from '../components/admin/AdminTabUsers.vue'
import AdminTabMonitor from '../components/admin/AdminTabMonitor.vue'
import AdminTabOverview from '../components/admin/AdminTabOverview.vue'
import AdminTabCred from '../components/admin/AdminTabCred.vue'
import {
  tierBadge as sharedTierBadge,
  statusBadge,
  fmtTime,
  makeStatusText,
} from '../components/admin/shared.js'
import EnvTemplatesAdmin from '../components/EnvTemplatesAdmin.vue'
import {
  requestAccounts,
  signMessage,
  getPublicKey,
  watchAccountsChanged,
  friendlyPluginError,
} from '../api/wallet.js'
import { signAdminOperation as signAdminCore } from '../api/adminSign.js'
import { formatBytes, shortAddress } from '../utils/format.js'

const { t } = useI18n()

// v1.5 刀5C/用户验收①：可被用户中心内嵌挂载（源码不合并，同一组件两用）。
// embedded=true 时不渲染自带侧栏——管理页签由用户中心左栏统一驱动（externalTab 传子页
// key，与用户 tab 平级并列，消灭"系统管理"嵌套壳）。登录会话（user_session
// 单源，判例 2026-10-30）的钱包签名登录
// **照旧要**（刀2B 安全模型一字不松：tab 可见=凭证判权，可操作=会话+当场签名）。
const props = defineProps({
  embedded: { type: Boolean, default: false },
  externalTab: { type: String, default: '' },
})

// ---- 侧栏导航（页签定义与用户中心共享：admin-tabs.js） ----
const activeTab = ref(props.embedded && props.externalTab ? props.externalTab : 'overview')
watch(
  () => props.externalTab,
  (v) => {
    if (props.embedded && v) activeTab.value = v
  },
)
const adminTabs = buildAdminTabs(t)

const users = ref([])
const stats = ref({ totalUsers: 0, runningUsers: 0, tierCounts: {} })
const tiers = ref({})
const loading = ref(true)
const error = ref(null)
const isAdmin = ref(false)
const notAdmin = ref(false)
const logging = ref(false)
const loginError = ref(null)
const hasCCDAO = ref(false)
const currentAdminAddress = ref(null)
const currentAddress = ref(null)
const dockerAvailable = ref(false)
// ---- DSH 版本管理 ----
const dshStatus = ref({
  image: null,
  currentImageVersion: null,
  currentImageId: null,
  upgrade: null,
  staleTenants: 0,
  tenants: [],
  history: [],
  note: null,
})
const dshStatusLoading = ref(false)
// dsh tab 专属读错状态（2026-10 审计：不再写跨 tab 的全局 error）
const dshError = ref('')
const dshVersions = ref({
  latest: null,
  stable: [],
  prerelease: [],
  prereleaseCount: 0,
  // 与"远端有哪些版本"分开：这三个回答"本地手上已有哪些版本"
  stableLocal: [],
  prereleaseLocal: [],
  localTags: [],
  currentVersion: null,
})
const dshVersionsLoading = ref(false)
const dshVersionsError = ref(null)
const dshIncludePrerelease = ref(false)
const dshSelectedVersion = ref('')
const dshBuild = ref({
  running: false,
  version: null,
  ok: null,
  error: null,
  result: null,
  finishedAt: null,
})
const dshApply = ref({
  running: false,
  total: 0,
  completed: 0,
  results: [],
  finishedAt: null,
})
// 本次会话内的应用/预览结果（含 dryRun 计划与逐租户失败原因）
const dshApplyResults = ref([])

/**
 * 「更新」进行中状态 —— 用**居中遮罩**告知用户"确实在执行"。
 *
 * 为什么必须要有：单租户更新是**同步**请求（后端重建完容器才返回），耗时数十秒
 * 到数分钟。期间页面只有按钮变灰，用户完全不知道是在跑、还是卡死了，容易重复点
 * 或以为没生效。批量更新虽然后台跑+轮询，但同样需要"正在进行"的明确反馈。
 */
const dshUpdate = ref({
  /** @type {'single'|'batch'|null} */
  kind: null,
  /** 当前正在处理的租户地址（单租户时有值） */
  address: '',
  /** 显示用标签：单租户显示短暂版本 → 目标版本 */
  phase: '',
})
let dshPollTimer = null

/** 居中遮罩的标题/说明文案由 kind 决定（模板里用 $t 拼） */
const dshUpdateBusy = computed(() => dshUpdate.value.kind !== null)

/**
 * 可选版本（远端）合并成一个列表。
 *
 * 不分成 stable / prerelease 两个 optgroup：DSH 目前**只有预发布版本**
 * （stable 恒为空），分组会让"稳定版"那一组永远空着、看起来像坏了；
 * 合并后按"latest 置顶 + 版本号降序"排列，预发布加个短标记区分。
 * /versions 默认折叠预发布，所以勾选"显示预发布"后会重新拉取。
 */
const allVersionOptions = computed(() => {
  const seen = new Set()
  const out = []
  const add = (v, stable) => {
    if (!v || seen.has(v)) return
    seen.add(v)
    out.push({ version: v, local: versionIsLocal(v), stable })
  }
  const stableRows = dshVersions.value.stableLocal || []
  const preRows = dshVersions.value.prereleaseLocal || []
  for (const r of stableRows) add(r.version, true)
  for (const r of preRows) add(r.version, false)
  const cmp = (a, b) => {
    if (a === dshVersions.value.latest) return -1
    if (b === dshVersions.value.latest) return 1
    // 按数字段降序比较版本号（预发布后缀不参与，够用且不会误排）
    const pa = String(a)
      .split(/[.-]/)
      .map((x) => parseInt(x, 10) || 0)
    const pb = String(b)
      .split(/[.-]/)
      .map((x) => parseInt(x, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0)
    }
    return String(b).localeCompare(String(a))
  }
  return out.sort((a, b) => cmp(a.version, b.version))
})

/** 后端已判定该版本对应镜像是否仍在本地 */
const versionIsLocal = (v) =>
  Boolean(
    (dshVersions.value.stableLocal || [])
      .concat(dshVersions.value.prereleaseLocal || [])
      .find((r) => r.version === v)?.local,
  )

/**
 * 本地已构建的版本行（来自 /versions 的 localTags）。
 * 注意：latest 是移动标签、不指向某个具体版本，界面里单独由「总体镜像」呈现，
 * 这里只列具体版本，避免同一镜像因为两个 tag 出现两行造成误解。
 */
/** 本地镜像清单（"钦定平台默认镜像"用：含 load 进来的、非本平台构建的） */
const dshImages = ref({ images: [], defaultId: '', defaultRef: '', defaultVersion: null })
const dshImagesLoading = ref(false)
const dshImagesError = ref('')
/** 正在钦定的 ref（禁重复点击） */
const dshSelecting = ref('')

/** 本地镜像清单（含不在历史里的，如更早遗留的 tag） */
const pruneItems = computed(() => dshStatus.value.prunable?.items || [])

/** 后端判定可安全清理的镜像 */
const pruneableItems = computed(() => pruneItems.value.filter((im) => im.removable))

/** 可清理体积合计（存在共享层，实际释放可能更少） */
const pruneableBytes = computed(() =>
  pruneableItems.value.reduce((s, im) => s + (im.sizeBytes || 0), 0),
)

/** 后端拿不到容器信息时为 true —— 此时无法判断谁在用，一律不可清理 */
const pruneInfoIncomplete = computed(() => Boolean(dshStatus.value.prunable?.infoIncomplete))

const selectedImageIds = ref([])

/** 镜像清理状态（成功后要刷新状态，"在本地"标记与清单会随之更新） */
const dshPrune = ref({ running: false, message: '' })

const toggleSelectAllImages = (e) => {
  selectedImageIds.value = e.target.checked ? pruneableItems.value.map((im) => im.id) : []
}

/** 把字节数格式化成人类可读（后端只给字节，避免在两端各写一套单位逻辑） */

/**
 * 清理选中的悬空镜像（破坏性操作 → 走管理端签名）。
 * 必须把 ids 并入签名 binding：签名内容即"删哪几个"，服务端会逐项重新校验。
 */
const pruneImages = async () => {
  const ids = [...selectedImageIds.value]
  if (!ids.length) return
  // 2026-10 审计：不可逆删镜像（zh.js 自己警告"带 tag 旧版本删掉无法回滚"）此前零确认
  if (
    !(await askConfirm({ message: t('admin.confirmPruneImages', { n: ids.length }), danger: true }))
  )
    return
  dshPrune.value = { running: true, message: '' }
  try {
    const headers = await signAdminOperation('dsh/prune-images', { ids })
    const res = await axios.post('/api/admin/dsh/images/prune', { ids }, { headers })
    const { removed = [], skipped = [], freedBytes = 0 } = res.data || {}
    // ⚠️ script setup 里没有 $t（那是模板专属）：必须用 useI18n() 的 t——
    // 此处曾写错，镜像删成功后组装回执时 ReferenceError，用户误以为没删掉
    const parts = [t('admin.dshPruned', { n: removed.length, size: formatBytes(freedBytes) })]
    if (skipped.length) parts.push(t('admin.dshPruneSkipped', { n: skipped.length }))
    dshPrune.value = { running: false, message: parts.join('，') }
  } catch (err) {
    dshPrune.value = { running: false, message: friendlyPluginError(err) }
  } finally {
    // 刷新放 finally 且两路都拉——不管这次是全删成、被服务端部分拒、还是中途抛错，
    // 页面都必须回到守护进程的真实状态：
    //   · /status 现算清理面板列表（prunable.items 与可回收字节）
    //   · /versions 现算版本行"✓ 本地"标记：不重拉的话刚删掉的 0.1.1-rc.2
    //     会长期谎称"本地存在"（2026-10 实测用户所见即此）
    // 两个都 catch：守护瞬时不答也不该把已执行完的清理反报成失败
    selectedImageIds.value = []
    await loadDshStatus().catch(() => {})
    await loadDshVersions().catch(() => {})
    // 镜像刚被删掉 → 钦定清单必须同步，否则按钮还对着一个已不存在的 tag
    await loadDshImages().catch(() => {})
  }
}

/** 短地址显示（前 6 + … + 后 4），表格里避免撑爆 */

/** 镜像 ID 只留前 12 位（sha256: 前缀太长） */
function shortImageId(id) {
  if (!id) return '—'
  const bare = String(id).replace(/^sha256:/, '')
  return bare.slice(0, 12)
}

function formatTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

// 最高配额等级（随 tier 配置动态变化，不硬编码 3）
const maxTier = computed(() => {
  const keys = Object.keys(tiers.value || {})
    .map(Number)
    .filter(Number.isFinite)
  return keys.length ? Math.max(...keys) : 3
})

let dataRefreshInterval = null
/** 上次拉取时间：切 tab 时做 1 秒节流，避免狂点 tab 打爆后端 */
let lastFetchAt = 0
/** 自动刷新间隔（毫秒）：后端 /api/stats 的 uiConfig 下发，默认 15 秒。
 *  想改成 5 分钟只需改 config.json 的 admin.refreshIntervalMs 并重启服务。 */
const refreshIntervalMs = ref(15000)

/** 停止轮询
 *  ⚠️ 事故复盘（2026-10 审计 P0）：这里曾写成 `stopPolling()`（调用自身、
 *  没有 clearInterval）——源码运行是无限递归 RangeError（onMounted 被 catch 吞掉后
 *  把合法管理员误判成"无权限"页）；生产 bundle 被压缩器折叠成空函数，登出/切账户/
 *  离开页面都停不掉 15 秒轮询，且每次 startPolling 叠加一个新定时器。 */
const stopPolling = () => {
  if (dataRefreshInterval) {
    clearInterval(dataRefreshInterval)
    dataRefreshInterval = null
  }
}

/**
 * 启动轮询：间隔取 refreshIntervalMs；定时器内再判一次 document.hidden，
 * 页面在后台时不空转（回到前台会有 visibilitychange 立即补一次）。
 */
const startPolling = () => {
  stopPolling()
  dataRefreshInterval = setInterval(() => {
    if (!document.hidden) fetchData()
  }, refreshIntervalMs.value)
}

/** 立即刷新（手动按钮 / 切 tab / 回到前台）；force 跳过服务端 3 秒短缓存 */
const refreshNow = async (force = false) => {
  lastFetchAt = Date.now()
  await fetchData(force)
}
// 账户监听解绑函数（wallet.js watchAccountsChanged 返回），卸载时调用避免重复监听
let unbindAccounts = null

const checkCCDAO = () => {
  hasCCDAO.value = typeof window.ccdao !== 'undefined'
}

// 账户变化统一处理（事件/轮询共用）：
// 地址切换 → 先做无痕管理员预检（不弹签名）→ 是管理员才签名换会话；
// 不是管理员 → 立即显示无权限页（notAdmin），绝不滞留系统管理页。
const handleAccountsChanged = async (accounts, source = 'unknown') => {
  console.log(`[AdminPanel] 检测到账户变化(${source}):`, accounts)

  if (!accounts || accounts.length === 0) {
    // 用户断开连接
    toast(t('admin.walletDisconnected'))
    isAdmin.value = false
    notAdmin.value = false
    currentAdminAddress.value = null
    currentAddress.value = null
    stopPolling()
    return
  }

  const pluginAddress = accounts[0] // 保留原始大小写！swtc_signMessage 的 accounts.includes 是大小写敏感严格匹配
  const newAddress = pluginAddress.toLowerCase()
  currentAddress.value = newAddress

  if (newAddress !== currentAdminAddress.value) {
    console.log(`[AdminPanel] 地址切换：${currentAdminAddress.value} -> ${newAddress}`)

    // 第一步：无痕预检（/api/admin/check 只查名单，不需要签名）
    // 先确认新地址在不在管理员名单里，避免对普通地址也弹签名窗
    let isAdminUser = false
    try {
      const checkRes = await axios.get('/api/admin/check', { params: { address: newAddress } })
      isAdminUser = checkRes.data.isAdmin
    } catch {
      /* 预检失败走签名兜底 */
    }

    if (!isAdminUser) {
      // 新地址不是管理员 → 直接无权限页（不弹签名、不刷新数据）
      console.log(`[AdminPanel] 新地址 ${newAddress.slice(0, 10)}... 不是管理员，显示无权限`)
      notAdmin.value = true
      isAdmin.value = false
      currentAdminAddress.value = null
      stopPolling()
      return
    }

    // 第二步：是管理员 → 重新钱包签名登录换会话（会话与地址绑定，P0-1）
    // 注意：signLogin 必须传【原始大小写】pluginAddress，传小写会被插件拒绝签名
    try {
      const res = await signLogin(pluginAddress)
      if (res.data.ok) {
        const address = res.data.address
        currentAdminAddress.value = address
        isAdmin.value = true
        notAdmin.value = false
        await fetchData()
        toast(t('admin.switchedAdmin', { addr: `${address.slice(0, 10)}...` }))
      } else {
        // 签名通过但后端判定无权限
        notAdmin.value = true
        isAdmin.value = false
        currentAdminAddress.value = null
        stopPolling()
      }
    } catch (err) {
      if (err.response?.status === 403) {
        // 新地址不是管理员，显示无权限页面
        notAdmin.value = true
        isAdmin.value = false
        currentAdminAddress.value = null
        stopPolling()
      } else {
        // 其他错误（如签名被拒/网络）：给用户明确反馈，不静默
        console.error('[AdminPanel] 验证新地址失败:', err)
        const msg = err.response?.data?.error || err.message
        loginError.value = t('admin.loginFail', { err: msg })
        toast(t('admin.loginFail', { err: msg }))
      }
    }
  }
}

// 监听账户变化事件（三通道兼容，共用 api/wallet.js 的 watchAccountsChanged）
const setupAccountChangeListener = () => {
  if (!hasCCDAO.value) return
  console.log('[AdminPanel] 设置账户监听器（三通道兼容）...')
  unbindAccounts = watchAccountsChanged(handleAccountsChanged)
}

const checkDockerStatus = async () => {
  try {
    const res = await axios.get('/api/docker/status')
    dockerAvailable.value = res.data.available
  } catch (err) {
    dockerAvailable.value = false
  }
}

const checkAdmin = async () => {
  try {
    const res = await axios.get('/api/admin/check')
    isAdmin.value = res.data.isAdmin
  } catch (err) {
    isAdmin.value = false
  }
}

/**
 * 钱包签名登录（security-hardening-plan P0-1）：
 * 领取一次性挑战 → 插件 signMessage 签名 → 提交验签换随机会话。
 * @param {string} pluginAddress 插件当前账户【保留原始大小写】！
 *   （插件 swtc_signMessage 的 accounts.includes 是大小写敏感严格匹配，
 *    只有 requestAccounts 原样返回的字符串才能通过；后端自行 normalize）
 */
const signLogin = async (pluginAddress) => {
  // 1. 领取挑战（地址传小写，后端 normalize 后校验管理员名单）
  const chalRes = await axios.post('/api/admin/challenge', {
    address: pluginAddress.toLowerCase(),
  })
  // 服务端下发 message = 用途绑定消息（`dsh-multitenant|login|<地址>|<nonce>` 的 hex）。
  // 必须签 message 而不是 nonce：否则为其它用途（连容器/网关校验/技能市场）取得的
  // 签名也能在登录处兑现 —— 那正是本次安全加固要堵的链。
  const { nonce, message } = chalRes.data
  // 2. 插件对 **message** 签名 + 取公钥（都用原始大小写地址）
  const signature = await signMessage(pluginAddress, message)
  const publicKey = await getPublicKey(pluginAddress)
  // 3. 提交登录（签名验明身份 + 地址归属 → 签发服务端会话）
  return axios.post('/api/admin/login', {
    address: pluginAddress,
    nonce,
    signature,
    publicKey,
  })
}

/**
 * 破坏性操作的当场钱包签名（P0 加固）。
 *
 * 背景：登录会话 token 是 12 小时有效的 bearer token（user_session 单源），只做查表不验签；而平台
 * 会把浏览器 cookie 原样转发进租户容器（`path=/` 的 cookie 不按端口隔离），
 * 所以"管理员访问过的租户"能拿到它并重放。钱包侧（改配置 / 装 skill / 进容器）
 * 本来就是**每次操作当场签一个一次性 nonce**，这里把那套样板搬到管理侧。
 *
 * 与登录签名的区别：签的不是裸 nonce，而是 `` `${nonce}|${binding}` ``，
 * binding 由**服务端**从 (operation, payload) 推导（客户端无法影响），
 * 因此"签了 A 却执行 B"会被后端拒绝。
 *
 * @param {string} operation 操作名（后端白名单）
 * @param {object} payload   会改变行为的入参（含目标 address）
 * @returns {Promise<object>} 可直接展开进 axios config 的 headers
 */
// P3 孪生收敛（2026-11-10）：challenge→sign→材料校验→三头 的权威流程唯 ../api/adminSign.js
// 一支（旧本地全装拷贝退役，判例 58 孪生面漂移根治）。此处只留桌面本地关注：
// hasCCDAO 前置闸 + 钱包≠会话预检（opts.sessionAddress 注入）+ friendlyPluginError 包装。
const signAdminOperation = async (operation, payload) => {
  if (!hasCCDAO.value) {
    throw new Error(t('admin.signNeedsWallet'))
  }
  try {
    return await signAdminCore(operation, payload, {
      sessionAddress: currentAddress.value,
      t,
    })
  } catch (err) {
    throw new Error(friendlyPluginError(err))
  }
}

// ---- v1.4 CWT 解除限制申请审批 ----

/* ── v1.5 管理员任免（名册=配发政策面；判权骑 admin 凭证，5A 后端编排） ── */

// promoteAdmin（任免名册的任命输入口）已退役（2026-10-23 用户拍板去双入口）：
// 任命=「用户管理」行内 promoteUser；名册块转只读审计视图。
// 从未开过容器的地址不在用户列表=系统里尚不存在该用户，本就不该提前任命。

const adminLogin = async () => {
  if (!hasCCDAO.value) return
  logging.value = true
  loginError.value = null
  try {
    // 插件原始大小写地址（用于签名）；展示用小写
    const pluginAddress = await requestAccounts()
    currentAddress.value = pluginAddress.toLowerCase()

    // 钱包签名登录（challenge → signMessage → 会话）
    const res = await signLogin(pluginAddress)
    if (res.data.ok) {
      // 是管理员，登录成功
      const address = res.data.address // 后端 normalize 后的小写地址
      isAdmin.value = true
      notAdmin.value = false
      currentAdminAddress.value = address
      await fetchData()

      // 启动数据刷新（间隔由 refreshIntervalMs 决定，默认 15 秒）
      startPolling()
    }
  } catch (err) {
    if (err.response?.status === 403) {
      // 不是管理员，显示无权限页面
      notAdmin.value = true
      isAdmin.value = false
      loginError.value = null
    } else {
      loginError.value = err.response?.data?.error || t('admin.loginFail', { err: err.message })
    }
  } finally {
    logging.value = false
  }
}

const switchWallet = () => {
  // 提示用户切换钱包
  toast(t('admin.switchWalletHint'))
}

const logout = async () => {
  // 后端吊销会话（P0-1）
  try {
    await axios.post('/api/admin/logout')
  } catch {
    // 忽略吊销失败（本地强制登出）
  }
  isAdmin.value = false
  currentAdminAddress.value = null
  stopPolling()
}

const fetchData = async (force = false) => {
  try {
    loading.value = true
    const [usersRes, statsRes] = await Promise.all([
      // force=1：绕过服务端短缓存（手动刷新/写操作后拿到的必须是最新）
      axios.get(force ? '/api/users?force=1' : '/api/users'),
      axios.get('/api/stats'),
    ])
    // 间隔由后端下发：改 config.json 后重启服务即生效，无需重新构建前端
    const iv = Number(statsRes.data?.uiConfig?.refreshIntervalMs)
    if (Number.isFinite(iv) && iv >= 3000 && iv !== refreshIntervalMs.value) {
      refreshIntervalMs.value = iv
      if (dataRefreshInterval) startPolling() // 间隔变了 → 用新间隔重建定时器
    }
    users.value = usersRes.data.users
    tiers.value = usersRes.data.tiers
    stats.value = statsRes.data
    error.value = null
  } catch (err) {
    error.value = t('admin.loadFail', { err: err.message })
  } finally {
    loading.value = false
  }
}

/** 手动触发精确扫描：du 实测每个租户卷真实占用（O(n)，管理员按需调用） */

const tierBadge = sharedTierBadge
const statusText = makeStatusText(t)

/** 内存占比样式：达到自动升级阈值（80%）时高亮警示 */

/** KB → 人类可读容量（如 "52.2 GB"） */

/** 宿主磁盘使用率样式 */

/** Docker 存储类型 → 中文名 */

/** 解析 docker 大小字符串（"101.3kB" / "602.1MB" / "1.2GB"）→ 字节数 */

/** 字节数 → 人类可读（如 "2.4 MB"） */

/** 实测值与引擎口径差异高亮：偏差 ≥2 倍标黄，≥10 倍标红（提示引擎口径失真） */

/** 按地址查租户数据卷大小（volume 名形如 dsh-data-swtc-<address>） */

const getCurrentAddress = async () => {
  if (!hasCCDAO.value) return
  try {
    const pluginAddress = await requestAccounts()
    currentAddress.value = pluginAddress.toLowerCase()
  } catch (err) {
    console.error('[AdminPanel] 获取当前地址失败:', err)
  }
}

// ---------------------------------------------------------------------------
// DSH 版本管理
// ---------------------------------------------------------------------------

/** 拉当前镜像状态 + 各租户版本归属 */
const loadDshStatus = async () => {
  dshStatusLoading.value = true
  try {
    // 先确保版本列表已加载：/status 只读缓存做版本对比（它不联网，以免拖慢刷新），
    // 所以这里必须先把缓存预热，否则"最新可用版本"永远显示"尚未加载"
    if (!dshVersions.value.latest) {
      await loadDshVersions()
    }
    const res = await axios.get('/api/admin/dsh/status')
    dshStatus.value = res.data
    dshError.value = ''
  } catch (err) {
    console.error('[AdminPanel] 读取 DSH 镜像状态失败:', err)
    // 写本 tab 的横幅（此前写全局 error：横幅在 users tab，看不见且会串tab）
    dshError.value = t('admin.loadFail', {
      err: err.response?.data?.error || err.message,
    })
  } finally {
    dshStatusLoading.value = false
  }
}

/** 拉本地镜像清单（含当前默认镜像的 ID 用于打标） */
const loadDshImages = async () => {
  dshImagesLoading.value = true
  dshImagesError.value = ''
  try {
    const res = await axios.get('/api/admin/dsh/local-images')
    // 形状归一：任何字段缺失都塌成安全默认值，绝不让模板对 undefined 取值
    // （曾经清单形状一变整张表就人间蒸发，"想设也没得设"）
    dshImages.value = {
      images: Array.isArray(res.data.images) ? res.data.images : [],
      defaultId: res.data.defaultId || '',
      defaultRef: res.data.defaultRef || '',
      defaultVersion: res.data.defaultVersion || null,
    }
  } catch (err) {
    // 错误必须上屏：静默 console 会让空表看起来像"本机真没镜像"（误导决策）
    dshImages.value = { images: [], defaultId: '', defaultRef: '', defaultVersion: null }
    dshImagesError.value = `${t('admin.dshImagesLoadFail')}：${err.response?.data?.error || err.message}`
  } finally {
    dshImagesLoading.value = false
  }
}

/** 把选中的本地镜像钦定为平台默认（签名绑 ref；只影响以后的新建/重建） */
const selectPlatformImage = async (img) => {
  await askConfirm({
    message: t('admin.dshSelectConfirm', { ref: img.ref }),
    run: async () => {
      dshSelecting.value = img.ref
      try {
        const headers = await signAdminOperation('dsh/select', { ref: img.ref })
        await axios.post('/api/admin/dsh/select', { ref: img.ref }, { headers })
        toast(t('admin.dshSelectDone', { ref: img.ref }))
      } catch (err) {
        toast(t('admin.dshSelectFail', { err: err.response?.data?.error || err.message }))
      } finally {
        // 无论成败都刷新：latest tag 可能已挪、清单与状态必须回到事实态
        dshSelecting.value = ''
        await Promise.all([
          loadDshImages().catch(() => {}),
          loadDshStatus().catch(() => {}),
          loadDshVersions().catch(() => {}),
        ])
      }
    },
  })
}

/** 拉 npm 可用版本（force=true 时让后端清缓存重拉） */
const loadDshVersions = async (force = false) => {
  dshVersionsLoading.value = true
  dshVersionsError.value = null
  try {
    const res = await axios.get('/api/admin/dsh/versions', {
      params: {
        includePrerelease: dshIncludePrerelease.value ? 1 : 0,
        ...(force ? { refresh: 1 } : {}),
      },
    })
    dshVersions.value = res.data
  } catch (err) {
    const data = err.response?.data
    // registry 不可达（503）要明确说明，而不是静默空列表
    dshVersionsError.value = data?.error || err.message
  } finally {
    dshVersionsLoading.value = false
  }
}

const stopDshPolling = () => {
  if (dshPollTimer) {
    clearInterval(dshPollTimer)
    dshPollTimer = null
  }
}

/** 还有任务在跑就不该停表（构建与批量共用同一个定时器） */
const anyDshTaskRunning = () => dshBuild.value.running || dshApply.value.running

/**
 * 批量任务在无法继续确认状态时的兜底收尾。
 * 否则遮罩会永久停留、进度不再更新，比"没有进度"更糟。
 */
const finishBatchUpdate = () => {
  stopDshPolling()
  if (dshUpdate.value.kind === 'batch') {
    dshUpdate.value = { kind: null, address: '', phase: '' }
  }
}

/** 轮询构建与应用进度（两者都可能在进行） */
const startDshPolling = () => {
  if (dshPollTimer) return
  // 是否已观察到批量任务"真的开始跑"。
  // 必须确认过才算结束：POST 返回 202 与后台任务被标记 running 之间有一瞬间，
  // 若第一次轮询恰好落在这个窗口，会看到 running:false 而**提前判定结束**
  // （遮罩卡死、进度不再更新）。没见过 running=true 之前不认"结束"。
  let sawApplyRunning = false
  // 兜底计时：POST 已返回 202 却迟迟等不到 running=true（服务端起来前就失败），
  // 不能让遮罩无限停留 —— 超时后收尾并强制刷新一次状态。
  let pollTicks = 0
  dshPollTimer = setInterval(async () => {
    pollTicks += 1
    try {
      if (dshBuild.value.running) {
        const res = await axios.get('/api/admin/dsh/image')
        dshBuild.value = res.data
        if (!res.data.running) {
          // 构建结束：刷新镜像状态（新版本要显示出来）。
          // 版本清单也要重拉：新构建的 "✓ 本地" 标记来自 /versions 的现算结果，
          // 不刷的话刚建好的版本要等用户手动点"更新"才亮勾（与清理面板同源同步）。
          // 钦定清单同样要重拉：刚构建的 tag 就是它的候选行。
          await loadDshStatus()
          await loadDshVersions().catch(() => {})
          await loadDshImages().catch(() => {})
          // 注意：批量可能同时在跑，不能无条件停表
          if (!anyDshTaskRunning()) stopDshPolling()
        }
      }
      if (dshApply.value.running) {
        const res = await axios.get('/api/admin/dsh/apply')
        dshApply.value = res.data
        if (res.data.running) sawApplyRunning = true
        if (!res.data.running && sawApplyRunning) {
          // 批量结束：把逐租户结果落到明细列表（含失败原因）
          dshApplyResults.value = res.data.results || []
          // 全部待选目标作废：批量已把陈旧租户刷到最新，下拉框回到实际钉像
          dshTargetImage.value = {}
          await loadDshStatus()
          finishBatchUpdate()
        } else if (!sawApplyRunning && pollTicks >= 30) {
          // ~60s 仍未见到任务启动 → 视为启动失败，收尾并刷新真实状态
          console.error('[AdminPanel] 批量任务迟迟未启动，停止跟踪')
          await loadDshStatus().catch(() => {})
          finishBatchUpdate()
        }
      }
    } catch (err) {
      // 单次轮询失败（网络抖动/瞬时 5xx）不该终止整个进度跟踪：
      // 停表会让遮罩永久停留、进度静默失效。只有确认没有任务在跑才真停。
      console.error('[AdminPanel] 轮询 DSH 任务失败:', err)
      if (!anyDshTaskRunning()) {
        stopDshPolling()
        if (dshUpdate.value.kind === 'batch') finishBatchUpdate()
      }
    }
  }, 2000)
}

/** 构建指定 DSH 版本的新镜像
 *  2026-10 审计：构建产物直接成为平台默认镜像（决定之后所有新租户），
 *  后端已要求当场签名（version 进绑定）——这里补危险确认 + 签名头 */
const startImageUpgrade = async () => {
  if (!dshSelectedVersion.value) return
  const version = dshSelectedVersion.value
  if (
    !(await askConfirm({
      message: t('admin.confirmBuildImage', { v: version }),
      danger: true,
    }))
  )
    return
  try {
    const headers = await signAdminOperation('dsh/build-image', { version })
    await axios.post('/api/admin/dsh/image', { version }, { headers })
    dshBuild.value = {
      running: true,
      version: dshSelectedVersion.value,
      ok: null,
      error: null,
      result: null,
      finishedAt: null,
    }
    startDshPolling()
  } catch (err) {
    dshBuild.value = {
      ...dshBuild.value,
      running: false,
      ok: false,
      error: err.response?.data?.error || err.message,
      finishedAt: Date.now(),
    }
  }
}

/**
 * 每个租户的目标镜像选择（地址 → 镜像 ref；空串 = 跟随平台默认 latest）。
 *
 * 为什么按租户分开存：这是「个别租户镜像」，不同租户可以跑不同版本
 * （例如给某个租户回滚到旧版排查问题），共用一个值就做不到。
 */
const dshTargetImage = ref({})

const dshAvailableImages = computed(() => dshStatus.value.availableImages || [])

const setTargetImage = (address, value) => {
  // 显式记录（含清空）：清空后要覆盖掉 pinnedImage 的回退值，所以不能删 key
  dshTargetImage.value = { ...dshTargetImage.value, [address]: value }
}

/** 该租户本次要用的镜像；空 = 不钉，走平台默认 */
const targetImageFor = (address) => dshTargetImage.value[address] || ''

/**
 * 是否需要更新。
 * 不能只看 t.stale（容器镜像 != 平台当前镜像）：钉到别的版本时目标可能
 * 根本不是平台当前镜像，此时即使不 stale 也必须允许执行。
 */
const needsApply = (t) => Boolean(t.stale) || targetImageFor(t.address) !== ''

/** 预览（dryRun）：单租户，不真正重建 */
const previewApplyOne = async (address) => {
  dshApplyResults.value = []
  try {
    // 预览也要签名：后端把 dsh/apply 整体当作破坏性操作（dryRun 只是"不执行"，
    // 签名绑定的是地址这个执行意图，与是否 dryRun 无关）。漏签名会直接 403
    // SIGNATURE_REQUIRED —— 这正是"预览按钮点了没反应"的原因。
    const image = targetImageFor(address)
    const headers = await signAdminOperation('dsh/apply', { address, image })
    const res = await axios.post(
      '/api/admin/dsh/apply',
      { address, image, dryRun: true },
      { headers },
    )
    dshApplyResults.value = res.data.results || []
  } catch (err) {
    dshApplyResults.value = [{ address, ok: false, error: friendlyPluginError(err) }]
  }
}

/** 预览全部待更新租户 */
const previewApplyAll = async () => {
  dshApplyResults.value = []
  try {
    const headers = await signAdminOperation('dsh/apply', { all: true })
    const res = await axios.post('/api/admin/dsh/apply', { all: true, dryRun: true }, { headers })
    dshApplyResults.value = res.data.results || []
  } catch (err) {
    toast(t('admin.applyFail', { err: friendlyPluginError(err) }))
  }
}

/** 应用当前镜像到单个租户（重建容器，保留数据卷）
 *  2026-10 审计：补危险确认（重建=该租户会话中断；签名已在） */
const applyOne = async (address) => {
  if (
    !(await askConfirm({
      message: t('admin.confirmApplyOne', { addr: `${address.slice(0, 10)}…` }),
      danger: true,
    }))
  )
    return
  dshApplyResults.value = []
  // 同步请求（后端重建完才返回），必须给用户明确的"正在执行"反馈。
  // phase 显示**目标版本**（这次要装上的），不是租户当前版本 —— 免得被读成
  // "正在更新到 <当前版本>"。
  const image = targetImageFor(address)
  // phase 要反映"这次到底装哪个"：钉了版本就显示那个版本，否则显示最新版
  const target = image
    ? String(image).split(':')[1]
    : dshStatus.value.upgrade?.latest || dshStatus.value.currentImageVersion || ''
  dshUpdate.value = { kind: 'single', address, phase: target }
  try {
    const headers = await signAdminOperation('dsh/apply', { address, image })
    const res = await axios.post('/api/admin/dsh/apply', { address, image }, { headers })
    dshApplyResults.value = res.data.results || []
    // 应用成功 → 撤销本地待选目标：下拉框回到"实际钉住的镜像"（loadDshStatus
    // 刷新出的 pinnedImage）。留着陈旧 key 会在别处换钉后仍显示旧目标（2026-10 审计）
    const rest = { ...dshTargetImage.value }
    delete rest[address]
    dshTargetImage.value = rest
    await loadDshStatus()
  } catch (err) {
    dshApplyResults.value = [{ address, ok: false, error: friendlyPluginError(err) }]
    await loadDshStatus()
  } finally {
    dshUpdate.value = { kind: null, address: '', phase: '' }
  }
}

/** 批量应用（后台跑，轮询进度）
 *  2026-10 审计：重建全部租户容器（在用会话全断）只有签名没有确认——补危险
 *  确认；zh.js 文案自己写着"建议先预览"，预览/执行必须有两道不同的动作 */
const applyAllStale = async () => {
  await askConfirm({
    message: t('admin.confirmApplyAllStale', { n: dshStatus.value?.staleTenants ?? 0 }),
    danger: true,
    run: async () => {
      dshApplyResults.value = []
      try {
        const headers = await signAdminOperation('dsh/apply', { all: true })
        const res = await axios.post('/api/admin/dsh/apply', { all: true }, { headers })
        dshApply.value = {
          running: true,
          total: res.data.total || 0,
          completed: 0,
          results: [],
          finishedAt: null,
        }
        // 批量在服务端后台跑，遮罩持续到轮询发现任务结束
        dshUpdate.value = { kind: 'batch', address: '', phase: '' }
        startDshPolling()
      } catch (err) {
        toast(t('admin.applyFail', { err: friendlyPluginError(err) }))
      }
    },
  })
}

/** 精确扫描结果回壳合并（AdminTabMonitor 的 disk-scan 事件） */
bindAdminCredHost({
  sign: (op, payload) => signAdminOperation(op, payload),
  refresh: (force) => fetchData(force),
})

const mergeDiskScan = ({ scanned, volumes, preciseScannedAt }) => {
  if (scanned && stats.value.resource?.disk) {
    stats.value.resource.disk.volumes = volumes
    stats.value.resource.disk.preciseScannedAt = preciseScannedAt
  }
}

// 子 tab 组件的壳层单例注入口（签名包装/数据刷新/撤销管理员——判例 58：全域唯此一支）
provide('adminSign', signAdminOperation)
provide('adminRefresh', (force) => fetchData(force))
provide('adminLogout', logout)
onMounted(async () => {
  checkCCDAO()

  // 检查 Docker 状态
  await checkDockerStatus()

  // 获取当前地址
  if (hasCCDAO.value) {
    await getCurrentAddress()
    // 设置账户变化监听器
    setupAccountChangeListener()

    // 检查当前地址是否是管理员
    if (currentAddress.value) {
      try {
        const res = await axios.get('/api/admin/check', {
          params: { address: currentAddress.value },
        })
        if (res.data.isAdmin) {
          // 当前地址是管理员，检查 cookie session
          await checkAdmin()
          if (isAdmin.value) {
            await fetchData()
            startPolling()
          } else {
            // cookie 无效，需要重新登录
            notAdmin.value = false
            isAdmin.value = false
          }
        } else {
          // 当前地址不是管理员，显示无权限页面
          notAdmin.value = true
          isAdmin.value = false
        }
      } catch (err) {
        console.error('[AdminPanel] 检查管理员权限失败:', err)
        notAdmin.value = true
        isAdmin.value = false
      }
    }
  } else {
    // 没有 CCDAO 插件，显示登录页面
    await checkAdmin()
  }
})

// 切 tab → 立即拉一次（1 秒节流，避免狂点侧栏把后端打爆）。
// 轮询间隔若被调长（例如 5 分钟），这一步保证「切过去看到的就是新的」。
watch(activeTab, () => {
  if (Date.now() - lastFetchAt > 1000) refreshNow()
  // DSH tab 的数据不在 fetchData 里：进来就拉一次，否则"当前镜像/本地镜像
  // 钦定清单"要用户手动点刷新才出现（新功能表第一眼是空的，不可接受）
  if (activeTab.value === 'dsh') {
    loadDshStatus().catch(() => {})
    loadDshImages().catch(() => {})
  }
})

// 回到前台 → 立即补一次；后台由 startPolling 的定时器判断跳过
const onVisibilityChange = () => {
  if (!document.hidden && isAdmin.value) refreshNow()
}
onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange))

onMounted(() => {
  startAdminBadges()
})
onUnmounted(() => {
  stopAdminBadges()
})
// ↑红点节拍收线；下方为本面板既有清理逻辑
onUnmounted(() => {
  // 清理定时器与监听
  stopPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  stopDshPolling()
  // 遮罩是组件状态：离开页面时必须清掉，否则再次进来会残留"执行中"
  dshUpdate.value = { kind: null, address: '', phase: '' }
  // 解绑账户监听（避免组件重挂载后重复监听）
  unbindAccounts?.()
  unbindAccounts = null
})
</script>

<style scoped>
.admin-panel {
  height: 100%;
  display: flex;
  animation: fadeIn 0.3s;
}
/* 内嵌态（v1.5 系统管理 tab）：不撑满整页高度，随内容生长 */
.admin-panel.embedded {
  height: auto;
  min-height: 480px;
}

/* ─── 磁盘扫描（租户卷区块） ─── */

/* ════ 状态卡片（noAccess / login） ════ */

.state-card h2 {
  font-size: 1.4rem;
  margin-bottom: 1rem;
  color: var(--text-main);
}

.state-card p {
  color: var(--text-muted);
  margin-bottom: 2rem;
}

.error-card h2 {
  color: var(--danger);
}

.address-display {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: var(--bg-page);
  padding: 0.5rem 0.75rem;
  border-radius: 10px;
  word-break: break-all;
  margin-bottom: 2rem;
  display: block;
  font-size: 0.85rem;
  color: var(--text-body);
}

.btn-small {
  padding: 0.25rem 0.75rem;
  font-size: 0.85rem;
  margin-left: 0.5rem;
}

.current-address {
  margin-bottom: 1.5rem;
}

.current-address p {
  color: var(--text-muted);
  margin-bottom: 0.5rem;
  font-size: 0.9rem;
}

/* ════ 主界面：左侧栏 + 右侧内容（与 React 原型稿一致） ════ */

.sidebar-item {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.75rem;
  border: none;
  background: transparent;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  transition: var(--transition-fast);
}

/* ─── 右侧内容卡 ─── */

.tab-content {
  animation: fadeIn 0.25s;
}

/* ─── 资源监控（配额配置页） ─── */

/* ─── 磁盘监控（配额配置页） ─── */

/* ─── 磁盘扫描（租户卷区块） ─── */

.btn-disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ─── 管理员信息卡 ─── */
/* ─── Docker 状态 ─── */
/* ─── 操作按钮行 ─── */
table {
  font-size: 0.875rem;
}

.btn {
  margin-right: 0.375rem;
  text-decoration: none;
  display: inline-flex;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.badge-secondary {
  background: var(--text-muted);
  color: white;
}

/* ─── CWT 授权管理 ─── */

/* ─── CWT 申请列表：筛选头 + 分页 ─── */

/* ─── 孤儿数据卷 ─── */
/* ==========================================================================
   DSH 版本管理
   ========================================================================== */

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

.dsh-select:focus {
  outline: none;
  border-color: var(--brand);
  box-shadow: 0 0 0 2px rgba(64, 126, 255, 0.15);
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

.dsh-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid #bfdbfe;
  border-top-color: #1d4ed8;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* 「更新」执行中的居中遮罩。
   目的：更新是同步长耗时操作（重建容器），必须让用户明确看到"正在执行"，
   而不是只有按钮变灰、无从判断是在跑还是卡死。 */
.dsh-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
}

.dsh-overlay-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  min-width: 280px;
  max-width: 420px;
  padding: 1.5rem 1.75rem;
  border-radius: 12px;
  background: var(--surface-white);
  box-shadow: 0 12px 40px rgba(15, 23, 42, 0.28);
  text-align: center;
}

.dsh-spinner-lg {
  width: 26px;
  height: 26px;
  border-width: 3px;
}

.dsh-overlay-title {
  margin: 0;
  font-size: 0.98rem;
  color: #0f172a;
}

.dsh-overlay-addr {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.dsh-overlay-phase {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: #1d4ed8;
}

.dsh-overlay-count {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: #1d4ed8;
}

.dsh-overlay-hint {
  margin: 0.15rem 0 0;
  font-size: 0.76rem;
  line-height: 1.5;
  color: var(--text-faint);
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

/* 步骤序号：把"版本 → 构建 → 总体镜像 → 租户镜像"这条链在视觉上串起来 */
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

/* "可清理"标记：与"在用/当前"形成对比，一眼能看出哪些是垃圾 */
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

/* 后门：万一请求真的挂死，用户不该只能强刷页面 */
.dsh-overlay-dismiss {
  margin-top: 0.35rem;
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

/* 租户实际在跑的 DSH 版本（主列表 + 镜像升级表共用） */
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

.dsh-badge-running {
  background: #dcfce7;
  color: #15803d;
}

.dsh-badge-stopped {
  background: var(--surface-soft);
  color: var(--text-muted);
}

.dsh-badge-stale {
  background: #fef3c7;
  color: #b45309;
}

.dsh-badge-ok {
  background: #dcfce7;
  color: #15803d;
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

/* 预览计划里的快照目录提示：会降级/不可用必须显眼，正常则弱化 */
.dsh-plan-warn {
  color: #b45309;
  font-weight: 600;
}

.dsh-plan-ok {
  color: var(--text-muted);
}

/* 版本历史：镜像是否仍在本地 + 可清理项 */
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

/* 概括页头：左标题/提示，右自动刷新提示+刷新按钮（按钮跟随每个 tab 的概括区） */

/* 缩写地址/镜像 ID：悬停立即弹出完整值。
   用自绘 tooltip 而不是原生 title —— 原生有约 1 秒延迟、样式不可控、不能选中。 */
/* 提示 ::after 是子节点：任何 overflow:hidden 祖先（含自身省略号）都会裁掉它 */

/* v1.4 CWT 审批 tab */

/* 凭证审批三表（审批/签发台账/任免名册）数据行恒单行（2026-10-23 用户反馈
   "表格里数据换行"）：列内容不被压缩折行，放不下时容器横向滚动——宽度换给
   内嵌态的窄内容区也不破版 */
/* 台账搜索：大号胶囊 + 放大镜 + 聚焦光晕 */
/* cred-search/addr-input 制式已废（2026-10-23 三框统一）：台账与名册搜索框
   改用全局 .search-input（参照=技能市场原版），单一来源防漂移 */
</style>
