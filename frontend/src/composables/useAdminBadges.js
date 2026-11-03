import { ref } from 'vue'
import axios from 'axios'

/**
 * 管理页签待审红点（单例共享：AdminPanel 独立侧栏与 UserCenter 并入侧栏两处消费）。
 * 队列口径按本仓实账：
 *  - 环境审批：GET /api/admin/environments 全量里数 status==='draft'
 *    （draft 是本仓真队列字面——重提入队写 draft，pending 系幽灵态，user.routes 白纸黑字）；
 *  - 凭证审批：CWT 解限申请单就在该页签内，服务端过滤 status=pending 借 total 白拿计数。
 * fail-open：查询失败沉默保留上一读数——红点是提示不是闸门，绝不因它挡住界面。
 *
 * 节拍器规矩（用户裁定 2026-11-02 终态）：
 *  - 频率可配置：走既有通道 GET /api/stats → uiConfig.refreshIntervalMs
 *    （config.json admin.refreshIntervalMs，默认 15000——改配置重启即生效，不重 build 前端）；
 *  - 只在管理员在场时打表：宿主组件（AdminPanel / UserCenter role=admin）start，
 *    全卸载或角色跌落即 stop——普通用户访问不产生任何红点流量；
 *  - 前台才打：页面切后台停表，回前台立即刷一次再续表（与管理列表既有轮询同精神）；
 *  - 本端动作不等节拍：审批后列表重拉走 syncEnvRows/syncCredCount 即时搭车。
 */
const env = ref(0)
const cred = ref(0)
let timer = null
let subs = 0
let tickMs = 15000
let tickInited = false
let visBound = false

async function refresh() {
  try {
    const res = await axios.get('/api/admin/environments')
    syncEnvRows(res.data.environments)
  } catch {
    /* 查不了不夺上一读数 */
  }
  try {
    const res = await axios.get('/api/admin/cwt-applications', {
      params: { status: 'pending', limit: 1 },
    })
    syncCredCount(res.data.total)
  } catch {
    /* 同上 */
  }
}

/** 频率读取：搭 /api/stats 的 uiConfig 顺风车（requireAdmin——非管理员 403 静默落默认） */
async function initTick() {
  try {
    const res = await axios.get('/api/stats')
    const v = Number(res.data?.uiConfig?.refreshIntervalMs)
    if (v >= 1000) tickMs = v
  } catch {
    /* 读不到就用默认 15s，不因此罢工也不因此报错 */
  }
  reschedule()
}

function reschedule() {
  if (timer) clearInterval(timer)
  timer = setInterval(refresh, tickMs)
}

function onVisibility() {
  if (document.visibilityState === 'visible') {
    if (subs > 0) {
      refresh()
      reschedule()
    }
  } else if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function useAdminBadges() {
  const badgeFor = (key) => (key === 'envtpl' ? env.value : key === 'cred' ? cred.value : 0)
  return { badgeFor, syncEnvRows, syncCredCount, refreshCred, refresh }
}

/** 环境红点就地搭车：管理面板 load() 本就拉了全量环境，数 draft 从它拿到的行算 */
export function syncEnvRows(rows) {
  env.value = (rows || []).filter((e) => e.status === 'draft').length
}

/** 凭证页签同款搭车：CWT 列表在 pending 视图重拉时，total 就是待审数 */
export function syncCredCount(n) {
  cred.value = n || 0
}

/** 非 pending 视图时的轻取：limit=1 只为拿 total */
export async function refreshCred() {
  try {
    const res = await axios.get('/api/admin/cwt-applications', {
      params: { status: 'pending', limit: 1 },
    })
    syncCredCount(res.data.total)
  } catch {
    /* fail-open：查不了保留上一读数 */
  }
}

/** 管理员宿主挂载时调用：立即查账 + 读配置频率 + 起表（引用计数双宿主单表） */
export function startAdminBadges() {
  subs++
  refresh()
  if (!visBound) {
    document.addEventListener('visibilitychange', onVisibility)
    visBound = true
  }
  if (!tickInited) {
    tickInited = true
    initTick()
  } else if (!timer && document.visibilityState === 'visible') {
    reschedule()
  }
}

/** 全部管理宿主卸载（或角色跌落）才停表——普通用户面前绝不打表 */
export function stopAdminBadges() {
  subs--
  if (subs <= 0) {
    subs = 0
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
