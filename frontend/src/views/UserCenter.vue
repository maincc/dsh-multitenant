<template>
  <div class="user-center">
    <!-- 加载页面 -->
    <div v-if="loading" class="card loading-card">
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

    <!-- 连接钱包页面 -->
    <div v-else-if="!connected" class="card connect-card">
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

    <!-- 等待队列页面 -->
    <div v-else-if="waiting" class="card waiting-card">
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

    <!-- 用户信息页面 -->
    <div v-else class="user-dashboard">
      <div class="card">
        <h2>{{ $t('user.myAccount') }}</h2>
        <div class="user-info">
          <div class="info-row">
            <span class="label">{{ $t('user.swtcAddress') }}</span>
            <span class="address">{{ userInfo.address }}</span>
            <button class="btn btn-small" @click="switchAddress">
              {{ $t('user.switchAddress') }}
            </button>
          </div>
          <div class="info-row">
            <span class="label">{{ $t('user.port') }}</span>
            <span>{{ userInfo.port }}</span>
          </div>
          <div class="info-row">
            <span class="label">{{ $t('user.tier') }}</span>
            <span class="badge" :class="tierBadge(userInfo.tier)">{{ userInfo.tierLabel }}</span>
          </div>
          <div class="info-row">
            <span class="label">{{ $t('user.containerStatus') }}</span>
            <span class="badge" :class="statusBadge(userInfo.status)">{{
              statusText(userInfo.status)
            }}</span>
            <button
              v-if="userInfo.status !== 'running'"
              class="btn btn-small btn-success"
              @click="restartContainer"
            >
              {{ $t('user.startContainer') }}
            </button>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>{{ $t('user.cwtVerify') }}</h2>
        <p>{{ $t('user.cwtVerifyHint') }}</p>

        <div v-if="cwtLoading" class="config-loading">
          <div class="mini-spinner"></div>
          <span>{{ $t('user.cwtLoading') }}</span>
        </div>

        <template v-else-if="cwtStatus">
          <!-- 已授权 -->
          <div v-if="cwtStatus.authorized" class="info-row">
            <span class="badge badge-success">{{ $t('user.cwtAuthorized') }}</span>
            <span class="cwt-meta">usr: {{ cwtStatus.registry?.usr }}</span>
          </div>

          <!-- 待审批 -->
          <div v-else-if="hasPendingApplication" class="info-row">
            <span class="badge badge-warning">{{ $t('user.cwtPending') }}</span>
            <span class="cwt-meta">
              {{ $t('user.cwtPendingHint', { text: pendingAppText }) }}
            </span>
          </div>

          <!-- 未申请 / 被拒 / 已撤销 -->
          <div v-else>
            <p class="cwt-meta">
              {{ $t('user.cwtNotVerified', { min: dailyLimitText }) }}
              {{
                cwtStatus.applications?.[0]?.status === 'rejected' ? $t('user.cwtRejectedHint') : ''
              }}
            </p>
            <div class="cwt-apply-form">
              <button class="btn btn-primary" :disabled="cwtSubmitting" @click="applyCwt">
                {{ cwtSubmitting ? $t('user.cwtSigning') : $t('user.cwtApplyBtn') }}
              </button>
              <div class="action-hints">
                <div class="hint">
                  <strong>{{ $t('user.cwtFlowTitle') }}</strong>
                  {{ $t('user.cwtFlow') }}
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div class="card">
        <h2>{{ $t('user.resourceUsage') }}</h2>
        <div v-if="userInfo.stats" class="resource-usage">
          <div class="resource-item">
            <div class="resource-header">
              <span>{{ $t('user.cpuUsage') }}</span>
              <span>{{ userInfo.stats.cpu }}</span>
            </div>
          </div>
          <div class="resource-item">
            <div class="resource-header">
              <span>{{ $t('user.memUsage') }}</span>
              <span>{{ userInfo.stats.memory }} ({{ userInfo.stats.memoryPercent }})</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: userInfo.stats.memoryPercent }"></div>
            </div>
          </div>
        </div>
        <div v-else class="loading">{{ $t('user.noData') }}</div>
      </div>

      <div class="card">
        <h2>{{ $t('user.enterDsh') }}</h2>
        <p>{{ $t('user.enterDshHint') }}</p>
        <a
          href="#"
          @click.prevent="enterDsh"
          rel="noopener noreferrer"
          class="btn btn-success btn-large"
        >
          {{ $t('user.openDsh') }}
        </a>
      </div>

      <div class="card">
        <h2>{{ $t('user.modelConfig') }}</h2>
        <p>
          {{ $t('user.modelConfigHint') }}
        </p>
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
                          <input v-model="m.name" :placeholder="$t('user.placeholderModelName')" />
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
            <button class="btn btn-primary" :disabled="!connected || keySaving" @click="saveConfig">
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

      <div class="card">
        <h2>{{ $t('user.containerManage') }}</h2>
        <p>{{ $t('user.containerManageHint') }}</p>
        <div class="action-buttons">
          <button class="btn btn-primary" @click="restartDSH">{{ $t('user.restartDsh') }}</button>
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

      <div class="card">
        <h2>{{ $t('user.mySkills') }}</h2>
        <p>{{ $t('user.mySkillsHint') }}</p>
        <div class="action-buttons">
          <button class="btn btn-primary" @click="openImportDialog">
            {{ $t('user.importSkill') }}
          </button>
          <button class="btn btn-primary" @click="openShareDialog">
            {{ $t('user.shareSkill') }}
          </button>
          <router-link to="/skills" class="btn btn-secondary">{{
            $t('user.skillMarketLink')
          }}</router-link>
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
            <div v-for="s in mineData.installed" :key="'i-' + s.name" class="skill-row">
              <div class="skill-row-main">
                <strong>{{ s.name }}</strong>
                <span class="skill-desc">
                  {{
                    s.description ||
                    $t('user.installedSource', {
                      source: s.source,
                      date: new Date(s.installedAt).toLocaleString(),
                    })
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
          <p v-if="mineData.published.length === 0 && mineData.installed.length === 0" class="hint">
            {{ $t('user.noSkillsHint') }}
          </p>
        </template>
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
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import axios from 'axios'
import { useI18n } from 'vue-i18n'
import { skillsApi } from '../api/skills.js'
import { requestAccounts, signMessage, getPublicKey, watchAccountsChanged } from '../api/wallet.js'

const { t } = useI18n()

const connected = ref(false)
const connecting = ref(false)
const hasCCDAO = ref(false)
const userInfo = ref({})
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

const fetchUsage = async (address) => {
  try {
    const res = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)
    usageInfo.value = res.data.usage || null
  } catch {
    usageInfo.value = null
  }
}

// ---- CWT 验证状态（M1：展示 + 插件签名申请）----
const cwtStatus = ref(null)
const cwtLoading = ref(false)
const cwtSubmitting = ref(false)

const hasPendingApplication = computed(() =>
  (cwtStatus.value?.applications || []).some((a) => a.status === 'pending'),
)

const pendingAppText = computed(() => {
  const app = (cwtStatus.value?.applications || []).find((a) => a.status === 'pending')
  return app
    ? t('user.pendingAppText', { id: app.id, date: new Date(app.submittedAt).toLocaleString() })
    : ''
})

const dailyLimitText = computed(() => usageInfo.value?.dailyMinutes ?? '120')

const fetchCwtStatus = async (address) => {
  if (!address) return
  try {
    cwtLoading.value = true
    const res = await axios.get(`/api/user/cwt/status?address=${encodeURIComponent(address)}`)
    cwtStatus.value = res.data || null
  } catch {
    cwtStatus.value = null
  } finally {
    cwtLoading.value = false
  }
}

/**
 * 申请 CWT 验证：点击 → 插件 cwt_sign 签名（usr 统一为 dsh-usr）→ 自动提交后端。
 * 插件弹窗确认后返回 token（header.payload.Signature），无需用户手动粘贴。
 * cwt_sign 参数：对象 { address: 插件当前账户(原始大小写), usr: 'dsh-usr' }。
 */
const applyCwt = async () => {
  if (!window.ccdao || !window.ccdao.request) {
    alert(t('user.errNoCcdao'))
    return
  }
  cwtSubmitting.value = true
  try {
    // 插件当前账户（requestAccounts 返回原始大小写，插件 accounts.includes 大小写敏感）
    const pluginAddress = await requestAccounts()
    // 插件 cwt_sign：usr 统一使用平台标识 dsh-usr（用户无需输入）
    const result = await window.ccdao.request({
      method: 'cwt_sign',
      params: [{ address: pluginAddress, usr: 'dsh-usr' }],
    })
    const token = typeof result === 'string' ? result : (result?.token ?? result?.signature)
    if (!token) {
      throw new Error(t('user.errNoToken'))
    }
    await axios.post('/api/user/cwt/apply', { token })
    alert(t('user.cwtAppliedOk'))
    await fetchCwtStatus(userInfo.value.address)
  } catch (err) {
    alert(t('user.cwtApplyFail', { err: err.response?.data?.error || err.message }))
  } finally {
    cwtSubmitting.value = false
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
  if (customCount.value >= 20) return alert(t('user.limitEndpoints'))
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

const removeItem = (idx) => {
  const item = items.value[idx]
  if (!confirm(t('user.confirmRemoveEndpoint', { name: item.displayName || t('user.unnamed') })))
    return
  items.value.splice(idx, 1)
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
 * 关键：签名对象必须用插件【当前选中的账户】，否则插件会以
 * "The requested account and/or method has not been authorized" 拒绝
 * （源码：swtc_signMessage 检查 accounts.includes(from)）。
 * 返回的 address 即插件当前账户，后续提交/清除都用它（写的是该账户自己的卷）。
 */
const signChallenge = async () => {
  if (!window.ccdao || !window.ccdao.request) {
    throw new Error(t('user.errNoCcdao'))
  }
  // 1. 插件当前账户【保留原始大小写】！
  //    插件的 accounts.includes() 是大小写敏感严格匹配：把 jNDwRet... 转成
  //    jndwret... 再传回去会被判"未授权"(4100)。只有 requestAccounts 原样
  //    返回的字符串才能通过。后端 normalizeAddress 会自己转小写，无需担心。
  const pluginAddress = await requestAccounts()
  // 2. 领一次性挑战
  const challengeRes = await axios.post('/api/user/config-challenge', { address: pluginAddress })
  const nonce = challengeRes.data.nonce
  // 3. 插件对 nonce 签名 + 取公钥（都用原始大小写地址）
  const signature = await signMessage(pluginAddress, nonce)
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
const friendlyPluginError = (err) => {
  const msg = err.response?.data?.error || err.message || t('user.unknownError')
  if (/not been authorized|unauthorized/i.test(String(msg))) {
    return t('user.pluginNotAuthorized')
  }
  return msg
}

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
  if (!currentAddress()) return alert(t('user.errConnectFirst'))
  const check = validateAll()
  if (!check.ok) return alert(check.msg)

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
    alert(t('user.savedOk'))
  } catch (err) {
    alert(t('user.saveFail', { err: friendlyPluginError(err) }))
  } finally {
    keySaving.value = false
  }
}

/** 探测某个自定义端点的模型列表（优先用输入框 key，否则用该端点已存 key） */
const discoverItem = async (idx) => {
  if (!currentAddress()) return alert(t('user.errConnectFirst'))
  const item = items.value[idx]
  if (!item?.baseURL?.trim()) return alert(t('user.errNeedBaseUrl'))
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
      alert(t('user.discoverEmpty'))
    } else {
      alert(
        t('user.discoveredOk', {
          count: models.length,
          name: item.displayName || t('user.unnamed'),
        }),
      )
    }
  } catch (err) {
    alert(t('user.discoverFail', { err: friendlyPluginError(err) }))
  } finally {
    discovering.value = null
  }
}

/** 只删除官方 DeepSeek API Key（不影响端点覆盖与自定义端点，需签名） */
const clearOfficialKey = async () => {
  if (!currentAddress()) return alert(t('user.errConnectFirst'))
  if (!confirm(t('user.confirmClearOfficialKey'))) return
  keySaving.value = true
  try {
    const { address, nonce, signature, publicKey } = await signChallenge()
    await axios.delete('/api/user/tenant-config', {
      data: { address, nonce, signature, publicKey, scope: 'official-key' },
    })
    await syncWalletAccount(address)
    alert(t('user.officialKeyCleared'))
  } catch (err) {
    alert(t('user.delFail', { err: friendlyPluginError(err) }))
  } finally {
    keySaving.value = false
  }
}

/** 恢复默认：清除官方 key + 官方端点覆盖 + 所有自定义端点（需签名） */
const resetConfig = async () => {
  if (!currentAddress()) return alert(t('user.errConnectFirst'))
  const customLine =
    customCount.value > 0 ? t('user.confirmResetCustomLine', { n: customCount.value }) : ''
  if (!confirm(t('user.confirmResetBase1') + customLine + t('user.confirmResetBase2'))) return
  keySaving.value = true
  try {
    const { address, nonce, signature, publicKey } = await signChallenge()
    await axios.delete('/api/user/tenant-config', {
      data: { address, nonce, signature, publicKey },
    })
    await syncWalletAccount(address)
    alert(t('user.resetOk'))
  } catch (err) {
    alert(t('user.resetFail', { err: friendlyPluginError(err) }))
  } finally {
    keySaving.value = false
  }
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
    alert(t('user.walletDisconnected'))
    return
  }

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

// 处理地址变化的通用函数
const handleAddressChange = async (newAddress, isInitialLoad = false) => {
  const oldAddress = localStorage.getItem('swtc_address')
  console.log(
    `[flow] F3 handleAddressChange 进入 (${isInitialLoad ? '初始加载' : '按钮/事件'}, old=${oldAddress}, new=${newAddress})`,
  )

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
    mineData.value = { published: [], installed: [], inContainer: [] }
    mySkillsLoading.value = true
    userInfo.value = {}
    connected.value = false
    usageInfo.value = null
    cwtStatus.value = null
  }

  try {
    // 显示加载页面
    console.log('[flow] L1 loading=10% 验证地址')
    showLoading(t('user.loadingConnect'), t('user.loadingVerify'), 10)

    // 关键：无论地址是否变化，都要确保容器存在并运行
    const containerStatus = await ensureContainer(newAddress)

    // 如果在等待队列中，不继续加载用户信息
    if (containerStatus === 'waiting') {
      hideLoading()
      // 保存地址
      localStorage.setItem('swtc_address', newAddress)
      return
    }

    // 今日额度用完：明确提示（初始加载不打扰），不再弹签名/进队列
    if (containerStatus === 'usage-limit') {
      hideLoading()
      localStorage.setItem('swtc_address', newAddress)
      if (!isInitialLoad) {
        alert(lastConnect202Message || t('user.usageLimitReached'))
      }
      return
    }

    // 更新加载状态
    showLoading(
      t('user.loadingCreateContainer'),
      containerStatus === 'created' ? t('user.loadingFirstStart') : t('user.loadingStartExisting'),
      50,
    )

    // 保存地址（即使是相同的地址也要保存，确保格式正确）
    localStorage.setItem('swtc_address', newAddress)

    // 获取用户信息
    showLoading(t('user.loadingFetchInfo'), t('user.loadingAccountData'), 80)
    await fetchUserInfo(newAddress)

    // 关键：设置 connected 为 true，否则页面不显示用户信息
    if (userInfo.value.address) {
      connected.value = true
      console.log('[flow] L4 connected=true → hideLoading（loading 在此结束）')
      console.log('[UserCenter] 已设置 connected = true')
      hideLoading()
    } else {
      console.error('[UserCenter] userInfo.value.address 为空，无法设置 connected')
      hideLoading()
    }

    // 只在地址真正变化时才显示提示
    if (!isInitialLoad && newAddress !== oldAddress) {
      alert(t('user.switchedAddress', { addr: `${newAddress.slice(0, 10)}...` }))
    }

    // 切换/连接后刷新"我的技能"为当前地址的个人视图
    console.log('[flow] F13 loadMine 开始（loading 已结束）')
    await loadMine()
    console.log('[flow] F13b loadMine 完成')
  } catch (err) {
    console.error('[UserCenter] 处理地址失败:', err)
    hideLoading()
    if (!isInitialLoad) {
      alert(t('user.addressFail', { err: err.message }))
    }
  }
}

