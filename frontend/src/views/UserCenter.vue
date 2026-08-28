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
      <h2>🔌 连接钱包</h2>
      <p>通过 CCDAO 插件连接您的 SWTC 钱包，自动分配专属 DSH 容器</p>

      <div v-if="!hasCCDAO" class="error">
        ❌ 未检测到 CCDAO 插件
        <br />
        <a
          href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
          target="_blank"
        >
          点击安装 CCDAO Connector
        </a>
      </div>

      <button v-else class="btn btn-primary btn-large" @click="connectWallet">
        连接 CCDAO 钱包
      </button>
    </div>

    <!-- 等待队列页面 -->
    <div v-else-if="waiting" class="card waiting-card">
      <div class="waiting-icon">⏳</div>
      <h2>资源不足，请等待</h2>
      <p class="waiting-message">系统资源不足，您已进入等待队列</p>
      <p class="waiting-message">资源释放后将自动为您创建容器</p>

      <div class="queue-info">
        <div class="queue-item">
          <span class="queue-label">排队位置：</span>
          <span class="queue-value">第 {{ queuePosition }} 位</span>
        </div>
        <div class="queue-item">
          <span class="queue-label">队列总人数：</span>
          <span class="queue-value">{{ queueTotal }} 人</span>
        </div>
        <div class="queue-item">
          <span class="queue-label">等待时间：</span>
          <span class="queue-value">{{ waitingTime }}</span>
        </div>
      </div>

      <div class="waiting-progress">
        <div class="spinner"></div>
        <span>系统正在清理闲置资源，请稍候...</span>
      </div>

      <button class="btn btn-secondary" @click="cancelWaiting">取消等待</button>
    </div>

    <!-- 用户信息页面 -->
    <div v-else class="user-dashboard">
      <div class="card">
        <h2>👤 我的账户</h2>
        <div class="user-info">
          <div class="info-row">
            <span class="label">SWTC 地址：</span>
            <span class="address">{{ userInfo.address }}</span>
            <button class="btn btn-small" @click="switchAddress">切换地址</button>
          </div>
          <div class="info-row">
            <span class="label">专属端口：</span>
            <span>{{ userInfo.port }}</span>
          </div>
          <div class="info-row">
            <span class="label">当前配额：</span>
            <span class="badge" :class="tierBadge(userInfo.tier)">{{ userInfo.tierLabel }}</span>
          </div>
          <div class="info-row">
            <span class="label">容器状态：</span>
            <span class="badge" :class="statusBadge(userInfo.status)">{{
              statusText(userInfo.status)
            }}</span>
            <button
              v-if="userInfo.status !== 'running'"
              class="btn btn-small btn-success"
              @click="restartContainer"
            >
              启动容器
            </button>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>📊 资源使用</h2>
        <div v-if="userInfo.stats" class="resource-usage">
          <div class="resource-item">
            <div class="resource-header">
              <span>CPU 使用率</span>
              <span>{{ userInfo.stats.cpu }}</span>
            </div>
          </div>
          <div class="resource-item">
            <div class="resource-header">
              <span>内存使用</span>
              <span>{{ userInfo.stats.memory }} ({{ userInfo.stats.memoryPercent }})</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: userInfo.stats.memoryPercent }"></div>
            </div>
          </div>
        </div>
        <div v-else class="loading">暂无数据</div>
      </div>

      <div class="card">
        <h2>🚀 进入 DSH</h2>
        <p>点击下方按钮进入您的专属 DSH 实例</p>
        <a :href="dshWebUrl" target="_blank" class="btn btn-success btn-large"> 打开 DSH Web UI </a>
      </div>

      <div class="card">
        <h2>🔑 模型配置</h2>
        <p>
          每个提供方独立配置，保存后进入 DSH 可在模型选择器中切换使用 （需 CCDAO 插件签名验证身份）
        </p>
        <div class="key-config">
          <!-- 获取提供方配置的 loading -->
          <div v-if="configLoading" class="config-loading">
            <div class="mini-spinner"></div>
            <span>正在获取提供方配置…</span>
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
                  <span v-if="item.kind === 'custom'" class="row-tag">自定义</span>
                  <span
                    class="cred-dot"
                    :class="item.keyConfigured ? 'ok' : 'missing'"
                    :title="item.keyConfigured ? 'API Key 已配置' : 'API Key 未配置'"
                  ></span>
                  <span
                    v-if="item.kind === 'official'"
                    class="key-state"
                    :class="item.keyConfigured ? 'ok' : 'missing'"
                  >
                    {{ item.keyConfigured ? '已配置' : '未配置' }}
                  </span>
                </span>
                <span class="row-actions">
                  <button class="btn btn-small" @click="toggleExpand(idx)">
                    {{ item.expanded ? '收起' : '编辑' }}
                  </button>
                  <button
                    v-if="item.removable"
                    class="btn btn-small btn-danger"
                    :disabled="!connected || keySaving"
                    @click="removeItem(idx)"
                  >
                    删除
                  </button>
                </span>
              </div>

              <div v-if="item.expanded" class="row-body">
                <input
                  v-if="item.kind === 'custom'"
                  v-model="item.displayName"
                  placeholder="显示名称（显示在模型选择器中）"
                  :disabled="!connected || keySaving"
                />
                <input
                  v-if="item.kind === 'custom'"
                  v-model="item.baseURL"
                  type="text"
                  placeholder="baseURL（OpenAI 兼容，如 https://gw.example.com/v1）"
                  :disabled="!connected || keySaving"
                />
                <input
                  v-model="item.apiKey"
                  type="password"
                  :placeholder="item.keyConfigured ? 'API Key（已配置，留空保留）' : 'API Key'"
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
                    删除官方 key
                  </button>
                  <span class="hint">只删除官方 DeepSeek API Key，不影响自定义端点</span>
                </div>
                <!-- 官方：固定端点 + 默认模型；检测到旧覆盖残留时警告并在保存时清除 -->
                <div
                  v-if="item.kind === 'official'"
                  class="override-warning"
                  v-show="item.officialOverride"
                >
                  ⚠️ 检测到旧的官方端点覆盖
                  <span v-if="item.officialBaseURL" class="override-url">{{
                    item.officialBaseURL
                  }}</span>
                  ，保存配置将自动清除，官方恢复
                  <code>https://api.deepseek.com</code>
                </div>
                <div v-if="item.kind === 'official'" class="hint">
                  官方端点固定为 https://api.deepseek.com，使用默认模型 （deepseek-v4-flash /
                  deepseek-v4-pro）。自定义端点请用下方「添加端点」。
                </div>
                <div v-if="item.kind === 'custom'" class="models-editor">
                  <div class="models-header">
                    <span>模型列表</span>
                    <button
                      class="btn btn-small"
                      :disabled="!connected || keySaving || discovering === idx || !item.baseURL"
                      @click="discoverItem(idx)"
                    >
                      {{ discovering === idx ? '探测中…' : '🔍 探测模型' }}
                    </button>
                  </div>
                  <div v-if="!item.baseURL" class="hint">
                    填写 baseURL 后可一键探测该端点提供的模型
                  </div>
                  <table v-if="item.baseURL" class="models-table">
                    <thead>
                      <tr>
                        <th>模型 ID</th>
                        <th>名称</th>
                        <th>contextWindow</th>
                        <th>maxTokens</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(m, mi) in item.models" :key="mi">
                        <td><input v-model="m.id" placeholder="model-id" /></td>
                        <td><input v-model="m.name" placeholder="显示名称" /></td>
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
                    ＋ 添加模型
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
                ＋ 添加端点
              </button>
            </div>
          </template>

          <div class="action-buttons">
            <button class="btn btn-primary" :disabled="!connected || keySaving" @click="saveConfig">
              {{ keySaving ? '保存中…' : '💾 保存配置' }}
            </button>
            <button
              class="btn btn-danger"
              :disabled="!connected || keySaving || !hasAnyConfig"
              @click="resetConfig"
            >
              恢复默认
            </button>
          </div>
          <div class="action-hints">
            <div class="hint">
              <strong>保存：</strong>CCDAO 插件会弹出签名确认；各提供方的 API Key 写入
              您自己的容器，端点与模型写入 settings.yaml，约 100ms 热生效，无需重启
            </div>
            <div class="hint">
              <strong>探测：</strong>请求端点 /models 接口并自动填入模型列表
              （使用容器内已保存的该端点 API Key 鉴权，密钥不离开您的容器）
            </div>
            <div class="hint">
              <strong>恢复默认：</strong>清除官方 API Key 与所有自定义端点，回到 DeepSeek
              官方配置（同样需要签名确认）
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>⚙️ 容器管理</h2>
        <p>管理您的 DSH 容器</p>
        <div class="action-buttons">
          <button class="btn btn-primary" @click="restartDSH">🔄 重启 DSH 服务</button>
          <button class="btn btn-danger" @click="resetContainer">🗑️ 重置容器（删除数据）</button>
        </div>
        <div class="action-hints">
          <div class="hint">
            <strong>重启 DSH 服务：</strong>安装插件后需要重启 DSH 服务才能生效
          </div>
          <div class="hint">
            <strong>重置容器：</strong>删除所有数据和配置，重新开始（不可恢复）
          </div>
        </div>
      </div>

      <div class="card">
        <h2>🧩 我的技能</h2>
        <p>将本地 DSH 的技能导入容器，或在技能市场安装他人共享的技能</p>
        <div class="action-buttons">
          <button class="btn btn-primary" @click="openImportDialog">📥 导入技能</button>
          <button class="btn btn-primary" @click="openShareDialog">📤 共享技能</button>
          <router-link to="/skills" class="btn btn-secondary">🏪 技能市场</router-link>
        </div>

        <div v-if="mySkillsLoading" class="config-loading">
          <div class="mini-spinner"></div>
          <span>正在获取我的技能…</span>
        </div>
        <template v-else>
          <div v-if="mineData.published.length > 0" class="skill-subsection">
            <h3>我的共享</h3>
            <div v-for="s in mineData.published" :key="'p-' + s.name" class="skill-row">
              <div class="skill-row-main">
                <strong>{{ s.name }}</strong>
                <span class="skill-desc">{{ s.description }}</span>
              </div>
              <button class="btn btn-small btn-danger" @click="unpublishSkill(s.name)">
                取消共享
              </button>
            </div>
          </div>
          <div v-if="mineData.installed.length > 0" class="skill-subsection">
            <h3>已安装</h3>
            <div v-for="s in mineData.installed" :key="'i-' + s.name" class="skill-row">
              <div class="skill-row-main">
                <strong>{{ s.name }}</strong>
                <span class="skill-desc">
                  {{
                    s.description ||
                    `来源：${s.source} · ${new Date(s.installedAt).toLocaleString()}`
                  }}
                </span>
                <span v-if="s.hasUpdate" class="badge badge-warning">有更新</span>
              </div>
              <button class="btn btn-small btn-danger" @click="uninstallSkill(s.name)">卸载</button>
            </div>
          </div>
          <p v-if="mineData.published.length === 0 && mineData.installed.length === 0" class="hint">
            还没有技能。可以把本地 DSH 写好的技能导入进来，或去技能市场逛逛。
          </p>
        </template>
      </div>

      <!-- 导入技能对话框 -->
      <div v-if="importDialogOpen" class="import-mask" @click.self="closeImportDialog">
        <div class="import-panel">
          <h3>📥 导入技能</h3>
          <p class="hint">
            选择本地 DSH 导出的技能文件（SKILL.md），或直接粘贴正文。导入会写入您自己的容器
            （需钱包签名确认）。
          </p>
          <div class="import-field">
            <label>技能文件</label>
            <input type="file" accept=".md,.txt,text/markdown" @change="onImportFile" />
          </div>
          <div class="import-field">
            <label>技能名（kebab-case，需与 frontmatter 的 name 一致）</label>
            <input v-model="importName" placeholder="my-skill" />
          </div>
          <div class="import-field">
            <label>SKILL.md 内容（或粘贴）</label>
            <textarea
              v-model="importText"
              rows="8"
              placeholder="---&#10;name: my-skill&#10;description: 一句话说明&#10;---&#10;正文…"
            ></textarea>
          </div>
          <div v-if="importBusy" class="loading">提交中…</div>
          <div class="action-buttons">
            <button class="btn btn-primary" :disabled="importBusy" @click="doImport">
              ✓ 签名并导入
            </button>
            <button class="btn btn-secondary" :disabled="importBusy" @click="closeImportDialog">
              取消
            </button>
          </div>
        </div>
      </div>

      <!-- 共享容器内技能对话框 -->
      <div v-if="shareDialogOpen" class="import-mask" @click.self="closeShareDialog">
        <div class="import-panel">
          <h3>📤 共享容器内的技能</h3>
          <p class="hint">
            从您容器里已有的技能中选择一个（自写或导入的都可以），共享后出现在技能市场，需钱包签名确认。
            <br />
            共享名要求<strong>唯一</strong>：若名称已被其他人共享，请改名后发布。
          </p>
          <div class="import-field">
            <label>选择容器内的技能</label>
            <select
              v-model="shareSourceName"
              :disabled="shareLoading || shareConflict || shareBusy"
            >
              <option value="" disabled>
                {{ shareLoading ? '正在获取列表…' : '— 请选择 —' }}
              </option>
              <option v-for="n in mineData.inContainer" :key="n" :value="n">{{ n }}</option>
            </select>
          </div>
          <div v-if="shareLoading" class="config-loading">
            <div class="mini-spinner"></div>
            <span>正在获取容器内技能…</span>
          </div>
          <div v-else-if="mineData.inContainer.length === 0" class="hint share-empty-hint">
            容器里还没有可共享的技能：先在 DSH 里写好一个（
            <code>/dsh-home/skills/</code>），或用上方「📥 导入技能」导入后再来共享
          </div>
          <div v-if="shareConflict" class="import-field share-conflict">
            <label>⚠️ 该名称已被占用，请填写新的共享名（frontmatter 的 name 会自动同步改写）</label>
            <input v-model="shareRenameTo" placeholder="my-skill-v2" />
            <span class="hint">源名保留在您的容器不变；发布到市场的名称需唯一</span>
          </div>
          <div v-if="shareBusy" class="loading">提交中…</div>
          <div class="action-buttons">
            <button
              class="btn btn-primary"
              :disabled="shareBusy || !shareSourceName"
              @click="doShare"
            >
              {{ shareConflict ? '✓ 用新名称共享' : '✓ 签名并共享' }}
            </button>
            <button class="btn btn-secondary" :disabled="shareBusy" @click="closeShareDialog">
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import axios from 'axios'
import { skillsApi } from '../api/skills.js'

