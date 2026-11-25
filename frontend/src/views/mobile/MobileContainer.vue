<template>
  <div class="mobile-container">
    <!-- Loading 状态 -->
    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">加载中...</div>
    </div>

    <!-- 数据加载完成后显示内容 -->
    <template v-else>
      <!-- 头部 -->
      <div class="ghead">
        <div class="row1">
          <div class="ttl">容器管理</div>
          <div class="avatar">{{ role === 'admin' ? '管' : '用' }}</div>
        </div>
        <div class="greet">查看容器状态与资源使用，管理你的专属 DSH 容器</div>
      </div>

      <!-- 主体内容 -->
      <div class="body">
        <!-- 子 tab 切换 -->
        <div class="sub-tabs">
          <button class="sub-tab" :class="{ active: cSub === 'info' }" @click="cSub = 'info'">
            容器信息
          </button>
          <!-- 审查修正 2026-11-10：旧版多语句内联 handler（cSub='x'; load()）会被
               prettier 换行去分号→Vue 编译器拒收（本次 --write 现场引爆）。语义收进方法 -->
          <button
            class="sub-tab"
            :class="{ active: cSub === 'skills' }"
            @click="switchSub('skills')"
          >
            技能插件
          </button>
          <button class="sub-tab" :class="{ active: cSub === 'model' }" @click="switchSub('model')">
            模型配置
          </button>
          <button class="sub-tab" :class="{ active: cSub === 'env' }" @click="switchSub('env')">
            环境现场
          </button>
        </div>

        <!-- 容器信息 tab -->
        <div v-show="cSub === 'info'">
          <!-- 容器信息卡片 -->
          <div class="card">
            <div class="kv">
              <span class="k">专属端口</span>
              <span class="v mono" style="font-weight: 700">{{ userInfo.port || '-' }}</span>
            </div>
            <div class="kv">
              <span class="k">当前配额</span>
              <span class="v">
                <span class="badge" :class="tierBadgeClass">{{ tierLabel }}</span>
              </span>
            </div>
            <div class="kv">
              <span class="k">容器状态</span>
              <span class="v">
                <span class="badge" :class="statusBadgeClass">{{ statusText }}</span>
              </span>
            </div>
          </div>

          <!-- 资源使用卡片 -->
          <div class="card">
            <div class="kv">
              <span class="k">CPU 使用率</span>
              <span class="v" style="font-weight: 700">{{ userInfo.stats?.cpu || '0%' }}</span>
            </div>
            <div class="kv" style="border: none; padding-bottom: 4px">
              <span class="k">内存使用</span>
              <span class="v" style="font-weight: 700">
                {{ userInfo.stats?.memory || '0MiB' }}
                <span style="color: var(--m-muted); font-weight: 400">
                  ({{ userInfo.stats?.memoryPercent || '0%' }})
                </span>
              </span>
            </div>
            <div class="progress">
              <i :style="{ width: memoryPercent }"></i>
            </div>
          </div>

          <!-- 进入 DSH 卡片 -->
          <div class="card enter-card">
            <div class="ct">🚀 进入 DSH</div>
            <div class="cd">
              点击下方按钮进入你的专属 DSH
              实例（每次进入需插件签名；容器停止时会顺带启动，会话过期时会顺带重登）
            </div>
            <div style="margin-top: 12px">
              <button class="btn btn-p" @click="enterDsh" :disabled="enteringDsh">
                {{
                  enteringDsh
                    ? '正在进入...'
                    : userInfo.status === 'running' && userInfo.port
                      ? '🚀 进入 DSH Web UI'
                      : '⚡ 启动并进入 DSH'
                }}
              </button>
            </div>
          </div>

          <!-- 操作按钮：运行/停止态配对（桌面 :743 同款语义——running 才谈"重启服务"，
               非 running 给"启动容器"，停机点重启是无意义操作不该占主位） -->
          <div class="btn-row">
            <button
              v-if="userInfo.status === 'running'"
              class="btn btn-p"
              @click="restartDSH"
              :disabled="containerBooting"
            >
              🔄 重启服务
            </button>
            <button
              v-else
              class="btn btn-p"
              @click="startContainerOnly"
              :disabled="containerBooting || !connected"
            >
              {{ containerBooting ? '启动中…' : '⚡ 启动容器' }}
            </button>
            <button
              class="btn btn-g"
              @click="stopContainer"
              :disabled="!connected || userInfo.status !== 'running'"
            >
              ■ 停止容器
            </button>
          </div>

          <!-- 危险操作 -->
          <button class="btn btn-r" @click="resetContainer">🗑 重置容器（删除数据）</button>

          <!-- 说明卡片 -->
          <div class="card">
            <div class="cd">
              <b style="color: var(--m-text)">启动/重启：</b>
              运行中此位是「重启服务」（装完插件生效用）；停止后自动换成「⚡
              启动容器」——签名确认后拉起，不跳页。<br /><br />
              <b style="color: var(--m-text)">停止容器：</b>
              立即结束今日使用时长并保全剩余额度，数据保留，可随时重新启动。{{
                usageInfoLabel ? '今日已用 ' + usageInfoLabel : ''
              }}<br /><br />
              <b style="color: var(--m-text)">重置容器：</b>
              删除所有数据和配置，重新开始（不可恢复）
            </div>
          </div>
        </div>

        <!-- 技能插件 tab -->
        <div v-show="cSub === 'skills'">
          <div v-if="skillsLoading" class="loading-state">
            <div class="loading-spinner"></div>
            <div class="loading-text">加载技能数据...</div>
          </div>
          <template v-else>
            <!-- 动作行（P2 移动发布链路入口；fe46075 桌面同款位次：导入主色/共享次色） -->
            <div class="skill-actions">
              <button class="btn btn-sm btn-p" @click="openImportDialog">📥 导入技能</button>
              <button class="btn btn-sm btn-g" @click="openShareDialog">⬆ 共享到市场</button>
            </div>
            <!-- 已发布的技能 -->
            <div v-if="mySkills.published.length > 0" class="card">
              <div class="ct">📤 已发布的技能</div>
              <div v-for="skill in mySkills.published" :key="'p-' + skill.name" class="skill-item">
                <div class="skill-info">
                  <div class="skill-name">{{ skill.name }}</div>
                  <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
                </div>
                <button class="btn btn-sm btn-r" @click="unpublishSkill(skill.name)">
                  取消发布
                </button>
              </div>
            </div>

            <!-- 已安装的技能 -->
            <div v-if="mySkills.installed.length > 0" class="card">
              <div class="ct">📦 已安装的技能</div>
              <div v-for="skill in mySkills.installed" :key="'i-' + skill.name" class="skill-item">
                <div class="skill-info">
                  <div class="skill-name">{{ skill.name }}</div>
                  <div class="skill-desc">{{ skill.description || '暂无描述' }}</div>
                  <div v-if="skill.installedAt" class="skill-meta">
                    安装于 {{ new Date(skill.installedAt).toLocaleDateString() }}
                  </div>
                </div>
                <button class="btn btn-sm btn-r" @click="uninstallSkill(skill.name)">卸载</button>
              </div>
            </div>

            <!-- 插件列表 -->
            <div class="card">
              <div class="ct">🔌 插件</div>
              <div v-if="mySkills.plugins.length === 0" class="empty-hint">暂无插件</div>
              <div v-for="plugin in mySkills.plugins" :key="'pl-' + plugin.name" class="skill-item">
                <div class="skill-info">
                  <div class="skill-name">
                    {{ plugin.name }}
                    <span v-if="plugin.version" class="badge b-purple">v{{ plugin.version }}</span>
                  </div>
                  <div class="skill-desc">{{ plugin.description || '暂无描述' }}</div>
                  <div class="skill-meta">
                    {{ plugin.kind === 'file' ? '文件' : '目录' }} ·
                    {{ plugin.fileCount || 0 }} 个文件 ·
                    {{ formatBytes(plugin.bytes || 0) }}
                  </div>
                </div>
              </div>
            </div>

            <!-- 空状态 -->
            <div
              v-if="mySkills.published.length === 0 && mySkills.installed.length === 0"
              class="card"
            >
              <div class="empty-hint">
                暂无技能数据<br />
                你可以在技能市场中安装技能
              </div>
            </div>
          </template>
        </div>

        <!-- 模型配置 tab（2026-11-11 用户裁定上移动端）。v-show 保活：表单有编辑值，
             切走再回不丢未保存改动（env/skills 无状态可 v-if，这里不行） -->
        <div v-show="cSub === 'model'">
          <div v-if="cfgLoading" class="card">
            <div class="cd">读取模型配置中…</div>
          </div>

          <template v-else>
            <div v-for="(item, idx) in cfgItems" :key="idx" class="card">
              <div class="ct">
                {{
                  item.kind === 'official' ? '🔵 DeepSeek 官方' : item.displayName || '自定义端点'
                }}
                <span
                  class="mono"
                  style="font-size: 11px; float: right"
                  :style="{ color: item.keyConfigured ? 'var(--m-green)' : 'var(--m-muted)' }"
                >
                  {{ item.keyConfigured ? '● 已设 Key' : '○ 未设 Key' }}
                </span>
              </div>

              <template v-if="item.kind === 'official'">
                <div v-if="item.officialOverride" class="cd" style="color: var(--m-amber-strong)">
                  ⚠️ 卷内还留着旧的官方覆盖（自定义端点/模型），点下方「保存配置」即清回官方
                </div>
                <input
                  v-model="item.apiKey"
                  class="ms-input"
                  type="password"
                  autocomplete="off"
                  placeholder="官方 API Key（留空 = 不改动）"
                />
                <!-- 桌面同款第二清除档：只删官方 Key，不动端点（独立签名） -->
                <button
                  v-if="item.keyConfigured"
                  class="btn btn-sm btn-r"
                  style="margin-top: 8px"
                  :disabled="cfgSaving"
                  @click="clearOfficialKey"
                >
                  清除官方 Key
                </button>
              </template>

              <template v-else>
                <input
                  v-model="item.displayName"
                  class="ms-input"
                  placeholder="端点名（如 SiliconFlow）"
                />
                <input
                  v-model="item.baseURL"
                  class="ms-input"
                  placeholder="Base URL（如 https://api.siliconflow.cn/v1）"
                />
                <input
                  v-model="item.apiKey"
                  class="ms-input"
                  type="password"
                  autocomplete="off"
                  :placeholder="item.keyConfigured ? 'API Key（留空 = 不改动）' : 'API Key'"
                />
                <textarea
                  v-model="item.modelsText"
                  class="ms-input ms-textarea"
                  rows="3"
                  placeholder="模型一行一个：id 或「id 显示名」"
                ></textarea>
                <div class="btn-row">
                  <button
                    class="btn btn-sm btn-g"
                    :disabled="cfgDiscovering !== null || !item.baseURL.trim()"
                    @click="discoverCfgItem(idx)"
                  >
                    {{ cfgDiscovering === idx ? '探测中…' : '📡 探测模型' }}
                  </button>
                  <button class="btn btn-sm btn-r" @click="removeCfgItem(idx)">移除</button>
                </div>
              </template>
            </div>

            <div class="btn-row">
              <button class="btn btn-g" :disabled="!cfgItems.length" @click="addCfgItem">
                ＋ 添加端点
              </button>
            </div>
            <div class="card">
              <div class="cd">
                保存/恢复默认都要钱包逐次签名确认；Key 只写不读，留空即保持原值。
              </div>
              <div class="btn-row">
                <button
                  class="btn btn-p"
                  :disabled="cfgSaving || !cfgItems.length"
                  @click="saveModelConfig"
                >
                  {{ cfgSaving ? '签名保存中…' : '💾 保存配置' }}
                </button>
                <button class="btn btn-r" :disabled="cfgSaving" @click="resetModelConfig">
                  恢复默认
                </button>
              </div>
            </div>
          </template>
        </div>

        <!-- 环境现场 tab（P2 用户裁定 2026-11-10：模板定格/上传保持 PC-only，
             这里把话说清——移动端能干什么、不能干什么去哪干） -->
        <div v-show="cSub === 'env'">
          <div class="card">
            <div class="ct">🌍 环境现场</div>
            <div class="empty-hint">
              <b style="color: var(--m-text)">模板定格与上传</b
              >流程较重（清洗勾选/随行包确认/落库签名），保持由 PC 端操作：<br />
              用户中心 → 容器管理 → 环境 →「上传」<br /><br />
              移动端可直接用<b style="color: var(--m-text)">市场 → 环境</b
              >：查看/应用已发布模板、回退、下架自己的模板。
            </div>
          </div>
        </div>
      </div>

      <!-- 共享弹窗（P2：桌面 shareDialog 同款语义——选容器内技能→签名发布；409 撞名就地转重命名） -->
      <div v-if="shareOpen" class="modal-mask" @click.self="closeShareDialog">
        <div class="modal-panel">
          <div class="modal-head">
            <h3>⬆ 共享容器技能</h3>
            <button class="close-btn" @click="closeShareDialog">✕</button>
          </div>
          <div class="modal-body">
            <div v-if="shareLoading" class="empty-hint">容器内技能读取中…</div>
            <div v-else-if="inContainer.length === 0" class="cd">
              容器里还没有可共享的技能——先在 DSH 中创建技能，或从市场安装后再共享。
            </div>
            <template v-else>
              <div class="cd">选择要共享到市场的技能：</div>
              <div
                v-for="s in inContainer"
                :key="'c-' + s.name"
                class="pick-item"
                :class="{ picked: shareSource === s.name }"
                @click="shareSource = s.name"
              >
                <div class="skill-info">
                  <div class="skill-name">{{ s.name }}</div>
                  <div class="skill-desc">{{ s.description || '' }}</div>
                </div>
                <span class="pick-mark" :class="{ on: shareSource === s.name }"></span>
              </div>
              <template v-if="shareConflict">
                <div class="cd" style="color: var(--m-amber-strong)">
                  这个名字已被占用，给它起个共享名：
                </div>
                <input
                  v-model="shareRenameTo"
                  class="ms-input"
                  placeholder="新共享名（小写字母/数字/连字符）"
                />
              </template>
              <button
                class="btn btn-p ms-submit"
                :disabled="!shareSource || shareBusy"
                @click="doShare"
              >
                {{ shareBusy ? '签名共享中…' : shareConflict ? '重命名并共享' : '签名共享' }}
              </button>
            </template>
          </div>
        </div>
      </div>

      <!-- 导入弹窗（桌面 importDialog 同款：名字+正文或选 .md 文件；写自己卷不入市场） -->
      <div v-if="importOpen" class="modal-mask" @click.self="closeImportDialog">
        <div class="modal-panel">
          <div class="modal-head">
            <h3>📥 导入技能</h3>
            <button class="close-btn" @click="closeImportDialog">✕</button>
          </div>
          <div class="modal-body">
            <div class="cd">
              导入只写入你自己的容器（本地可用）；要共享到市场请再用"共享到市场"。
            </div>
            <input
              v-model="importName"
              class="ms-input"
              placeholder="技能名（kebab-case，如 my-skill）"
            />
            <label class="ms-file">
              <input type="file" accept=".md,.txt,text/markdown" @change="onImportFile" />
              <span>或选择 SKILL.md 文件（自动填名字与正文）</span>
            </label>
            <textarea
              v-model="importText"
              class="ms-input ms-textarea"
              rows="8"
              placeholder="粘贴技能正文（SKILL.md 内容）"
            ></textarea>
            <button class="btn btn-p ms-submit" :disabled="importBusy" @click="doImport">
              {{ importBusy ? '签名导入中…' : '签名导入' }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import { signChallenge, friendlyPluginError } from '../../api/wallet.js'
import { signConnectPlugin, buildConnectUrl } from '../../api/connect.js'
import { skillsApi } from '../../api/skills.js'
import { toast, askConfirm } from '../../composables/useDialog'
import { formatBytes, shortAddress } from '../../utils/format.js'

// 移动深链穿透（2026-11-11 幻影键 adm:model 正链）：壳 applyMobileTabLink('model')
// 落本 tab 时经 initial-sub 指定子页签；一次性消费——应用后立即 emit 请壳清空，
// 免得下次手点「容器」重挂载还跳老地方。未知值一律忽略回落 info。
const props = defineProps({ initialSub: { type: String, default: '' } })
const emit = defineEmits(['sub-consumed'])

const loading = ref(true)
const enteringDsh = ref(false)
const userInfo = ref({
  address: '',
  port: '',
  tier: '',
  tierLabel: '',
  status: '',
  stats: null,
})
const role = ref('user')
const connected = ref(false)
const containerBooting = ref(false)
const usageInfo = ref(null)

// 子 tab 状态
const cSub = ref('info') // 'info' | 'skills' | 'model' | 'env'

// 子 tab 切换：技能/模型/环境进场时拉各自数据（原为模板多语句 handler，prettier 重排会破
// Vue 表达式解析，2026-11-10 审查收进方法）
function switchSub(tab) {
  cSub.value = tab
  if (tab === 'skills') loadMySkills()
  else if (tab === 'model') loadModelConfig()
  else if (tab === 'env') loadEnvVars()
}

// ===================== 模型配置（2026-11-11 用户裁定上移动端） =====================
// 契约与桌面 UserCenter 模型页签逐字对齐：GET 只回脱敏态（永不回显 key）；写/清/探测
// 全走 TENANT_CONFIG 用途签名（config-challenge），一次操作一次钱包确认；providers
// 提交是**全量替换**语义（带 route=更新，新建由服务端分配 route），删除端点=本地移除
// 后保存。官方 item 不可编辑端点/模型，仅可换 key；旧官方覆盖在保存时显式清空回官方。
const cfgItems = ref([])
const cfgLoading = ref(false)
const cfgSaving = ref(false)
const cfgDiscovering = ref(null) // 串行互斥：一次只探一个端点（桌面 2026-10 审计同款）

// credentialRef 必须逐字等于服务端规范体 tenant-config.service.js:133
// `${route.toUpperCase().replace(/[^A-Z0-9]/g,'_')}_API_KEY`——存 Key 与探测取 Key
// 用同一 ref，客户端只能复现不能自创（2026-11-11 审查现场揪出我曾加 'MODEL_'
// 前缀：那样探测读的是容器里不存在的 MODEL_*_API_KEY，已存 Key 端点永远探空）。
const cfgRefFor = (route) =>
  String(route || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_') + '_API_KEY'

/** 文本域一行一模型：`id 名称(可省)` → 服务端形状 */
function parseModelsText(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, ...rest] = l.split(/\s+/)
      return { id, ...(rest.length ? { name: rest.join(' ') } : {}) }
    })
}
function modelsToText(models) {
  return (models || [])
    .map((m) => (m.name && m.name !== m.id ? `${m.id} ${m.name}` : m.id))
    .join('\n')
}

