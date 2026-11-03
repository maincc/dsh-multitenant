import { ref } from 'vue'
import axios from 'axios'

/**
 * 管理页签待审红点（单例共享：AdminPanel 独立侧栏与 UserCenter 并入侧栏两处消费）。
 * 队列口径按本仓实账：
 *  - 环境审批：GET /api/admin/environments 全量里数 status==='draft'
 *    （draft 是本仓真队列字面——重提入队写 draft，pending 系幽灵态，user.routes 白纸黑字）；
 *  - 凭证审批：CWT 解限申请单就在该页签内，服务端过滤 status=pending 借 total 白拿计数。
 * fail-open：查询失败沉默保留上一读数——红点是提示不是闸门，绝不因它挡住界面。
 * 更新时刻=挂载一次+动作搭车，无后台定时器。
 */
const env = ref(0)
const cred = ref(0)
// 无轮询定时器（用户裁定 2026-11-02：『动作结束询问一次』即够）：判数只发生在
// 两个时刻——面板打开挂载查一次、动作落定后列表重拉搭车同步。代价如实：别的
// 浏览器/同事做的审批，本页要等下次打开或下次动作才见——单人管理场景可接受。

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
    cred.value = res.data.total || 0
  } catch {
    /* 同上 */
  }
}

export function useAdminBadges() {
  const badgeFor = (key) => (key === 'envtpl' ? env.value : key === 'cred' ? cred.value : 0)
  return { badgeFor, syncEnvRows, syncCredCount, refreshCred, refresh }
}

/**
 * 环境红点就地搭车：管理面板 load() 本就拉了全量环境，数 draft 的活直接从
 * 它拿到的行算——审批/驳回落定后徽标即刻跟随（60 秒轮询只是别的浏览器/别人
 * 操作的兜底，不该是本浏览器自己的节拍）。
 */
function syncEnvRows(rows) {
  env.value = (rows || []).filter((e) => e.status === 'draft').length
}

/** 凭证页签同款搭车：CWT 列表在 pending 视图重拉时，total 就是待审数，直接同步 */
export function syncCredCount(n) {
  cred.value = n || 0
}

/** 非 pending 视图（或跨端兜底）时的轻取：limit=1 只为拿 total */
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

/** 面板挂载时调用：开门查一次账（动作后的更新全靠 syncEnvRows/syncCredCount 搭车） */
export function startAdminBadges() {
  refresh()
}