const connected = ref(false)
const connecting = ref(false)
const hasCCDAO = ref(false)
const userInfo = ref({})
const waiting = ref(false)
const queuePosition = ref(0)
const queueTotal = ref(0)
const waitingSince = ref(0)

// 专属 DSH 实例地址：用用户当前访问入口页的 host 拼端口，
// 保证内网/公网/域名部署下跳转目标正确（不再硬编码 127.0.0.1）
const dshWebUrl = computed(() => {
  if (!userInfo.value.port) return ''
  return `http://${window.location.hostname}:${userInfo.value.port}/`
})

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
  if (customCount.value >= 20) return alert('自定义端点最多 20 个')
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
  if (
    !confirm(
      `确定删除端点「${item.displayName || '未命名'}」吗？\n将同时清除该端点的 API Key 与模型配置。`,
    )
  )
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
    throw new Error('未检测到 CCDAO 插件，请先安装并连接钱包')
  }
  // 1. 插件当前账户【保留原始大小写】！
  //    插件的 accounts.includes() 是大小写敏感严格匹配：把 jNDwRet... 转成
  //    jndwret... 再传回去会被判"未授权"(4100)。只有 requestAccounts 原样
  //    返回的字符串才能通过。后端 normalizeAddress 会自己转小写，无需担心。
  const accounts = await window.ccdao.request({
    method: 'swtc_requestAccounts',
    params: [],
  })
  const pluginAddress = accounts?.[0]
  if (!pluginAddress) {
    throw new Error('未获取到钱包账户，请确认 CCDAO 插件已解锁并授权本网站')
  }
  // 2. 领一次性挑战
  const challengeRes = await axios.post('/api/user/config-challenge', { address: pluginAddress })
  const nonce = challengeRes.data.nonce
  // 3. 插件对 nonce 签名 + 取公钥（都用原始大小写地址）
  const signature = await window.ccdao.request({
    method: 'swtc_signMessage',
    params: [pluginAddress, nonce],
  })
  const publicKey = await window.ccdao.request({
    method: 'swtc_getPublicKey',
    params: [pluginAddress],
  })
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
  const msg = err.response?.data?.error || err.message || '未知错误'
  if (/not been authorized|unauthorized/i.test(String(msg))) {
    return (
      'CCDAO 插件尚未授权本网站：请先点击浏览器上的 CCDAO 插件图标解锁钱包，' +
      '再点击本页"连接钱包"完成授权（会弹出授权确认框），然后重试'
    )
  }
  return msg
}