async function loadModelConfig() {
  const { success, address } = await ensureLogin()
  if (!success || !address) {
    toast('登录会话不可用，请到「我的」tab 重新登录')
    cfgItems.value = []
    return
  }
  cfgLoading.value = true
  try {
    const res = await axios.get(`/api/user/tenant-config?address=${encodeURIComponent(address)}`)
    const officialOverride = !!(res.data.baseURL || (res.data.models && res.data.models.length > 0))
    cfgItems.value = [
      {
        kind: 'official',
        route: 'deepseek-official',
        displayName: 'DeepSeek 官方',
        baseURL: '',
        models: [],
        modelsText: '',
        apiKey: '',
        keyConfigured: !!res.data.apiKeyConfigured,
        removable: false,
        officialOverride,
      },
      ...(Array.isArray(res.data.providers)
        ? res.data.providers.map((p) => ({
            kind: 'custom',
            route: p.route,
            displayName: p.displayName || '',
            baseURL: p.baseURL || '',
            models: Array.isArray(p.models) ? p.models : [],
            modelsText: modelsToText(p.models),
            apiKey: '',
            keyConfigured: !!p.keyConfigured,
            removable: true,
          }))
        : []),
    ]
  } catch (e) {
    toast('读取模型配置失败: ' + (e.response?.data?.error || e.message))
    cfgItems.value = []
  } finally {
    cfgLoading.value = false
  }
}