const connectWallet = async () => {
  console.log('[flow] F1 connectWallet 进入')
  if (!hasCCDAO.value) return

  connecting.value = true
  // 钱包弹窗请求账户期间先给反馈；后续 handleAddressChange 会覆盖进度继续展示
  showLoading(t('user.connecting'), t('user.loadingWalletConnect'), 5)
  try {
    const pluginAddress = await requestAccounts()

    // 统一转小写
    const address = pluginAddress.toLowerCase()
    console.log('[flow] F2 拿到地址:', address)
    console.log('[UserCenter] 连接钱包，地址:', address)

    // 使用通用处理函数
    await handleAddressChange(address)
  } catch (err) {
    console.error('[UserCenter] 连接失败:', err)
    alert(t('user.connectFail', { err: err.message }))
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
  console.log('[flow] F6 connectWithOwnership 进入（签名链路）')
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
    // 覆盖"钱包弹窗请求账户 → 领取挑战 → 等待签名 → 建立连接"的每个耗时环节
    showLoading(title, t('user.loadingVerify'), progress0)

    const pluginAddress = await requestAccounts()
    // 1) 领取一次性挑战（按插件账户下发，5 分钟有效）
    showLoading(title, t('user.loadingWalletConnect'), Math.max(progress0, 25))
    const challengeRes = await axios.post('/api/user/config-challenge', {
      address: pluginAddress,
    })
    const nonce = challengeRes.data.nonce
    console.log('[flow] F7 挑战获取完成 nonce.length=' + (nonce ? String(nonce).length : 0))
    // 2) 插件签名（用户确认弹窗，可能等待较久）
    showLoading(title, t('user.loadingSign'), Math.max(progress0, 45))
    const signature = await signMessage(pluginAddress, nonce)
    const publicKey = await getPublicKey(pluginAddress)
    console.log('[flow] F8 钱包签名+公钥完成')
    // 3) 带签名访问 /connect（已存在容器同样验签并发 cookie）
    // format=json：浏览器 fetch 的 redirect:manual 会把 302 包成 opaque (status 0)，
    // 取不到 location → 后端直接回 200 JSON {url}，前端 window.open。
    showLoading(title, t('user.loadingEstablish'), Math.max(progress0, 70))
    const params = new URLSearchParams({ address, nonce, signature, publicKey, format: 'json' })
    console.log('[flow] F9a 发起 /connect（带签名）')
    const cRes = await fetch(`/connect?${params}`)
    console.log('[flow] F9b /connect 返回 status=' + cRes.status)
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
    alert(t('user.errConnectFirst'))
    return
  }
  if (!window.ccdao) {
    alert(t('user.errNoAccount'))
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
        console.log('[flow] F14 打开容器页: ' + data.url)
        window.open(data.url, '_blank', 'noopener')
        return
      }
      alert(data?.message || data?.error || t('user.enterDshFail', { err: res.status }))
      return
    }
    if (res.status === 302) {
      const loc = res.headers.get('location')
      if (loc) {
        console.log('[flow] F14 302 打开容器页: ' + loc)
        window.open(loc, '_blank', 'noopener')
      }
      return
    }
    if (res.status === 202) {
      const data = await res.json()
      alert(data.message || data.error || '资源不足，请等待')
      return
    }
    alert(t('user.enterDshFail', { err: res.status }))
  } catch (err) {
    hideLoading()
    alert(t('user.enterDshFail', { err: err.message || err }))
  }
}