/** 模型行校验：id 非空且唯一 */
const validateModelRows = (models) => {
  const rows = (models || []).filter((m) => m.id && String(m.id).trim())
  const ids = new Set(rows.map((m) => String(m.id).trim()))
  if (ids.size !== rows.length) return { ok: false, msg: '模型 ID 不能重复' }
  for (const m of rows) {
    if (m.contextWindow && (typeof m.contextWindow !== 'number' || m.contextWindow < 1)) {
      return { ok: false, msg: `模型 ${m.id} 的 contextWindow 非法` }
    }
    if (m.maxTokens && (typeof m.maxTokens !== 'number' || m.maxTokens < 1)) {
      return { ok: false, msg: `模型 ${m.id} 的 maxTokens 非法` }
    }
  }
  return { ok: true }
}

/** 整体校验：每个 item（官方 key 长度、自定义显示名/baseURL/模型） */
const validateAll = () => {
  const seenNames = new Set()
  for (const item of items.value) {
    if (item.apiKey && item.apiKey.length > 4096) {
      return { ok: false, msg: 'API Key 长度超出限制' }
    }
    if (item.kind === 'custom') {
      const name = (item.displayName || '').trim()
      if (!name) return { ok: false, msg: '自定义端点需要填写显示名称' }
      if (name.length > 64) return { ok: false, msg: '显示名称不能超过 64 字符' }
      if (seenNames.has(name)) return { ok: false, msg: `显示名称重复：${name}` }
      seenNames.add(name)
      if (!/^https?:\/\//.test(item.baseURL || '')) {
        return { ok: false, msg: `端点 ${name} 的 baseURL 必须是 http(s) 地址` }
      }
    } else if (item.baseURL && !/^https?:\/\//.test(item.baseURL)) {
      return { ok: false, msg: '官方端点 baseURL 必须是 http(s) 地址' }
    }
    const check = validateModelRows(item.models)
    if (!check.ok) return { ok: false, msg: `${item.displayName}：${check.msg}` }
  }
  return { ok: true }
}