function addCfgItem() {
  if (cfgItems.value.filter((i) => i.kind === 'custom').length >= 20) {
    toast('端点数量已达上限（20）')
    return
  }
  cfgItems.value.push({
    kind: 'custom',
    route: undefined,
    displayName: '',
    baseURL: '',
    models: [],
    modelsText: '',
    apiKey: '',
    keyConfigured: false,
    removable: true,
  })
}

async function removeCfgItem(idx) {
  const item = cfgItems.value[idx]
  if (
    !(await askConfirm({
      message: `移除端点「${item.displayName || '未命名'}」？保存后生效（同端点 route 由服务端重派，旧 Key 会一并清除）`,
      danger: true,
      confirmLabel: '移除',
    }))
  )
    return
  cfgItems.value.splice(idx, 1)
}

async function discoverCfgItem(idx) {
  if (cfgDiscovering.value !== null) return
  const item = cfgItems.value[idx]
  if (!item?.baseURL?.trim()) {
    toast('先填 Base URL 再探测')
    return
  }
  // 只重建目标行对象（v-model 编辑的其他行引用不动，不会丢改动）；每次操作
  // 独立领 nonce——探测点完不"顺带保存"，列表回填后仍需点保存生效。
  cfgDiscovering.value = idx
  try {
    const sig = await signChallenge('/api/user/config-challenge')
    const payload = { ...sig, baseURL: item.baseURL.trim() }
    if (item.apiKey && item.apiKey.trim()) payload.apiKey = item.apiKey.trim()
    if (item.route) payload.credentialRef = cfgRefFor(item.route)
    const res = await axios.post('/api/user/tenant-config/discover', payload)
    const models = Array.isArray(res.data.models) ? res.data.models : []
    item.models = models.map((m) => ({ id: m.id || '', name: m.name || '' }))
    item.modelsText = modelsToText(item.models)
    toast(models.length ? `探测到 ${models.length} 个模型（点保存生效）` : '该端点未返回模型列表')
  } catch (e) {
    toast('探测失败: ' + friendlyPluginError(e))
  } finally {
    cfgDiscovering.value = null
  }
}

