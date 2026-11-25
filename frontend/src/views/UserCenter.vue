<template>
  <div class="user-center">
    <!-- 加载页面 -->
    <div v-if="loading" class="state-card loading-card">
      <div class="loading-spinner">
        <div class="spinner"></div>
      </div>
      <h2>{{ loadingTitle }}</h2>
      <p class="loading-message">{{ loadingMessage }}</p>
      <div class="loading-progress">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: loadingProgress + '%' }"></div>
        </div>
        <span class="progress-text">{{ loadingProgress }}%</span>
      </div>
    </div>

    <!-- 连接钱包页面（桌面专属 2026-11-10：判例·挂机跌落报障——这张全屏卡曾顶掉
         整个移动壳，底部 tab 跟着消失；且它让手机"装 Chrome 扩展"，移动端无从点击。
         移动失联不再换卡：壳常驻，自动回落「我的」tab 用 MobileMe 登录面板恢复。） -->
    <div v-else-if="!connected && !isMobile" class="state-card connect-card">
      <h2>{{ $t('user.connectTitle') }}</h2>
      <p>{{ $t('user.connectHint') }}</p>

      <div v-if="!hasCCDAO" class="error">
        {{ $t('user.noCcdao') }}
        <br />
        <a
          href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ $t('user.installCcdao') }}
        </a>
      </div>

      <button v-else class="btn btn-primary btn-large" @click="connectWallet">
        {{ $t('user.connectBtn') }}
      </button>
    </div>

    <!-- 等待队列页面（桌面专属，同连接卡：移动壳不许被全屏卡顶掉——tab 常驻是
         2026-11-10 报障定下的移动端铁律；移动排队进度由 MobileMe/容器 tab 自述） -->
    <div v-else-if="waiting && !isMobile" class="state-card waiting-card">
      <div class="waiting-icon">⏳</div>
      <h2>{{ $t('user.waitingTitle') }}</h2>
      <p class="waiting-message">{{ $t('user.waitingMsg1') }}</p>
      <p class="waiting-message">{{ $t('user.waitingMsg2') }}</p>

      <div class="queue-info">
        <div class="queue-item">
          <span class="queue-label">{{ $t('user.queuePos') }}</span>
          <span class="queue-value">{{ $t('user.queuePosValue', { n: queuePosition }) }}</span>
        </div>
        <div class="queue-item">
          <span class="queue-label">{{ $t('user.queueTotal') }}</span>
          <span class="queue-value">{{ $t('user.queueTotalValue', { n: queueTotal }) }}</span>
        </div>
        <div class="queue-item">
          <span class="queue-label">{{ $t('user.waitTime') }}</span>
          <span class="queue-value">{{ waitingTime }}</span>
        </div>
      </div>

      <div class="waiting-progress">
        <div class="spinner"></div>
        <span>{{ $t('user.waitCleanup') }}</span>
      </div>

      <button class="btn btn-secondary" @click="cancelWaiting">{{ $t('user.cancelWait') }}</button>
    </div>

    <!-- 用户信息页面：左侧栏 + 右侧内容（与 React 原型稿一致） -->
    <!-- 移动端布局：底部 Tab 导航 -->
    <div v-else-if="isMobile" class="mobile-shell">
      <!-- 移动端内容区 -->
      <div class="mobile-content">
        <!-- 首页 -->
        <div v-if="mobileTab === 'home'" class="mobile-page">
          <MobileHome />
        </div>
        <!-- 容器 -->
        <div v-else-if="mobileTab === 'container'" class="mobile-page">
          <MobileContainer
            :initial-sub="containerInitialSub"
            @sub-consumed="containerInitialSub = ''"
          />
        </div>
        <!-- 技能市场 -->
        <div v-else-if="mobileTab === 'skills'" class="mobile-page">
          <MobileMarket />
        </div>
        <!-- 审批 -->
        <div v-else-if="mobileTab === 'approvals'" class="mobile-page">
          <MobileApprovals />
        </div>
        <!-- 我的（P1 落地 2026-11-10：登录/退出+配额+v1.4 凭证，替换原占位） -->
        <div v-else-if="mobileTab === 'me'" class="mobile-page">
          <MobileMe />
        </div>
      </div>

      <!-- 底部 Tab 导航 -->
      <nav class="mobile-tabbar">
        <button
          class="tab-item"
          :class="{ active: mobileTab === 'home' }"
          @click="mobileTab = 'home'"
        >
          <div class="tab-icon">🏠</div>
          <div class="tab-label">首页</div>
        </button>
        <button
          class="tab-item"
          :class="{ active: mobileTab === 'container' }"
          @click="mobileTab = 'container'"
        >
          <div class="tab-icon">📦</div>
          <div class="tab-label">容器</div>
        </button>
        <button
          class="tab-item"
          :class="{ active: mobileTab === 'skills' }"
          @click="mobileTab = 'skills'"
        >
          <div class="tab-icon">🏪</div>
          <div class="tab-label">市场</div>
        </button>
        <!-- B3（2026-11-10）：审批是管理面，普通用户从装配层移除（桌面侧栏同款基调，
             不再靠后端 403 兜底） -->
        <button
          v-if="role === 'admin'"
          class="tab-item"
          :class="{ active: mobileTab === 'approvals' }"
          @click="mobileTab = 'approvals'"
        >
          <div class="tab-icon">
            ✅
            <span v-if="approvalCount > 0" class="tab-dot"></span>
          </div>
          <div class="tab-label">审批</div>
        </button>
        <button class="tab-item" :class="{ active: mobileTab === 'me' }" @click="mobileTab = 'me'">
          <div class="tab-icon">👤</div>
          <div class="tab-label">我的</div>
        </button>
      </nav>
    </div>

    <!-- 桌面端布局：左侧栏 + 右侧内容 -->
    <div v-else class="gate-shell">
      <!-- 左侧栏 -->
      <aside class="gate-sidebar">
        <div class="sidebar-card">
          <!-- 钱包摘要 -->
          <div class="wallet-summary">
            <span class="live-dot"></span>
            <span class="wallet-label">{{ $t('user.connected') }}</span>
            <code class="wallet-short addr-tip" :data-full="displayAddr">{{ shortAddrText }}</code>
          </div>
          <!-- 导航项（v1.5：管理员页签与用户页签同侧栏并列，中间一条"管理"分组线） -->
          <nav class="sidebar-nav">
            <template v-for="tab in sidebarTabs" :key="tab.key || 'div-' + tab.label">
              <div v-if="tab.divider" class="sidebar-divider">{{ tab.label }}</div>
              <button
                v-else
                class="sidebar-item"
                :class="{ active: activeTab === tab.key }"
                @click="activeTab = tab.key"
              >
                <span class="sidebar-icon" v-html="tab.icon"></span>
                <span>{{ tab.label }}</span>
                <span
                  v-if="badgeFor(tab.subKey)"
                  class="tab-dot"
                  :title="$t('admin.pendingTip', { n: badgeFor(tab.subKey) })"
                ></span>
                <!-- 后台自动拉起指示：容器 tab 右侧小转圈（完成/失败即消失，弹窗收尾） -->
                <span
                  v-if="tab.key === 'container' && containerBooting"
                  class="spin"
                  :title="$t('user.tabBooting')"
                ></span>
              </button>
            </template>
          </nav>
        </div>
      </aside>

      <!-- 右侧内容 -->
      <section class="gate-content">
        <!-- ════════ 账户信息 ════════ -->
        <div v-if="activeTab === 'account'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('user.myAccount') }}</h4>
            <p class="tab-hint">{{ $t('user.accountHint') }}</p>
          </div>
          <div class="stat-rows">
            <div class="stat-row">
              <span class="stat-label">{{ $t('user.swtcAddress') }}</span>
              <code class="stat-value mono addr-tip" :data-full="displayAddr">{{
                shortAddrText
              }}</code>
            </div>
            <!-- v1.5 验收反馈③：账号详情区分管理员/普通用户（判权来自服务端活验证 role） -->
            <div class="stat-row">
              <span class="stat-label">{{ $t('user.roleLabel') }}</span>
              <span
                class="badge"
                :class="role === 'admin' ? 'badge-danger' : 'badge-info'"
                style="align-self: center"
              >
                {{ role === 'admin' ? $t('user.roleAdmin') : $t('user.roleUser') }}
              </span>
            </div>
          </div>

          <UserTabCredential />
        </div>

        <!-- ════════ 模型配置 ════════ -->
        <div v-else-if="activeTab === 'model'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('user.modelConfig') }}</h4>
            <p class="tab-hint">{{ $t('user.modelConfigHint') }}</p>
          </div>
          <div class="key-config">
            <!-- 获取提供方配置的 loading -->
            <div v-if="configLoading" class="config-loading">
              <div class="mini-spinner"></div>
              <span>{{ $t('user.configLoading') }}</span>
            </div>

            <!-- 提供方列表：DeepSeek 官方也是其中一个 item -->
            <template v-else>
              <div
                v-for="(item, idx) in items"
                :key="item.route || `new-${idx}`"
                class="provider-row"
              >
                <div class="row-head">
                  <span class="row-identity">
                    <span class="row-name" :class="{ 'row-name-missing': !item.keyConfigured }">
                      {{ item.displayName }}
                    </span>
                    <span v-if="item.kind === 'custom'" class="row-tag">{{
                      $t('user.customTag')
                    }}</span>
                    <span
                      class="cred-dot"
                      :class="item.keyConfigured ? 'ok' : 'missing'"
                      :title="
                        item.keyConfigured ? $t('user.keyConfigured') : $t('user.keyNotConfigured')
                      "
                    ></span>
                    <span
                      v-if="item.kind === 'official'"
                      class="key-state"
                      :class="item.keyConfigured ? 'ok' : 'missing'"
                    >
                      {{ item.keyConfigured ? $t('user.configured') : $t('user.notConfigured') }}
                    </span>
                  </span>
                  <span class="row-actions">
                    <button class="btn btn-small" @click="toggleExpand(idx)">
                      {{ item.expanded ? $t('user.collapse') : $t('user.edit') }}
                    </button>
                    <button
                      v-if="item.removable"
                      class="btn btn-small btn-danger"
                      :disabled="!connected || keySaving"
                      @click="removeItem(idx)"
                    >
                      {{ $t('user.delete') }}
                    </button>
                  </span>
                </div>

                <div v-if="item.expanded" class="row-body">
                  <input
                    v-if="item.kind === 'custom'"
                    v-model="item.displayName"
                    :placeholder="$t('user.placeholderDisplayName')"
                    :disabled="!connected || keySaving"
                  />
                  <input
                    v-if="item.kind === 'custom'"
                    v-model="item.baseURL"
                    type="text"
                    :placeholder="$t('user.placeholderBaseUrl')"
                    :disabled="!connected || keySaving"
                  />
                  <input
                    v-model="item.apiKey"
                    type="password"
                    :placeholder="
                      item.keyConfigured ? $t('user.placeholderKeyKeep') : $t('user.placeholderKey')
                    "
                    :disabled="!connected || keySaving"
                  />
                  <!-- 官方：可单独删除 key（不影响自定义端点） -->
                  <div
                    v-if="item.kind === 'official' && item.keyConfigured"
                    class="official-key-actions"
                  >
                    <button
                      class="btn btn-small btn-danger"
                      :disabled="!connected || keySaving"
                      @click="clearOfficialKey"
                    >
                      {{ $t('user.deleteOfficialKey') }}
                    </button>
                    <span class="hint">{{ $t('user.deleteOfficialKeyHint') }}</span>
                  </div>
                  <!-- 官方：固定端点 + 默认模型；检测到旧覆盖残留时警告并在保存时清除 -->
                  <div
                    v-if="item.kind === 'official'"
                    class="override-warning"
                    v-show="item.officialOverride"
                  >
                    {{ $t('user.officialOverrideWarn') }}
                    <span v-if="item.officialBaseURL" class="override-url">{{
                      item.officialBaseURL
                    }}</span>
                    {{ $t('user.officialOverrideTail') }}
                    <code>https://api.deepseek.com</code>
                  </div>
                  <div v-if="item.kind === 'official'" class="hint">
                    {{ $t('user.officialEndpointHint') }}
                  </div>
                  <div v-if="item.kind === 'custom'" class="models-editor">
                    <div class="models-header">
                      <span>{{ $t('user.modelsTitle') }}</span>
                      <button
                        class="btn btn-small"
                        :disabled="!connected || keySaving || discovering === idx || !item.baseURL"
                        @click="discoverItem(idx)"
                      >
                        {{ discovering === idx ? $t('user.discovering') : $t('user.discoverBtn') }}
                      </button>
                    </div>
                    <div v-if="!item.baseURL" class="hint">
                      {{ $t('user.discoverHint') }}
                    </div>
                    <table v-if="item.baseURL" class="models-table">
                      <thead>
                        <tr>
                          <th>{{ $t('user.colModelId') }}</th>
                          <th>{{ $t('user.colName') }}</th>
                          <th>{{ $t('user.colContext') }}</th>
                          <th>{{ $t('user.colMaxTokens') }}</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(m, mi) in item.models" :key="mi">
                          <td><input v-model="m.id" placeholder="model-id" /></td>
                          <td>
                            <input
                              v-model="m.name"
                              :placeholder="$t('user.placeholderModelName')"
                            />
                          </td>
                          <td>
                            <input
                              v-model.number="m.contextWindow"
                              type="number"
                              min="1"
                              placeholder="128000"
                            />
                          </td>
                          <td>
                            <input
                              v-model.number="m.maxTokens"
                              type="number"
                              min="1"
                              placeholder="8192"
                            />
                          </td>
                          <td>
                            <button class="btn btn-small btn-danger" @click="removeModel(idx, mi)">
                              ✕
                            </button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <button
                      class="btn btn-small"
                      :disabled="!connected || keySaving"
                      @click="addModel(idx)"
                    >
                      {{ $t('user.addModel') }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- 添加提供方 -->
              <div class="add-actions">
                <button
                  class="btn btn-small"
                  :disabled="!connected || keySaving || customCount >= 20"
                  @click="addItem"
                >
                  {{ $t('user.addEndpoint') }}
                </button>
              </div>
            </template>

            <div class="action-buttons">
              <button
                class="btn btn-primary"
                :disabled="!connected || keySaving"
                @click="saveConfig"
              >
                {{ keySaving ? $t('user.saving') : $t('user.saveConfig') }}
              </button>
              <button
                class="btn btn-danger"
                :disabled="!connected || keySaving || !hasAnyConfig"
                @click="resetConfig"
              >
                {{ $t('user.resetConfig') }}
              </button>
            </div>
            <div class="action-hints">
              <div class="hint">
                <strong>{{ $t('user.saveFlowTitle') }}</strong>
                {{ $t('user.saveFlow') }}
              </div>
              <div class="hint">
                <strong>{{ $t('user.discoverFlowTitle') }}</strong>
                {{ $t('user.discoverFlow') }}
              </div>
              <div class="hint">
                <strong>{{ $t('user.resetFlowTitle') }}</strong>
                {{ $t('user.resetFlow') }}
              </div>
            </div>
          </div>
        </div>

        <!-- ════════ 容器管理 ════════ -->
        <div v-else-if="activeTab === 'container'" class="tab-content">
          <div class="tab-head">
            <h4>{{ $t('user.containerManage') }}</h4>
            <p class="tab-hint">{{ $t('user.containerManageHint') }}</p>
          </div>
          <!-- 容器管理页顶三段页签（用户裁定 2026-11-02：与市场品类 pill 同款）：
               原一页竖堆 容器信息/我的技能/环境现场 三段，翻到底上传之苦——现在点一段看一段。
               v-show 互斥非卸载：向导在途草稿、技能列表状态翻页不丢。 -->
          <div class="action-buttons container-subtabs">
            <button
              class="btn btn-small"
              :class="cSub === 'info' ? 'btn-primary' : 'btn-secondary'"
              @click="cSub = 'info'"
            >
              {{ $t('user.subTabInfo') }}
            </button>
            <button
              class="btn btn-small"
              :class="cSub === 'skills' ? 'btn-primary' : 'btn-secondary'"
              @click="cSub = 'skills'"
            >
              {{ $t('user.tabSkillsPlugins') }}
            </button>
            <button
              class="btn btn-small"
              :class="cSub === 'env' ? 'btn-primary' : 'btn-secondary'"
              @click="cSub = 'env'"
            >
              {{ $t('user.subTabEnv') }}
            </button>
          </div>
          <div v-show="cSub === 'info'">
            <!-- 容器信息（原在账户信息）：端口/配额/状态/资源使用都归容器 -->
            <div class="stat-rows">
              <div class="stat-row">
                <span class="stat-label">{{ $t('user.port') }}</span>
                <code class="stat-value mono">{{ userInfo.port }}</code>
              </div>
              <div class="stat-row">
                <span class="stat-label">{{ $t('user.tier') }}</span>
                <span class="badge" :class="tierBadge(userInfo.tier)">{{
                  userInfo.tierLabel
                }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">{{ $t('user.containerStatus') }}</span>
                <span class="badge" :class="statusBadge(userInfo.status)">{{
                  statusText(userInfo.status)
                }}</span>
                <button
                  v-if="userInfo.status !== 'running'"
                  class="btn btn-small btn-success"
                  :disabled="containerBooting"
                  :title="containerBooting ? $t('user.tabBooting') : ''"
                  @click="restartContainer"
                >
                  {{ $t('user.startContainer') }}
                </button>
              </div>
            </div>

            <div v-if="userInfo.stats" class="resource-usage">
              <div class="resource-item">
                <div class="resource-header">
                  <span>{{ $t('user.cpuUsage') }}</span>
                  <span class="mono">{{ userInfo.stats.cpu }}</span>
                </div>
              </div>
              <div class="resource-item">
                <div class="resource-header">
                  <span>{{ $t('user.memUsage') }}</span>
                  <span class="mono"
                    >{{ userInfo.stats.memory }} ({{ userInfo.stats.memoryPercent }})</span
                  >
                </div>
                <div class="progress-bar">
                  <div class="progress-fill" :style="{ width: userInfo.stats.memoryPercent }"></div>
                </div>
              </div>
            </div>
            <div v-else class="loading">{{ $t('user.noData') }}</div>

            <div class="tab-divider" />

            <!-- 进入容器入口（连同容器状态/端口/配额/资源使用一起，均已从账户信息迁来） -->
            <div class="enter-box">
              <div class="enter-info">
                <div class="enter-title">{{ $t('user.enterDsh') }}</div>
                <div class="enter-hint">{{ $t('user.enterDshHint') }}</div>
              </div>
              <button class="btn btn-primary btn-enter" @click="enterDsh">
                {{ $t('user.openDsh') }}
              </button>
            </div>

            <div class="tab-divider" />

            <div class="action-buttons">
              <button class="btn btn-primary" @click="restartDSH">
                {{ $t('user.restartDsh') }}
              </button>
              <button
                class="btn btn-secondary"
                :disabled="!connected || userInfo.status !== 'running'"
                @click="stopContainer"
              >
                {{ $t('user.stopContainer') }}
              </button>
              <button class="btn btn-danger" @click="resetContainer">
                {{ $t('user.resetContainer') }}
              </button>
            </div>
            <div class="action-hints">
              <div class="hint">
                <strong>{{ $t('user.restartDshFlowTitle') }}</strong>
                {{ $t('user.restartDshFlow') }}
              </div>
              <div class="hint">
                <strong>{{ $t('user.stopFlowTitle') }}</strong>
                {{ $t('user.stopFlow') }}
                {{ usageInfoLabel ? $t('user.todayUsagePrefix') + usageInfoLabel : '' }}
              </div>
              <div class="hint">
                <strong>{{ $t('user.resetFlowTitle') }}</strong>
                {{ $t('user.resetContainerFlow') }}
              </div>
            </div>
          </div>

          <div v-show="cSub === 'skills'">
            <div class="tab-head">
              <h4>{{ $t('user.mySkills') }}</h4>
              <p class="tab-hint">{{ $t('user.mySkillsHint') }}</p>
            </div>
            <!-- 按钮行只放按钮（用户反馈 2026-11-02 挤一行别扭）：解释文案归上方
                 tab-hint 唯一一处——原先行尾重复挂了一遍，删 -->
            <div class="action-buttons skill-actions">
              <button class="btn btn-primary" @click="openImportDialog">
                {{ $t('user.importSkill') }}
              </button>
              <button class="btn btn-secondary" @click="openShareDialog">
                {{ $t('user.shareSkill') }}
              </button>
            </div>

            <div v-if="mySkillsLoading" class="config-loading">
              <div class="mini-spinner"></div>
              <span>{{ $t('user.mySkillsLoading') }}</span>
            </div>
            <template v-else>
              <div v-if="mineData.published.length > 0" class="skill-subsection">
                <h3>{{ $t('user.myPublished') }}</h3>
                <div v-for="s in mineData.published" :key="'p-' + s.name" class="skill-row">
                  <div class="skill-row-main">
                    <strong>{{ s.name }}</strong>
                    <span class="skill-desc">{{ s.description }}</span>
                  </div>
                  <button class="btn btn-small btn-danger" @click="unpublishSkill(s.name)">
                    {{ $t('user.unpublish') }}
                  </button>
                </div>
              </div>
              <div v-if="mineData.installed.length > 0" class="skill-subsection">
                <h3>{{ $t('user.myInstalled') }}</h3>
                <p v-if="mineData.unverified" class="skill-desc">{{ $t('user.unverifiedNote') }}</p>
                <div v-for="s in mineData.installed" :key="'i-' + s.name" class="skill-row">
                  <div class="skill-row-main">
                    <strong>{{ s.name }}</strong>
                    <span class="skill-desc">
                      {{
                        s.description ||
                        (s.installedAt
                          ? $t('user.installedSource', {
                              source: s.source,
                              date: new Date(s.installedAt).toLocaleString(),
                            })
                          : $t('user.installedFromVolume'))
                      }}
                    </span>
                    <span v-if="s.hasUpdate" class="badge badge-warning">{{
                      $t('user.hasUpdate')
                    }}</span>
                  </div>
                  <button class="btn btn-small btn-danger" @click="uninstallSkill(s.name)">
                    {{ $t('user.uninstall') }}
                  </button>
                </div>
              </div>
              <p
                v-if="mineData.published.length === 0 && mineData.installed.length === 0"
                class="hint"
              >
                {{ $t('user.noSkillsHint') }}
              </p>
              <!-- 插件实物小节（判例 55：无账、以卷为断）：探针取法与技能同船；
                   null=查不了（≠没了，话术分明）；只陈列不配删钮——插件退场语义
                   归「回退/环境」侧，此处不开第二把刀 -->
              <div class="skill-subsection">
                <h3>{{ $t('user.pluginsTitle') }}</h3>
                <p v-if="mineData.plugins === null" class="skill-desc">
                  {{ $t('user.pluginsUnprobed') }}
                </p>
                <p v-else-if="mineData.plugins.length === 0" class="skill-desc">
                  {{ $t('user.pluginsEmpty') }}
                </p>
                <div v-for="pl in mineData.plugins || []" :key="'pl-' + pl.name" class="skill-row">
                  <div class="skill-row-main">
                    <strong>{{ pl.name }}</strong>
                    <span v-if="pl.version" class="badge badge-info">v{{ pl.version }}</span>
                    <span class="skill-desc">{{ pl.description || $t('user.pluginNoDesc') }}</span>
                    <span class="skill-desc">
                      {{
                        $t('user.pluginMeta', {
                          kind:
                            pl.kind === 'file' ? $t('user.pluginFileTag') : $t('user.pluginDirTag'),
                          files: pl.fileCount,
                          size: formatBytes(pl.bytes),
                        })
                      }}
                    </span>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <div v-show="cSub === 'env'">
            <!-- ════════ 环境·我的现场（货架/选用在「市场」的环境品类）════════ -->
            <div class="tab-head">
              <h4>{{ $t('env.mineSectionTitle') }}</h4>
              <p class="tab-hint">{{ $t('env.mineSectionHint') }}</p>
            </div>
            <EnvTemplatesUser mode="mine" @mine-changed="loadMine" />
          </div>
        </div>

        <!-- ════════ 我的技能 ════════ -->
        <!-- ════════ v1.5 管理员页签（验收反馈①：与用户页签平级并列，无嵌套壳）════════
             role='admin'（官网活验证属实）才装配；内嵌复用独立版 AdminPanel（源码不合并，
             同一组件两用：externalTab 驱动子页、自带侧栏隐藏）。操作仍要登录会话+当场签名
             签名——tab 可见=凭证判权，可操作=会话+钱包双门禁（刀2B 模型一字不松） -->
        <div v-else-if="isSystemTab" class="tab-content admin-embed">
          <AdminPanel embedded :external-tab="systemSubTab" />
        </div>

        <div v-else class="tab-content">
          <div class="action-buttons">
            <button
              class="btn btn-small"
              :class="marketCat === 'skills' ? 'btn-primary' : 'btn-secondary'"
              @click="marketCat = 'skills'"
            >
              {{ $t('env.catSkills') }}
            </button>
            <button
              class="btn btn-small"
              :class="marketCat === 'env' ? 'btn-primary' : 'btn-secondary'"
              @click="marketCat = 'env'"
            >
              {{ $t('env.catEnv') }}
            </button>
          </div>
          <SkillMarket v-if="marketCat === 'skills'" embedded external-tab="market" />
          <EnvTemplatesUser v-if="marketCat === 'env'" mode="market" />
        </div>
      </section>

      <!-- 导入技能对话框 -->
      <div v-if="importDialogOpen" class="import-mask" @click.self="closeImportDialog">
        <div class="import-panel">
          <h3>{{ $t('user.importDialogTitle') }}</h3>
          <p class="hint">
            {{ $t('user.importDialogHint') }}
          </p>
          <div class="import-field">
            <label>{{ $t('user.importFileLabel') }}</label>
            <input type="file" accept=".md,.txt,text/markdown" @change="onImportFile" />
          </div>
          <div class="import-field">
            <label>{{ $t('user.importNameLabel') }}</label>
            <input v-model="importName" placeholder="my-skill" />
          </div>
          <div class="import-field">
            <label>{{ $t('user.importTextLabel') }}</label>
            <textarea
              v-model="importText"
              rows="8"
              placeholder="---&#10;name: my-skill&#10;description: 一句话说明&#10;---&#10;正文…"
            ></textarea>
          </div>
          <div v-if="importBusy" class="loading">{{ $t('user.submitting') }}</div>
          <div class="action-buttons">
            <button class="btn btn-primary" :disabled="importBusy" @click="doImport">
              {{ $t('user.importSubmit') }}
            </button>
            <button class="btn btn-secondary" :disabled="importBusy" @click="closeImportDialog">
              {{ $t('user.cancel') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 共享容器内技能对话框 -->
      <div v-if="shareDialogOpen" class="import-mask" @click.self="closeShareDialog">
        <div class="import-panel">
          <h3>{{ $t('user.shareDialogTitle') }}</h3>
          <p class="hint">
            {{ $t('user.shareDialogHint1') }}
            <br />
            {{ $t('user.shareDialogHint2') }}
          </p>
          <div class="import-field">
            <label>{{ $t('user.shareSelectLabel') }}</label>
            <select
              v-model="shareSourceName"
              :disabled="shareLoading || shareConflict || shareBusy"
            >
              <option value="" disabled>
                {{ shareLoading ? $t('user.shareLoadingList') : $t('user.shareSelectPlaceholder') }}
              </option>
              <option v-for="n in mineData.inContainer" :key="n" :value="n">{{ n }}</option>
            </select>
          </div>
          <div v-if="shareLoading" class="config-loading">
            <div class="mini-spinner"></div>
            <span>{{ $t('user.shareLoading') }}</span>
          </div>
          <div v-else-if="mineData.inContainer.length === 0" class="hint share-empty-hint">
            {{ $t('user.shareEmptyHintA') }}
            <code>/dsh-home/skills/</code>{{ $t('user.shareEmptyHintB') }}
          </div>
          <div v-if="shareConflict" class="import-field share-conflict">
            <label>{{ $t('user.shareConflictLabel') }}</label>
            <input v-model="shareRenameTo" placeholder="my-skill-v2" />
            <span class="hint">{{ $t('user.shareConflictHint') }}</span>
          </div>
          <div v-if="shareBusy" class="loading">{{ $t('user.submitting') }}</div>
          <div class="action-buttons">
            <button
              class="btn btn-primary"
              :disabled="shareBusy || !shareSourceName"
              @click="doShare"
            >
              {{ shareConflict ? $t('user.shareWithRename') : $t('user.shareSubmit') }}
            </button>
            <button class="btn btn-secondary" :disabled="shareBusy" @click="closeShareDialog">
              {{ $t('user.cancel') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { askConfirm, toast } from '../composables/useDialog'
import { useIsMobile } from '../composables/useIsMobile.js'
import { bindUserCredHost, useUserCred } from '../composables/useUserCred.js'
import UserTabCredential from '../components/user/UserTabCredential.vue'
import { ref, onMounted, onUnmounted, computed, watch, defineAsyncComponent } from 'vue'
import { useAdminBadges, startAdminBadges, stopAdminBadges } from '../composables/useAdminBadges'
const { badgeFor } = useAdminBadges()
// 红点节拍起停的组件侧凭证：防角色状态反复刷新叠加引用计数（起一次=守一次）
let badgesStarted = false
import axios from 'axios'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { skillsApi } from '../api/skills.js'
import { sha256Hex as sha256HexFallback } from '../utils/sha256.js'
import AdminPanel from './AdminPanel.vue'
import EnvTemplatesUser from '../components/EnvTemplatesUser.vue'
// T5 移动 chunk 拆分（2026-11-10）：五个移动组件按 isMobile 条件渲染，改 defineAsyncComponent
// 懒加载——桌面首屏 chunk 不再打包移动全量（~数百行），移动侧单独异步包。切换首帧由
// 各组件自带 loading spinner 兜底（无感）；判权/签名链与同步 import 逐字节一致，仅装载时机变。
const MobileHome = defineAsyncComponent(() => import('./mobile/MobileHome.vue'))
const MobileContainer = defineAsyncComponent(() => import('./mobile/MobileContainer.vue'))
const MobileMarket = defineAsyncComponent(() => import('./mobile/MobileMarket.vue'))
const MobileApprovals = defineAsyncComponent(() => import('./mobile/MobileApprovals.vue'))
const MobileMe = defineAsyncComponent(() => import('./mobile/MobileMe.vue'))
// B2 清理（2026-11-10）：MobileSkills 系孤儿组件（import 未挂载，且其无签名 API 与后端
// 签名要求分叉）。P2 移动发布链路改在 MobileContainer 另建（走 signChallenge+skillsApi
// 真签名口径），旧孤儿文件已于 P2 删除——双实现收敛完毕，不再留"暂留"尾巴。
import SkillMarket from './SkillMarket.vue'
import { buildAdminTabs } from '../admin-tabs'
import {
  requestAccounts,
  signMessage,
  getPublicKey,
  signFileBytes,
  getIpfsPublicKey,
  watchAccountsChanged,
  friendlyPluginError,
} from '../api/wallet.js'
import { signConnectPlugin, buildConnectUrl } from '../api/connect.js'
import { formatBytes, shortAddress } from '../utils/format.js'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

// ---- 移动端检测（T3 收敛 2026-11-10：走全站单例，旧本地 ref+resize 监听已摘） ----
const isMobile = useIsMobile()
const mobileTab = ref('home') // home/container/skills/approvals/me
// 移动深链→容器子页签的一次性接力（applyMobileTabLink 写入，MobileContainer 挂载
// 消费后经 sub-consumed 清空——不清的话用户再点「容器」top tab 重挂载会误跳子页）
const containerInitialSub = ref('')

// ---- 移动深链消费（B1 修复 2026-11-10）----
// MobileHome 管理员 8 宫格 push 的 /user?tab=adm:* 过去只被桌面侧栏 activeTab 消费，
// 移动壳根本不读 query——八条快捷全成死链（全景报告 B1）。现在移动壳消费同款深链，
// 落定即清 query（同一条目重复点击可重放）。角色未定时先寄存、credential-status 回落后
// 消费——防把"还在查角色"误判成"不是管理员"。注意 roleSettled / mobileDeepLinkPending
// 与 initialTabApplied 同款刻意用裸非响应值（2026-10-23"裸布尔按 ref 用"判例在前）。
let roleSettled = false
let mobileDeepLinkPending = null

function applyMobileTabLink(s) {
  const str = String(s)
  const isAdm = str.startsWith('adm:') || str === 'system'
  if (isAdm && role.value !== 'admin') toast(t('user.adminEntryLocked'))
  else if (isAdm && /approval|cred|cwt|env/i.test(str)) mobileTab.value = 'approvals'
  else if (isAdm) toast('该管理功能移动端暂未提供，请在 PC 端使用')
  else if (str === 'account' || str === 'me') mobileTab.value = 'me'
  else if (str === 'market') mobileTab.value = 'skills'
  // 模型配置是**用户域**功能（桌面侧栏 key:'model' 人人可见；管理注册表 admin-tabs.js
  // 从未有 model——首页八宫格旧链 adm:model 是幻影键：移动 toast 谎称"PC 才有"，桌面
  // 直落空白页签）。2026-11-11 裁定模型配置上移动端后，此处正链为 tab=model：
  // 落容器 tab 并穿透到「模型配置」子页签（initial-sub 一次性消费，见 MobileContainer）。
  else if (str === 'model') {
    mobileTab.value = 'container'
    containerInitialSub.value = 'model'
  } else if (['home', 'container', 'skills', 'approvals'].includes(str)) mobileTab.value = str
  router.replace({ query: {} })
}

watch(
  () => route.query.tab,
  (q) => {
    if (!isMobile.value || !q) return
    if (!roleSettled) {
      mobileDeepLinkPending = String(q)
      return
    }
    applyMobileTabLink(String(q))
  },
)

// 计算待审批总数（环境模板 + CWT 申请）
const approvalCount = computed(() => badgeFor('envtpl') + badgeFor('cred'))

// ---- 侧栏导航（与 React 原型稿一致） ----
// 落地页 = 容器管理：多数操作（进入 DSH、启停、资源查看）都发生在这里，
// 账户信息只剩地址一项，不该默认挡在前面。
// v1.5 用户验收②修订：进用户中心**不再自动建容器**，容器可能不存在——
// 首屏停在"容器管理"会直面一片未就绪；改默认「账户信息」（凭证/角色第一眼看，反馈③）。
const activeTab = ref('account')
// 市场页签内品类（用户终审 IA）：市场=挑（技能/环境）；容器管理=经营（定格/显示/回退/技能装卸）
const marketCat = ref('skills')
// 容器管理页三段页签（info/skills/env）；默认容器信息=原第一屏
const cSub = ref('info')
// v1.5 刀5C：判权面（credential-status 的 role，服务端活验证 admin 凭证属实才为 'admin'）。
// tab 注册表按 role 装配——管理页签对普通用户不存在（数据面砍掉，不是 CSS 隐藏）；
// 对管理员则与用户页签**平级并列**（验收反馈①：消灭"系统管理"嵌套壳，同一侧栏）。
const role = ref('user')
const sidebarTabs = computed(() => {
  const tabs = [
    {
      key: 'account',
      label: t('user.tabAccount'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
    },
    {
      key: 'model',
      label: t('user.tabModel'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="17" r="4"/><path d="M10.6 13.4L21 3"/><path d="M19 5l2 2"/><path d="M15 9l2 2"/></svg>',
    },
    {
      key: 'container',
      label: t('user.tabContainer'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/></svg>',
    },
    {
      key: 'skills',
      label: t('user.tabSkills'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    },
  ]
  if (role.value === 'admin') {
    // 管理页签与用户页签同一侧栏并列（key 前缀 adm: 防碰撞；子页 key 见 subKey）
    tabs.push({ divider: true, label: t('user.adminGroup') })
    tabs.push(...buildAdminTabs(t, 'adm:'))
  }
  return tabs
})
const isSystemTab = computed(() => activeTab.value.startsWith('adm:'))
const systemSubTab = computed(() => (isSystemTab.value ? activeTab.value.slice(4) : 'overview'))
let initialTabApplied = false

const shortAddrText = computed(() => {
  const a = displayAddr.value
  return a ? `${a.slice(0, 12)}…${a.slice(-4)}` : ''
})

const connected = ref(false)
// 挂机跌落兜底（2026-11-10 报障"长时间不管底部 tab 消失"）：移动失联不再换全屏卡
// （模板两处 !isMobile），tab 壳常驻；失联瞬间自动回落「我的」——MobileMe 登录
// 面板是移动端唯一重登录门（桌面那张卡让手机装 Chrome 扩展，本来就点不动）。
watch(connected, (v) => {
  if (!v && isMobile.value) mobileTab.value = 'me'
})
const connecting = ref(false)
const hasCCDAO = ref(false)
const userInfo = ref({})
// 地址展示统一为钱包原始大小写形态（内部匹配/台账主键仍是小写，不动语义）
const pluginCaseAddr = ref(localStorage.getItem('swtc_plugin_case') || '')
const displayAddr = computed(
  () =>
    pluginCaseAddr.value || userInfo.value.address || localStorage.getItem('swtc_address') || '',
)
function rememberPluginCase(a) {
  if (a && typeof a === 'string' && /[A-Z]/.test(a)) {
    pluginCaseAddr.value = a
    localStorage.setItem('swtc_plugin_case', a)
  }
}

const { loadCredentialStatus, credInfo, credVc, credApp, credNoDid } = useUserCred()
bindUserCredHost({
  loginOnly,
  currentAddress,
  pluginCaseAddr,
  rememberPluginCase,
  connected,
})
const usageInfo = ref(null)
const waiting = ref(false)
const queuePosition = ref(0)
const queueTotal = ref(0)
const waitingSince = ref(0)

// ---- 每日使用时限展示（非 CWT 授权用户受每日分钟数限制）----
const usageInfoLabel = computed(() => {
  const u = usageInfo.value
  if (!u) return ''
  if (!u.enabled) return t('user.usageUnlimited')
  if (u.exempt) return t('user.usageExempt')
  return t('user.usageToday', { used: u.usedMinutes, total: u.dailyMinutes })
})

const loginAttempted = ref(false)
const walletLogin = async (address) => {
  const pluginAddress = await requestAccounts()
  rememberPluginCase(pluginAddress)
  const target =
    (address || '').toLowerCase() === pluginAddress.toLowerCase() ? address : pluginAddress
  const ch = await axios.post('/api/user/wallet-login-challenge', { address: target })
  const { nonce, message } = ch.data
  const signature = await signMessage(pluginAddress, message)
  const publicKey = await getPublicKey(pluginAddress)
  await axios.post('/api/user/wallet-login', {
    address: pluginAddress,
    nonce,
    signature,
    publicKey,
  })
  return pluginAddress
}

const fetchUsage = async (address) => {
  try {
    const res = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)
    usageInfo.value = res.data.usage || null
    // 隐私门分支（无 tier 字段）且还没试过 → 静默签名登录一次再刷新
    if (res?.data?.exists === true && !('tier' in res.data) && !loginAttempted.value && address) {
      loginAttempted.value = true
      try {
        await walletLogin(address)
        await fetchUsage(address)
        loadCredentialStatus(address)
        return
      } catch {
        /* 保持"需要重新登录"提示，按钮手动兜底 */
      }
    }
  } catch {
    usageInfo.value = null
  }
}

// ---- 模型配置（钱包签名验证身份后写入自己的租户卷）----
// items：每个提供方一个 item；DeepSeek 官方也是其中一个（不可删除）
// { kind: 'official'|'custom', route?, displayName, baseURL, models, apiKey, keyConfigured, removable, expanded }
const items = ref([])
const keySaving = ref(false)
const discovering = ref(null) // 正在探测的 item 下标
const configLoading = ref(false) // 获取提供方配置的 loading

const currentAddress = () => userInfo.value.address || localStorage.getItem('swtc_address')

const customCount = computed(() => items.value.filter((i) => i.kind === 'custom').length)
const hasAnyConfig = computed(
  () => items.value.some((i) => i.keyConfigured) || items.value.some((i) => i.kind === 'custom'),
)

/** 自定义 provider route -> 凭据引用名（与服务端一致） */
const credentialRefFor = (route) =>
  `${String(route)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')}_API_KEY`

const fetchConfigStatus = async () => {
  const address = currentAddress()
  if (!address) return
  configLoading.value = true
  try {
    const res = await axios.get(`/api/user/tenant-config?address=${encodeURIComponent(address)}`)
    // 官方 item：不再编辑 baseURL/models；检测旧覆盖残留（保存时自动清除）
    const officialOverride = !!(res.data.baseURL || (res.data.models && res.data.models.length > 0))
    items.value = [
      {
        kind: 'official',
        route: 'deepseek-official',
        displayName: 'DeepSeek 官方',
        baseURL: '',
        models: [],
        apiKey: '',
        keyConfigured: !!res.data.apiKeyConfigured,
        removable: false,
        expanded: true,
        officialOverride,
        officialBaseURL: res.data.baseURL || '',
      },
      ...(Array.isArray(res.data.providers)
        ? res.data.providers.map((p) => ({
            kind: 'custom',
            route: p.route,
            displayName: p.displayName || '',
            baseURL: p.baseURL || '',
            models: Array.isArray(p.models)
              ? p.models.map((m) => ({
                  id: m.id || '',
                  name: m.name || '',
                  contextWindow: m.contextWindow,
                  maxTokens: m.maxTokens,
                }))
              : [],
            apiKey: '',
            keyConfigured: !!p.keyConfigured,
            removable: true,
            expanded: false,
          }))
        : []),
    ]
  } catch {
    items.value = []
  } finally {
    configLoading.value = false
  }
}

const toggleExpand = (idx) => {
  items.value[idx].expanded = !items.value[idx].expanded
}

const addItem = () => {
  if (customCount.value >= 20) return toast(t('user.limitEndpoints'))
  items.value.push({
    kind: 'custom',
    route: undefined,
    displayName: '',
    baseURL: '',
    models: [],
    apiKey: '',
    keyConfigured: false,
    removable: true,
    expanded: true,
  })
}

const removeItem = async (idx) => {
  const item = items.value[idx]
  await askConfirm({
    message: t('user.confirmRemoveEndpoint', { name: item.displayName || t('user.unnamed') }),
    run: () => items.value.splice(idx, 1),
  })
}

const addModel = (idx) => {
  items.value[idx].models.push({ id: '', name: '', contextWindow: undefined, maxTokens: undefined })
}

const removeModel = (idx, mi) => {
  items.value[idx].models.splice(mi, 1)
}

/**
 * 钱包签名挑战-响应：先取插件当前账户 → 领 nonce → 插件签名 + 取公钥。
 *
 * 【挑战池按用途隔离】后端只在发放时的 purpose 池里消费，借错池必报
 * "挑战无效或已过期"——
 *   - 租户配置操作（保存/清除/重置/模型发现）→ 默认 '/api/user/config-challenge'
 *   - 技能操作（mine/import/unpublish/uninstall/publish）→ '/api/skills/challenge'
 *
 * 关键：签名对象必须用插件【当前选中的账户】，否则插件会以
 * "The requested account and/or method has not been authorized" 拒绝
 * （源码：swtc_signMessage 检查 accounts.includes(from)）。
 * 返回的 address 即插件当前账户，后续提交/清除都用它（写的是该账户自己的卷）。
 */
const signChallenge = async (challengeUrl = '/api/user/config-challenge') => {
  if (!window.ccdao || !window.ccdao.request) {
    throw new Error(t('user.errNoCcdao'))
  }
  // 1. 插件当前账户【保留原始大小写】！
  //    插件的 accounts.includes() 是大小写敏感严格匹配：把 jNDwRet... 转成
  //    jndwret... 再传回去会被判"未授权"(4100)。只有 requestAccounts 原样
  //    返回的字符串才能通过。后端 normalizeAddress 会自己转小写，无需担心。
  const pluginAddress = await requestAccounts()
  rememberPluginCase(pluginAddress)
  // 2. 领一次性挑战（响应含 message：服务端构造的用途绑定被签内容）
  const challengeRes = await axios.post(challengeUrl, { address: pluginAddress })
  const { nonce, message } = challengeRes.data
  // 3. 插件对 **message** 签名 + 取公钥（都用原始大小写地址）。
  //    签的是用途绑定消息（hex），不是裸 nonce —— 跨端点凭证混淆加固。
  const signature = await signMessage(pluginAddress, message)
  const publicKey = await getPublicKey(pluginAddress)
  return { address: pluginAddress, nonce, signature, publicKey }
}

/** 保存/清除成功后，把插件当前账户同步到页面与 localStorage */
const syncWalletAccount = async (address) => {
  const normalized = String(address).toLowerCase()
  localStorage.setItem('swtc_address', normalized)
  if (userInfo.value.address !== normalized) {
    userInfo.value = { ...userInfo.value, address: normalized }
    await fetchUserInfo(normalized)
  }
  fetchConfigStatus()
}

/**
 * 把 CCDAO 插件的未授权错误转成可操作的提示。
 * 插件对每个网站（origin）单独授权，且 swtc_signMessage 不会自动触发授权
 * （源码确认：signMessage 直接验签，无授权/解锁流程）。
 */

/** 模型行校验：id 非空且唯一 */
const validateModelRows = (models) => {
  const rows = (models || []).filter((m) => m.id && String(m.id).trim())
  const ids = new Set(rows.map((m) => String(m.id).trim()))
  if (ids.size !== rows.length) return { ok: false, msg: t('user.errModelIdDup') }
  for (const m of rows) {
    if (m.contextWindow && (typeof m.contextWindow !== 'number' || m.contextWindow < 1)) {
      return { ok: false, msg: t('user.errCwInvalid', { id: m.id }) }
    }
    if (m.maxTokens && (typeof m.maxTokens !== 'number' || m.maxTokens < 1)) {
      return { ok: false, msg: t('user.errMtInvalid', { id: m.id }) }
    }
  }
  return { ok: true }
}

/** 整体校验：每个 item（官方 key 长度、自定义显示名/baseURL/模型） */
const validateAll = () => {
  const seenNames = new Set()
  for (const item of items.value) {
    if (item.apiKey && item.apiKey.length > 4096) {
      return { ok: false, msg: t('user.errKeyTooLong') }
    }
    if (item.kind === 'custom') {
      const name = (item.displayName || '').trim()
      if (!name) return { ok: false, msg: t('user.errNeedName') }
      if (name.length > 64) return { ok: false, msg: t('user.errNameTooLong') }
      if (seenNames.has(name)) return { ok: false, msg: t('user.errNameDup', { name }) }
      seenNames.add(name)
      if (!/^https?:\/\//.test(item.baseURL || '')) {
        return { ok: false, msg: t('user.errBadBaseUrl', { name }) }
      }
    } else if (item.baseURL && !/^https?:\/\//.test(item.baseURL)) {
      return { ok: false, msg: t('user.errOfficialBaseUrl') }
    }
    const check = validateModelRows(item.models)
    if (!check.ok) return { ok: false, msg: `${item.displayName}：${check.msg}` }
  }
  return { ok: true }
}

const saveConfig = async () => {
  if (!currentAddress()) return toast(t('user.errConnectFirst'))
  const check = validateAll()
  if (!check.ok) return toast(check.msg)

  keySaving.value = true
  try {
    const { address, nonce, signature, publicKey } = await signChallenge()
    const official = items.value.find((i) => i.kind === 'official')
    const payload = {
      address,
      nonce,
      signature,
      publicKey,
      providers: items.value
        .filter((i) => i.kind === 'custom')
        .map((p) => ({
          // 已有 route 回传（更新）；新建的由服务端分配
          ...(p.route ? { route: p.route } : {}),
          displayName: p.displayName.trim(),
          baseURL: p.baseURL.trim(),
          models: (p.models || [])
            .filter((m) => m.id && String(m.id).trim())
            .map((m) => ({
              id: String(m.id).trim(),
              name: (m.name || '').trim() || undefined,
              contextWindow: m.contextWindow || undefined,
              maxTokens: m.maxTokens || undefined,
            })),
          ...(p.apiKey && p.apiKey.trim() ? { apiKey: p.apiKey.trim() } : {}),
        })),
    }
    if (official?.apiKey?.trim()) payload.apiKey = official.apiKey.trim()
    // 官方 item 不再编辑端点/模型；但若检测到旧覆盖残留，保存时显式清除（回官方）
    if (official?.officialOverride) {
      payload.baseURL = ''
      payload.models = []
    }

    await axios.post('/api/user/tenant-config', payload)
    await syncWalletAccount(address)
    toast(t('user.savedOk'))
  } catch (err) {
    toast(t('user.saveFail', { err: friendlyPluginError(err) }))
  } finally {
    keySaving.value = false
  }
}

/** 探测某个自定义端点的模型列表（优先用输入框 key，否则用该端点已存 key） */
const discoverItem = async (idx) => {
  if (!currentAddress()) return toast(t('user.errConnectFirst'))
  // 串行互斥（2026-10 审计）：discovering 只记一个下标，点了 A 再点 B 会让
  // A 的"探测中"态被顶掉且两笔并发——签名挑战/限流都会交叠。一次只探一个。
  if (discovering.value !== null) return
  const item = items.value[idx]
  if (!item?.baseURL?.trim()) return toast(t('user.errNeedBaseUrl'))
  discovering.value = idx
  try {
    const { address, nonce, signature, publicKey } = await signChallenge()
    const payload = {
      address,
      nonce,
      signature,
      publicKey,
      baseURL: item.baseURL.trim(),
    }
    if (item.apiKey && item.apiKey.trim()) payload.apiKey = item.apiKey.trim()
    if (item.route) payload.credentialRef = credentialRefFor(item.route)

    const res = await axios.post('/api/user/tenant-config/discover', payload)
    const models = Array.isArray(res.data.models) ? res.data.models : []
    item.models = models.map((m) => ({
      id: m.id || '',
      name: m.name || '',
      contextWindow: undefined,
      maxTokens: undefined,
    }))
    if (models.length === 0) {
      toast(t('user.discoverEmpty'))
    } else {
      toast(
        t('user.discoveredOk', {
          count: models.length,
          name: item.displayName || t('user.unnamed'),
        }),
      )
    }
  } catch (err) {
    toast(t('user.discoverFail', { err: friendlyPluginError(err) }))
  } finally {
    discovering.value = null
  }
}

/** 只删除官方 DeepSeek API Key（不影响端点覆盖与自定义端点，需签名） */
const clearOfficialKey = async () => {
  if (!currentAddress()) return toast(t('user.errConnectFirst'))
  await askConfirm({
    message: t('user.confirmClearOfficialKey'),
    run: async () => {
      keySaving.value = true
      try {
        const { address, nonce, signature, publicKey } = await signChallenge()
        await axios.delete('/api/user/tenant-config', {
          data: { address, nonce, signature, publicKey, scope: 'official-key' },
        })
        await syncWalletAccount(address)
        toast(t('user.officialKeyCleared'))
      } catch (err) {
        toast(t('user.delFail', { err: friendlyPluginError(err) }))
      } finally {
        keySaving.value = false
      }
    },
  })
}

/** 恢复默认：清除官方 key + 官方端点覆盖 + 所有自定义端点（需签名） */
const resetConfig = async () => {
  if (!currentAddress()) return toast(t('user.errConnectFirst'))
  const customLine =
    customCount.value > 0 ? t('user.confirmResetCustomLine', { n: customCount.value }) : ''
  await askConfirm({
    message: t('user.confirmResetBase1') + customLine + t('user.confirmResetBase2'),
    danger: true,
    run: async () => {
      keySaving.value = true
      try {
        const { address, nonce, signature, publicKey } = await signChallenge()
        await axios.delete('/api/user/tenant-config', {
          data: { address, nonce, signature, publicKey },
        })
        await syncWalletAccount(address)
        toast(t('user.resetOk'))
      } catch (err) {
        toast(t('user.resetFail', { err: friendlyPluginError(err) }))
      } finally {
        keySaving.value = false
      }
    },
  })
}

// 加载状态
const loading = ref(false)
const loadingTitle = ref('')
const loadingMessage = ref('')
const loadingProgress = ref(0)

// 等待时间计算
const waitingTime = computed(() => {
  if (!waitingSince.value) return t('user.waitZero')
  const ms = Date.now() - waitingSince.value
  if (ms < 60000) return t('user.waitSec', { n: Math.floor(ms / 1000) })
  if (ms < 3600000) return t('user.waitMin', { n: Math.floor(ms / 60000) })
  return t('user.waitHour', { n: (ms / 3600000).toFixed(1) })
})

const showLoading = (title, message, progress = 0) => {
  loading.value = true
  loadingTitle.value = title
  loadingMessage.value = message
  loadingProgress.value = progress
}

const hideLoading = () => {
  loading.value = false
}

const checkCCDAO = () => {
  hasCCDAO.value = typeof window.ccdao !== 'undefined'
}

// 账户变化处理（watchAccountsChanged 回调）
// 只处理「已连接过且地址真正变化」：首次连接由按钮/初始恢复流程负责，
// 避免与 connectWallet 竞态并发跑创建流程。
const handleAccountsChanged = async (accounts) => {
  console.log('[UserCenter] 检测到账户变化:', accounts)

  if (!accounts || accounts.length === 0) {
    // 用户断开连接
    localStorage.removeItem('swtc_address')
    connected.value = false
    userInfo.value = {}
    pluginCaseAddr.value = ''
    toast(t('user.walletDisconnected'))
    return
  }

  rememberPluginCase(accounts[0]) // 先记原始大小写（全界面地址展示以它为准）
  const newAddress = accounts[0].toLowerCase()
  const saved = localStorage.getItem('swtc_address')
  if (!saved || saved === newAddress) {
    console.log('[UserCenter] 账户未变化或尚未连接，忽略广播')
    return
  }
  // 切换钱包地址：立即吊销旧地址的门禁钥匙（user_session），
  // 防止旧 URL 凭旧 cookie 仍能进入（会话 2h/30min 也是兜底）
  console.log('[UserCenter] 钱包地址切换，吊销旧会话钥匙...')
  try {
    await axios.post('/api/user/logout')
  } catch (err) {
    console.warn('[UserCenter] 吊销旧会话失败（非关键）:', err.message)
  }
  handleAddressChange(newAddress)
}

// 监听账户变化事件（三通道兼容，共用 api/wallet.js）
let unbindAccounts = null
const setupAccountChangeListener = () => {
  if (!hasCCDAO.value) {
    console.log('[UserCenter] CCDAO 插件未安装')
    return
  }
  console.log('[UserCenter] 设置账户监听器（三通道兼容）...')
  unbindAccounts = watchAccountsChanged(handleAccountsChanged)
}

/**
 * 确立「已连接」身份：**只要拿到钱包地址就算连上**，与容器是否可用、是否被限时无关。
 *
 * 背景（用户实测死循环）：模板里「连接钱包」卡片是 `v-else-if="!connected"`，
 * 而额度用完 / 排队时 `handleAddressChange` 会提前 return。若这些分支不把
 * `connected` 置真，页面就一直停在「连接钱包」卡片 —— 用户点一次弹一次
 * 「今日时长已用完」，弹完还停在连接钱包；而**解除限时的 CWT 验证 tab 恰恰在
 * `connected === true` 之后的主界面里**，于是永远进不去 → 永远无法自助解锁。
 *
 * `fetchUserInfo` 失败也不阻断：无会话时 `/api/user/:address` 会回脱敏壳
 * （只有 address/exists/status），有 address 就足够把界面（含 CWT tab）渲染出来。
 */
const establishConnected = async (address) => {
  try {
    await fetchUserInfo(address)
  } catch (err) {
    console.warn('[UserCenter] 建立已连接态时拉取用户信息失败（不阻断）:', err?.message)
  }
  if (!userInfo.value?.address) userInfo.value = { ...(userInfo.value || {}), address }
  connected.value = true
}

// ★v1.5 验收反馈②：登录与建容器解耦（后端 /connect action=login：验签+换 cookie，不 docker、
// 不过准入闸——准入闸只咬"进容器"，登录被咬会让过期凭证者进不了续发通道，死锁）。
// 会话有效且地址一致 → 免签名弹窗秒进；否则一次性签名登录。绝不调 ensureContainer。
const loginOnly = async (address) => {
  try {
    const s = await axios.get('/api/user/session-info')
    if (s.data?.address && String(s.data.address).toLowerCase() === String(address).toLowerCase())
      return 'ok'
  } catch {
    /* 会话查询失败按"无会话"处理，走签名登录 */
  }
  try {
    const res = await connectWithOwnership(address, {
      action: 'login',
      title: t('user.loadingLogin'),
      progress: 35,
    })
    if (res.status === 200) return 'ok'
    const data = await res.json().catch(() => ({}))
    toast(data.error || t('user.loginFail', { err: res.status }))
    return 'denied'
  } catch (err) {
    toast(t('user.loginFail', { err: err?.message || err }))
    return 'denied'
  }
}

// 处理地址变化的通用函数
const handleAddressChange = async (newAddress, isInitialLoad = false) => {
  const oldAddress = localStorage.getItem('swtc_address')

  if (isInitialLoad) {
    console.log('[UserCenter] 初始加载，恢复地址:', newAddress)
  } else if (newAddress !== oldAddress) {
    console.log(`[UserCenter] 地址切换：${oldAddress} -> ${newAddress}`)
  } else {
    console.log('[UserCenter] 地址相同，但仍需检查容器状态')
  }

  // 地址真正变化时：立即清空上一个地址的全部用户数据并进入 loading，
  // 避免切换后短暂闪现上一个用户的共享/安装列表；
  // 也保证后续失败分支（额度用完/资源排队/异常）不会残留旧地址的页面与信息
  if (!isInitialLoad && newAddress !== oldAddress) {
    mineData.value = { published: [], installed: [], inContainer: [], plugins: null }
    mySkillsLoading.value = true
    userInfo.value = {}
    connected.value = false
    usageInfo.value = null
    // 2026-10 审计补：凭证与模型配置也是**按地址**的数据——切钱包瞬间把上一个
    // 地址的卡片/申请状态/模型条目留在屏上，既是误导（新地址显示"已领取"），
    // 也有把旧配置原样保存到新地址的串写风险。
    credInfo.value = null
    credVc.value = null
    credApp.value = null
    items.value = []
  }

  try {
    // 显示加载页面
    showLoading(t('user.loadingConnect'), t('user.loadingVerify'), 10)

    // ★v1.5 验收反馈②：进入用户中心 = **登录**，不再顺手建容器。
    // 签名换 cookie（/connect action=login，后端不碰 docker）→ 正常拉账户/凭证/角色。
    // 容器创建/启动是显式动作：容器管理页「启动容器」按钮（restartContainer→ensureContainer
    // 全状态机）或「进入 DSH」（enterDsh，自带创建+跳转）。管理员进来管理不再空转容器，
    // 普通用户也不再被"进来即计费起时限"绑架——启动时机还给用户。
    const loginState = await loginOnly(newAddress)
    if (loginState === 'denied') {
      // 换 cookie 失败（验签被拒/准入异常）→ 停在连接钱包卡片，loginOnly 已弹人话原因
      hideLoading()
      return
    }

    // 保存地址（即使是相同的地址也要保存，确保格式正确）
    localStorage.setItem('swtc_address', newAddress)

    // ★凭证/角色是"登录"这一动作的直接结论，不寄生在用户信息接口的分支里：
    //   先拉 credential-status（账户信息的凭证卡 + 管理 tab 判权），再补业务数据。
    //   （历史坑：fetchUserInfo 走 403/401 分支时早退，loadCredentialStatus 没被调，
    //   credInfo 空置 → 凭证卡整块"消失"——用户实测反馈即此。）
    await loadCredentialStatus(newAddress)

    // 身份已确立 → 进入已连接态（establishConnected 内部 fetchUserInfo 拉全量；
    // 其内部再调一次 loadCredentialStatus 属幂等刷新，无副作用）
    showLoading(t('user.loadingFetchInfo'), t('user.loadingAccountData'), 70)
    await establishConnected(newAddress)
    hideLoading()

    // 只在地址真正变化时才显示提示
    if (!isInitialLoad && newAddress !== oldAddress) {
      toast(t('user.switchedAddress', { addr: `${newAddress.slice(0, 10)}...` }))
    }

    // 切换/连接后刷新"我的技能"为当前地址的个人视图
    await loadMine()
  } catch (err) {
    console.error('[UserCenter] 处理地址失败:', err)
    hideLoading()
    if (!isInitialLoad) {
      toast(t('user.addressFail', { err: err.message }))
    }
  }
}

const connectWallet = async () => {
  if (!hasCCDAO.value) return

  connecting.value = true
  // 钱包弹窗请求账户期间先给反馈；后续 handleAddressChange 会覆盖进度继续展示
  showLoading(t('user.connecting'), t('user.loadingWalletConnect'), 5)
  try {
    const pluginAddress = await requestAccounts()
    rememberPluginCase(pluginAddress)
    // 统一转小写
    const address = pluginAddress.toLowerCase()
    console.log('[UserCenter] 连接钱包，地址:', address)

    // 使用通用处理函数
    await handleAddressChange(address)
  } catch (err) {
    console.error('[UserCenter] 连接失败:', err)
    toast(t('user.connectFail', { err: err.message }))
  } finally {
    connecting.value = false
    hideLoading()
  }
}

/**
 * 容器连接/创建（所有权签名 + 网关门禁会话）
 * - 总是走签名流程：后端验签通过后签发 user_session cookie，
 *   浏览器凭 cookie 才能通过租户网关（0.0.0.0:<port> → 127.0.0.1:<内部端口>）
 * - 流程：领取一次性挑战 → 插件签名（当前选中账户，原始大小写）→
 *   带 nonce/signature/publicKey 访问 /connect
 * - 签名账户必须与目标地址一致，否则后端验签会 403
 */
// 签名连接防重入：事件监听器/用户双击/自动恢复可能并发触发，
// 同一时刻只允许一次「请求账户 → 挑战 → 签名 → 建立连接」，
// 避免重复弹签名窗、重复创建容器。
let ownershipInFlight = false
const connectWithOwnership = async (address, opts = {}) => {
  // quiet=后台自动拉起（进入用户中心触发）：钱包签名弹窗照常（归属闸不放松），
  // 但不糊全屏 loading——用户可继续浏览，进度由容器 tab 的加载图标承担
  const quiet = !!opts.quiet
  if (ownershipInFlight) {
    console.warn('[UserCenter] 签名连接进行中，忽略重复请求')
    throw new Error(t('user.busy'))
  }
  ownershipInFlight = true
  // 首屏标题由调用方决定：主动「连接钱包/进入 DSH」显示"连接中"；
  // 创建容器场景（ensureContainer）显示"正在创建容器"，避免创建期间
  // UI 又跳回"连接钱包"页面（各阶段只有副标题在变）。
  const title = opts.title || t('user.connecting')
  const progress0 = opts.progress ?? 10
  try {
    // 阶段化 loading（每次 show 不 hide，由调用方统一 hideLoading）：
    // 覆盖"钱包弹窗请求账户 → 领取挑战 → 等待签名 → 建立连接"的每个耗时环节。
    // T4 收敛（2026-11-10）：requestAccounts→/connect-challenge→signMessage→getPublicKey
    // 的签名原语走 api/connect.js 唯一权威支（与 MobileContainer 同支，判例 58 漂移根治）；
    // 拼法记录（rememberPluginCase）与阶段 loading 经回调注入，语义与逐点时序同改造前。
    if (!quiet) showLoading(title, t('user.loadingVerify'), progress0)

    const core = await signConnectPlugin({
      onPluginAddress: rememberPluginCase,
      onPhase: (phase) => {
        if (quiet) return
        if (phase === 'challenge') {
          showLoading(title, t('user.loadingWalletConnect'), Math.max(progress0, 25))
        } else if (phase === 'sign') {
          showLoading(title, t('user.loadingSign'), Math.max(progress0, 45))
        }
      },
    })
    // 3) 带签名访问 /connect（已存在容器同样验签并发 cookie）
    // format=json：浏览器 fetch 的 redirect:manual 会把 302 包成 opaque (status 0)，
    // 取不到 location → 后端直接回 200 JSON {url}，前端 window.open。
    if (!quiet) showLoading(title, t('user.loadingEstablish'), Math.max(progress0, 70))
    // action=login（v1.5 反馈②）：只换 cookie 不建容器——签的仍是 CONNECT 用途同一消息，
    // 额外 query 不参与签名内容，防重放语义不变。
    const cRes = await fetch(buildConnectUrl(address, core, opts.action || null))
    return cRes
  } finally {
    ownershipInFlight = false
  }
}

/**
 * 「进入 DSH」：签名连接 → 302 后在浏览器新标签打开租户容器。
 * 必须先过签名（拿 user_session cookie），否则网关门禁 403。
 */
const enterDsh = async () => {
  const address = currentAddress()
  if (!address) {
    toast(t('user.errConnectFirst'))
    return
  }
  if (!window.ccdao) {
    toast(t('user.errNoAccount'))
    return
  }
  try {
    showLoading(t('user.connecting'))
    const res = await connectWithOwnership(address, { title: t('user.connecting') })
    hideLoading()
    // 200 JSON：后端已签发 user_session cookie，返回容器 url
    if (res.status === 200) {
      const data = await res.json()
      if (data?.url) {
        window.open(data.url, '_blank', 'noopener')
        return
      }
      toast(data?.message || data?.error || t('user.enterDshFail', { err: res.status }))
      return
    }
    if (res.status === 302) {
      const loc = res.headers.get('location')
      if (loc) {
        window.open(loc, '_blank', 'noopener')
      }
      return
    }
    if (res.status === 202) {
      const data = await res.json()
      toast(data.message || data.error || '资源不足，请等待')
      return
    }
    toast(t('user.enterDshFail', { err: res.status }))
  } catch (err) {
    hideLoading()
    toast(t('user.enterDshFail', { err: err.message || err }))
  }
}

// 最近一次 /connect 202 的后端提示（资源不足/额度用完），供上层展示
let lastConnect202Message = ''
const ensureContainer = async (address, opts = {}) => {
  // 先检查容器状态
  try {
    const statusRes = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)

    // 如果在等待队列中
    if (statusRes.data.status === 'waiting') {
      waiting.value = true
      queuePosition.value = statusRes.data.queuePosition
      queueTotal.value = statusRes.data.queueTotal
      waitingSince.value = statusRes.data.waitingSince
      // 开始轮询队列状态
      startQueuePolling(address)
      return 'waiting'
    }

    // 如果容器不存在或已销毁，创建新容器
    if (!statusRes.data.exists || statusRes.data.status === 'destroyed') {
      console.log('[UserCenter] 容器不存在，正在创建...')
      const connectRes = await connectWithOwnership(address, {
        title: t('user.loadingCreateContainer'),
        progress: 50,
        quiet: !!opts.quiet,
      })

      // 检查是否返回 202（资源不足 → 排队；额度用完 → 明确提示，不排队）
      if (connectRes.status === 202) {
        const data = await connectRes.json()
        lastConnect202Message = data.message || data.error || '资源不足，请等待'
        if (data.code === 'USAGE_LIMIT_REACHED') {
          console.warn('[flow] USAGE_LIMIT_REACHED:', lastConnect202Message)
          waiting.value = false
          return 'usage-limit'
        }
        waiting.value = true
        queuePosition.value = data.queuePosition
        queueTotal.value = 1 // 初始值，后续轮询会更新
        waitingSince.value = Date.now()
        startQueuePolling(address)
        return 'waiting'
      }

      // 等待容器就绪
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return 'created'
    }
    // 如果容器已停止，启动它
    else if (statusRes.data.status === 'stopped') {
      console.log('[UserCenter] 容器已停止，正在启动...')
      await connectWithOwnership(address, {
        title: t('user.loadingStartExisting'),
        progress: 50,
      })
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return 'started'
    }
    // 容器正在运行，无需操作
    else {
      console.log('[UserCenter] 容器正在运行')
      return 'running'
    }
  } catch (err) {
    console.error('[UserCenter] 检查容器状态失败:', err)
    // 如果检查失败，尝试直接创建容器
    const connectRes = await connectWithOwnership(address, {
      title: t('user.loadingCreateContainer'),
      progress: 50,
    })

    // 检查是否返回 202（资源不足 → 排队；额度用完 → 明确提示，不排队）
    if (connectRes.status === 202) {
      const data = await connectRes.json()
      lastConnect202Message = data.message || data.error || '资源不足，请等待'
      if (data.code === 'USAGE_LIMIT_REACHED') {
        console.warn('[flow] USAGE_LIMIT_REACHED:', lastConnect202Message)
        waiting.value = false
        return 'usage-limit'
      }
      waiting.value = true
      queuePosition.value = data.queuePosition
      queueTotal.value = 1
      waitingSince.value = Date.now()
      startQueuePolling(address)
      return 'waiting'
    }

    await new Promise((resolve) => setTimeout(resolve, 3000))
    return 'created'
  }
}

// 轮询队列状态
let queuePollingTimer = null
const startQueuePolling = (address) => {
  // 清除之前的轮询
  if (queuePollingTimer) {
    clearInterval(queuePollingTimer)
  }

  // 每 5 秒检查一次队列状态
  queuePollingTimer = setInterval(async () => {
    try {
      const statusRes = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)

      // 如果容器已创建成功
      if (statusRes.data.exists) {
        waiting.value = false
        if (queuePollingTimer) {
          clearInterval(queuePollingTimer)
          queuePollingTimer = null
        }
        // 重新加载用户信息
        await fetchUserInfo(address)
        connected.value = true
        return
      }

      // 更新队列信息
      if (statusRes.data.status === 'waiting') {
        queuePosition.value = statusRes.data.queuePosition
        queueTotal.value = statusRes.data.queueTotal
      }
    } catch (err) {
      console.error('[UserCenter] 轮询队列状态失败:', err)
    }
  }, 5000)
}

// 取消等待
const cancelWaiting = () => {
  waiting.value = false
  if (queuePollingTimer) {
    clearInterval(queuePollingTimer)
    queuePollingTimer = null
  }
  connected.value = false
  userInfo.value = {}
  // 断开即清凭证视图（防上一钱包的卡片残留给下一个地址）
  credInfo.value = null
  credApp.value = null
  credNoDid.value = null
}

const fetchUserInfo = async (address) => {
  // 门控 loading：仅当调用方没有在展示 loading 时才自己开/关，
  // 避免打断 handleAddressChange 的整体加载流程（它自己会 hide）
  const opened = !loading.value
  if (opened) showLoading(t('user.loadingFetchInfo'), t('user.loadingAccountData'), 80)
  try {
    const res = await axios.get(`/api/user/${address}`)
    // 未建档新用户空态：后端以 200+USER_NOT_FOUND 表达（根治浏览器网络层红字
    // 404；catch 里的 404 分支保留兼容旧服务端）。空态不发 usage/config 请求；
    // 装配必须先于 userInfo 落位——领取弹窗由装配触发，若后于容器管理块的
    // 档案加载完成，会被其"无档案→弹连接引导"时序顶掉（新用户首见弹窗不能丢）。
    if (res.data && res.data.code === 'USER_NOT_FOUND') {
      await loadCredentialStatus(address)
      userInfo.value = { address, status: 'none', exists: false }
      return
    }
    userInfo.value = res.data
    fetchUsage(address)
    fetchConfigStatus()
    loadCredentialStatus(address)
    // 进入即检容器态并后台拉起（每地址一次性；不 await——凭证装配不受牵制）
    void autoBootContainer(res.data)
  } catch (err) {
    // 403/404 是已知良性态（未连接/未建档空态），不再 error 级刷屏——
    // 真异常仍走 error（下面分支处理不到的情况）
    const benign = err.response?.status === 404 || err.response?.status === 403
    ;(benign ? console.info : console.error)(
      benign ? '[UserCenter] 用户信息空态/待解锁:' : '获取用户信息失败:',
      err,
    )

    // 如果是 400 错误，说明地址无效，清除 localStorage
    if (err.response?.status === 400) {
      console.warn('[UserCenter] 地址无效，清除 localStorage')
      localStorage.removeItem('swtc_address')
      connected.value = false
      userInfo.value = {}
      pluginCaseAddr.value = ''
      toast(t('user.invalidAddress'))
      return
    }

    // 403（会话无效/他人地址）：不打断、不弹错——签名连接后自动解锁
    if (err.response?.status === 403) {
      console.warn('[UserCenter] 用户信息需完成签名连接后解锁（403），请点击「进入 DSH」')
      return
    }

    // 401（2026-10 审计补）：user_session 过期/被吊销。吞进"重试"会把界面
    // 停在半连接的假象——明确回到未连接态，提示一键重连。
    if (err.response?.status === 401) {
      connected.value = false
      toast(t('user.sessionExpired'))
      return
    }

    // 404（v1.5 反馈②）：登录建档分离后，未启动过容器=无档案——**正常初始态**，
    // 不是错误：渲染"未创建"空态（容器管理页的「启动容器」按钮就是入口），不重试不弹错。
    // 凭证/角色不依赖容器，照常拉取（判权与卡面展示都挂在 credential-status 上）。
    if (err.response?.status === 404) {
      userInfo.value = { address, status: 'none', exists: false }
      loadCredentialStatus(address)
      return
    }

    // 如果获取失败，可能是容器刚创建，重试一次
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      const res = await axios.get(`/api/user/${address}`)
      userInfo.value = res.data
    } catch (err2) {
      console.error('重试获取用户信息失败:', err2)
    }
  } finally {
    if (opened) hideLoading()
  }
}

// ══ 进入用户中心·容器后台自动拉起（2026-10-23 用户拍板）══
// 检查容器态 → 未跑则后台启动（不糊页面，tab 挂加载图标）→ 完毕弹窗；
// 本来就在跑 → 直接弹窗告知。与 v1.5"进入不顺手建容器"的关系：当年痛点是
// **全屏 loading 阻断浏览**，这里改为后台化+图标化，签名仅 destroyed 重建
// 时按归属闸照常请求一次（闸口语义不放松）。每地址一次性，轮询/手动刷新不重复弹。
let autoBootFor = ''
const containerBooting = ref(false)
// 弹窗收尾约定（2026-10-23 用户拍板）：确定=跳「容器管理」页看结果/手动重试，
// 取消=仅关闭。后台启动期间 restartContainer 入口同样置灰+防御性直返
const bootNotice = (msg) => {
  askConfirm({ message: msg }).then((ok) => {
    if (ok) activeTab.value = 'container'
  })
}
const autoBootContainer = async (data) => {
  const address = data?.address || currentAddress()
  if (!address || autoBootFor === address) return
  autoBootFor = address
  const st = data?.status
  if (st === 'running') {
    bootNotice(t('user.bootAlreadyRunning'))
    return
  }
  // 只拉"登过账的停机户"：stopped（纯 session 静默启动）与 destroyed（需一次
  // 归属签名重建）；none 未建档/waiting 已在排队页/未知态都不自动造轮子
  if (st !== 'stopped' && st !== 'destroyed') return
  containerBooting.value = true
  try {
    if (st === 'stopped') {
      await axios.post(`/api/user/${address}/restart`)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    } else {
      const r = await ensureContainer(address, { quiet: true })
      if (r === 'waiting') return // 排队页由状态机挂出——页面本身即告知
      if (r === 'usage-limit') {
        bootNotice(lastConnect202Message || t('user.bootUsageLimit'))
        return
      }
    }
    await fetchUserInfo(address)
    bootNotice(t('user.bootDoneNotice'))
  } catch (err) {
    bootNotice(t('user.bootFailNotice', { err: err?.message || String(err) }))
  } finally {
    containerBooting.value = false
  }
}

const restartContainer = async () => {
  // 后台自动拉起进行中：按钮已置灰，这里再挡一层（快捷键/其他路径直触）
  if (containerBooting.value) return
  const address = userInfo.value.address || currentAddress()
  if (!address) {
    toast(t('user.errConnectFirst'))
    return
  }
  try {
    showLoading(t('user.loadingStarting'), t('user.loadingPleaseWait'), 40)
    // ★v1.5 反馈②：进页面不再建容器，此按钮成为建/启容器的唯一自动入口——
    // 走 ensureContainer 全状态机（不存在→创建、停止→启动、排队→排队页、额度尽→提示），
    // 旧实现直连 /connect 不看 202 的坑也一并消掉（202 在状态机内转成排队/usage-limit）。
    const st = await ensureContainer(address)
    hideLoading()
    if (st === 'waiting') return // 排队页已由状态机挂出（waiting.value）
    if (st === 'usage-limit') {
      toast(lastConnect202Message || t('user.usageLimitReached'))
      return
    }
    await fetchUserInfo(address)
    toast(t('user.startedOk'))
  } catch (err) {
    hideLoading()
    toast(t('user.startFail', { err: err.message }))
  }
}

const restartDSH = async () => {
  await askConfirm({
    message: t('user.confirmRestartDsh'),
    run: async () => {
      try {
        const address = userInfo.value.address
        showLoading(t('user.loadingRestarting'), t('user.loadingPleaseWait'), 50)

        const res = await axios.post(`/api/user/${address}/restart`)

        // 等待容器完全就绪
        await new Promise((resolve) => setTimeout(resolve, 5000))

        await fetchUserInfo(address)
        hideLoading()
        toast(t('user.restartedOk'))
      } catch (err) {
        hideLoading()
        toast(t('user.restartFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}

const resetContainer = async () => {
  if (!(await askConfirm(t('user.confirmResetContainer')))) return

  await askConfirm({
    message: t('user.confirmResetContainer2'),
    danger: true,
    run: async () => {
      const address = userInfo.value.address
      showLoading(t('user.loadingResetting'), t('user.loadingDeleteRebuild'), 50)
      try {
        // 后端在同一个请求里完成「清空旧容器/数据 → 重建全新容器 → 签发会话」，
        // 返回新容器 url，前端直接打开即可（无需手动重新连接）
        const res = await axios.post(`/api/user/${address}/reset`)

        hideLoading()
        const { url } = res.data
        if (url) window.open(url, '_blank', 'noopener')
        toast(t('user.resetContainerOk'))
      } catch (err) {
        hideLoading()
        toast(t('user.resetContainerFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}

/**
 * 主动停止自己的容器：立即结算今日使用时长并保全剩余额度
 * （停止期间不计时，挂机不再消耗每日限额；数据保留，随时可重新启动）
 */
const stopContainer = async () => {
  await askConfirm({
    message: t('user.confirmStopContainer'),
    run: async () => {
      try {
        const address = userInfo.value.address
        showLoading(t('user.loadingStopping'), t('user.loadingSettleStop'), 50)

        await axios.post(`/api/user/${address}/stop`)

        await fetchUserInfo(address)
        hideLoading()
        toast(t('user.stoppedOk'))
      } catch (err) {
        hideLoading()
        toast(t('user.stopFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}

const tierBadge = (tier) => {
  const map = { 1: 'badge-info', 2: 'badge-warning', 3: 'badge-success' }
  return map[tier] || 'badge-info'
}

const statusBadge = (status) => {
  const map = { running: 'badge-success', stopped: 'badge-warning', destroyed: 'badge-danger' }
  return map[status] || 'badge-info'
}

const statusText = (status) => {
  const map = {
    running: t('user.statusRunning'),
    stopped: t('user.statusStopped'),
    destroyed: t('user.statusDestroyed'),
    // v1.5 反馈②：登录不建容器后"未创建"是常态首屏，不该裸显 null/none
    none: t('user.statusNone'),
    null: t('user.statusNone'),
  }
  if (!status) return map.none
  return map[status] || status
}

onMounted(async () => {
  checkCCDAO()

  // 设置账户变化监听器
  if (hasCCDAO.value) {
    setupAccountChangeListener()
  }

  // 优先从 CCDAO 插件获取当前地址，而不是 localStorage
  if (hasCCDAO.value && window.ccdao && window.ccdao.request) {
    try {
      const pluginAddress = await requestAccounts()
      rememberPluginCase(pluginAddress)
      if (pluginAddress) {
        const currentAddress = pluginAddress.toLowerCase()
        console.log('[UserCenter] 从 CCDAO 获取当前地址:', currentAddress)

        // 比对 cookie 会话地址与插件当前地址：不一致说明钱包已切换
        // （旧 user_session 可能还有效）→ 吊销旧钥匙，防止旧容器 URL 仍可进
        try {
          const sessionRes = await axios.get('/api/user/session-info')
          const cookieAddr = sessionRes.data.address
          if (cookieAddr && cookieAddr.toLowerCase() !== currentAddress) {
            console.log(
              `[UserCenter] 会话地址(${cookieAddr}) ≠ 插件地址(${currentAddress})，吊销旧钥匙`,
            )
            await axios.post('/api/user/logout')
            toast(t('user.sessionMismatchRevoked'))
          }
        } catch (sessionErr) {
          console.warn('[UserCenter] 会话比对失败（非关键）:', sessionErr.message)
        }

        // 清除 localStorage 中的旧地址（如果有）
        const savedAddress = localStorage.getItem('swtc_address')
        if (savedAddress && savedAddress !== currentAddress) {
          console.log(`[UserCenter] 清除旧地址：${savedAddress} -> ${currentAddress}`)
          localStorage.removeItem('swtc_address')
        }

        // 使用当前地址
        await handleAddressChange(currentAddress, true)
      } else {
        // 没有账户，检查 localStorage
        const savedAddress = localStorage.getItem('swtc_address')
        if (savedAddress) {
          console.log('[UserCenter] CCDAO 无账户，使用 localStorage:', savedAddress)
          await handleAddressChange(savedAddress, true)
        }
      }
    } catch (err) {
      console.error('[UserCenter] 获取 CCDAO 账户失败:', err)

      // 降级：使用 localStorage
      const savedAddress = localStorage.getItem('swtc_address')
      if (savedAddress) {
        console.log('[UserCenter] 降级使用 localStorage:', savedAddress)
        await handleAddressChange(savedAddress, true)
      }
    }
  } else {
    // 没有 CCDAO，使用 localStorage
    const savedAddress = localStorage.getItem('swtc_address')
    if (savedAddress) {
      console.log('[UserCenter] 无 CCDAO，使用 localStorage:', savedAddress)
      await handleAddressChange(savedAddress, true)
    }
  }
  // 首帧失联落位（watcher 只管"连上过又掉"）：移动端开机即无会话 → 直接进
  // 「我的」亮登录面板，而不是对着一屏 '-' 的首页（2026-11-10 挂机报障）。
  // 置于 loadMine 前：connected 此刻已是终值，且不惧 loadMine 异常吞掉落位。
  if (!connected.value && isMobile.value) mobileTab.value = 'me'
  await loadMine()
})

// ===================== 🧩 我的技能（技能市场集成） =====================
const mineData = ref({ published: [], installed: [], inContainer: [], unverified: false })
const mySkillsLoading = ref(true) // 初始即 loading：面板首帧显示 spinner，避免空态闪现后突然出数据
const importDialogOpen = ref(false)
const importName = ref('')
const importText = ref('')
const importBusy = ref(false)

/** 拉取 mine 数据（含签名） */
const fetchMine = async () => {
  const sig = await signChallenge('/api/skills/challenge')
  const res = await skillsApi.mine(sig)
  return {
    published: res.published || [],
    installed: res.installed || [],
    inContainer: res.inContainer || [],
  }
}

let mineInFlight = null

/** 我的技能列表整体刷新（控制下方列表区的 loading） */
const loadMine = async () => {
  if (mineInFlight) return mineInFlight // 并发去重：watch 与切换流程可能重叠触发
  if (!connected.value) return
  mySkillsLoading.value = true
  const startedAt = Date.now()
  mineInFlight = (async () => {
    try {
      // 个人视图接口：无需钱包签名，任何环境都能加载出"我的共享/已安装"
      // （inContainer 由共享弹窗单独用签名接口刷新，这里保留原有值）
      const res = await skillsApi.mineView(currentAddress())
      mineData.value = {
        ...mineData.value,
        published: res.published || [],
        installed: res.installed || [],
        unverified: Boolean(res.unverified),
        plugins: Array.isArray(res.plugins) ? res.plugins : null,
      }
      if (res.reconciled) toast(t('skills.reconciledGone', { n: res.reconciled }))
    } catch (err) {
      // 我的技能加载失败不阻塞其他功能
      console.warn('[skills] 加载我的技能失败（忽略）:', err)
    } finally {
      // 保证 loading 至少可见一小段时间：请求太快时若立即关闭，
      // spinner 来不及渲染一帧就被替换，用户会以为"没有 loading"
      const MIN_LOADING_MS = 400
      const elapsed = Date.now() - startedAt
      if (elapsed < MIN_LOADING_MS) {
        await new Promise((r) => setTimeout(r, MIN_LOADING_MS - elapsed))
      }
      mySkillsLoading.value = false
    }
  })()
  try {
    return await mineInFlight
  } finally {
    mineInFlight = null
  }
}

/**
 * 共享对话框专用：只刷新 inContainer，不触发下方列表区的 loading。
 * 弹窗与外层"我的共享/已安装"列表的加载态互相独立。
 */
const loadContainerSkills = async () => {
  if (!connected.value) return
  try {
    const data = await fetchMine()
    mineData.value = { ...mineData.value, inContainer: data.inContainer }
  } catch (err) {
    mineData.value = { ...mineData.value, inContainer: [] }
    console.warn('[skills] 获取容器内技能失败（忽略）:', err)
  }
}

watch(connected, (v) => {
  if (v) {
    loadMine()
    loadCredentialStatus(userInfo.value.address)
  }
})

const openImportDialog = () => {
  importDialogOpen.value = true
  importName.value = ''
  importText.value = ''
}

const closeImportDialog = () => {
  importDialogOpen.value = false
}

const onImportFile = (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    importText.value = String(reader.result || '')
    // 从文件名推断技能名（去 .md 后缀、转小写）
    const base = String(file.name).replace(/\.md$/i, '').trim().toLowerCase()
    if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(base)) importName.value = base
  }
  reader.readAsText(file)
}

const doImport = async () => {
  const name = importName.value.trim()
  if (!name) {
    toast(t('user.errNeedSkillName'))
    return
  }
  if (!importText.value.trim()) {
    toast(t('user.errNeedSkillText'))
    return
  }
  importBusy.value = true
  try {
    const sig = await signChallenge('/api/skills/challenge')
    await skillsApi.importSkill(sig, name, importText.value)
    toast(t('user.importedOk', { name }))
    closeImportDialog()
    await loadMine()
  } catch (err) {
    toast(t('user.importFail', { err: friendlyPluginError(err) }))
  } finally {
    importBusy.value = false
  }
}

const unpublishSkill = async (name) => {
  await askConfirm({
    message: t('user.confirmUnpublish', { name }),
    run: async () => {
      try {
        const sig = await signChallenge('/api/skills/challenge')
        await skillsApi.unpublish(sig, name)
        await loadMine()
      } catch (err) {
        toast(t('user.opFail', { err: friendlyPluginError(err) }))
      }
    },
  })
}

const uninstallSkill = async (name) => {
  await askConfirm({
    message: t('user.confirmUninstall', { name }),
    run: async () => {
      try {
        const sig = await signChallenge('/api/skills/challenge')
        await skillsApi.uninstall(sig, name)
        await loadMine()
      } catch (err) {
        toast(t('user.uninstallFail', { err: friendlyPluginError(err) }))
      }
    },
  })
}

// ===================== 📤 共享容器内的技能（含撞名重命名） =====================
const shareDialogOpen = ref(false)
const shareSourceName = ref('')
const shareRenameTo = ref('')
const shareBusy = ref(false)
const shareConflict = ref(false)
const shareLoading = ref(false) // 获取容器内技能列表的 loading

const openShareDialog = async () => {
  shareDialogOpen.value = true
  shareSourceName.value = ''
  shareRenameTo.value = ''
  shareConflict.value = false
  // 打开时只刷新弹窗用的容器内技能列表（不触碰下方列表区的 loading）
  if (connected.value) {
    shareLoading.value = true
    try {
      await loadContainerSkills()
    } finally {
      shareLoading.value = false
    }
  }
}

const closeShareDialog = () => {
  shareDialogOpen.value = false
}

const doShare = async () => {
  const source = shareSourceName.value
  if (!source) {
    toast(t('user.errNeedShareSource'))
    return
  }
  const renameTo = shareConflict.value ? shareRenameTo.value.trim() : ''
  if (shareConflict.value && !renameTo) {
    toast(t('user.errNeedShareRename'))
    return
  }
  shareBusy.value = true
  try {
    const sig = await signChallenge('/api/skills/challenge')
    await skillsApi.publish(sig, source, renameTo || undefined)
    toast(
      renameTo
        ? t('user.sharedWithRename', { name: renameTo })
        : t('user.sharedOk', { name: source }),
    )
    closeShareDialog()
    await loadMine()
  } catch (err) {
    if (err.response?.status === 409) {
      // 共享名已被占用：进入重命名模式，源名保持不变
      shareConflict.value = true
      shareRenameTo.value = ''
      return
    }
    toast(t('user.shareFail', { err: friendlyPluginError(err) }))
  } finally {
    shareBusy.value = false
  }
}

onUnmounted(() => {
  stopAdminBadges()
  // 排队轮询是全局 interval：不随组件卸载停止的话，切走页面的用户仍在后台
  // 空转打接口（僵尸组件 setState），重挂载后新旧两条轮询并行（2026-10 审计）。
  if (queuePollingTimer) {
    clearInterval(queuePollingTimer)
    queuePollingTimer = null
  }
  // 解绑账户监听，避免组件重挂载后重复监听
  unbindAccounts?.()
  unbindAccounts = null
})
</script>

<style scoped>
/* 技能动作行：紧凑贴标题，别再让全局 action-buttons 的 1.25rem 上下大空档 */
.skill-actions {
  margin: 0.5rem 0 1rem;
}

/* 移动端布局 */
.mobile-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  background: #f4f5fa;
}

.mobile-content {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  width: 100%;
}

.mobile-page {
  min-height: 100%;
  width: 100%;
}

.mobile-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  background: var(--surface-white);
  margin: 16px;
  border-radius: 16px;
}

.placeholder-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.placeholder-text {
  font-size: 16px;
  font-weight: 600;
  color: #20242f;
  margin-bottom: 8px;
}

.placeholder-hint {
  font-size: 14px;
  color: #8a90a3;
}

.mobile-tabbar {
  display: flex;
  background: var(--surface-white);
  border-top: 1px solid #eceef4;
  padding: 8px 0 calc(8px + env(safe-area-inset-bottom));
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.05);
}

.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  background: none;
  border: none;
  color: #8a90a3;
  cursor: pointer;
  transition: color 0.2s;
}

.tab-item.active {
  color: #6a72e8;
}

.tab-icon {
  font-size: 24px;
  position: relative;
}

.tab-dot {
  position: absolute;
  top: -2px;
  right: -6px;
  width: 10px;
  height: 10px;
  background: #ff4757;
  border-radius: 50%;
  border: 2px solid var(--surface-white);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.tab-label {
  font-size: 12px;
  font-weight: 500;
}

.user-center {
  height: 100%;
  display: flex;
  animation: fadeIn 0.3s;
}

/* ════ 状态卡片（loading / connect / waiting，居中显示） ════ */

.loading-card h2,
.connect-card h2,
.waiting-card h2 {
  font-size: 1.4rem;
  margin-bottom: 1rem;
  color: var(--text-main);
}

.loading-spinner {
  margin-bottom: 2rem;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 4px solid #eef0f8;
  border-top: 4px solid var(--brand-text);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.loading-message {
  color: var(--text-muted);
  margin-bottom: 2rem;
}

.loading-progress {
  max-width: 400px;
  margin: 0 auto;
}

.progress-text {
  font-size: 0.9rem;
  color: var(--text-muted);
}

.connect-card p {
  color: var(--text-muted);
  margin-bottom: 2rem;
}

.btn-small {
  padding: 0.25rem 0.75rem;
  font-size: 0.85rem;
  margin-left: 0.5rem;
}

/* ─── 等待队列 ─── */
.waiting-icon {
  font-size: 3.5rem;
  margin-bottom: 1rem;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.1);
  }
}

.waiting-card h2 {
  color: #92400e;
}

.waiting-message {
  color: #78350f;
  margin-bottom: 0.5rem;
  font-size: 1rem;
}

.queue-info {
  background: #fffbeb;
  border-radius: 12px;
  padding: 1.25rem;
  margin: 2rem 0;
  border: 1px solid #fde68a;
}

.queue-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 0;
  border-bottom: 1px solid #fef3c7;
}

.queue-item:last-child {
  border-bottom: none;
}

.queue-label {
  color: #92400e;
  font-size: 0.9rem;
}

.queue-value {
  color: #78350f;
  font-weight: 600;
  font-size: 1.05rem;
}

.waiting-progress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin: 2rem 0;
  color: #92400e;
}

.waiting-progress .spinner {
  width: 30px;
  height: 30px;
  border: 4px solid #fde68a;
  border-top: 4px solid #f59e0b;
}

/* ════ 主界面：左侧栏 + 右侧内容（与 React 原型稿一致） ════ */

.wallet-summary {
  padding: 0.75rem;
  margin-bottom: 0.25rem;
  border-bottom: 1px solid var(--surface-soft);
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
  animation: pulse 2s ease-in-out infinite;
}

.wallet-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--success);
}

.wallet-short {
  display: block;
  width: 100%;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

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

/* v1.5 验收①：用户页签与管理页签同侧栏并列，中间一条"管理"分组细线 */
.sidebar-divider {
  margin: 0.85rem 0.75rem 0.4rem;
  padding-top: 0.6rem;
  border-top: 1px solid rgba(226, 232, 240, 0.9);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-faint);
  user-select: none;
}

/* v1.5 验收①：管理页签内嵌 AdminPanel——外层 tab-content 不再叠 padding，
   避免双层留白；AdminPanel(embedded) 自身不渲染侧栏，内容即全宽 */
.tab-content.admin-embed {
  padding: 0;
  display: block;
}

/* ─── 右侧内容卡 ─── */

.tab-content {
  animation: fadeIn 0.25s;
}

.tab-divider {
  border-top: 1px solid var(--surface-soft);
  margin: 1.25rem 0;
}

/* ─── 账户信息 ─── */
.stat-rows {
  display: flex;
  flex-direction: column;
}

.stat-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0;
  border-bottom: 1px solid var(--bg-page);
}

.stat-row:last-child {
  border-bottom: none;
}

.stat-label {
  font-size: 12px;
  color: var(--text-faint);
  width: 88px;
  flex-shrink: 0;
}

.stat-value {
  font-size: 13px;
  color: var(--text-body);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 长值行（vcId/profileDid+复制按钮）：2026-10-23 实锤——.addr-tip[data-full] 全局
   overflow:visible（hover 提示不能被裁）把上面的省略号推翻，nowrap 长串+不可压缩的
   emoji 按钮一起撑破卡片边界。解法=职责拆分：外层宿主自然收窄成 flex 行，
   省略号交给内层 .stat-clip，按钮永不缩 */
.stat-value.addr-tip {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}
.stat-clip {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}

.resource-usage {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.resource-item {
  padding: 0.75rem 1rem;
  background: var(--bg-page);
  border-radius: 12px;
  border: 1px solid var(--surface-soft);
}

.resource-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.375rem;
  font-weight: 500;
  font-size: 13px;
  color: var(--text-secondary);
}

.btn-enter {
  padding: 0.75rem 2rem;
  font-size: 1rem;
}

/* ─── 进入容器入口卡（容器管理顶部） ─── */
.enter-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.25rem 1.5rem;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(107, 123, 219, 0.08) 0%, rgba(108, 105, 194, 0.08) 100%);
  border: 1px solid rgba(107, 123, 219, 0.25);
}

.enter-info {
  min-width: 0;
}

.enter-title {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-main);
  margin-bottom: 0.25rem;
}

.enter-hint {
  font-size: 0.8rem;
  color: var(--text-muted);
  line-height: 1.5;
}

.enter-box .btn-enter {
  flex-shrink: 0;
  margin: 0;
}

/* ════ 通用小组件 ════ */
.action-buttons {
  display: flex;
  gap: 0.75rem;
  margin: 1.25rem 0;
  flex-wrap: wrap;
}

.action-buttons .btn {
  flex: 1;
  min-width: 150px;
  padding: 0.625rem 1.25rem;
  font-size: 0.95rem;
}

.action-hints {
  margin-top: 1rem;
  padding: 1rem;
  background: var(--bg-page);
  border-radius: 12px;
  border: 1px solid var(--surface-soft);
}

.hint {
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
  color: var(--text-muted);
  line-height: 1.6;
}

.hint strong {
  color: var(--text-body);
}

.hint:last-child {
  margin-bottom: 0;
}

.info-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.5rem 0;
}

/* ─── 模型配置 ─── */
.key-config input {
  width: 100%;
  padding: 0.625rem 0.85rem;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  font-size: 0.9rem;
  margin-bottom: 0.75rem;
  box-sizing: border-box;
  background: var(--surface-white);
  color: var(--text-main);
}

.key-config input:focus {
  outline: none;
  border-color: var(--brand-text);
  box-shadow: 0 0 0 3px rgba(107, 123, 219, 0.15);
}

.provider-row {
  border: 1px solid var(--border-light);
  border-radius: 12px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 8px;
  background: var(--surface-white);
}

.row-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.row-identity {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.row-name {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--text-main);
}

.row-tag {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--border-light);
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--text-muted);
}

.key-state {
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
}

.key-state.ok {
  color: var(--success);
}

.key-state.missing {
  color: #ef4444;
}

.row-name-missing {
  color: var(--danger);
}

.official-key-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 0.75rem;
}

.official-key-actions .hint {
  margin: 0;
}

.row-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.override-warning {
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid #fcd34d;
  border-radius: 8px;
  background: #fffbeb;
  color: #92400e;
  font-size: 0.85rem;
  line-height: 1.5;
}

.override-url {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.add-actions {
  display: flex;
  gap: 8px;
  margin: 4px 0 12px;
}

.models-editor {
  margin: 0.25rem 0 0.75rem;
  padding: 0.75rem;
  border: 1px dashed #cbd5e1;
  border-radius: 10px;
  background: var(--bg-page);
}

.models-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: var(--text-body);
  font-size: 0.9rem;
}

.models-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 0.5rem;
}

.models-table th {
  text-align: left;
  font-size: 0.75rem;
  color: var(--text-faint);
  font-weight: 600;
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid var(--surface-soft);
  background: transparent;
}

.models-table td {
  padding: 0.25rem 0.4rem;
}

.models-table input {
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  font-size: 0.85rem;
  box-sizing: border-box;
  margin: 0;
}

.models-table td:last-child {
  width: 2.5rem;
  text-align: center;
}

/* ─── 我的技能 ─── */
.skill-subsection {
  margin-top: 1rem;
}

.skill-subsection h3 {
  font-size: 0.95rem;
  color: var(--text-body);
  margin: 0 0 0.5rem;
}

.skill-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--surface-soft);
  border-radius: 10px;
  margin-bottom: 0.5rem;
  background: var(--bg-page);
}

.skill-row-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.skill-row-main strong {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9rem;
}

.skill-desc {
  font-size: 0.8rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── CWT 验证 ─── */

/* ─── 对话框 ─── */
.import-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.import-panel {
  background: var(--surface-white);
  border-radius: 16px;
  padding: 1.5rem;
  max-width: 560px;
  width: calc(100% - 2rem);
  max-height: 86vh;
  overflow: auto;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}

.import-panel h3 {
  margin: 0 0 0.5rem;
  font-size: 1.05rem;
}

.import-field {
  margin: 0.75rem 0;
}

.import-field label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-bottom: 0.25rem;
  font-weight: 600;
}

.import-field input[type='text'],
.import-field select,
.import-field textarea,
.import-field input:not([type='file']) {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  font-size: 0.9rem;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--surface-white);
  color: var(--text-main);
}

/* 下拉框自绘箭头：文字左右等距（原生箭头挤右侧会失衡） */
.import-field select {
  -webkit-appearance: none;
  appearance: none;
  padding: 0.5rem 1.85rem 0.5rem 0.6rem;
  background: var(--surface-white)
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='7' viewBox='0 0 11 7'><path d='M1 1l4.5 4.5L10 1' fill='none' stroke='%2364748b' stroke-width='1.6' stroke-linecap='round'/></svg>")
    no-repeat right 0.7rem center;
}

.share-empty-hint {
  padding: 0.5rem 0.6rem;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  background: var(--bg-page);
}

.import-field textarea {
  resize: vertical;
}

.share-conflict {
  padding: 0.65rem 0.75rem;
  border: 1px solid #fcd34d;
  border-radius: 10px;
  background: #fffbeb;
}

/* 缩写地址/镜像 ID：悬停立即弹出完整值。
   用自绘 tooltip 而不是原生 title —— 原生有约 1 秒延迟、样式不可控、不能选中。 */
/* 悬停提示是元素的 ::after 子节点：带 overflow:hidden 的省略号会把提示裁掉。
   凡承载 data-full 提示的元素一律不裁剪，短展示由 JS 头尾截取负责 */

/* ─── v1.4 凭证体系 ─── */
.spin {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  margin-left: auto;
  border: 2px solid rgba(107, 123, 219, 0.25);
  border-top-color: var(--brand-text);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.copy-mini {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 0.8em;
  padding: 0 0.2rem;
  opacity: 0.6;
  vertical-align: baseline;
  flex-shrink: 0;
}
.copy-mini:hover {
  opacity: 1;
}
</style>