// 最近一次 /connect 202 的后端提示（资源不足/额度用完），供上层展示
let lastConnect202Message = ''
const ensureContainer = async (address) => {
  console.log('[flow] F4a ensureContainer 进入')
  // 先检查容器状态
  try {
    const statusRes = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)
    console.log(
      `[flow] F4b /connect-status 返回 exists=${statusRes.data.exists} status=${statusRes.data.status}`,
    )

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
      console.log('[flow] F5 容器不存在 → 签名并创建')
      console.log('[UserCenter] 容器不存在，正在创建...')
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
}

const fetchUserInfo = async (address) => {
  console.log('[flow] F11 fetchUserInfo 开始')
  // 门控 loading：仅当调用方没有在展示 loading 时才自己开/关，
  // 避免打断 handleAddressChange 的整体加载流程（它自己会 hide）
  const opened = !loading.value
  if (opened) showLoading(t('user.loadingFetchInfo'), t('user.loadingAccountData'), 80)
  try {
    const res = await axios.get(`/api/user/${address}`)
    console.log(
      '[flow] F12 用户信息返回 OK, address=' +
        (res.data?.address || '(空)') +
        ', status=' +
        res.data?.status,
    )
    userInfo.value = res.data
    fetchUsage(address)
    fetchCwtStatus(address)
    fetchConfigStatus()
  } catch (err) {
    console.error('获取用户信息失败:', err)

    // 如果是 400 错误，说明地址无效，清除 localStorage
    if (err.response?.status === 400) {
      console.warn('[UserCenter] 地址无效，清除 localStorage')
      localStorage.removeItem('swtc_address')
      connected.value = false
      userInfo.value = {}
      alert(t('user.invalidAddress'))
      return
    }

    // 403（会话无效/他人地址）：不打断、不弹错——签名连接后自动解锁
    if (err.response?.status === 403) {
      console.warn('[UserCenter] 用户信息需完成签名连接后解锁（403），请点击「进入 DSH」')
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

const switchAddress = async () => {
  if (!hasCCDAO.value) {
    alert(t('user.errInstallCcdao'))
    return
  }

  try {
    const pluginAddress = await requestAccounts()

    if (!pluginAddress) {
      throw new Error(t('user.noAccounts'))
    }

    // 统一转小写
    const newAddress = accounts[0].toLowerCase()
    console.log('[UserCenter] 切换地址:', newAddress)

    // 使用通用处理函数
    await handleAddressChange(newAddress)
  } catch (err) {
    console.error('[UserCenter] 切换失败:', err)
    alert(t('user.switchFail', { err: err.message }))
  }
}

const restartContainer = async () => {
  try {
    const address = userInfo.value.address
    showLoading(t('user.loadingStarting'), t('user.loadingPleaseWait'), 40)

    await connectWithOwnership(address, {
      title: t('user.loadingStarting'),
      progress: 40,
    })

    // 等待容器完全就绪
    await new Promise((resolve) => setTimeout(resolve, 5000))

    await fetchUserInfo(address)
    hideLoading()
    alert(t('user.startedOk'))
  } catch (err) {
    hideLoading()
    alert(t('user.startFail', { err: err.message }))
  }
}

const restartDSH = async () => {
  if (!confirm(t('user.confirmRestartDsh'))) return

  try {
    const address = userInfo.value.address
    showLoading(t('user.loadingRestarting'), t('user.loadingPleaseWait'), 50)

    const res = await axios.post(`/api/user/${address}/restart`)

    // 等待容器完全就绪
    await new Promise((resolve) => setTimeout(resolve, 5000))

    await fetchUserInfo(address)
    hideLoading()
    alert(t('user.restartedOk'))
  } catch (err) {
    hideLoading()
    alert(t('user.restartFail', { err: err.response?.data?.error || err.message }))
  }
}

const resetContainer = async () => {
  if (!confirm(t('user.confirmResetContainer'))) return

  if (!confirm(t('user.confirmResetContainer2'))) return

  try {
    const address = userInfo.value.address
    showLoading(t('user.loadingResetting'), t('user.loadingDeleteRebuild'), 50)

    // 后端在同一个请求里完成「清空旧容器/数据 → 重建全新容器 → 签发会话」，
    // 返回新容器 url，前端直接打开即可（无需手动重新连接）
    const res = await axios.post(`/api/user/${address}/reset`)

    hideLoading()
    const { url } = res.data
    if (url) window.open(url, '_blank', 'noopener')
    alert(t('user.resetContainerOk'))
  } catch (err) {
    hideLoading()
    alert(t('user.resetContainerFail', { err: err.response?.data?.error || err.message }))
  }
}

/**
 * 主动停止自己的容器：立即结算今日使用时长并保全剩余额度
 * （停止期间不计时，挂机不再消耗每日限额；数据保留，随时可重新启动）
 */
const stopContainer = async () => {
  if (!confirm(t('user.confirmStopContainer'))) return

  try {
    const address = userInfo.value.address
    showLoading(t('user.loadingStopping'), t('user.loadingSettleStop'), 50)

    await axios.post(`/api/user/${address}/stop`)

    await fetchUserInfo(address)
    hideLoading()
    alert(t('user.stoppedOk'))
  } catch (err) {
    hideLoading()
    alert(t('user.stopFail', { err: err.response?.data?.error || err.message }))
  }
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
  }
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
            alert(t('user.sessionMismatchRevoked'))
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
  await loadMine()
})

// ===================== 🧩 我的技能（技能市场集成） =====================
const mineData = ref({ published: [], installed: [], inContainer: [] })
const mySkillsLoading = ref(true) // 初始即 loading：面板首帧显示 spinner，避免空态闪现后突然出数据
const importDialogOpen = ref(false)
const importName = ref('')
const importText = ref('')
const importBusy = ref(false)

/** 拉取 mine 数据（含签名） */
const fetchMine = async () => {
  const sig = await signChallenge()
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
      }
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
  if (v) loadMine()
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
    alert(t('user.errNeedSkillName'))
    return
  }
  if (!importText.value.trim()) {
    alert(t('user.errNeedSkillText'))
    return
  }
  importBusy.value = true
  try {
    const sig = await signChallenge()
    await skillsApi.importSkill(sig, name, importText.value)
    alert(t('user.importedOk', { name }))
    closeImportDialog()
    await loadMine()
  } catch (err) {
    alert(t('user.importFail', { err: friendlyPluginError(err) }))
  } finally {
    importBusy.value = false
  }
}