/** 保存前校验（桌面 validateAll 同款、签名前拦截——移动旧版让服务端报错，
    白烧一次钱包确认与 nonce）。cw/maxTokens 移动不可编辑（只继承），无需校验 */
function validateCfg() {
  const seen = new Set()
  for (const i of cfgItems.value) {
    if (i.kind !== 'custom') continue
    const name = String(i.displayName || '').trim()
    if (!name) return `端点名不能为空（Base URL：${String(i.baseURL || '').trim() || '新端点'}）`
    if (name.length > 64) return `端点名过长（≤64 字符）：${name.slice(0, 20)}…`
    if (seen.has(name)) return `端点名重复：${name}`
    seen.add(name)
    if (!/^https?:\/\//.test(String(i.baseURL || '').trim())) {
      return `端点「${name}」的 Base URL 必须是 http(s) 地址`
    }
    const ids = parseModelsText(i.modelsText).map((m) => m.id)
    if (new Set(ids).size !== ids.length) return `端点「${name}」存在重复的模型 id`
  }
  return null
}

async function saveModelConfig() {
  if (cfgSaving.value) return
  const bad = validateCfg()
  if (bad) {
    toast(bad)
    return
  }
  cfgSaving.value = true
  try {
    const sig = await signChallenge('/api/user/config-challenge')
    const official = cfgItems.value.find((i) => i.kind === 'official')
    const payload = {
      ...sig,
      providers: cfgItems.value
        .filter((i) => i.kind === 'custom')
        .map((p) => ({
          ...(p.route ? { route: p.route } : {}),
          displayName: String(p.displayName || '').trim(),
          baseURL: String(p.baseURL || '').trim(),
          // 2026-11-11 移动↔PC 对比修正：providers 是**全量替换**，而 PC 模型行带
          // contextWindow/maxTokens 两个数值字段（UserCenter :615/:623 可编辑、
          // 服务端逐字存储）。移动 modelsText 只表达 id+名——若不按 id 从原
          // item.models 继承这两字段，手机保存会把 PC 配的窗口/上限抹掉。
          models: parseModelsText(p.modelsText)
            .filter((m) => m.id)
            .map((m) => {
              const prev = (p.models || []).find((o) => String(o?.id || '') === m.id)
              const row = { id: m.id, name: m.name || undefined }
              if (prev?.contextWindow) row.contextWindow = prev.contextWindow
              if (prev?.maxTokens) row.maxTokens = prev.maxTokens
              return row
            }),
          ...(p.apiKey && p.apiKey.trim() ? { apiKey: p.apiKey.trim() } : {}),
        })),
    }
    if (official?.apiKey?.trim()) payload.apiKey = official.apiKey.trim()
    // 官方旧覆盖残留：保存时显式清空回官方（桌面同款语义）
    if (official?.officialOverride) {
      payload.baseURL = ''
      payload.models = []
    }
    await axios.post('/api/user/tenant-config', payload)
    toast('模型配置已保存')
    await loadModelConfig()
  } catch (e) {
    toast('保存失败: ' + friendlyPluginError(e))
  } finally {
    cfgSaving.value = false
  }
}