const saveConfig = async () => {
  if (!currentAddress()) return alert('请先连接钱包')
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
    alert('✅ 配置已保存并热加载：进入 DSH 后可在模型选择器中切换各提供方')
  } catch (err) {
    alert('保存失败：' + friendlyPluginError(err))
  } finally {
    keySaving.value = false
  }
}

/** 探测某个自定义端点的模型列表（优先用输入框 key，否则用该端点已存 key） */
const discoverItem = async (idx) => {
  if (!currentAddress()) return alert('请先连接钱包')
  const item = items.value[idx]
  if (!item?.baseURL?.trim()) return alert('请先填写该端点的 baseURL')
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
      alert('该端点未返回任何模型（可能需要鉴权：先填写 API Key 并保存后再试）')
    } else {
      alert(
        `✅ 探测到 ${models.length} 个模型，已填入「${item.displayName || '该端点'}」，可编辑后保存`,
      )
    }
  } catch (err) {
    alert('探测失败：' + friendlyPluginError(err))
  } finally {
    discovering.value = null
  }
}

/** 只删除官方 DeepSeek API Key（不影响端点覆盖与自定义端点，需签名） */
const clearOfficialKey = async () => {
  if (!currentAddress()) return alert('请先连接钱包')
  if (!confirm('确认删除官方 DeepSeek API Key 吗？\n只删除官方 key，不影响自定义端点。')) return
  keySaving.value = true
  try {
    const { address, nonce, signature, publicKey } = await signChallenge()
    await axios.delete('/api/user/tenant-config', {
      data: { address, nonce, signature, publicKey, scope: 'official-key' },
    })
    await syncWalletAccount(address)
    alert('✅ 官方 DeepSeek API Key 已删除')
  } catch (err) {
    alert('删除失败：' + friendlyPluginError(err))
  } finally {
    keySaving.value = false
  }
}