const unpublishSkill = async (name) => {
  if (!confirm(t('user.confirmUnpublish', { name }))) return
  try {
    const sig = await signChallenge()
    await skillsApi.unpublish(sig, name)
    await loadMine()
  } catch (err) {
    alert(t('user.opFail', { err: friendlyPluginError(err) }))
  }
}

const uninstallSkill = async (name) => {
  if (!confirm(t('user.confirmUninstall', { name }))) return
  try {
    const sig = await signChallenge()
    await skillsApi.uninstall(sig, name)
    await loadMine()
  } catch (err) {
    alert(t('user.uninstallFail', { err: friendlyPluginError(err) }))
  }
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
    alert(t('user.errNeedShareSource'))
    return
  }
  const renameTo = shareConflict.value ? shareRenameTo.value.trim() : ''
  if (shareConflict.value && !renameTo) {
    alert(t('user.errNeedShareRename'))
    return
  }
  shareBusy.value = true
  try {
    const sig = await signChallenge()
    await skillsApi.publish(sig, source, renameTo || undefined)
    alert(
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
    alert(t('user.shareFail', { err: friendlyPluginError(err) }))
  } finally {
    shareBusy.value = false
  }
}

onUnmounted(() => {
  // 解绑账户监听，避免组件重挂载后重复监听
  unbindAccounts?.()
  unbindAccounts = null
})
</script>