/** 只删官方 DeepSeek Key（桌面 clearOfficialKey 同款：scope='official-key'，
    自定义端点及其 Key 不动；独立签名） */
async function clearOfficialKey() {
  if (cfgSaving.value) return
  const official = cfgItems.value.find((i) => i.kind === 'official')
  if (!official?.keyConfigured) {
    toast('官方 Key 本来就没设置')
    return
  }
  if (
    !(await askConfirm({
      message: '只删除官方 DeepSeek API Key？自定义端点与其 Key 不受影响',
      confirmLabel: '清除',
    }))
  )
    return
  cfgSaving.value = true
  try {
    const sig = await signChallenge('/api/user/config-challenge')
    await axios.delete('/api/user/tenant-config', { data: { ...sig, scope: 'official-key' } })
    toast('官方 Key 已清除')
    await loadModelConfig()
  } catch (e) {
    toast('清除失败: ' + friendlyPluginError(e))
  } finally {
    cfgSaving.value = false
  }
}

async function resetModelConfig() {
  const customN = cfgItems.value.filter((i) => i.kind === 'custom').length
  if (
    !(await askConfirm({
      message:
        customN > 0
          ? `恢复默认将清除官方 Key、端点覆盖及 ${customN} 个自定义端点（含其 Key），不可恢复。继续？`
          : '恢复默认将清除官方 Key 与端点覆盖，不可恢复。继续？',
      danger: true,
      confirmLabel: '恢复默认',
    }))
  )
    return
  try {
    const sig = await signChallenge('/api/user/config-challenge')
    await axios.delete('/api/user/tenant-config', { data: sig })
    toast('已恢复默认配置')
    await loadModelConfig()
  } catch (e) {
    toast('清除失败: ' + friendlyPluginError(e))
  }
}

// 技能数据
const mySkills = ref({
  published: [],
  installed: [],
  plugins: [],
})
const skillsLoading = ref(false)

// 环境变量数据
const envVars = ref([])
const envLoading = ref(false)

const memoryPercent = computed(() => {
  return userInfo.value.stats?.memoryPercent || '0%'
})

const tierBadgeClass = computed(() => {
  const tier = userInfo.value.tier
  if (tier === 'basic' || tier === 'T1') return 'b-purple'
  if (tier === 'enhanced' || tier === 'T2') return 'b-orange'
  if (tier === 'performance' || tier === 'T3') return 'b-green'
  return 'b-purple'
})

const tierLabel = computed(() => {
  return userInfo.value.tierLabel || '基础'
})

const statusBadgeClass = computed(() => {
  const status = userInfo.value.status
  if (status === 'running') return 'b-green'
  if (status === 'stopped') return 'b-red'
  if (status === 'creating') return 'b-orange'
  return 'b-red'
})

const statusText = computed(() => {
  const status = userInfo.value.status
  if (status === 'running') return '● 运行中'
  if (status === 'stopped') return '● 已停止'
  if (status === 'creating') return '● 创建中'
  return '● 未知'
})

const usageInfoLabel = computed(() => {
  const u = usageInfo.value
  if (!u) return ''
  if (!u.enabled) return '无限制'
  if (u.exempt) return '豁免'
  return `${u.usedMinutes} / ${u.dailyMinutes} 分钟`
})

// 连接钱包并建立会话（T4 收敛 2026-11-10：challenge→sign 原语走 api/connect.js 唯一权威支；
// 旧拷贝漏记 swtc_plugin_case 拼法线索——桌面"档案优先发现"依赖它，移动路径就此补齐）
async function connectWithOwnership(action = null) {
  try {
    const core = await signConnectPlugin({
      onPluginAddress: (a) => {
        if (a) localStorage.setItem('swtc_plugin_case', a)
      },
    })
    const cRes = await fetch(buildConnectUrl(core.pluginAddress, core, action))
    return { res: cRes, address: core.pluginAddress }
  } catch (err) {
    console.error('连接失败:', err)
    throw err
  }
}

// 检查并建立登录会话
async function ensureLogin() {
  try {
    // 先检查是否已有有效会话
    const sessionRes = await axios.get('/api/user/session-info')
    if (sessionRes.data?.address) {
      return { success: true, address: sessionRes.data.address }
    }
  } catch {
    /* 会话查询失败按无会话处理，走钱包登录 */
  }

  // 没有有效会话，调用钱包登录
  try {
    const { res, address } = await connectWithOwnership('login')
    return { success: res.status === 200, address }
  } catch (err) {
    console.error('[MobileContainer] 登录失败:', err)
    toast('登录失败: ' + (err.message || '未知错误'))
    return { success: false, address: null }
  }
}

async function loadUserInfo() {
  try {
    // 确保已登录（建立会话）
    const { success, address } = await ensureLogin()
    if (!success || !address) {
      console.error('登录失败，无法加载容器信息')
      return
    }

    // 获取角色信息
    const credRes = await axios.get('/api/user/credential-status')
    role.value = credRes.data.role || 'user'

    // 获取容器信息（使用登录时确定的地址）
    const containerRes = await axios.get(`/api/user/${address}`)
    userInfo.value = {
      address: address,
      port: containerRes.data.port || '',
      tier: containerRes.data.tier || 'basic',
      tierLabel: containerRes.data.tierLabel || '基础',
      status: containerRes.data.status || 'unknown',
      stats: containerRes.data.stats || null,
    }
    connected.value = true
  } catch (e) {
    console.error('加载用户信息失败:', e)
  }
}

