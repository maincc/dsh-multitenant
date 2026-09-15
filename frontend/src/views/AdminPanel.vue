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
                <th>{{ $t('admin.colStatus') }}</th>
                <th>{{ $t('admin.colIdle') }}</th>
                <th>{{ $t('admin.colRole') }}</th>
                <th>{{ $t('admin.colOps') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in users" :key="user.address">
                <td>
                  <span class="address">{{ user.address.slice(0, 10) }}...</span>
                </td>
                <td>{{ user.port }}</td>
                <td>
                  <span class="badge" :class="tierBadge(user.tier)">
                    {{ user.tierLabel }}
                  </span>
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
                  <td class="cwt-mono">{{ shortAddr(u.address) }}</td>
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
        <div v-else class="tab-content">
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
                  <td class="cwt-mono">{{ shortAddr(app.parsed?.address) }}</td>
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
                  <td class="cwt-mono">{{ shortAddr(entry.address) }}</td>
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
                  <td class="cwt-mono">{{ shortAddr(rec.address) }}</td>
                  <td>{{ fmtTime(rec.at) }}</td>
                  <td class="cwt-mono">{{ shortAddr(rec.by) }}</td>
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
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import { useI18n } from 'vue-i18n'
import { requestAccounts, signMessage, getPublicKey, watchAccountsChanged } from '../api/wallet.js'

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
    if (dataRefreshInterval) {
      clearInterval(dataRefreshInterval)
      dataRefreshInterval = null
    }
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
      if (dataRefreshInterval) {
        clearInterval(dataRefreshInterval)
        dataRefreshInterval = null
      }
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
        if (dataRefreshInterval) {
          clearInterval(dataRefreshInterval)
          dataRefreshInterval = null
        }
      }
    } catch (err) {
      if (err.response?.status === 403) {
        // 新地址不是管理员，显示无权限页面
        notAdmin.value = true
        isAdmin.value = false
        currentAdminAddress.value = null
        if (dataRefreshInterval) {
          clearInterval(dataRefreshInterval)
          dataRefreshInterval = null
        }
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

      // 启动数据刷新（每 10 秒刷新一次）
      if (dataRefreshInterval) {
        clearInterval(dataRefreshInterval)
      }
      dataRefreshInterval = setInterval(fetchData, 10000)
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
  if (dataRefreshInterval) {
    clearInterval(dataRefreshInterval)
    dataRefreshInterval = null
  }
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

const fetchData = async () => {
  try {
    loading.value = true
    const [usersRes, statsRes] = await Promise.all([
      axios.get('/api/users'),
      axios.get('/api/stats'),
    ])
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
    await axios.post(`/api/user/${address}/remove`, null, {
      params: keepVolume ? { keepVolume: 1 } : {},
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
    await axios.post(`/api/admin/force-stop/${address}`)
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
    await axios.post(`/api/admin/delete-volume/${address}`)
    await fetchData()
    alert(t('admin.volumeDeletedOk'))
  } catch (err) {
    alert(t('admin.removeFail', { err: err.response?.data?.error || err.message }))
  }
}

const promoteUser = async (address) => {
  if (!confirm(t('admin.confirmPromote', { addr: `${address.slice(0, 10)}...` }))) return
  try {
    await axios.post(`/api/admin/promote/${address}`)
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
            dataRefreshInterval = setInterval(fetchData, 10000)
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

onUnmounted(() => {
  // 清理定时器
  if (dataRefreshInterval) {
    clearInterval(dataRefreshInterval)
    dataRefreshInterval = null
  }
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
</style>
