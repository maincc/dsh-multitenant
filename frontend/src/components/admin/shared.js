// 管理端 tab 组件群的共享小件（随 P3 拆分逐批迁入，勿再复制成孪生）
export const tierBadge = (tier) => {
  const map = { 1: 'badge-info', 2: 'badge-warning', 3: 'badge-success' }
  return map[tier] || 'badge-info'
}