async function loadUsageInfo() {
  try {
    const res = await axios.get('/api/user/credential-status')
    const address = res.data.address
    if (!address) return

    // 使用 PC 端的端点
    const usageRes = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)
    usageInfo.value = usageRes.data.usage || null
  } catch (e) {
    console.error('加载使用信息失败:', e)
  }
}

// 签名 connect 通道（启动+重登+进入三合一）的两个按钮共用一份响应分流
// ——孪生纪律：enterDsh 与 startContainerOnly 的状态码语义必须同处读。
// data 预解析自 clone()，原 body 不被消费；无体/非 JSON（302 等）为 null。
async function connectForContainer() {
  const { res } = await connectWithOwnership()
  let data = null
  try {
    data = await res.clone().json()
  } catch {
    /* 空体或非 JSON */
  }
  return { res, data }
}

async function enterDsh() {
  // C 修复（2026-11-10 用户报障"容器没启动、也没有启动按钮"）：旧版先按
  // !userInfo.port 短路——但带签名的 /connect 本就是启动+重登+进入三合一通道
  // （ensureContainer: stopped→docker start；会话过期重新签发 cookie）。
  // port/status 只影响按钮文案，不再影响能否点击。
  enteringDsh.value = true
  try {
    const { res, data } = await connectForContainer()

    if (res.status === 200) {
      if (data?.url) {
        // 移动端进入 DSH 同页跳转（2026-11-11 用户裁定）：新标签=孤儿页制造机；
        // 返回手势回平台壳（SPA 重载，会话 cookie 在，状态自动回正）。
        window.location.assign(data.url)
        return
      }
      toast(data?.message || data?.error || '进入 DSH 失败：未返回 URL')
      return
    }

    if (res.status === 302) {
      const loc = res.headers.get('location')
      if (loc) {
        window.location.assign(loc)
      }
      return
    }

    if (res.status === 202) {
      toast(data?.message || data?.error || '资源不足，请等待')
      return
    }

    // 4xx/5xx：透传服务端原因（凭证闸/会话类错误全靠这里说人话）
    const why = data?.error || data?.message
    toast(why ? `无法启动/进入：${why}` : `进入 DSH 失败: HTTP ${res.status}`)
    loadUserInfo() // 会话可能被本次调用救活，刷新页面口径
  } catch (err) {
    console.error('[MobileContainer] enterDsh 失败:', err)
    toast('进入 DSH 失败: ' + (err.message || '未知错误'))
  } finally {
    enteringDsh.value = false
  }
}

// 启动容器（桌面 restartContainer→ensureContainer 的移动镜像，2026-11-11 用户
// 报障"停止后没有启动按钮"）：同一条签名 connect 通道，只启动**不跳转**——
// 停止态下操作行那颗"重启服务"对停机无意义，换成这颗才是状态配对（桌面 :743 同款）。
async function startContainerOnly() {
  if (containerBooting.value) return
  containerBooting.value = true
  try {
    const { res, data } = await connectForContainer()
    if (res.status === 200 || res.status === 302) {
      await loadUserInfo()
      toast('⚡ 容器已启动')
      return
    }
    if (res.status === 202) {
      await loadUserInfo()
      toast(data?.message || data?.error || '资源不足，已进入排队，稍后再点启动')
      return
    }
    const why = data?.error || data?.message
    toast(why ? `无法启动容器：${why}` : `启动失败: HTTP ${res.status}`)
    loadUserInfo()
  } catch (err) {
    console.error('[MobileContainer] 启动容器失败:', err)
    toast('启动失败: ' + (err.message || '未知错误'))
  } finally {
    containerBooting.value = false
  }
}

async function restartDSH() {
  if (
    !(await askConfirm({
      message: '确定要重启 DSH 服务吗？',
      confirmLabel: '重启',
    }))
  )
    return

  containerBooting.value = true
  try {
    const address = userInfo.value.address
    await axios.post(`/api/user/${address}/restart`)
    toast('重启指令已下发，服务将稍后恢复')
    // 重新加载容器信息
    setTimeout(() => {
      loadUserInfo()
    }, 3000)
  } catch (e) {
    console.error('重启失败:', e)
    toast('重启失败: ' + (e.response?.data?.error || e.message))
  } finally {
    containerBooting.value = false
  }
}

async function stopContainer() {
  if (
    !(await askConfirm({
      message: '确定要停止容器吗？今日使用时长将结束，数据保留。',
      danger: true,
      confirmLabel: '停止',
    }))
  )
    return

  try {
    const address = userInfo.value.address
    await axios.post(`/api/user/${address}/stop`)
    toast('容器已停止，时长保留')
    // 重新加载容器信息
    setTimeout(() => {
      loadUserInfo()
    }, 2000)
  } catch (e) {
    console.error('停止失败:', e)
    toast('停止失败: ' + (e.response?.data?.error || e.message))
  }
}

async function resetContainer() {
  if (
    !(await askConfirm({
      message: '确认重置容器？将删除所有数据和配置，不可恢复！',
      danger: true,
      confirmLabel: '重置',
    }))
  )
    return

  try {
    const address = userInfo.value.address
    const res = await axios.post(`/api/user/${address}/reset`)
    toast('重置请求已提交')
    // 重置成功且服务端回了新容器 URL：移动端同页直进新容器（2026-11-11 裁定，
    // 与「进入 DSH」同口径；旧版新标签留孤儿页，且漏 noopener 的审计 INFO 顺带消失）
    if (res.data?.url) {
      window.location.assign(res.data.url)
      return
    }
    // 无 URL 回（排队/旧协议）：留在壳内，3 秒后回读新状态
    setTimeout(() => {
      loadUserInfo()
    }, 3000)
  } catch (e) {
    console.error('重置失败:', e)
    toast('重置失败: ' + (e.response?.data?.error || e.message))
  }
}