<style scoped>
.user-center {
  animation: fadeIn 0.3s;
}

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

.loading-card {
  text-align: center;
  padding: 3rem;
}

.loading-spinner {
  margin-bottom: 2rem;
}

.spinner {
  width: 60px;
  height: 60px;
  border: 6px solid #f3f4f6;
  border-top: 6px solid #667eea;
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

.loading-card h2 {
  font-size: 1.8rem;
  margin-bottom: 1rem;
  color: #374151;
}

.loading-message {
  color: #6b7280;
  margin-bottom: 2rem;
}

.loading-progress {
  max-width: 400px;
  margin: 0 auto;
}

.progress-bar {
  width: 100%;
  height: 8px;
  background: #f3f4f6;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 0.9rem;
  color: #6b7280;
}

.connect-card {
  text-align: center;
  padding: 3rem;
}

.connect-card h2 {
  font-size: 1.8rem;
  margin-bottom: 1rem;
}

.connect-card p {
  color: #6b7280;
  margin-bottom: 2rem;
}

.btn-large {
  padding: 0.75rem 2rem;
  font-size: 1.1rem;
}

.btn-small {
  padding: 0.25rem 0.75rem;
  font-size: 0.85rem;
  margin-left: 0.5rem;
}

.user-info {
  display: grid;
  gap: 1rem;
}

.info-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.info-row .label {
  font-weight: 600;
  color: #374151;
  min-width: 100px;
}

.info-row .address {
  font-family: monospace;
  background: #f3f4f6;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  word-break: break-all;
}

.resource-usage {
  display: grid;
  gap: 1.5rem;
}

.resource-item {
  padding: 1rem;
  background: #f9fafb;
  border-radius: 8px;
}

.resource-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.5rem;
  font-weight: 500;
}

