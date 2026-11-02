import { ref } from 'vue'
import axios from 'axios'

/**
 * 管理页签待审红点（单例共享：AdminPanel 独立侧栏与 UserCenter 并入侧栏两处消费）。
 * 队列口径按本仓实账：
 *  - 环境审批：GET /api/admin/environments 全量里数 status==='draft'
 *    （draft 是本仓真队列字面——重提入队写 draft，pending 系幽灵态，user.routes 白纸黑字）；
 *  - 凭证审批：CWT 解限申请单就在该页签内，服务端过滤 status=pending 借 total 白拿计数。
 * fail-open：查询失败沉默保留上一读数——红点是提示不是闸门，绝不因它挡住界面。
 */
const env = ref(0)
const cred = ref(0)
let timer = null
let subs = 0

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
  return { badgeFor, syncEnvRows, refresh }
}

/**
 * 环境红点就地搭车：管理面板 load() 本就拉了全量环境，数 draft 的活直接从
 * 它拿到的行算——审批/驳回落定后徽标即刻跟随（60 秒轮询只是别的浏览器/别人
 * 操作的兜底，不该是本浏览器自己的节拍）。
 */
function syncEnvRows(rows) {
  env.value = (rows || []).filter((e) => e.status === 'draft').length
}

export function startAdminBadges() {
  subs++
  if (timer) return
  refresh()
  timer = setInterval(refresh, 60000)
}

export function stopAdminBadges() {
  subs--
  if (subs <= 0) {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    subs = 0
  }
}