onMounted(async () => {
  // 深链子页签落位先于数据加载（switchSub 自带各子页取数；info 的常规加载照常跑）
  if (props.initialSub && ['skills', 'model', 'env'].includes(props.initialSub)) {
    switchSub(props.initialSub)
  }
  emit('sub-consumed')
  try {
    await Promise.all([loadUserInfo(), loadUsageInfo()])
  } catch (e) {
    console.error('加载数据失败:', e)
  } finally {
    loading.value = false
  }
})

// 加载技能数据
// ===================== ⬆ 共享 / 📥 导入（P2 移动发布链路）=====================
// 语义逐字对齐桌面 UserCenter：共享源=容器内技能（signChallenge→skillsApi.mine 的
// inContainer）、发布=skillsApi.publish（409 撞名就地转重命名）、导入=importSkill
// （写自己卷不入市场，文件名推名走 kebab 校验——桌面 onImportFile 同款）。
const shareOpen = ref(false)
const shareLoading = ref(false)
const shareBusy = ref(false)
const inContainer = ref([])
const shareSource = ref('')
const shareConflict = ref(false)
const shareRenameTo = ref('')

const importOpen = ref(false)
const importName = ref('')
const importText = ref('')
const importBusy = ref(false)

async function openShareDialog() {
  shareOpen.value = true
  shareSource.value = ''
  shareConflict.value = false
  shareRenameTo.value = ''
  shareLoading.value = true
  try {
    const sig = await signChallenge()
    const res = await skillsApi.mine(sig)
    inContainer.value = res.inContainer || []
  } catch (e) {
    inContainer.value = []
    toast(`容器技能读取失败：${friendlyPluginError(e) || e.message}`)
  } finally {
    shareLoading.value = false
  }
}

function closeShareDialog() {
  shareOpen.value = false
}

async function doShare() {
  const source = shareSource.value
  if (!source) {
    toast('先选一个容器内技能')
    return
  }
  const renameTo = shareConflict.value ? shareRenameTo.value.trim() : ''
  if (shareConflict.value && !renameTo) {
    toast('撞名后要起个共享名')
    return
  }
  shareBusy.value = true
  try {
    const sig = await signChallenge()
    await skillsApi.publish(sig, source, renameTo || undefined)
    toast(renameTo ? `已按"${renameTo}"共享到市场` : `已共享 ${source}`)
    closeShareDialog()
    loadMySkills()
  } catch (e) {
    if (e.response?.status === 409) {
      // 桌面同款：共享名被占→切重命名模式，源名不动
      shareConflict.value = true
      shareRenameTo.value = ''
      return
    }
    toast(`共享失败：${friendlyPluginError(e) || e.message}`)
  } finally {
    shareBusy.value = false
  }
}

function openImportDialog() {
  importOpen.value = true
  importName.value = ''
  importText.value = ''
}

function closeImportDialog() {
  importOpen.value = false
}

function onImportFile(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    importText.value = String(reader.result || '')
    // 桌面逐字同款：文件名去 .md 后缀转小写，kebab 合规才回填
    const base = String(file.name).replace(/\.md$/i, '').trim().toLowerCase()
    if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(base)) importName.value = base
  }
  reader.readAsText(file)
}

async function doImport() {
  const name = importName.value.trim()
  if (!name) {
    toast('技能名必填（小写字母/数字/连字符）')
    return
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    toast('技能名须为 kebab-case（如 my-skill）')
    return
  }
  if (!importText.value.trim()) {
    toast('技能正文不能为空')
    return
  }
  importBusy.value = true
  try {
    const sig = await signChallenge()
    await skillsApi.importSkill(sig, name, importText.value)
    toast(`已导入 ${name}（写入容器本地可用；上市场请再点"共享到市场"）`)
    closeImportDialog()
    loadMySkills()
  } catch (e) {
    toast(`导入失败：${friendlyPluginError(e) || e.message}`)
  } finally {
    importBusy.value = false
  }
}

async function loadMySkills() {
  skillsLoading.value = true
  try {
    const address = userInfo.value.address
    if (!address) {
      console.error('无法加载技能数据：用户地址为空')
      return
    }
    // 使用 skillsApi.mineView，只需要地址，不需要签名
    const res = await skillsApi.mineView(address)
    mySkills.value = {
      published: res.published || [],
      installed: res.installed || [],
      plugins: res.plugins || [],
    }
  } catch (e) {
    console.error('加载技能数据失败:', e)
  } finally {
    skillsLoading.value = false
  }
}

// 加载环境变量
async function loadEnvVars() {
  // 环境变量功能较复杂，移动端暂不支持
  // 用户需要在 PC 端管理环境变量
  envLoading.value = false
  envVars.value = []
}

// 卸载技能
// 卸载/取消发布（P3 治活 bug 2026-11-10：旧代码 POST /api/skills/uninstall|unpublish 裸
// JSON——后端无此路由一直 404；正解 /:name/uninstall 与 DELETE /:name 且必须带钱包签名
// auth，与桌面孪生同口径）
async function uninstallSkill(skillName) {
  if (
    !(await askConfirm({
      message: `确定要卸载技能 "${skillName}" 吗？`,
      danger: true,
      confirmLabel: '卸载',
    }))
  )
    return

  try {
    const sig = await signChallenge()
    await skillsApi.uninstall(sig, skillName)
    toast('技能已卸载')
    await loadMySkills()
  } catch (e) {
    console.error('卸载技能失败:', e)
    toast('卸载失败: ' + (friendlyPluginError(e) || e.response?.data?.error || e.message))
  }
}

// 取消发布技能
async function unpublishSkill(skillName) {
  if (
    !(await askConfirm({
      message: `确定要取消发布技能 "${skillName}" 吗？`,
      danger: true,
      confirmLabel: '取消发布',
    }))
  )
    return

  try {
    const sig = await signChallenge()
    await skillsApi.unpublish(sig, skillName)
    toast('技能已取消发布')
    await loadMySkills()
  } catch (e) {
    console.error('取消发布失败:', e)
    toast('取消发布失败: ' + (friendlyPluginError(e) || e.response?.data?.error || e.message))
  }
}

// 格式化字节数
</script>

<style scoped>
.mobile-container {
  min-height: 100vh;
  background: var(--m-bg);
}

