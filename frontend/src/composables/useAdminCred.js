import { ref } from 'vue'
import axios from 'axios'
import i18n from '../i18n'
import { toast, askConfirm } from './useDialog'
import { syncCredCount, refreshCred } from './useAdminBadges'

/**
 * 管理端凭证域单例（P3 cred 刀）：CWT 解限队列 / 凭证台账 / 任免名册
 * 三块的 state+动作全在此，AdminTabCred 整块消费；demoteAdmin 另被
 * AdminTabUsers 行内按钮共享——两处 import 同一支，判例 58 红线。
 *
 * 宿主（AdminPanel 壳）经 bindAdminCredHost 注入两把刀：
 *  - sign：壳层 signAdminOperation 薄包装（hasCCDAO 闸 + friendlyPluginError）
 *  - refresh：fetchData（撤销管理员后行徽章即时翻转）
 * i18n 用全局 t（composable 不在 setup 上下文，locale 现固定 zh 已核）。
 */
const t = (key, params) => i18n.global.t(key, params)

let host = {
  sign: async () => {
    throw new Error('adminCred host not bound')
  },
  refresh: async () => {},
}
export function bindAdminCredHost(h) {
  host = { ...host, ...h }
}

const cwtApps = ref([])
const cwtTotal = ref(0)
const cwtOffset = ref(0)
const cwtStatusFilter = ref('pending')
const cwtLoading = ref(false)
const cwtBusy = ref('')
const credRows = ref([])
const credTotal = ref(0)
const credOffset = ref(0)
const credKind = ref('all')
const credQ = ref('')
const credLoading = ref(false)
const rosterAddrs = ref([])
const rosterHistory = ref([])
const rosterLoading = ref(false)
const rosterBusy = ref('')

const loadCwtApps = async () => {
  cwtLoading.value = true
  try {
    const res = await axios.get('/api/admin/cwt-applications', {
      params: { status: cwtStatusFilter.value, limit: 10, offset: cwtOffset.value },
    })
    cwtApps.value = res.data.applications || []
    cwtTotal.value = res.data.total || 0
    // 红点实时化（用户裁定）：审批动作后本函数必被重拉——pending 视图直接搭车，
    // 切了别的过滤则轻取一次 total，判数始终来自写后重读的库账
    if (cwtStatusFilter.value === 'pending') syncCredCount(cwtTotal.value)
    else refreshCred()
  } catch (err) {
    toast(t('admin.credOpFail', { err: err?.response?.data?.error || err.message }))
  } finally {
    cwtLoading.value = false
  }
}

const setCwtStatus = (s) => {
  cwtStatusFilter.value = s
  cwtOffset.value = 0
  loadCwtApps()
}

const cwtPage = (delta) => {
  cwtOffset.value = Math.max(0, cwtOffset.value + delta * 10)
  loadCwtApps()
}

const loadCredRows = async () => {
  credLoading.value = true
  try {
    const res = await axios.get('/api/admin/credentials', {
      params: {
        kind: credKind.value,
        // 台账主键/档案 DID 一律小写形态存储：把用户粘贴的规范大小写地址
        // 原样传 q 会精确匹配空手而归（2026-10 审计）。查询前先归一。
        q: credQ.value.trim().toLowerCase(),
        limit: 10,
        offset: credOffset.value,
      },
    })
    credRows.value = res.data.credentials || []
    credTotal.value = res.data.total || 0
  } catch (err) {
    toast(t('admin.credOpFail', { err: err?.response?.data?.error || err.message }))
  } finally {
    credLoading.value = false
  }
}

const setCredKind = (k) => {
  credKind.value = k
  credOffset.value = 0
  loadCredRows()
}

const credPage = (delta) => {
  credOffset.value = Math.max(0, credOffset.value + delta * 10)
  loadCredRows()
}

const loadRoster = async () => {
  rosterLoading.value = true
  try {
    const res = await axios.get('/api/admin/admins')
    rosterAddrs.value = res.data.addresses || []
    rosterHistory.value = res.data.history || []
  } catch (err) {
    toast(t('admin.credOpFail', { err: err?.response?.data?.error || err.message }))
  } finally {
    rosterLoading.value = false
  }
}

const demoteAdmin = async (addr) => {
  if (rosterBusy.value) return
  if (
    !(await askConfirm({
      message: t('admin.rosterDemoteConfirm', { addr: addr.slice(0, 10) + '…' }),
      danger: true,
    }))
  )
    return
  try {
    rosterBusy.value = 'demote'
    const headers = await host.sign('demote', { address: addr })
    const res = await axios.post(`/api/admin/demote/${addr}`, {}, { headers })
    toast(
      t('admin.rosterDemoted', { addr: addr.slice(0, 10) + '…', to: res.data.demotedTo || '?' }),
    )
    await loadRoster()
    // 从用户管理撤销时：行徽章与提权/撤销按钮态必须即时翻转（force 绕 3s 缓存）
    host.refresh(true)
  } catch (err) {
    // LAST_ADMIN 等人话错误直出（后端已把防锁死语义写在 error 里）
    toast(t('admin.credOpFail', { err: err?.response?.data?.error || err.message }))
  } finally {
    rosterBusy.value = ''
  }
}

const approveCwt = async (app) => {
  await askConfirm({
    message: t('admin.credConfirmApprove', { addr: app.addressDisplay || app.address }),
    confirmLabel: t('admin.credApprove'),
    run: async () => {
      cwtBusy.value = app._id
      try {
        const headers = await host.sign('cwt/approve', {
          id: app._id,
          address: app.address,
        })
        await axios.post(
          `/api/admin/cwt-applications/${encodeURIComponent(app._id)}/approve`,
          {},
          { headers },
        )
        toast(t('admin.credApproved'))
        await loadCwtApps()
        loadCredRows().catch(() => {})
      } catch (err) {
        toast(t('admin.credOpFail', { err: err?.response?.data?.error || err.message }))
        throw err
      } finally {
        cwtBusy.value = ''
      }
    },
  })
}

const rejectCwt = async (app) => {
  await askConfirm({
    message: t('admin.credConfirmReject', { addr: app.addressDisplay || app.address }),
    confirmLabel: t('admin.credReject'),
    danger: true,
    run: async () => {
      cwtBusy.value = app._id
      try {
        const headers = await host.sign('cwt/reject', {
          id: app._id,
          address: app.address,
        })
        await axios.post(
          `/api/admin/cwt-applications/${encodeURIComponent(app._id)}/reject`,
          {},
          { headers },
        )
        toast(t('admin.credRejected'))
        await loadCwtApps()
        loadCredRows().catch(() => {})
      } catch (err) {
        toast(t('admin.credOpFail', { err: err?.response?.data?.error || err.message }))
        throw err
      } finally {
        cwtBusy.value = ''
      }
    },
  })
}

export function useAdminCred() {
  return {
    cwtApps,
    cwtTotal,
    cwtOffset,
    cwtStatusFilter,
    cwtLoading,
    cwtBusy,
    credRows,
    credTotal,
    credOffset,
    credKind,
    credQ,
    credLoading,
    rosterAddrs,
    rosterHistory,
    rosterLoading,
    rosterBusy,
    loadCwtApps,
    setCwtStatus,
    cwtPage,
    loadCredRows,
    setCredKind,
    credPage,
    loadRoster,
    demoteAdmin,
    approveCwt,
    rejectCwt,
  }
}