/** 恢复默认：清除官方 key + 官方端点覆盖 + 所有自定义端点（需签名） */
const resetConfig = async () => {
  if (!currentAddress()) return alert('请先连接钱包')
  if (
    !confirm(
      '确认恢复默认配置吗？\n\n将清除：\n1. 官方 DeepSeek API Key\n2. ' +
        (customCount.value > 0 ? `全部 ${customCount.value} 个自定义端点及其 API Key\n3. ` : '') +
        '官方端点覆盖配置\n\n回到 DeepSeek 官方 API + 默认模型。此操作需要钱包签名确认，不可恢复。',
    )
  )
    return
  keySaving.value = true
  try {
    const { address, nonce, signature, publicKey } = await signChallenge()
    await axios.delete('/api/user/tenant-config', {
      data: { address, nonce, signature, publicKey },
    })
    await syncWalletAccount(address)
    alert('✅ 已恢复默认配置（官方 API + 默认模型）')
  } catch (err) {
    alert('恢复失败：' + friendlyPluginError(err))
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
  if (!waitingSince.value) return '0 秒'
  const ms = Date.now() - waitingSince.value
  if (ms < 60000) return `${Math.floor(ms / 1000)} 秒`
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟`
  return `${(ms / 3600000).toFixed(1)} 小时`
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

// 监听账户变化事件
const setupAccountChangeListener = () => {
  if (!hasCCDAO.value) {
    console.log('[UserCenter] CCDAO 插件未安装')
    return
  }

  console.log('[UserCenter] 设置账户监听器...')
  console.log('[UserCenter] window.ethereum:', typeof window.ethereum)
  console.log('[UserCenter] window.ccdao:', typeof window.ccdao)

  // 尝试多种方式监听账户变化
  let eventEmitter = null

  // 方式 1: window.ethereum.on (MetaMask 风格)
  if (window.ethereum && window.ethereum.on) {
    console.log('[UserCenter] 使用 window.ethereum.on')
    eventEmitter = window.ethereum
  }
  // 方式 2: window.ccdao.on (CCDAO 风格)
  else if (window.ccdao && window.ccdao.on) {
    console.log('[UserCenter] 使用 window.ccdao.on')
    eventEmitter = window.ccdao
  }
  // 方式 3: 轮询检查（备用方案）
  else {
    console.log('[UserCenter] 未找到事件监听器，使用轮询检查')
    let lastAddress = localStorage.getItem('swtc_address')
    setInterval(async () => {
      try {
        if (window.ccdao && window.ccdao.request) {
          const accounts = await window.ccdao.request({
            method: 'swtc_requestAccounts',
            params: [],
          })
          const currentAddress = accounts?.[0]?.toLowerCase()
          if (currentAddress && currentAddress !== lastAddress) {
            console.log(`[UserCenter] 轮询检测到地址变化：${lastAddress} -> ${currentAddress}`)
            lastAddress = currentAddress
            await handleAddressChange(currentAddress)
          }
        }
      } catch (err) {
        // 忽略错误
      }
    }, 3000) // 每 3 秒检查一次
    return
  }

  // 注册事件监听器
  if (eventEmitter) {
    eventEmitter.on('swtcAccountsChanged', async (accounts) => {
      console.log('[UserCenter] 检测到账户变化:', accounts)

      if (!accounts || accounts.length === 0) {
        // 用户断开连接
        localStorage.removeItem('swtc_address')
        connected.value = false
        userInfo.value = {}
        alert('钱包已断开连接')
        return
      }

      const newAddress = accounts[0].toLowerCase()
      await handleAddressChange(newAddress)
    })
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

  // 地址真正变化时：立即清空"我的技能"并进入 loading，
  // 避免切换后短暂闪现上一个用户的共享/安装列表
  if (!isInitialLoad && newAddress !== oldAddress) {
    mineData.value = { published: [], installed: [], inContainer: [] }
    mySkillsLoading.value = true
  }

  try {
    // 显示加载页面
    showLoading('正在连接钱包', '验证地址...', 10)

    // 关键：无论地址是否变化，都要确保容器存在并运行
    const containerStatus = await ensureContainer(newAddress)

    // 如果在等待队列中，不继续加载用户信息
    if (containerStatus === 'waiting') {
      hideLoading()
      // 保存地址
      localStorage.setItem('swtc_address', newAddress)
      return
    }

    // 更新加载状态
    showLoading(
      '正在创建容器',
      containerStatus === 'created' ? '首次创建，需要等待容器启动...' : '容器已存在，正在启动...',
      50,
    )

    // 保存地址（即使是相同的地址也要保存，确保格式正确）
    localStorage.setItem('swtc_address', newAddress)

    // 获取用户信息
    showLoading('正在获取用户信息', '加载账户数据...', 80)
    await fetchUserInfo(newAddress)

    // 关键：设置 connected 为 true，否则页面不显示用户信息
    if (userInfo.value.address) {
      connected.value = true
      console.log('[UserCenter] 已设置 connected = true')
      hideLoading()
    } else {
      console.error('[UserCenter] userInfo.value.address 为空，无法设置 connected')
      hideLoading()
    }

    // 只在地址真正变化时才显示提示
    if (!isInitialLoad && newAddress !== oldAddress) {
      alert(`已切换到新地址：${newAddress.slice(0, 10)}...`)
    }

    // 切换/连接后刷新"我的技能"为当前地址的个人视图
    await loadMine()
  } catch (err) {
    console.error('[UserCenter] 处理地址失败:', err)
    hideLoading()
    if (!isInitialLoad) {
      alert('处理地址失败：' + err.message)
    }
  }
}

const connectWallet = async () => {
  if (!hasCCDAO.value) return

  connecting.value = true
  try {
    const accounts = await window.ccdao.request({
      method: 'swtc_requestAccounts',
      params: [],
    })

    if (!accounts || accounts.length === 0) {
      throw new Error('未获取到账户')
    }

    // 统一转小写
    const address = accounts[0].toLowerCase()
    console.log('[UserCenter] 连接钱包，地址:', address)

    // 使用通用处理函数
    await handleAddressChange(address)
  } catch (err) {
    console.error('[UserCenter] 连接失败:', err)
    alert('连接失败：' + err.message)
  } finally {
    connecting.value = false
  }
}

const ensureContainer = async (address) => {
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
      const connectRes = await fetch(`/connect?address=${encodeURIComponent(address)}`, {
        redirect: 'manual',
      })

      // 检查是否返回 202（资源不足，进入队列）
      if (connectRes.status === 202) {
        const data = await connectRes.json()
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
      await fetch(`/connect?address=${encodeURIComponent(address)}`, {
        redirect: 'manual',
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
    const connectRes = await fetch(`/connect?address=${encodeURIComponent(address)}`, {
      redirect: 'manual',
    })

    // 检查是否返回 202（资源不足，进入队列）
    if (connectRes.status === 202) {
      const data = await connectRes.json()
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
  try {
    const res = await axios.get(`/api/user/${address}`)
    userInfo.value = res.data
    fetchConfigStatus()
  } catch (err) {
    console.error('获取用户信息失败:', err)

    // 如果是 400 错误，说明地址无效，清除 localStorage
    if (err.response?.status === 400) {
      console.warn('[UserCenter] 地址无效，清除 localStorage')
      localStorage.removeItem('swtc_address')
      connected.value = false
      userInfo.value = {}
      alert('保存的地址无效，请重新连接钱包')
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
  }
}

const switchAddress = async () => {
  if (!hasCCDAO.value) {
    alert('请先安装 CCDAO 插件')
    return
  }

  try {
    const accounts = await window.ccdao.request({
      method: 'swtc_requestAccounts',
      params: [],
    })

    if (!accounts || accounts.length === 0) {
      throw new Error('未获取到账户')
    }

    // 统一转小写
    const newAddress = accounts[0].toLowerCase()
    console.log('[UserCenter] 切换地址:', newAddress)

    // 使用通用处理函数
    await handleAddressChange(newAddress)
  } catch (err) {
    console.error('[UserCenter] 切换失败:', err)
    alert('切换失败：' + err.message)
  }
}

const restartContainer = async () => {
  try {
    const address = userInfo.value.address
    showLoading('正在启动容器', '请稍候...', 50)

    await fetch(`/connect?address=${encodeURIComponent(address)}`, {
      redirect: 'manual',
    })

    // 等待容器完全就绪
    await new Promise((resolve) => setTimeout(resolve, 5000))

    await fetchUserInfo(address)
    hideLoading()
    alert('容器已启动')
  } catch (err) {
    hideLoading()
    alert('启动失败：' + err.message)
  }
}

const restartDSH = async () => {
  if (!confirm('确定要重启 DSH 服务吗？\n\n安装插件后需要重启才能生效。\n重启期间服务暂时不可用。'))
    return

  try {
    const address = userInfo.value.address
    showLoading('正在重启 DSH 服务', '请稍候...', 50)

    const res = await axios.post(`/api/user/${address}/restart`)

    // 等待容器完全就绪
    await new Promise((resolve) => setTimeout(resolve, 5000))

    await fetchUserInfo(address)
    hideLoading()
    alert('DSH 服务已重启')
  } catch (err) {
    hideLoading()
    alert('重启失败：' + (err.response?.data?.error || err.message))
  }
}

const resetContainer = async () => {
  if (
    !confirm(
      '️ 警告：此操作将删除所有数据！\n\n确定要重置容器吗？\n- 删除所有 DSH 配置\n- 删除所有插件\n- 删除所有会话数据\n- 此操作不可恢复！',
    )
  )
    return

  if (!confirm('再次确认：您确定要放弃所有数据重新开始吗？')) return

  try {
    const address = userInfo.value.address
    showLoading('正在重置容器', '删除数据和重建容器...', 50)

    const res = await axios.post(`/api/user/${address}/reset`)

    // 重置后需要重新创建容器
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // 重新连接
    await handleAddressChange(address)

    hideLoading()
    alert('容器已重置，正在重新创建...')
  } catch (err) {
    hideLoading()
    alert('重置失败：' + (err.response?.data?.error || err.message))
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
  const map = { running: '运行中', stopped: '已停止', destroyed: '已销毁' }
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
      const accounts = await window.ccdao.request({
        method: 'swtc_requestAccounts',
        params: [],
      })

      if (accounts && accounts.length > 0) {
        const currentAddress = accounts[0].toLowerCase()
        console.log('[UserCenter] 从 CCDAO 获取当前地址:', currentAddress)

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
    alert('请填写技能名（kebab-case）')
    return
  }
  if (!importText.value.trim()) {
    alert('请选择技能文件或粘贴 SKILL.md 内容')
    return
  }
  importBusy.value = true
  try {
    const sig = await signChallenge()
    await skillsApi.importSkill(sig, name, importText.value)
    alert(`技能 ${name} 导入成功，已写入您的容器，DSH 会话中可直接使用`)
    closeImportDialog()
    await loadMine()
  } catch (err) {
    alert('导入失败：' + friendlyPluginError(err))
  } finally {
    importBusy.value = false
  }
}

const unpublishSkill = async (name) => {
  if (!confirm(`确定取消共享技能 ${name} 吗？（已安装用户不受影响）`)) return
  try {
    const sig = await signChallenge()
    await skillsApi.unpublish(sig, name)
    await loadMine()
  } catch (err) {
    alert('操作失败：' + friendlyPluginError(err))
  }
}

const uninstallSkill = async (name) => {
  if (!confirm(`确定从您的容器卸载技能 ${name} 吗？`)) return
  try {
    const sig = await signChallenge()
    await skillsApi.uninstall(sig, name)
    await loadMine()
  } catch (err) {
    alert('卸载失败：' + friendlyPluginError(err))
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
    alert('请从列表中选择要共享的技能')
    return
  }
  const renameTo = shareConflict.value ? shareRenameTo.value.trim() : ''
  if (shareConflict.value && !renameTo) {
    alert('该名称已被占用，请填写一个新的共享名（kebab-case）')
    return
  }
  shareBusy.value = true
  try {
    const sig = await signChallenge()
    await skillsApi.publish(sig, source, renameTo || undefined)
    alert(
      renameTo
        ? `技能已以新名称「${renameTo}」发布到技能市场`
        : `技能「${source}」已发布到技能市场`,
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
    alert('共享失败：' + friendlyPluginError(err))
  } finally {
    shareBusy.value = false
  }
}
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
</style>