.tier-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-top: 1rem;
}

.tier-option {
  padding: 1.5rem;
  background: #f9fafb;
  border-radius: 12px;
  border: 2px solid transparent;
  text-align: center;
}

.tier-option.current {
  border-color: #667eea;
  background: linear-gradient(135deg, #f0f4ff 0%, #faf5ff 100%);
}

.tier-option h4 {
  margin-bottom: 1rem;
  color: #374151;
}

.tier-option ul {
  list-style: none;
  margin-bottom: 1rem;
  text-align: left;
}

.tier-option li {
  padding: 0.25rem 0;
  font-size: 0.9rem;
  color: #6b7280;
}

/* 等待队列样式 */
.waiting-card {
  text-align: center;
  padding: 3rem;
  background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
  border: 2px solid #f59e0b;
}

.waiting-icon {
  font-size: 4rem;
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
  font-size: 1.8rem;
  margin-bottom: 1rem;
  color: #92400e;
}

.waiting-message {
  color: #78350f;
  margin-bottom: 0.5rem;
  font-size: 1rem;
}

.queue-info {
  background: white;
  border-radius: 12px;
  padding: 1.5rem;
  margin: 2rem 0;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.queue-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 0;
  border-bottom: 1px solid #f3f4f6;
}

.queue-item:last-child {
  border-bottom: none;
}

.queue-label {
  color: #6b7280;
  font-size: 0.9rem;
}

.queue-value {
  color: #1f2937;
  font-weight: 600;
  font-size: 1.1rem;
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
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.btn-secondary {
  background: #6b7280;
  color: white;
  padding: 0.75rem 2rem;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  transition: background 0.3s;
}

.btn-secondary:hover {
  background: #4b5563;
}

/* 容器管理卡片样式 */
.action-buttons {
  display: flex;
  gap: 1rem;
  margin: 1.5rem 0;
  flex-wrap: wrap;
}

.action-buttons .btn {
  flex: 1;
  min-width: 150px;
  padding: 0.75rem 1.5rem;
  font-size: 1rem;
}

.action-hints {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid #e5e7eb;
}

.hint {
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
  color: #6b7280;
  line-height: 1.5;
}

.hint strong {
  color: #374151;
}

.hint:last-child {
  margin-bottom: 0;
}

/* 我的模型密钥卡片 */
.key-config input {
  width: 100%;
  padding: 0.65rem 0.85rem;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 0.95rem;
  margin-bottom: 0.75rem;
  box-sizing: border-box;
}

.key-config input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}

.key-status {
  display: inline-block;
  padding: 0.3rem 0.8rem;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 600;
  background: #f3f4f6;
  color: #6b7280;
  margin-bottom: 0.75rem;
}

.key-status.ok {
  background: #d1fae5;
  color: #065f46;
}

/* 模型配置卡片：提供方行卡片（参考 DSH 模型设置页设计语言） */

.provider-row {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 8px;
  background: #fff;
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
  color: #1f2937;
}

.row-tag {
  flex: none;
  padding: 1px 6px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  color: #6b7280;
}

.cred-dot {
  box-sizing: border-box;
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.cred-dot.ok {
  background: #10b981;
}

.cred-dot.missing {
  background: #ef4444;
}

.key-state {
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
}

.key-state.ok {
  color: #10b981;
}

.key-state.missing {
  color: #ef4444;
}

.row-name-missing {
  color: #dc2626;
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
  border: 1px solid #f59e0b;
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
  border-radius: 8px;
  background: #fafbfc;
}

.models-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: #374151;
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
  color: #6b7280;
  font-weight: 600;
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid #e5e7eb;
}

.models-table td {
  padding: 0.25rem 0.4rem;
}

.models-table input {
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.85rem;
  box-sizing: border-box;
}

.models-table input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}