/* Loading 状态 */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  gap: 16px;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(106, 114, 232, 0.2);
  border-top-color: var(--m-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.loading-text {
  font-size: 14px;
  color: var(--m-muted);
}

/* 头部 */
.ghead {
  background: linear-gradient(135deg, var(--m-primary) 0%, var(--m-primary-2) 100%);
  padding: 20px 16px 24px;
  color: #fff;
}

.row1 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.ttl {
  font-size: 18px;
  font-weight: 700;
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
}

.greet {
  font-size: 13px;
  opacity: 0.9;
  line-height: 1.5;
}

/* 主体内容 */
.body {
  padding: 16px;
}

/* 卡片 */
.card {
  background: #fff;
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 4px 16px rgba(60, 70, 120, 0.08);
  margin-bottom: 16px;
}

.kv {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--m-line);
}

.kv:last-child {
  border-bottom: none;
}

.k {
  font-size: 13px;
  color: var(--m-muted);
}

.v {
  font-size: 14px;
  color: var(--m-ink);
  font-weight: 500;
}

.mono {
  font-family: 'SF Mono', Monaco, monospace;
}

/* 徽章 */
.badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.b-purple {
  background: var(--m-purple-soft);
  color: var(--m-primary);
}

.b-orange {
  background: var(--m-amber-soft);
  color: var(--m-amber);
}

.b-green {
  background: var(--m-green-soft);
  color: var(--m-green);
}

.b-red {
  background: var(--m-danger-soft);
  color: #e5484d;
}

/* 进度条 */
.progress {
  height: 6px;
  background: var(--m-line);
  border-radius: 3px;
  overflow: hidden;
  margin-top: 8px;
}

.progress i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--m-primary) 0%, var(--m-primary-2) 100%);
  transition: width 0.3s;
}

/* 进入 DSH 卡片 */
.enter-card {
  background: linear-gradient(135deg, #f0f1ff, #faf8ff);
}

.ct {
  font-size: 15px;
  font-weight: 700;
  color: var(--m-ink);
  margin-bottom: 8px;
}

.cd {
  font-size: 12px;
  color: var(--m-muted);
  line-height: 1.6;
}

/* 按钮 */
.btn {
  padding: 12px 20px;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  width: 100%;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-p {
  background: linear-gradient(135deg, var(--m-primary) 0%, var(--m-primary-2) 100%);
  color: #fff;
  box-shadow: 0 4px 12px rgba(106, 114, 232, 0.3);
}

.btn-g {
  background: var(--m-green-soft);
  color: var(--m-green);
}

.btn-r {
  background: var(--m-danger-soft);
  color: #e5484d;
  margin-bottom: 16px;
}

.btn:active:not(:disabled) {
  transform: scale(0.98);
}

/* 按钮行 */
.btn-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.btn-row .btn {
  flex: 1;
  /* 行内模式必须清零 btn-r 自带的全宽堆叠 margin-bottom——否则 flex stretch 下
     带 margin 的那颗比邻座矮 16px（2026-11-11 用户报障"保存/恢复默认一大一小"） */
  margin-bottom: 0;
}

/* 子 tab 切换 */
.sub-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
  background: #fff;
  padding: 6px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(60, 70, 120, 0.06);
}

.sub-tab {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  padding: 9px 4px;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--m-muted);
  cursor: pointer;
  transition: all 0.2s;
}

.sub-tab.active {
  background: linear-gradient(135deg, var(--m-primary) 0%, var(--m-primary-2) 100%);
  color: #fff;
  box-shadow: 0 2px 8px rgba(106, 114, 232, 0.3);
}

/* 技能列表项 */
.skill-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--m-line);
  gap: 12px;
}

.skill-item:last-child {
  border-bottom: none;
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--m-ink);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.skill-desc {
  font-size: 12px;
  color: var(--m-muted);
  line-height: 1.5;
  margin-bottom: 4px;
}

.skill-meta {
  font-size: 11px;
  color: #b0b5c5;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
  width: auto;
  white-space: nowrap;
}

/* 环境变量项 */
.env-item {
  padding: 12px 0;
  border-bottom: 1px solid var(--m-line);
}

.env-item:last-child {
  border-bottom: none;
}

.env-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--m-ink);
  margin-bottom: 4px;
  font-family: 'SF Mono', Monaco, monospace;
}

.env-value {
  font-size: 13px;
  color: var(--m-primary);
  word-break: break-all;
  margin-bottom: 4px;
}

.env-desc {
  font-size: 12px;
  color: var(--m-muted);
  line-height: 1.5;
}

/* 空状态提示 */
.empty-hint {
  text-align: center;
  padding: 40px 20px;
  color: var(--m-muted);
  font-size: 13px;
  line-height: 1.6;
}

/* ===== P2 技能动作行与共享/导入弹窗（弹窗族样式与 MobileMarket 同配方可循） ===== */
.skill-actions {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.modal-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-panel {
  background: #fff;
  border-radius: 16px;
  max-width: 500px;
  width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid #f2f3f8;
}

.modal-head h3 {
  margin: 0;
  font-size: 15px;
  color: var(--m-ink);
}

.close-btn {
  border: none;
  background: none;
  font-size: 16px;
  color: var(--m-muted);
  cursor: pointer;
  padding: 4px 8px;
}

.modal-body {
  padding: 14px 16px 18px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.pick-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid #edeff5;
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 8px;
  cursor: pointer;
}

.pick-item.picked {
  border-color: var(--m-primary);
  background: #f6f5ff;
}

.pick-mark {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid #c9cede;
  flex-shrink: 0;
}

.pick-mark.on {
  border-color: var(--m-primary);
  background: var(--m-primary);
  box-shadow: inset 0 0 0 3px #fff;
}

.ms-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #d9dde8;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  margin-bottom: 10px;
  background: #fafbfe;
  color: var(--m-ink);
}

.ms-textarea {
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 12px;
  resize: vertical;
  min-height: 120px;
}

.ms-file {
  display: block;
  font-size: 12px;
  color: var(--m-primary);
  margin-bottom: 12px;
  cursor: pointer;
}

.ms-file input[type='file'] {
  font-size: 12px;
  margin-bottom: 4px;
}

.ms-submit {
  width: 100%;
  margin-top: 4px;
}
</style>
