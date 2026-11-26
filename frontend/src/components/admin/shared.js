// 管理端 tab 组件群的共享小件（随 P3 拆分逐批迁入，勿再复制成孪生）
export const tierBadge = (tier) => {
  const map = { 1: 'badge-info', 2: 'badge-warning', 3: 'badge-success' }
  return map[tier] || 'badge-info'
}
export const statusBadge = (status) => {
  const map = {
    running: 'badge-success',
    stopped: 'badge-warning',
    destroyed: 'badge-danger',
    unknown: 'badge-secondary',
  }
  return map[status] || 'badge-info'
}
// fmtTime 参数名 t 为时间戳（遮蔽 i18n t，原样搬迁不改写——纯函数无副作用）
export const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '-')
// statusText 依赖 i18n，工厂化避免把 t 焊进模块
export const makeStatusText = (t) => (status) => {
  const map = {
    running: t('admin.statusRunning'),
    stopped: t('admin.statusStopped'),
    destroyed: t('admin.statusDestroyed'),
    unknown: t('admin.statusUnknown'),
  }
  return map[status] || status
}
