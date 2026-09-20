<template>
  <div class="admin-panel">
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

    <!-- 管理面板：左侧栏 + 右侧内容（与 React 原型稿一致） -->
    <div v-else class="gate-shell">
      <!-- 左侧栏 -->
      <aside class="gate-sidebar">
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
            </button>
          </nav>
        </div>
      </aside>

      <!-- 右侧内容 -->
      <section class="gate-content">
        <!-- 全局刷新条：所有 tab 通用。轮询间隔调长（如 5 分钟）时靠它手动取最新 -->
        <div class="refresh-bar">
          <span class="refresh-hint">{{
            $t('admin.refreshAuto', { n: Math.round(refreshIntervalMs / 1000) })
          }}</span>
          <button class="btn btn-small" :disabled="loading" @click="refreshNow(true)">
            {{ loading ? $t('admin.loading') : $t('admin.refresh') }}
          </button>
        </div>

        <!-- ════════ 系统概览 ════════ -->
        <div v-if="activeTab === 'overview'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('admin.tabOverview') }}</h4>
            <p class="tab-hint">{{ $t('admin.overviewHint') }}</p>
          </div>

          <!-- 当前管理员信息 -->
          <div class="admin-info-card">
            <div class="admin-info">
              <div class="admin-label">{{ $t('admin.currentAdminLabel') }}</div>
              <code class="admin-address">{{ currentAddress || currentAdminAddress }}</code>
              <button class="btn btn-small btn-danger" @click="logout">
                {{ $t('admin.logout') }}
              </button>
            </div>
          </div>

          <!-- Docker 状态指示器 -->
          <div class="docker-status-card" :class="dockerAvailable ? 'docker-ok' : 'docker-error'">
            <div class="docker-status">
              <div class="status-icon"></div>
              <div class="status-info">
                <div class="status-label">{{ $t('admin.dockerStatus') }}</div>
                <div class="status-text">
                  {{ dockerAvailable ? $t('admin.running') : $t('admin.notRunning') }}
                </div>
              </div>
              <div v-if="!dockerAvailable" class="status-hint">{{ $t('admin.dockerHint') }}</div>
            </div>
          </div>

          <!-- 系统统计 -->
          <div class="stats-grid">
            <div class="stat-card">
              <h3>{{ $t('admin.statTotal') }}</h3>
              <div class="value">{{ stats.totalUsers }}</div>
            </div>
            <div class="stat-card">
              <h3>{{ $t('admin.running') }}</h3>
              <div class="value">{{ stats.runningUsers }}</div>
            </div>
            <div class="stat-card">
              <h3>{{ $t('admin.statTier1') }}</h3>
              <div class="value">{{ stats.tierCounts[1] || 0 }}</div>
            </div>
            <div class="stat-card">
              <h3>{{ $t('admin.statTier2') }}</h3>
              <div class="value">{{ stats.tierCounts[2] || 0 }}</div>
            </div>
          </div>

          <!-- 孤儿数据卷清理 -->
          <div class="sub-section">
            <h4>{{ $t('admin.orphanTitle') }}</h4>
            <p class="tab-hint">{{ $t('admin.orphanHint') }}</p>
            <div class="action-buttons">
              <button class="btn btn-warning" @click="scanOrphanVolumes" :disabled="orphanScanning">
                {{ orphanScanning ? $t('admin.orphanScanning') : $t('admin.orphanScanBtn') }}
              </button>
              <button
                v-if="orphanVolumes.length > 0"
                class="btn btn-danger"
                @click="cleanupOrphanVolumes"
              >
                {{ $t('admin.orphanCleanBtn', { n: orphanVolumes.length }) }}
              </button>
            </div>
            <div v-if="orphanNotice" class="orphan-notice">{{ orphanNotice }}</div>
            <ul v-if="orphanVolumes.length > 0" class="orphan-list">
              <li v-for="v in orphanVolumes" :key="v" class="orphan-item">
                <span class="orphan-name">{{ v }}</span>
              </li>
            </ul>
          </div>
        </div>

        <!-- ════════ 用户管理 ════════ -->
        <div v-else-if="activeTab === 'users'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('admin.tabUsers') }}</h4>
            <p class="tab-hint">{{ $t('admin.userListHint') }}</p>
          </div>
          <div v-if="loading" class="loading">{{ $t('admin.loading') }}</div>
          <div v-else-if="error" class="error">{{ error }}</div>
          <table v-else>
            <thead>
              <tr>
                <th>{{ $t('admin.colAddress') }}</th>
                <th>{{ $t('admin.colPort') }}</th>
                <th>{{ $t('admin.colTier') }}</th>
                <th>{{ $t('admin.colVersion') }}</th>
                <th>{{ $t('admin.colStatus') }}</th>
                <th>{{ $t('admin.colIdle') }}</th>
                <th>{{ $t('admin.colRole') }}</th>
                <th>{{ $t('admin.colOps') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in users" :key="user.address">
                <td>
                  <span class="address" :title="user.address"
                    >{{ user.address.slice(0, 10) }}...</span
                  >
                </td>
                <td>{{ user.port }}</td>
                <td>
                  <span class="badge" :class="tierBadge(user.tier)">
                    {{ user.tierLabel }}
                  </span>
                </td>
                <td>
                  <code v-if="user.dshVersion" class="dsh-ver">{{ user.dshVersion }}</code>
                  <span v-else class="dsh-ver-unknown">{{ $t('admin.versionUnknown') }}</span>
                </td>
                <td>
                  <span class="badge" :class="statusBadge(user.status)">
                    {{ statusText(user.status) }}
                  </span>
                </td>
                <td>{{ formatIdle(user.idle) }}</td>
                <td>
                  <span v-if="user.isAdmin" class="badge badge-success">{{
                    $t('admin.roleAdmin')
                  }}</span>
                  <span v-else class="badge badge-info">{{ $t('admin.roleUser') }}</span>
                </td>
                <td>
                  <div class="ops-cell">
                    <button
                      class="btn btn-primary"
                      @click="upgradeUser(user.address, user.tier + 1)"
                      :disabled="
                        user.tier >= maxTier ||
                        user.status === 'destroyed' ||
                        user.status === 'unknown'
                      "
                    >
                      {{ $t('admin.upgrade') }}
                    </button>
                    <button
                      class="btn btn-success"
                      @click="downgradeUser(user.address, user.tier - 1)"
                      :disabled="
                        user.tier <= 1 || user.status === 'destroyed' || user.status === 'unknown'
                      "
                    >
                      {{ $t('admin.downgrade') }}
                    </button>
                    <button
                      v-if="!user.isAdmin"
                      class="btn btn-warning"
                      @click="promoteUser(user.address)"
                      :disabled="user.status === 'destroyed' || user.status === 'unknown'"
                    >
                      {{ $t('admin.promote') }}
                    </button>
                    <a
                      v-if="user.status === 'running'"
                      href="#"
                      @click.prevent="openTenant(user.address)"
                      rel="noopener noreferrer"
                      class="btn btn-info"
                    >
                      {{ $t('admin.visit') }}
                    </a>
                    <button
                      v-if="user.status === 'running'"
                      class="btn btn-warning"
                      @click="forceStopUser(user.address)"
                      :title="$t('admin.forceStopTitle')"
                    >
                      {{ $t('admin.forceStop') }}
                    </button>
                    <button
                      v-if="user.status === 'stopped' || user.status === 'destroyed'"
                      class="btn btn-danger"
                      @click="deleteVolume(user.address)"
                      :title="$t('admin.deleteDataTitle')"
                    >
                      {{ $t('admin.deleteData') }}
                    </button>
                    <button
                      v-if="user.status === 'destroyed' || user.status === 'unknown'"
                      class="btn btn-danger"
                      @click="removeUser(user.address)"
                      :title="$t('admin.removeTitle')"
                    >
                      {{ $t('admin.remove') }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- ════════ 配额配置（只读） ════════ -->
        <div v-else-if="activeTab === 'quota'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('admin.tabQuota') }}</h4>
            <p class="tab-hint">{{ $t('admin.tierConfigHint') }}</p>
            <p class="tab-hint tab-hint-warn">{{ $t('admin.diskQuotaHint') }}</p>
          </div>
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

        <!-- ════════ 资源监控 ════════ -->
        <div v-else-if="activeTab === 'monitor'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('admin.tabMonitor') }}</h4>
            <p class="tab-hint">{{ $t('admin.monitorHint') }}</p>
          </div>

          <!-- 资源监控（M2：自动升级） -->
          <div class="sub-section">
            <h4>{{ $t('admin.monitorTitle') }}</h4>

            <!-- 监控配置卡 -->
            <div class="monitor-config">
              <div class="monitor-item">
                <span class="monitor-label">{{ $t('admin.monitorThreshold') }}</span>
                <span class="monitor-value">
                  {{ stats.resource?.autoUpgradeThreshold ?? 80 }}%
                </span>
              </div>
              <div class="monitor-item">
                <span class="monitor-label">{{ $t('admin.monitorInterval') }}</span>
                <span class="monitor-value">
                  {{ ((stats.resource?.monitorIntervalMs ?? 30000) / 1000).toFixed(0) }}s
                </span>
              </div>
              <div class="monitor-item">
                <span class="monitor-label">{{ $t('admin.monitorCooldown') }}</span>
                <span class="monitor-value">
                  {{ ((stats.resource?.autoUpgradeCooldownMs ?? 600000) / 60000).toFixed(0) }}min
                </span>
              </div>
              <div class="monitor-item">
                <span class="monitor-label">{{ $t('admin.monitorUpgraded') }}</span>
                <span class="monitor-value monitor-upgraded">
                  {{
                    $t('admin.monitorUpgradedCount', { n: stats.resource?.autoUpgradeCount ?? 0 })
                  }}
                </span>
              </div>
            </div>

            <!-- 各容器资源一览 -->
            <h5 class="monitor-subtitle">{{ $t('admin.monitorUsersTitle') }}</h5>
            <p class="tab-hint">{{ $t('admin.monitorUsersHint') }}</p>
            <table v-if="users.length">
              <thead>
                <tr>
                  <th>{{ $t('admin.monitorColAddress') }}</th>
                  <th>{{ $t('admin.monitorColTier') }}</th>
                  <th>{{ $t('admin.monitorColStatus') }}</th>
                  <th>{{ $t('admin.monitorColMem') }}</th>
                  <th>{{ $t('admin.monitorColMemPct') }}</th>
                  <th>{{ $t('admin.monitorColCpu') }}</th>
                  <th>{{ $t('admin.monitorColVolume') }}</th>
                  <th>{{ $t('admin.monitorColUpgraded') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="u in users" :key="u.address">
                  <td class="cwt-mono" :title="u.address">{{ shortAddr(u.address) }}</td>
                  <td>
                    <span class="badge" :class="tierBadge(u.tier)">
                      {{ u.tierLabel }}
                    </span>
                  </td>
                  <td>
                    <span class="badge" :class="statusBadge(u.status)">
                      {{ statusText(u.status) }}
                    </span>
                  </td>
                  <td>{{ u.stats ? u.stats.memory : '-' }}</td>
                  <td>
                    <span
                      v-if="u.stats"
                      class="mem-pct"
                      :class="memPctClass(u.stats.memoryPercent)"
                    >
                      {{ u.stats.memoryPercent }}
                    </span>
                    <span v-else>-</span>
                  </td>
                  <td>{{ u.stats ? u.stats.cpu : '-' }}</td>
                  <td>{{ volumeSize(u.address) }}</td>
                  <td>
                    <span v-if="u.lastAutoUpgradeAt" class="badge badge-success">
                      {{ $t('admin.monitorUpgradedAt', { time: fmtTime(u.lastAutoUpgradeAt) }) }}
                    </span>
                    <span v-else class="monitor-never">{{ $t('admin.monitorNever') }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="monitor-empty">{{ $t('admin.monitorNoUsers') }}</div>
          </div>

          <!-- 磁盘监控 -->
          <div class="sub-section">
            <h4>{{ $t('admin.diskTitle') }}</h4>
            <p class="tab-hint">
              {{
                $t('admin.diskHint', {
                  n: ((stats.resource?.diskCheckIntervalMs ?? 300000) / 60000).toFixed(0),
                })
              }}
            </p>

            <template v-if="stats.resource?.disk">
              <!-- 宿主磁盘 -->
              <h5 class="monitor-subtitle">{{ $t('admin.diskHostTitle') }}</h5>
              <div class="monitor-config">
                <div class="monitor-item">
                  <span class="monitor-label">{{ $t('admin.diskTotal') }}</span>
                  <span class="monitor-value">{{
                    fmtDisk(stats.resource.disk.host?.totalKB || 0)
                  }}</span>
                </div>
                <div class="monitor-item">
                  <span class="monitor-label">{{ $t('admin.diskUsed') }}</span>
                  <span class="monitor-value">{{
                    fmtDisk(stats.resource.disk.host?.usedKB || 0)
                  }}</span>
                </div>
                <div class="monitor-item">
                  <span class="monitor-label">{{ $t('admin.diskAvailable') }}</span>
                  <span class="monitor-value">{{
                    fmtDisk(stats.resource.disk.host?.availableKB || 0)
                  }}</span>
                </div>
                <div class="monitor-item">
                  <span class="monitor-label">{{ $t('admin.diskUsage') }}</span>
                  <span
                    class="monitor-value"
                    :class="usagePctClass(stats.resource.disk.host?.usePercent)"
                  >
                    {{ stats.resource.disk.host?.usePercent || '-' }}
                  </span>
                </div>
              </div>

              <!-- Docker 存储 -->
              <h5 class="monitor-subtitle">{{ $t('admin.diskDockerTitle') }}</h5>
              <table v-if="stats.resource.disk.docker?.items?.length">
                <thead>
                  <tr>
                    <th>{{ $t('admin.diskColType') }}</th>
                    <th>{{ $t('admin.diskColSize') }}</th>
                    <th>{{ $t('admin.diskColReclaimable') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in stats.resource.disk.docker.items" :key="item.name">
                    <td>{{ dockerTypeLabel(item.name) }}</td>
                    <td>{{ item.size }}</td>
                    <td class="reclaimable-cell">{{ item.reclaimable }}</td>
                  </tr>
                </tbody>
              </table>

              <!-- 租户数据卷 -->
              <div class="disk-vol-head">
                <h5 class="monitor-subtitle">{{ $t('admin.diskVolumesTitle') }}</h5>
                <button
                  class="btn btn-small"
                  :class="diskScanning ? 'btn-disabled' : 'btn-primary'"
                  :disabled="diskScanning"
                  @click="runDiskScan"
                >
                  {{ diskScanning ? $t('admin.diskScanning') : $t('admin.diskScanBtn') }}
                </button>
              </div>
              <p class="tab-hint">{{ $t('admin.diskScanHint') }}</p>
              <table v-if="stats.resource.disk.volumes?.length">
                <thead>
                  <tr>
                    <th>{{ $t('admin.diskColVolume') }}</th>
                    <th>{{ $t('admin.diskColVolSize') }}（{{ $t('admin.diskHostEngine') }}）</th>
                    <th>{{ $t('admin.diskColVolSize') }}（{{ $t('admin.diskHostActual') }}）</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="v in stats.resource.disk.volumes" :key="v.volume">
                    <td class="cwt-mono">{{ v.volume.replace('dsh-data-swtc-', '…') }}</td>
                    <td class="mem-pct-ok">{{ v.size }}</td>
                    <td>
                      <span v-if="v.sizeActual" :class="actualSizeClass(v.size, v.sizeActual)">
                        {{ fmtBytes(v.sizeActual) }}
                      </span>
                      <span v-else class="monitor-never">-</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </template>
            <div v-else class="monitor-empty">{{ $t('admin.diskNoData') }}</div>
          </div>
        </div>

        <!-- ════════ CWT 授权 ════════ -->
        <div v-else-if="activeTab === 'cwt'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('admin.tabCwt') }}</h4>
            <p class="tab-hint">{{ $t('admin.cwtManageHint') }}</p>
          </div>

          <div v-if="cwtLoading" class="config-loading">
            <span>{{ $t('admin.cwtLoading') }}</span>
          </div>

          <div class="sub-section">
            <div class="cwt-list-head">
              <h4>{{ $t('admin.cwtPending') }}</h4>
              <label class="cwt-filter">
                <span>{{ $t('admin.cwtFilterLabel') }}</span>
                <select v-model="cwtStatusFilter" @change="onCwtFilterChange">
                  <option value="all">{{ $t('admin.cwtFilterAll') }}</option>
                  <option value="pending">{{ $t('admin.cwtFilterPending') }}</option>
                  <option value="approved">{{ $t('admin.cwtFilterApproved') }}</option>
                  <option value="rejected">{{ $t('admin.cwtFilterRejected') }}</option>
                </select>
              </label>
            </div>
            <table v-if="cwtApplications.length">
              <thead>
                <tr>
                  <th>{{ $t('admin.colUsr') }}</th>
                  <th>{{ $t('admin.colAddress') }}</th>
                  <th>{{ $t('admin.colAlg') }}</th>
                  <th>{{ $t('admin.colSubmitted') }}</th>
                  <th>{{ $t('admin.colVerify') }}</th>
                  <th>{{ $t('admin.colOps') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="app in cwtApplications" :key="app.id">
                  <td>{{ app.parsed?.usr || '-' }}</td>
                  <td class="cwt-mono" :title="app.parsed?.address">
                    {{ shortAddr(app.parsed?.address) }}
                  </td>
                  <td>{{ app.parsed?.alg || '-' }}</td>
                  <td>{{ fmtTime(app.submittedAt) }}</td>
                  <td>
                    <span class="badge" :class="app.sigOk ? 'badge-success' : 'badge-danger'">
                      {{ app.sigOk ? $t('admin.sigOk') : $t('admin.sigFail') }}
                    </span>
                  </td>
                  <td>
                    <template v-if="app.status === 'pending'">
                      <button
                        class="btn btn-small btn-success"
                        :disabled="cwtBusy"
                        @click="approveCwt(app.id)"
                      >
                        {{ $t('admin.approve') }}
                      </button>
                      <button
                        class="btn btn-small btn-danger"
                        :disabled="cwtBusy"
                        @click="rejectCwt(app.id)"
                      >
                        {{ $t('admin.reject') }}
                      </button>
                    </template>
                    <span
                      v-else
                      class="badge"
                      :class="app.status === 'approved' ? 'badge-success' : 'badge-info'"
                    >
                      {{ app.status }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="cwt-empty">{{ $t('admin.cwtPageEmpty') }}</div>

            <!-- 分页控件（后端分页：limit/offset/total） -->
            <div v-if="cwtTotal > 0" class="cwt-pager">
              <span class="cwt-page-info">
                {{
                  $t('admin.cwtPageInfo', {
                    from: cwtOffset + 1,
                    to: Math.min(cwtOffset + cwtLimit, cwtTotal),
                    total: cwtTotal,
                  })
                }}
              </span>
              <div class="cwt-page-btns">
                <button
                  class="btn btn-small"
                  :disabled="cwtOffset <= 0 || cwtLoading"
                  @click="cwtPrevPage"
                >
                  {{ $t('admin.cwtPagePrev') }}
                </button>
                <button
                  class="btn btn-small"
                  :disabled="!cwtHasMore || cwtLoading"
                  @click="cwtNextPage"
                >
                  {{ $t('admin.cwtPageNext') }}
                </button>
              </div>
            </div>
          </div>

          <div class="sub-section">
            <h4>{{ $t('admin.cwtRegistry') }}</h4>
            <table v-if="cwtRegistry.length">
              <thead>
                <tr>
                  <th>{{ $t('admin.colUsr') }}</th>
                  <th>{{ $t('admin.colAddress') }}</th>
                  <th>{{ $t('admin.colStatus') }}</th>
                  <th>{{ $t('admin.colApprovedAt') }}</th>
                  <th>{{ $t('admin.colOps') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in cwtRegistry" :key="entry.address">
                  <td>{{ entry.usr }}</td>
                  <td class="cwt-mono" :title="entry.address">{{ shortAddr(entry.address) }}</td>
                  <td>
                    <span
                      class="badge"
                      :class="entry.status === 'approved' ? 'badge-success' : 'badge-danger'"
                    >
                      {{ entry.status }}
                    </span>
                  </td>
                  <td>{{ fmtTime(entry.approvedAt) }}</td>
                  <td>
                    <button
                      v-if="entry.status === 'approved'"
                      class="btn btn-small btn-danger"
                      :disabled="cwtBusy"
                      @click="revokeCwt(entry.address)"
                    >
                      {{ $t('admin.revoke') }}
                    </button>
                    <span v-else-if="entry.revokedAt"
                      >{{ fmtTime(entry.revokedAt) }} {{ $t('admin.revokedSuffix') }}</span
                    >
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="cwt-empty">{{ $t('admin.noRegistry') }}</div>

            <!-- 分页控件（后端分页：limit/offset/total） -->
            <div v-if="cwtRegTotal > 0" class="cwt-pager">
              <span class="cwt-page-info">
                {{
                  $t('admin.cwtPageInfo', {
                    from: cwtRegOffset + 1,
                    to: Math.min(cwtRegOffset + cwtRegLimit, cwtRegTotal),
                    total: cwtRegTotal,
                  })
                }}
              </span>
              <div class="cwt-page-btns">
                <button
                  class="btn btn-small"
                  :disabled="cwtRegOffset <= 0 || cwtLoading"
                  @click="cwtRegistryPrevPage"
                >
                  {{ $t('admin.cwtPagePrev') }}
                </button>
                <button
                  class="btn btn-small"
                  :disabled="!cwtRegHasMore || cwtLoading"
                  @click="cwtRegistryNextPage"
                >
                  {{ $t('admin.cwtPageNext') }}
                </button>
              </div>
            </div>
          </div>

          <div class="sub-section">
            <h4>{{ $t('admin.cwtRecords') }}</h4>
            <table v-if="cwtRecords.length">
              <thead>
                <tr>
                  <th>{{ $t('admin.colAction') }}</th>
                  <th>{{ $t('admin.colUsr') }}</th>
                  <th>{{ $t('admin.colAddress') }}</th>
                  <th>{{ $t('admin.colTime') }}</th>
                  <th>{{ $t('admin.colBy') }}</th>
                  <th>{{ $t('admin.colToken') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(rec, i) in cwtRecords" :key="i">
                  <td>
                    <span class="badge" :class="actionBadge(rec.action)">{{ rec.action }}</span>
                  </td>
                  <td>{{ rec.usr || '-' }}</td>
                  <td class="cwt-mono" :title="rec.address">{{ shortAddr(rec.address) }}</td>
                  <td>{{ fmtTime(rec.at) }}</td>
                  <td class="cwt-mono" :title="rec.by">{{ shortAddr(rec.by) }}</td>
                  <td>
                    <button v-if="rec.token" class="btn btn-small" @click="toggleToken(i)">
                      {{ expandedToken === i ? $t('admin.collapse') : $t('admin.view') }}
                    </button>
                    <div v-if="expandedToken === i" class="cwt-token-preview">
                      {{ rec.token }}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="cwt-empty">{{ $t('admin.noRecords') }}</div>

            <!-- 分页控件（后端尾部读取分页；无 total，按 hasMore 判断） -->
            <div v-if="cwtRecords.length || cwtRecOffset > 0" class="cwt-pager">
              <span class="cwt-page-info">
                {{
                  $t('admin.cwtRecPageInfo', {
                    from: cwtRecOffset + 1,
                    to: cwtRecOffset + cwtRecords.length,
                  })
                }}
                <span v-if="cwtRecHasMore" class="cwt-more-hint">
                  · {{ $t('admin.cwtRecHasMore') }}</span
                >
              </span>
              <div class="cwt-page-btns">
                <button
                  class="btn btn-small"
                  :disabled="cwtRecOffset <= 0 || cwtLoading"
                  @click="cwtRecordsPrevPage"
                >
                  {{ $t('admin.cwtPagePrev') }}
                </button>
                <button
                  class="btn btn-small"
                  :disabled="!cwtRecHasMore || cwtLoading"
                  @click="cwtRecordsNextPage"
                >
                  {{ $t('admin.cwtPageNext') }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ════════ DSH 版本管理 ════════ -->
        <div v-else-if="activeTab === 'dsh'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('admin.tabDsh') }}</h4>
            <p class="tab-hint">{{ $t('admin.dshHint') }}</p>
          </div>

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

            <!-- 本地已构建版本清单：这是"我手上有哪些版本"的权威答案 -->
            <h6 class="dsh-subhead">
              {{ $t('admin.dshLocalVersions') }}
              <span class="dsh-muted">（{{ localVersionRows.length }}）</span>
            </h6>
            <table v-if="localVersionRows.length" class="dsh-table">
              <thead>
                <tr>
                  <th>{{ $t('admin.dshColVersion') }}</th>
                  <th>{{ $t('admin.dshImageName') }}</th>
                  <th>{{ $t('admin.dshBuiltAt') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="lv in localVersionRows" :key="lv.imageId">
                  <td>
                    <code class="dsh-ver">{{ lv.version }}</code>
                    <span v-if="lv.isCurrent" class="dsh-ver-tag">
                      {{ $t('admin.dshCurrentTag') }}
                    </span>
                  </td>
                  <td>
                    <code>{{ lv.imageId }}</code>
                  </td>
                  <td class="dsh-muted">{{ lv.createdAt || '—' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="dsh-note">{{ $t('admin.dshNoLocalVersions') }}</p>
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
                    <code class="dsh-addr" :title="t.address">{{ shortAddress(t.address) }}</code>
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
                    <code class="dsh-img" :title="t.containerImageId || ''">{{
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
                <code :title="r.address">{{ shortAddress(r.address) }}</code>
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
                <span class="dsh-muted" :title="h.imageId || ''">{{
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
                <span class="dsh-muted" :title="im.id || ''">{{ shortImageId(im.id) }}</span>
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
          <code :title="dshUpdate.address">{{ shortAddress(dshUpdate.address) }}</code>
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
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import axios from 'axios'
import { useI18n } from 'vue-i18n'
import {
  requestAccounts,
  signMessage,
  getPublicKey,
  watchAccountsChanged,
  friendlyPluginError,
} from '../api/wallet.js'

const { t } = useI18n()

// ---- 侧栏导航（与 React 原型稿一致） ----
const activeTab = ref('overview')
const adminTabs = [
  {
    key: 'overview',
    label: t('admin.tabOverview'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  },
  {
    key: 'users',
    label: t('admin.tabUsers'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  },
  {
    key: 'quota',
    label: t('admin.tabQuota'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  },
  {
    key: 'monitor',
    label: t('admin.tabMonitor'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  },
  {
    key: 'cwt',
    label: t('admin.tabCwt'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  },
  {
    key: 'dsh',
    label: t('admin.tabDsh'),
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  },
]

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
// CWT 授权管理（M1）
const cwtApplications = ref([])
// CWT 申请列表：后端分页（limit/offset/total/hasMore）+ 状态筛选
const cwtLimit = ref(10)
const cwtOffset = ref(0)
const cwtTotal = ref(0)
const cwtHasMore = ref(false)
const cwtStatusFilter = ref('all')
const cwtRegistry = ref([])
// 授权注册表：后端分页（limit/offset/total/hasMore）
const cwtRegLimit = ref(10)
const cwtRegOffset = ref(0)
const cwtRegTotal = ref(0)
const cwtRegHasMore = ref(false)
const cwtRecords = ref([])
// 审计记录：后端分页（尾部读取 + hasMore；日志 append-only，不提供 total）
const cwtRecLimit = ref(10)
const cwtRecOffset = ref(0)
const cwtRecHasMore = ref(false)
const cwtLoading = ref(false)
const cwtBusy = ref(false)
const diskScanning = ref(false)

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
const localVersionRows = computed(() =>
  (dshVersions.value.localTags || []).filter((t) => t.version && t.version !== 'latest'),
)

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
const formatBytes = (n) => {
  const b = Number(n) || 0
  if (b <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)))
  return `${(b / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

/**
 * 清理选中的悬空镜像（破坏性操作 → 走管理端签名）。
 * 必须把 ids 并入签名 binding：签名内容即"删哪几个"，服务端会逐项重新校验。
 */
const pruneImages = async () => {
  const ids = [...selectedImageIds.value]
  if (!ids.length) return
  dshPrune.value = { running: true, message: '' }
  try {
    const headers = await signAdminOperation('dsh/prune-images', { ids })
    const res = await axios.post('/api/admin/dsh/images/prune', { ids }, { headers })
    const { removed = [], skipped = [], freedBytes = 0 } = res.data || {}
    const parts = [$t('admin.dshPruned', { n: removed.length, size: formatBytes(freedBytes) })]
    if (skipped.length) parts.push($t('admin.dshPruneSkipped', { n: skipped.length }))
    dshPrune.value = { running: false, message: parts.join('，') }
    selectedImageIds.value = []
    await loadDshStatus()
  } catch (err) {
    dshPrune.value = { running: false, message: friendlyPluginError(err) }
  }
}

/** 短地址显示（前 6 + … + 后 4），表格里避免撑爆 */
function shortAddress(addr) {
  if (!addr) return '—'
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

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

/**
 * 配额档位行（升序）。过滤非数字键：运维可能在 tiers 里加 comment 等说明键
 * （其他配置块都带 comment），这些不该被渲染成一档配额。
 */
const tierRows = computed(() =>
  Object.entries(tiers.value || {})
    .filter(([key]) => Number.isFinite(Number(key)))
    .map(([tier, limits]) => ({ tier: Number(tier), limits }))
    .sort((a, b) => a.tier - b.tier),
)
const expandedToken = ref(null)
let dataRefreshInterval = null
/** 上次拉取时间：切 tab 时做 1 秒节流，避免狂点 tab 打爆后端 */
let lastFetchAt = 0
/** 自动刷新间隔（毫秒）：后端 /api/stats 的 uiConfig 下发，默认 15 秒。
 *  想改成 5 分钟只需改 config.json 的 admin.refreshIntervalMs 并重启服务。 */
const refreshIntervalMs = ref(15000)

/** 停止轮询 */
const stopPolling = () => {
  stopPolling()
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

// 租户 DSH 实例地址：用当前访问入口页的 host 拼端口（不再硬编码 127.0.0.1）
// 注：网关方案下不再直接拼 URL —— 打开租户需先取一次性 gateway_ticket（见 openTenant）
const webUrl = (port) => `http://${window.location.hostname}:${port}/`

/**
 * 管理员代开租户容器：后端生成一次性 gateway_ticket（管理员会话授权），
 * 浏览器打开该 URL 首跳即换取租户会话并放行（后续请求无需再带 ticket）。
 */
const openTenant = async (address) => {
  try {
    const res = await axios.get(`/api/admin/tenant-url?address=${encodeURIComponent(address)}`)
    if (res.data.url) {
      window.open(res.data.url, '_blank', 'noopener')
      return
    }
    alert(t('admin.openFail', { err: res.data.error || res.status }))
  } catch (err) {
    const msg = err.response?.data?.error || err.message
    alert(t('admin.openFail', { err: msg }))
  }
}

const checkCCDAO = () => {
  hasCCDAO.value = typeof window.ccdao !== 'undefined'
}

// 账户变化统一处理（事件/轮询共用）：
// 地址切换 → 先做无痕管理员预检（不弹签名）→ 是管理员才签名换会话；
// 不是管理员 → 立即显示无权限页（notAdmin），绝不滞留管理面板。
const handleAccountsChanged = async (accounts, source = 'unknown') => {
  console.log(`[AdminPanel] 检测到账户变化(${source}):`, accounts)

  if (!accounts || accounts.length === 0) {
    // 用户断开连接
    alert(t('admin.walletDisconnected'))
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
        alert(t('admin.switchedAdmin', { addr: `${address.slice(0, 10)}...` }))
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
        alert(t('admin.loginFail', { err: msg }))
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
  const nonce = chalRes.data.nonce
  // 2. 插件对 nonce 签名 + 取公钥（都用原始大小写地址）
  const signature = await signMessage(pluginAddress, nonce)
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
 * 背景：`admin_session` 是 12 小时有效的 bearer token，只做查表不验签；而平台
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
const signAdminOperation = async (operation, payload) => {
  if (!hasCCDAO.value) {
    throw new Error(t('admin.signNeedsWallet'))
  }
  // 插件原始大小写地址（签名用）；挑战必须绑在**当前登录会话**的地址上
  const pluginAddress = await requestAccounts()
  try {
    const chalRes = await axios.post('/api/admin/challenge', {
      address: pluginAddress.toLowerCase(),
      operation,
      payload,
    })
    const { message } = chalRes.data
    const signature = await signMessage(pluginAddress, message)
    const publicKey = await getPublicKey(pluginAddress)
    return {
      'x-admin-nonce': chalRes.data.nonce,
      'x-admin-signature': signature,
      'x-admin-pubkey': publicKey,
    }
  } catch (err) {
    throw new Error(friendlyPluginError(err))
  }
}

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
  alert(t('admin.switchWalletHint'))
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

// ---- 孤儿数据卷（扫描 + 清理） ----
const orphanVolumes = ref([])
const orphanScanning = ref(false)
const orphanNotice = ref('')

const scanOrphanVolumes = async () => {
  orphanScanning.value = true
  orphanNotice.value = ''
  try {
    const res = await axios.get('/api/admin/orphan-volumes')
    orphanVolumes.value = res.data.orphanVolumes || []
    orphanNotice.value = orphanVolumes.value.length
      ? t('admin.orphanFound', { n: orphanVolumes.value.length })
      : t('admin.orphanNone')
  } catch (err) {
    alert(t('admin.orphanScanFail', { err: err.response?.data?.error || err.message }))
  } finally {
    orphanScanning.value = false
  }
}

const cleanupOrphanVolumes = async () => {
  if (!orphanVolumes.value.length) return
  if (!confirm(t('admin.orphanConfirm', { n: orphanVolumes.value.length }))) return
  try {
    const res = await axios.post('/api/admin/cleanup-orphan-volumes')
    const { removed, failed } = res.data
    orphanNotice.value = t('admin.orphanCleaned', {
      ok: removed.length,
      fail: failed.length,
    })
    // 刷新列表：剩下的就是删除失败的
    orphanVolumes.value = (failed || []).map((f) => f.name)
  } catch (err) {
    alert(t('admin.orphanCleanFail', { err: err.response?.data?.error || err.message }))
  }
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
  // CWT 数据跟随主刷新（登录成功、定时刷新、操作后刷新均自动带上）
  fetchCwtData()
}

/** 手动触发精确扫描：du 实测每个租户卷真实占用（O(n)，管理员按需调用） */
const runDiskScan = async () => {
  if (diskScanning.value) return
  diskScanning.value = true
  try {
    const res = await axios.post('/api/admin/disk-scan')
    // 扫描结果直接合并进本地 stats，避免等待下一次轮询
    const { scanned, volumes } = res.data
    if (scanned && stats.value.resource?.disk) {
      stats.value.resource.disk.volumes = volumes
      stats.value.resource.disk.preciseScannedAt = res.data.preciseScannedAt
    }
    alert(t('admin.diskScanDone', { n: volumes?.length ?? 0 }))
  } catch (err) {
    alert(t('admin.diskScanFail', { err: err.response?.data?.error || err.message }))
  } finally {
    diskScanning.value = false
  }
}

// ---------- CWT 授权管理（M1） ----------

const shortAddr = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '-')
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '-')
const actionBadge = (action) =>
  ({ approve: 'badge-success', reject: 'badge-warning', revoke: 'badge-danger' })[action] ||
  'badge-info'
const toggleToken = (i) => {
  expandedToken.value = expandedToken.value === i ? null : i
}

const fetchCwtData = async () => {
  try {
    cwtLoading.value = true
    const [apps, reg, recs] = await Promise.all([
      axios.get('/api/admin/cwt/applications', {
        params: {
          limit: cwtLimit.value,
          offset: cwtOffset.value,
          status: cwtStatusFilter.value,
        },
      }),
      axios.get('/api/admin/cwt/registry', {
        params: { limit: cwtRegLimit.value, offset: cwtRegOffset.value },
      }),
      axios.get('/api/admin/cwt/records', {
        params: { limit: cwtRecLimit.value, offset: cwtRecOffset.value },
      }),
    ])
    cwtApplications.value = apps.data.applications || []
    cwtTotal.value = apps.data.total ?? cwtApplications.value.length
    cwtHasMore.value = Boolean(apps.data.hasMore)
    // 服务端可能钳制了参数（如 limit 上限），以响应为准
    if (apps.data.limit) cwtLimit.value = apps.data.limit

    // 页越界回退：审批/拒绝后 total 变小，当前页可能已空 → 自动退到上一页
    if (cwtApplications.value.length === 0 && cwtOffset.value > 0 && cwtTotal.value > 0) {
      cwtOffset.value = Math.max(0, cwtOffset.value - cwtLimit.value)
      return await fetchCwtData()
    }
    cwtRegistry.value = reg.data.registry || []
    cwtRegTotal.value = reg.data.total ?? cwtRegistry.value.length
    cwtRegHasMore.value = Boolean(reg.data.hasMore)
    if (reg.data.limit) cwtRegLimit.value = reg.data.limit
    // 页越界回退：撤销授权后 total 变小，当前页可能已空 → 自动退到上一页
    if (cwtRegistry.value.length === 0 && cwtRegOffset.value > 0 && cwtRegTotal.value > 0) {
      cwtRegOffset.value = Math.max(0, cwtRegOffset.value - cwtRegLimit.value)
      return await fetchCwtData()
    }
    cwtRecords.value = recs.data.records || []
    cwtRecHasMore.value = Boolean(recs.data.hasMore)
    if (recs.data.limit) cwtRecLimit.value = recs.data.limit
    // 页越界回退：日志轮转后更早的记录消失，当前页可能已空 → 自动退到上一页
    if (cwtRecords.value.length === 0 && cwtRecOffset.value > 0) {
      cwtRecOffset.value = Math.max(0, cwtRecOffset.value - cwtRecLimit.value)
      return await fetchCwtData()
    }
  } catch (err) {
    console.error('加载 CWT 数据失败:', err)
  } finally {
    cwtLoading.value = false
  }
}

/** 翻页：offset 越界时回退（如末页数据被处理致 total 变小） */
const cwtPrevPage = () => {
  cwtOffset.value = Math.max(0, cwtOffset.value - cwtLimit.value)
  fetchCwtData()
}

const cwtNextPage = () => {
  if (!cwtHasMore.value) return
  cwtOffset.value += cwtLimit.value
  fetchCwtData()
}

/** 切换状态筛选：回到第一页再查询（否则可能落在空页） */
const onCwtFilterChange = () => {
  cwtOffset.value = 0
  fetchCwtData()
}

/** 授权注册表翻页 */
const cwtRegistryPrevPage = () => {
  cwtRegOffset.value = Math.max(0, cwtRegOffset.value - cwtRegLimit.value)
  fetchCwtData()
}

const cwtRegistryNextPage = () => {
  if (!cwtRegHasMore.value) return
  cwtRegOffset.value += cwtRegLimit.value
  fetchCwtData()
}

/** 审计记录翻页（无 total，仅按 hasMore 判断是否还有更早记录） */
const cwtRecordsPrevPage = () => {
  cwtRecOffset.value = Math.max(0, cwtRecOffset.value - cwtRecLimit.value)
  fetchCwtData()
}

const cwtRecordsNextPage = () => {
  if (!cwtRecHasMore.value) return
  cwtRecOffset.value += cwtRecLimit.value
  fetchCwtData()
}

const approveCwt = async (id) => {
  if (!confirm(t('admin.confirmApprove'))) return
  cwtBusy.value = true
  try {
    await axios.post(`/api/admin/cwt/applications/${id}/approve`)
    alert(t('admin.approvedOk'))
    await fetchData()
  } catch (err) {
    alert(t('admin.approveFail', { err: err.response?.data?.error || err.message }))
  } finally {
    cwtBusy.value = false
  }
}

const rejectCwt = async (id) => {
  if (!confirm(t('admin.confirmReject'))) return
  cwtBusy.value = true
  try {
    await axios.post(`/api/admin/cwt/applications/${id}/reject`)
    alert(t('admin.rejectedOk'))
    await fetchData()
  } catch (err) {
    alert(t('admin.rejectFail', { err: err.response?.data?.error || err.message }))
  } finally {
    cwtBusy.value = false
  }
}

const revokeCwt = async (address) => {
  if (!confirm(t('admin.confirmRevoke', { addr: `${address.slice(0, 8)}…` }))) return
  cwtBusy.value = true
  try {
    await axios.post(`/api/admin/cwt/registry/${address}/revoke`)
    alert(t('admin.revokedOk'))
    await fetchData()
  } catch (err) {
    alert(t('admin.revokeFail', { err: err.response?.data?.error || err.message }))
  } finally {
    cwtBusy.value = false
  }
}

const upgradeUser = async (address, tier) => {
  if (tier > maxTier.value) return
  try {
    await axios.post(`/api/upgrade/${address}`, { tier })
    await fetchData()
    alert(t('admin.upgradeOk'))
  } catch (err) {
    alert(t('admin.upgradeFail', { err: err.response?.data?.error || err.message }))
  }
}

const downgradeUser = async (address, tier) => {
  if (tier < 1) return
  try {
    await axios.post(`/api/upgrade/${address}`, { tier })
    await fetchData()
    alert(t('admin.downgradeOk'))
  } catch (err) {
    alert(t('admin.downgradeFail', { err: err.response?.data?.error || err.message }))
  }
}

const removeUser = async (address) => {
  const port = users.value.find((u) => u.address === address)?.port
  if (!confirm(t('admin.confirmRemove', { addr: `${address.slice(0, 10)}...`, port }))) return

  // 是否保留数据卷：确定=保留（留档/审计），取消=连同数据一起删除（彻底清除）
  const keepVolume = confirm(t('admin.confirmRemoveKeepVolume'))

  try {
    const headers = await signAdminOperation('remove', { address, keepVolume })
    await axios.post(`/api/user/${address}/remove`, null, {
      params: keepVolume ? { keepVolume: 1 } : {},
      headers,
    })
    await fetchData()
    alert(keepVolume ? t('admin.removedOkKeepVolume') : t('admin.removedOk'))
  } catch (err) {
    alert(t('admin.removeFail', { err: err.response?.data?.error || err.message }))
  }
}

const forceStopUser = async (address) => {
  if (!confirm(t('admin.confirmForceStop', { addr: `${address.slice(0, 10)}...` }))) return

  try {
    const headers = await signAdminOperation('force-stop', { address })
    await axios.post(`/api/admin/force-stop/${address}`, null, { headers })
    await fetchData()
    alert(t('admin.forceStoppedOk'))
  } catch (err) {
    alert(t('admin.forceStopFail', { err: err.response?.data?.error || err.message }))
  }
}

const deleteVolume = async (address) => {
  if (!confirm(t('admin.confirmDeleteVolume', { addr: `${address.slice(0, 10)}...` }))) return

  if (!confirm(t('admin.confirmDeleteVolume2'))) return

  try {
    const headers = await signAdminOperation('delete-volume', { address })
    await axios.post(`/api/admin/delete-volume/${address}`, null, { headers })
    await fetchData()
    alert(t('admin.volumeDeletedOk'))
  } catch (err) {
    alert(t('admin.removeFail', { err: err.response?.data?.error || err.message }))
  }
}

const promoteUser = async (address) => {
  if (!confirm(t('admin.confirmPromote', { addr: `${address.slice(0, 10)}...` }))) return
  try {
    const headers = await signAdminOperation('promote', { address })
    await axios.post(`/api/admin/promote/${address}`, null, { headers })
    await fetchData()
    alert(t('admin.promoteOk'))
  } catch (err) {
    alert(t('admin.promoteFail', { err: err.response?.data?.error || err.message }))
  }
}

const tierBadge = (tier) => {
  const map = { 1: 'badge-info', 2: 'badge-warning', 3: 'badge-success' }
  return map[tier] || 'badge-info'
}

const statusBadge = (status) => {
  const map = {
    running: 'badge-success',
    stopped: 'badge-warning',
    destroyed: 'badge-danger',
    unknown: 'badge-secondary',
  }
  return map[status] || 'badge-info'
}

const statusText = (status) => {
  const map = {
    running: t('admin.statusRunning'),
    stopped: t('admin.statusStopped'),
    destroyed: t('admin.statusDestroyed'),
    unknown: t('admin.statusUnknown'),
  }
  return map[status] || status
}

/** 内存占比样式：达到自动升级阈值（80%）时高亮警示 */
const memPctClass = (pct) => {
  const n = Number.parseFloat(String(pct ?? ''))
  if (!Number.isFinite(n)) return ''
  if (n >= 80) return 'mem-pct-high'
  if (n >= 60) return 'mem-pct-warn'
  return 'mem-pct-ok'
}

/** KB → 人类可读容量（如 "52.2 GB"） */
const fmtDisk = (kb) => {
  const b = Number(kb)
  if (!Number.isFinite(b) || b <= 0) return '-'
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} TB`
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} GB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} MB`
  return `${kb} KB`
}

/** 宿主磁盘使用率样式 */
const usagePctClass = (pct) => {
  const n = Number.parseFloat(String(pct ?? ''))
  if (!Number.isFinite(n)) return ''
  if (n >= 80) return 'mem-pct-high'
  if (n >= 60) return 'mem-pct-warn'
  return 'mem-pct-ok'
}

/** Docker 存储类型 → 中文名 */
const dockerTypeLabel = (name) => {
  const map = {
    Images: t('admin.diskTypeImages'),
    Containers: t('admin.diskTypeContainers'),
    'Local Volumes': t('admin.diskTypeLocalVolumes'),
    'Build Cache': t('admin.diskTypeBuildCache'),
  }
  return map[name] || name
}

/** 解析 docker 大小字符串（"101.3kB" / "602.1MB" / "1.2GB"）→ 字节数 */
const parseSize = (s) => {
  const m = String(s ?? '')
    .trim()
    .match(/^([\d.]+)\s*([kKmMgGtT]?)[bB]?$/)
  if (!m) return 0
  const n = Number.parseFloat(m[1])
  const unit = (m[2] || '').toLowerCase()
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit] || 1
  return n * mult
}

/** 字节数 → 人类可读（如 "2.4 MB"） */
const fmtBytes = (b) => {
  const n = Number(b)
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${n} B`
}

/** 实测值与引擎口径差异高亮：偏差 ≥2 倍标黄，≥10 倍标红（提示引擎口径失真） */
const actualSizeClass = (engineSize, actualBytes) => {
  const engine = parseSize(engineSize)
  const actual = Number(actualBytes)
  if (!engine || !Number.isFinite(actual) || actual <= 0) return ''
  const ratio = actual / engine
  if (ratio >= 10) return 'mem-pct-high'
  if (ratio >= 2) return 'mem-pct-warn'
  return 'mem-pct-ok'
}

/** 按地址查租户数据卷大小（volume 名形如 dsh-data-swtc-<address>） */
const volumeSize = (address) => {
  const volumes = stats.value.resource?.disk?.volumes
  if (!Array.isArray(volumes) || !address) return '-'
  const hit = volumes.find((v) => v.volume === `dsh-data-swtc-${address}`)
  if (!hit) return '-'
  // 有 du 实测值优先展示（真实占用），否则回退引擎口径
  return hit.sizeActual ? fmtBytes(hit.sizeActual) : hit.size
}

/** 磁盘占用进度条宽度：该卷占所有租户卷最大者的百分比（最小 4% 保证可见） */
const formatIdle = (ms) => {
  if (ms < 60000) return `${Math.floor(ms / 1000)}${t('admin.secUnit')}`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}${t('admin.minUnit')}`
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}${t('admin.hourUnit')}`
  return `${(ms / 86400000).toFixed(1)}${t('admin.dayUnit')}`
}

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
  } catch (err) {
    console.error('[AdminPanel] 读取 DSH 镜像状态失败:', err)
    error.value = err.response?.data?.error || err.message
  } finally {
    dshStatusLoading.value = false
  }
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
          // 构建结束：刷新镜像状态（新版本要显示出来）
          await loadDshStatus()
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

/** 构建指定 DSH 版本的新镜像 */
const startImageUpgrade = async () => {
  if (!dshSelectedVersion.value) return
  try {
    await axios.post('/api/admin/dsh/image', { version: dshSelectedVersion.value })
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
    error.value = friendlyPluginError(err)
  }
}

/** 应用当前镜像到单个租户（重建容器，保留数据卷） */
const applyOne = async (address) => {
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
    await loadDshStatus()
  } catch (err) {
    dshApplyResults.value = [{ address, ok: false, error: friendlyPluginError(err) }]
    await loadDshStatus()
  } finally {
    dshUpdate.value = { kind: null, address: '', phase: '' }
  }
}

/** 批量应用（后台跑，轮询进度） */
const applyAllStale = async () => {
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
    error.value = friendlyPluginError(err)
  }
}

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
})

// 回到前台 → 立即补一次；后台由 startPolling 的定时器判断跳过
const onVisibilityChange = () => {
  if (!document.hidden && isAdmin.value) refreshNow()
}
onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange))

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

/* ─── 磁盘扫描（租户卷区块） ─── */

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ════ 状态卡片（noAccess / login） ════ */
.state-card {
  margin: auto;
  width: min(540px, calc(100% - 2rem));
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
  text-align: center;
  padding: 3rem 2rem;
}

.state-card h2 {
  font-size: 1.4rem;
  margin-bottom: 1rem;
  color: #1e293b;
}

.state-card p {
  color: #64748b;
  margin-bottom: 2rem;
}

.error-card h2 {
  color: #dc2626;
}

.address-display {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: #f8fafc;
  padding: 0.5rem 0.75rem;
  border-radius: 10px;
  word-break: break-all;
  margin-bottom: 2rem;
  display: block;
  font-size: 0.85rem;
  color: #334155;
}

.btn-large {
  padding: 0.75rem 2rem;
  font-size: 1.05rem;
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
  color: #64748b;
  margin-bottom: 0.5rem;
  font-size: 0.9rem;
}

/* ════ 主界面：左侧栏 + 右侧内容（与 React 原型稿一致） ════ */
.gate-shell {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 1rem;
  padding: 1.25rem;
  align-items: stretch;
}

.gate-sidebar {
  width: 176px;
  flex-shrink: 0;
}

.sidebar-card {
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
  padding: 0.5rem;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding-top: 0.25rem;
}

.sidebar-item {
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
  color: #64748b;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s;
}

.sidebar-item:hover {
  background: #f8fafc;
  color: #475569;
}

.sidebar-item.active {
  background: #eef0f8;
  color: #6b7bdb;
}

.sidebar-icon {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.sidebar-icon :deep(svg) {
  display: block;
}

/* ─── 右侧内容卡 ─── */
.gate-content {
  flex: 1;
  min-width: 0;
  background: #fff;
  border-radius: 16px;
  border: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
  padding: 1.5rem;
  overflow-y: auto;
}

.tab-content {
  animation: fadeIn 0.25s;
}

.tab-head h4 {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
  margin-bottom: 0.125rem;
}

.tab-hint {
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.6;
  margin-bottom: 1rem;
}

.sub-section {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid #f8fafc;
}

.sub-section h4 {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
  margin-bottom: 0.25rem;
}

/* ─── 资源监控（配额配置页） ─── */
.monitor-config {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
  margin: 0.75rem 0 1.25rem;
  padding: 1rem 1.25rem;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
}

.monitor-item {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.monitor-label {
  font-size: 0.75rem;
  color: #94a3b8;
}

.monitor-value {
  font-size: 1.1rem;
  font-weight: 700;
  color: #1e293b;
}

.monitor-upgraded {
  color: #10b981;
}

.monitor-subtitle {
  font-size: 0.9rem;
  font-weight: 600;
  color: #334155;
  margin: 1rem 0 0.25rem;
}

.mem-pct {
  font-weight: 600;
}

.mem-pct-ok {
  color: #10b981;
}

.mem-pct-warn {
  color: #f59e0b;
}

.mem-pct-high {
  color: #ef4444;
}

.monitor-never {
  color: #94a3b8;
  font-size: 0.8rem;
}

.monitor-empty {
  padding: 1.25rem;
  text-align: center;
  color: #94a3b8;
  font-size: 0.85rem;
  background: #f8fafc;
  border: 1px dashed #e2e8f0;
  border-radius: 12px;
}

/* ─── 磁盘监控（配额配置页） ─── */
.reclaimable-cell {
  color: #f59e0b;
  font-size: 0.8rem;
}

/* ─── 磁盘扫描（租户卷区块） ─── */
.disk-vol-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.disk-vol-head .monitor-subtitle {
  margin: 0.5rem 0 0;
}

.btn-disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ─── 管理员信息卡 ─── */
.admin-info-card {
  background: linear-gradient(135deg, #6b7bdb 0%, #6c69c2 100%);
  color: white;
  border-radius: 12px;
  padding: 0.875rem 1.25rem;
  margin-bottom: 1rem;
}

.admin-info {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.admin-label {
  font-weight: 600;
  font-size: 0.95rem;
  flex-shrink: 0;
}

.admin-address {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  background: rgba(255, 255, 255, 0.2);
  padding: 0.4rem 0.875rem;
  border-radius: 8px;
  flex: 1;
  font-size: 0.85rem;
  word-break: break-all;
}

.admin-info .btn-danger {
  color: white;
  border-color: rgba(255, 255, 255, 0.4);
  background: rgba(255, 255, 255, 0.12);
  margin-left: 0;
}

.admin-info .btn-danger:hover {
  background: rgba(255, 255, 255, 0.22);
}

/* ─── Docker 状态 ─── */
.docker-status-card {
  padding: 0.875rem 1.25rem;
  border-radius: 12px;
  margin-bottom: 1rem;
  transition: all 0.3s;
  color: white;
}

.docker-status-card.docker-ok {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
}

.docker-status-card.docker-error {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
}

.docker-status {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.status-icon {
  font-size: 1.5rem;
}

.status-info {
  flex: 1;
}

.status-label {
  font-weight: 600;
  font-size: 0.85rem;
  opacity: 0.9;
}

.status-text {
  font-size: 1.05rem;
  font-weight: 700;
}

.status-hint {
  font-size: 0.85rem;
  opacity: 0.9;
  margin-top: 0.25rem;
  flex: 1;
  text-align: right;
}

/* ─── 操作按钮行 ─── */
.action-buttons {
  display: flex;
  gap: 0.75rem;
  margin: 1rem 0;
  flex-wrap: wrap;
}

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

.ops-cell {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
  align-items: center;
}

.ops-cell .btn {
  margin-right: 0;
  padding: 0.25rem 0.625rem;
  font-size: 0.8rem;
}

.badge-secondary {
  background: #64748b;
  color: white;
}

/* ─── CWT 授权管理 ─── */
.cwt-mono {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.82rem;
}

.cwt-empty {
  color: #94a3b8;
  padding: 0.6rem 0;
  font-size: 0.875rem;
}

/* ─── CWT 申请列表：筛选头 + 分页 ─── */
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
  color: #64748b;
}

.cwt-filter select {
  padding: 0.25rem 0.5rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  font-size: 0.82rem;
  color: #334155;
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
  color: #64748b;
}

.cwt-more-hint {
  color: #94a3b8;
}

.cwt-page-btns {
  display: flex;
  gap: 0.4rem;
}

.cwt-token-preview {
  margin-top: 0.4rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.72rem;
  background: #f8fafc;
  border-radius: 8px;
  padding: 0.4rem;
  word-break: break-all;
  max-width: 420px;
  border: 1px solid #f1f5f9;
}

/* ─── 孤儿数据卷 ─── */
.orphan-notice {
  margin-top: 0.6rem;
  font-size: 0.85rem;
  color: #475569;
}

.orphan-list {
  margin-top: 0.6rem;
  list-style: none;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;
}

.orphan-item {
  padding: 0.25rem 0.4rem;
  border-bottom: 1px dashed #f1f5f9;
}

.orphan-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  word-break: break-all;
}

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
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}

.dsh-step-no {
  flex: 0 0 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--brand);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dsh-model-step strong {
  display: block;
  font-size: 0.86rem;
  color: #1e293b;
}

.dsh-model-step p {
  margin: 0.15rem 0 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: #64748b;
}

.dsh-card {
  background: #fff;
  border: 1px solid #e2e8f0;
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
  color: #1e293b;
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
  color: #94a3b8;
}

.dsh-kv code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
  color: #334155;
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
  padding: 0.35rem 0.5rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  font-size: 0.82rem;
  color: #334155;
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
  color: #475569;
  cursor: pointer;
}

.dsh-hint-small {
  margin: 0.6rem 0 0;
  font-size: 0.76rem;
  line-height: 1.5;
  color: #94a3b8;
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
  animation: dsh-spin 0.8s linear infinite;
}

@keyframes dsh-spin {
  to {
    transform: rotate(360deg);
  }
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
  background: #fff;
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
  color: #475569;
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
  color: #94a3b8;
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
  color: #fff;
  font-size: 0.7rem;
  font-weight: 700;
  vertical-align: middle;
}

.dsh-subhead {
  margin: 0.85rem 0 0.35rem;
  font-size: 0.82rem;
  color: #334155;
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
  border-bottom: 1px solid #e2e8f0;
  font-size: 0.75rem;
  font-weight: 600;
  color: #94a3b8;
  white-space: nowrap;
}

.dsh-table td {
  padding: 0.5rem;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: middle;
}

.dsh-addr,
.dsh-img {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  color: #475569;
}

/* 租户实际在跑的 DSH 版本（主列表 + 镜像升级表共用） */
.dsh-ver {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  color: #0f172a;
}

.dsh-ver-stale {
  color: #b45309;
  font-weight: 600;
}

.dsh-ver-tag {
  margin-left: 0.35rem;
}

.dsh-ver-unknown {
  font-size: 0.78rem;
  color: #94a3b8;
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
  background: #f1f5f9;
  color: #64748b;
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
  color: #94a3b8;
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
  color: #64748b;
}

/* 版本历史：镜像是否仍在本地 + 可清理项 */
.dsh-history-hint {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  line-height: 1.5;
  color: #94a3b8;
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
  border-top: 1px solid #e2e8f0;
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
  color: #475569;
}

.dsh-history li {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.35rem 0;
  border-bottom: 1px solid #f1f5f9;
  font-size: 0.8rem;
}

.dsh-muted {
  color: #94a3b8;
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

/* 全局刷新条 */
.refresh-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}
.refresh-hint {
  font-size: 11px;
  color: #94a3b8;
}

/* 缩写地址：悬停用原生 title 显示完整值，光标提示可悬停 */
.address[title],
.cwt-mono[title],
.dsh-addr[title] {
  cursor: help;
}

.dsh-img[title],
.dsh-muted[title] {
  cursor: help;
}
</style>
