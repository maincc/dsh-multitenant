import { ref, computed } from 'vue'
import axios from 'axios'
import i18n from '../i18n'
import { toast, askConfirm } from './useDialog'
import { friendlyPluginError } from '../api/wallet.js'

/**
 * 模型配置域单例（P3 UC 第二刀）：提供方 items 与增删改/探测/保存/重置。
 * 壳（UserCenter）的 syncWalletAccount/handleAddressChange 与断连复位仍经
 * 解构调 fetchConfigStatus / 清 items——状态主权在域，调用点不复制（判例 58）。
 * host 注入：signChallenge（connect 域跨 5 处复用的钱包验证基座，主权留壳）、
 * currentAddress（同壳）。
 */
const t = (key, params) => i18n.global.t(key, params)

let host = {
  signChallenge: async () => {
    throw new Error('userModel host not bound')
  },
  currentAddress: () => '',
}
export function bindUserModelHost(h) {
  host = { ...host, ...h }
}

// ---- 模型配置（钱包签名验证身份后写入自己的租户卷）----
// items：每个提供方一个 item；DeepSeek 官方也是其中一个（不可删除）
// { kind: 'official'|'custom', route?, displayName, baseURL, models, apiKey, keyConfigured, removable, expanded }
const items = ref([])

const keySaving = ref(false)

const discovering = ref(null) // 正在探测的 item 下标

const configLoading = ref(false) // 获取提供方配置的 loading

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
  const address = host.currentAddress()
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
  if (!host.currentAddress()) return toast(t('user.errConnectFirst'))
  const check = validateAll()
  if (!check.ok) return toast(check.msg)

  keySaving.value = true
  try {
    const { address, nonce, signature, publicKey } = await host.signChallenge()
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
  if (!host.currentAddress()) return toast(t('user.errConnectFirst'))
  // 串行互斥（2026-10 审计）：discovering 只记一个下标，点了 A 再点 B 会让
  // A 的"探测中"态被顶掉且两笔并发——签名挑战/限流都会交叠。一次只探一个。
  if (discovering.value !== null) return
  const item = items.value[idx]
  if (!item?.baseURL?.trim()) return toast(t('user.errNeedBaseUrl'))
  discovering.value = idx
  try {
    const { address, nonce, signature, publicKey } = await host.signChallenge()
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
  if (!host.currentAddress()) return toast(t('user.errConnectFirst'))
  await askConfirm({
    message: t('user.confirmClearOfficialKey'),
    run: async () => {
      keySaving.value = true
      try {
        const { address, nonce, signature, publicKey } = await host.signChallenge()
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
  if (!host.currentAddress()) return toast(t('user.errConnectFirst'))
  const customLine =
    customCount.value > 0 ? t('user.confirmResetCustomLine', { n: customCount.value }) : ''
  await askConfirm({
    message: t('user.confirmResetBase1') + customLine + t('user.confirmResetBase2'),
    danger: true,
    run: async () => {
      keySaving.value = true
      try {
        const { address, nonce, signature, publicKey } = await host.signChallenge()
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

export function useUserModel() {
  return {
    items,
    keySaving,
    discovering,
    configLoading,
    customCount,
    hasAnyConfig,
    credentialRefFor,
    fetchConfigStatus,
    toggleExpand,
    addItem,
    removeItem,
    addModel,
    removeModel,
    validateModelRows,
    validateAll,
    saveConfig,
    discoverItem,
    clearOfficialKey,
    resetConfig,
  }
}
