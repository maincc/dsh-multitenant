import { ref } from 'vue'
import axios from 'axios'
import i18n from '../i18n'
import { toast, askConfirm } from './useDialog'
import { shortAddress } from '../utils/format.js'
import { friendlyPluginError } from '../utils/pluginErrorText.js'
import { skillsApi } from '../api/skills.js'

/**
 * 我的技能域单例（P3 UC 第三刀副册）：已发布/已安装/容器内三表 + 导入/分享
 * 弹窗流。loadMine 由壳 handleAddressChange 地址切换调用（解构同名）。
 * 发布走 signChallenge 钱包验证（connect 域基座，经 host 注入）。
 */
const t = (key, params) => i18n.global.t(key, params)

// 地址切换并发互斥（随域迁入；壳旧 let 已删）
let mineInFlight = null

let host = {
  signChallenge: async () => {
    throw new Error('userSkills host not bound')
  },
  currentAddress: () => '',
  connected: { value: false },
}
export function bindUserSkillsHost(h) {
  host = { ...host, ...h }
}

const mineData = ref({ published: [], installed: [], inContainer: [], unverified: false })

const mySkillsLoading = ref(true) // 初始即 loading：面板首帧显示 spinner，避免空态闪现后突然出数据

const importDialogOpen = ref(false)

const importName = ref('')

const importText = ref('')

const importBusy = ref(false)

const fetchMine = async () => {
  const sig = await host.signChallenge('/api/skills/challenge')
  const res = await skillsApi.mine(sig)
  return {
    published: res.published || [],
    installed: res.installed || [],
    inContainer: res.inContainer || [],
  }
}

const loadMine = async () => {
  if (mineInFlight) return mineInFlight // 并发去重：watch 与切换流程可能重叠触发
  if (!host.connected.value) return
  mySkillsLoading.value = true
  const startedAt = Date.now()
  mineInFlight = (async () => {
    try {
      // 个人视图接口：无需钱包签名，任何环境都能加载出"我的共享/已安装"
      // （inContainer 由共享弹窗单独用签名接口刷新，这里保留原有值）
      const res = await skillsApi.mineView(host.currentAddress())
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

const loadContainerSkills = async () => {
  if (!host.connected.value) return
  try {
    const data = await fetchMine()
    mineData.value = { ...mineData.value, inContainer: data.inContainer }
  } catch (err) {
    mineData.value = { ...mineData.value, inContainer: [] }
    console.warn('[skills] 获取容器内技能失败（忽略）:', err)
  }
}

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
    const sig = await host.signChallenge('/api/skills/challenge')
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
        const sig = await host.signChallenge('/api/skills/challenge')
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
        const sig = await host.signChallenge('/api/skills/challenge')
        await skillsApi.uninstall(sig, name)
        await loadMine()
      } catch (err) {
        toast(t('user.uninstallFail', { err: friendlyPluginError(err) }))
      }
    },
  })
}

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
  if (host.connected.value) {
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
    const sig = await host.signChallenge('/api/skills/challenge')
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

export function useUserSkills() {
  return {
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
  }
}
