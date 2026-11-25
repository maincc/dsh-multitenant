/**
 * 前端格式化单源（审查轮收敛判例）
 *
 * 背景：fmtBytes×5 + formatBytes×3（两种命名八处实现，≥4 种行为）、
 * shortAddr×6 + shortAddress×4（四种截法 8/10/12/6、空占位 ''/'—'/'-'/'未连接'）。
 * 其中移动端三处 `sizes[i]` 无上限钳位——数据过 1TB 显示 "...undefined"（真 bug）。
 *
 * 统一语义决定（本轮拍板）：
 *   - formatBytes：1024 进制，B/KB/MB/GB/TB/PB；B 级 0 位小数（整数字节），
 *     其余 2 位（管理端原样）；≤0/缺省 → '0 B'；NaN/非数 → '—'；指数钳位防越界。
 *   - shortAddress：主流 8+4 截法（7/10 处现役实现即此形），空值 '—'；
 *     head/tail/empty 可选项——移动端大标题场景保留 12 字截法与自定义空态（'未连接'）。
 */

export function formatBytes(n) {
  if (n === null || n === undefined || n === '') return '—'
  const b = Number(n)
  if (Number.isNaN(b)) return '—'
  if (b <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)))
  return `${(b / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

export function shortAddress(addr, { head = 8, tail = 4, empty = '—' } = {}) {
  if (!addr) return empty
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`
}
