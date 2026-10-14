/**
 * 全局对话框（自研，替代原生 confirm/alert）——UI 意见 2026-10：
 * 原生弹窗顶上是浏览器域名"假标题"、正文塞不进操作对象明细，删卷这类
 * 不可逆确认只能对着一个数字点确定。askConfirm 无标题行、正文即动作描述，
 * 可选 details 列表把"要对哪些对象下手"摆进决策现场。
 *
 * 用法：
 *   const ok = await askConfirm(t('admin.xxxConfirm'))            // 普通确认
 *   const ok = await askConfirm({                                  // 危险确认+明细
 *     message: t('admin.orphanConfirm', { n: list.length }),
 *     details: list,                                               // 逐行展示的对象清单
 *     danger: true,                                                // 红色确认按钮
 *     confirmLabel: t('admin.orphanCleanBtn', { n: list.length }), // 按钮写具体动作
 *   })
 *   if (!ok) return
 *   toast('已保存')   // 提示类（按文案自动分 error/info）
 */
import { reactive } from 'vue'

export const dialogState = reactive({
  confirm: { open: false, opts: null },
  toasts: [],
})

/** @returns {Promise<boolean>} true=点确认，false=取消/Esc/点遮罩 */
export function askConfirm(options) {
  const opts = typeof options === 'string' ? { message: options } : { ...options }
  return new Promise((resolve) => {
    dialogState.confirm = { open: true, opts, _resolve: resolve }
  })
}

export function settleConfirm(ok) {
  const c = dialogState.confirm
  if (!c.open) return
  dialogState.confirm = { open: false, opts: null }
  c._resolve(ok)
}

/** error/info 按文案启发式分类（沿用原 alert 时代大量"失败：xxx"话术） */
function autoKind(message) {
  return /fail|error|invalid|denied|失败|错误|异常|拒绝|无效/i.test(String(message))
    ? 'error'
    : 'info'
}

let toastSeq = 0
export function toast(message, kind = 'auto', ms = 3800) {
  const id = ++toastSeq
  const k = kind === 'auto' ? autoKind(message) : kind
  dialogState.toasts.push({ id, message: String(message), kind: k })
  setTimeout(() => {
    dialogState.toasts = dialogState.toasts.filter((t) => t.id !== id)
  }, ms)
}
