/**
 * 全局对话框（自研，替代原生 confirm/alert）——UI 意见 2026-10：
 * 原生弹窗顶上是浏览器域名"假标题"、正文塞不进操作对象明细，删卷这类
 * 不可逆确认只能对着一个数字点确定。askConfirm 无标题行、正文即动作描述，
 * 可选 details 列表把"要对哪些对象下手"摆进决策现场。
 *
 * 用法：
 *   const ok = await askConfirm(t('admin.xxxConfirm'))            // 普通确认
 *   const ok = await askConfirm({                                 // 危险确认+明细
 *     message: t('admin.orphanConfirm', { n: list.length }),
 *     details: list,                                              // 逐行展示的对象清单
 *     danger: true,                                               // 红色确认按钮
 *     confirmLabel: t('admin.orphanCleanBtn', { n: list.length }),// 按钮写具体动作
 *     run: () => doTheThing(),                                    // 动作在弹窗内完成：
 *   })                                                            // busy 锁屏直到结束
 *   if (!ok) return
 *   toast('已保存')   // 提示类（按文案自动分 error/info）
 */
import { reactive } from 'vue'

export const dialogState = reactive({
  confirm: { open: false, busy: false, opts: null },
  toasts: [],
})

/**
 * @returns {Promise<boolean>} true=确认且（如有 run）动作成功；
 *   false=取消/Esc/遮罩/run 抛错（错误已自动 toast，调用方无须再报）
 * opts.run 给了就跑"弹窗内动作"模式：点确认→busy 锁屏（按钮/Esc/遮罩全冻结，
 * 防双击与中途逃离）→动作完成弹窗才关闭。没给则维持"点即关"旧语义。
 */
export function askConfirm(options) {
  const opts = typeof options === 'string' ? { message: options } : { ...options }
  return new Promise((resolve) => {
    if (dialogState.confirm.open) {
      // 防重入：已有弹窗时后来的请求按"取消"处理并留 console 线索
      // （静默覆盖会让前一个 promise 永不结算——那是更坏的失败模式）
      console.warn('[useDialog] askConfirm 重入被拒（已有弹窗未关闭）:', opts.message)
      resolve(false)
      return
    }
    dialogState.confirm = { open: true, busy: false, opts, _resolve: resolve }
  })
}

/** 关闭并结算。busy 期间一切关闭路径（取消键/Esc/遮罩）无效——"动作没完别想走" */
export function settleConfirm(ok) {
  const c = dialogState.confirm
  if (!c.open || c.busy) return
  dialogState.confirm = { open: false, busy: false, opts: null }
  c._resolve(ok)
}

/** 确认键入口：无 run 直接结算；有 run 先进 busy，动作结束才结算 */
export async function confirmWithRun() {
  const c = dialogState.confirm
  if (!c.open || c.busy) return
  const run = c.opts && c.opts.run
  if (typeof run !== 'function') {
    settleConfirm(true)
    return
  }
  dialogState.confirm = { ...c, busy: true, opts: c.opts }
  try {
    await run()
    closeAndResolve(true)
  } catch (err) {
    // 提取可读错误：后端 4xx 的 data.error 优先（与全站 catch 话术同源），其次 message
    const msg =
      (err && err.response && err.response.data && err.response.data.error) ||
      (err && err.message) ||
      String(err)
    toast(msg, 'error')
    closeAndResolve(false)
  }
}

function closeAndResolve(ok) {
  const c = dialogState.confirm
  dialogState.confirm = { open: false, busy: false, opts: null }
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
