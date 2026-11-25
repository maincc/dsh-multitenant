<!-- 容器管理 tab（P3 拆分自 UserCenter）：三段页签 信息/技能/环境现场。
     cSub 属本 tab UI 态归组件本地；深链段经 props initialSub。
     容器运维走 useUserContainer、我的技能走 useUserSkills（皆单例，
     壳的地址切换/进页自检仍调同名导出）。 -->
<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserContainer } from '../../composables/useUserContainer.js'
import { useUserSkills } from '../../composables/useUserSkills.js'
import { tierBadge, statusBadge } from '../admin/shared.js'
import { formatBytes, shortAddress } from '../../utils/format.js'
import SkillMarket from '../../views/SkillMarket.vue'
import EnvTemplatesUser from '../../components/EnvTemplatesUser.vue'

const { t } = useI18n()
const statusText = (status) => {
  const map = {
    running: t('user.statusRunning'),
    stopped: t('user.statusStopped'),
    destroyed: t('user.statusDestroyed'),
    none: t('user.statusNone'),
    null: t('user.statusNone'),
  }
  if (!status) return map.none
  return map[status] || status
}

const props = defineProps({
  initialSub: { type: String, default: 'info' },
  marketCat: { type: String, default: 'skills' },
})

const {
  containerBooting,
  bootNotice,
  autoBootContainer,
  restartContainer,
  restartDSH,
  resetContainer,
  stopContainer,
  userInfo,
  connected,
} = useUserContainer()
const {
  mineData,
  mySkillsLoading,
  importDialogOpen,
  importName,
  importText,
  importBusy,
  fetchMine,
  loadMine,
  loadContainerSkills,
  openImportDialog,
  closeImportDialog,
  onImportFile,
  doImport,
  unpublishSkill,
  uninstallSkill,
  shareDialogOpen,
  shareSourceName,
  shareRenameTo,
  shareBusy,
  shareConflict,
  shareLoading,
  openShareDialog,
  closeShareDialog,
  doShare,
} = useUserSkills()

const cSub = ref(props.initialSub || 'info')
watch(
  () => props.initialSub,
  (v) => {
    if (v) cSub.value = v
  },
)
</script>

<template>
  <div>
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
          <span class="badge" :class="tierBadge(userInfo.tier)">{{ userInfo.tierLabel }}</span>
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
              <span v-if="s.hasUpdate" class="badge badge-warning">{{ $t('user.hasUpdate') }}</span>
            </div>
            <button class="btn btn-small btn-danger" @click="uninstallSkill(s.name)">
              {{ $t('user.uninstall') }}
            </button>
          </div>
        </div>
        <p v-if="mineData.published.length === 0 && mineData.installed.length === 0" class="hint">
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
                    kind: pl.kind === 'file' ? $t('user.pluginFileTag') : $t('user.pluginDirTag'),
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
          <select v-model="shareSourceName" :disabled="shareLoading || shareConflict || shareBusy">
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
</template>

<style scoped>
.tab-content.admin-embed {
  padding: 0;
  display: block;
}

.btn-enter {
  padding: 0.75rem 2rem;
  font-size: 1rem;
}

.enter-box .btn-enter {
  flex-shrink: 0;
  margin: 0;
}

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

.enter-hint {
  font-size: 0.8rem;
  color: var(--text-muted);
  line-height: 1.5;
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

.import-field select {
  -webkit-appearance: none;
  appearance: none;
  padding: 0.5rem 1.85rem 0.5rem 0.6rem;
  background: var(--surface-white)
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='11' height='7' viewBox='0 0 11 7'><path d='M1 1l4.5 4.5L10 1' fill='none' stroke='%2364748b' stroke-width='1.6' stroke-linecap='round'/></svg>")
    no-repeat right 0.7rem center;
}

.import-field textarea {
  resize: vertical;
}

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

.info-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.5rem 0;
}

.resource-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.375rem;
  font-weight: 500;
  font-size: 13px;
  color: var(--text-secondary);
}

.resource-item {
  padding: 0.75rem 1rem;
  background: var(--bg-page);
  border-radius: 12px;
  border: 1px solid var(--surface-soft);
}

.resource-usage {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.share-conflict {
  padding: 0.65rem 0.75rem;
  border: 1px solid #fcd34d;
  border-radius: 10px;
  background: #fffbeb;
}

.share-empty-hint {
  padding: 0.5rem 0.6rem;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  background: var(--bg-page);
}

.skill-actions {
  margin: 0.5rem 0 1rem;
}

.skill-desc {
  font-size: 0.8rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.skill-subsection {
  margin-top: 1rem;
}

.skill-subsection h3 {
  font-size: 0.95rem;
  color: var(--text-body);
  margin: 0 0 0.5rem;
}

.tab-content {
  animation: fadeIn 0.25s;
}

.tab-divider {
  border-top: 1px solid var(--surface-soft);
  margin: 1.25rem 0;
}
</style>