.models-table td:last-child {
  width: 2.5rem;
  text-align: center;
}

/* ===================== 我的技能 ===================== */
.skill-subsection {
  margin-top: 1rem;
}

.skill-subsection h3 {
  font-size: 0.95rem;
  color: #374151;
  margin: 0 0 0.5rem;
}

.skill-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin-bottom: 0.5rem;
  background: #fafbfc;
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
  color: #6b7280;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  background: #fff;
  border-radius: 14px;
  padding: 1.5rem;
  max-width: 560px;
  width: calc(100% - 2rem);
  max-height: 86vh;
  overflow: auto;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}

.import-panel h3 {
  margin: 0 0 0.5rem;
}

.import-field {
  margin: 0.75rem 0;
}

.import-field label {
  display: block;
  font-size: 0.8rem;
  color: #6b7280;
  margin-bottom: 0.25rem;
  font-weight: 600;
}

.import-field input[type='text'],
.import-field select,
.import-field textarea {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.9rem;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #fff;
}

.share-empty-hint {
  padding: 0.5rem 0.6rem;
  border: 1px dashed #d1d5db;
  border-radius: 6px;
}

.import-field textarea {
  resize: vertical;
}

.share-conflict {
  padding: 0.65rem 0.75rem;
  border: 1px solid #f59e0b;
  border-radius: 8px;
  background: #fffbeb;
}

/* ---- CWT 验证卡片（M1） ---- */
.cwt-meta {
  color: #666;
  font-size: 0.9rem;
  margin: 0.35rem 0;
}

.cwt-apply-form textarea {
  width: 100%;
  max-width: 560px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0.6rem;
  font-family: monospace;
  font-size: 0.82rem;
  resize: vertical;
  margin: 0.5rem 0;
}

.cwt-apply-form .btn {
  margin-top: 0.2rem;
}

/* ---- 凭 CWT 进入（出示 token 换会话） ---- */
.cwt-enter {
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px dashed #d1d5db;
}
.cwt-enter .btn {
  margin-right: 0.4rem;
}
.cwt-enter-paste {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.5rem;
  flex-wrap: wrap;
}
.cwt-token-input {
  flex: 1;
  min-width: 260px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0.5rem 0.6rem;
  font-family: monospace;
  font-size: 0.8rem;
}
</style>
