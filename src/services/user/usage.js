/**
 * 用户域模块 · 每日限时账（refactor-giant-files §P2 第二刀，源 user.service.js 逐字节搬运）
 *
 * 三枚模块级 free function（todayStr/dayStartMs/usageRecMs）随域迁入：
 * 搬前已 grep 全部调用点——仅 settleUsage/getUsedMinutes 消费，无跨域引用残留。
 * 精度三修注释（2026-10 审计）原文照录；"停成功才结算"的顺序纪律在方法体内原位。
 */

import { CONFIG } from '../../config/config.js'
import { credentialService } from '../credential.service.js'
import { dockerService } from '../docker.service.js'
import { dataService } from '../data.service.js'
import { swtcContainerName } from '../../utils/address.js'

/** 本地日期 YYYY-MM-DD（每日限时按此重置） */
function todayStr() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 今日本地 00:00 的毫秒时间戳（跨午夜运行段的截断点，2026-10 审计 #配额精度） */
function dayStartMs() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * usages 记录 → 毫秒累计。
 * 新格式 {date, ms, minutes} 直取 ms；旧格式 {date, minutes}（历史落盘/测试夹具）
 * 折算 minutes*60000——下次 settle 写回即自然完成迁移，无需启动期批量改写。
 */
function usageRecMs(rec) {
  return typeof rec.ms === 'number' ? rec.ms : (rec.minutes || 0) * 60000
}

export const usageMixin = {
  /**
   * 每日使用时限配置（优先 state，回退 config.json）
   */
  usageLimitConfig() {
    return this.state?.usageLimit ?? CONFIG.usageLimit ?? {}
  },

  /**
   * 结算一段运行时长：把 usageStartedAt 累计进当日 usages，然后清零起点。
   * 所有"容器停止"路径都要调用，保证挂机时间也被准确结算。
   *
   * 2026-10 全面审计三处精度修复（原实现在免费额度语义上是可绕过的）：
   * ① 尾差：原先每段 `Math.floor(段/60000)`，<60s 的段整段记 0——反复"起 59s 停一次"
   *    当日额度几乎不掉，限时形同虚设。现按**毫秒**累计（usages[].ms），
   *    minutes 字段照旧双写供展示/旧读方使用，只有视图层才 floor。
   * ② 跨午夜：容器 23:50 起、00:10 结算时，原先把 20 分钟全记进"今天"——
   *    新的一天被昨天开的段白白吃掉。现段起点截到今日 00:00（昨日槽本就归零，
   *    跨日部分丢弃即是正确语义）。
   * ③ 锚点：settledAt 由调用方在 **docker stop 成功之后**传入（默认现在），
   *    与"先停再结"的顺序纪律配套（见各停止路径）。
   * @returns {number} 本次结算的分钟数（视图口径）
   */
  settleUsage(address, settledAt = Date.now()) {
    const user = this.state.swtcUsers?.[address]
    const startedAt = user?.usageStartedAt
    if (!startedAt) return 0
    const today = todayStr()
    const rec = this.state.usages[address] || {}
    const baseMs = rec.date === today ? usageRecMs(rec) : 0
    const effStart = Math.max(startedAt, dayStartMs())
    const segMs = Math.max(0, settledAt - effStart)
    // P7 顺序纪律：先清表针再累计——若颠倒，中间任何失败会让下一段重复计费
    delete user.usageStartedAt
    const ms = baseMs + segMs
    this.state.usages[address] = { date: today, ms, minutes: Math.floor(ms / 60000) }
    return Math.floor(segMs / 60000)
  },

  /**
   * 当日已用分钟（含当前运行段），跨日自动归零
   */
  getUsedMinutes(address) {
    const today = todayStr()
    const rec = this.state.usages[address]
    let ms = rec && rec.date === today ? usageRecMs(rec) : 0
    const user = this.state.swtcUsers?.[address]
    if (user?.usageStartedAt) {
      // 与 settleUsage 同口径：跨午夜的段只计今日部分
      ms += Math.max(0, Date.now() - Math.max(user.usageStartedAt, dayStartMs()))
    }
    return Math.floor(ms / 60000)
  },

  /**
   * 启动容器前的每日额度检查；超限抛 USAGE_LIMIT_REACHED（开关关闭则放行）
   */
  ensureUsageAllowed(address) {
    const cfg = this.usageLimitConfig()
    if (!cfg.enabled) return
    // v1.4：持 CWT 解除凭证 = 不限时（台账快照同步查，零 I/O）
    if (credentialService.isExemptSync(address)) return
    const limit = cfg.dailyMinutes
    if (limit === null || !Number.isFinite(limit) || limit <= 0) return
    const used = this.getUsedMinutes(address)
    if (used >= limit) {
      const err = new Error(`今日使用时长已达上限（${limit} 分钟），请明日再试`)
      err.code = 'USAGE_LIMIT_REACHED'
      err.usedMinutes = used
      err.dailyLimit = limit
      throw err
    }
  },

  /**
   * 定时检查：运行中的非豁免容器超限 → 优雅停止（结算后停）
   */
  async checkUsageLimitAndStop() {
    if (this._usageCheckRunning) return
    this._usageCheckRunning = true
    try {
      const cfg = this.usageLimitConfig()
      if (!cfg.enabled) return
      // 豁免判据走 credentialService 内存快照（其 init 自带周期水合，不在热循环里 await 库）
      const limit = cfg.dailyMinutes
      if (!Number.isFinite(limit) || limit <= 0) return
      const grace =
        this.state.cleanupPolicy?.stopGraceSeconds ?? CONFIG.cleanup.stopGraceSeconds ?? 60
      let changed = false
      for (const [address, user] of Object.entries(this.state.swtcUsers || {})) {
        if (user.containerStatus !== 'running') continue
        if (credentialService.isExemptSync(address)) continue
        if (this.getUsedMinutes(address) < limit) continue
        // 2026-10 审计：原先"先结算后停止"——若 stop 失败（continue 走人），
        // 表针已被清掉而容器还在跑，此后一分钟都不计费 = 免费无限运行。
        // 现在停成功才结算（锚点=此刻，容器实际已停）。
        const name = swtcContainerName(address)
        try {
          await dockerService.stopContainer(name, grace)
        } catch (err) {
          console.error(`[usage-limit] failed to stop ${name}:`, err.message)
          continue
        }
        this.settleUsage(address)
        user.containerStatus = 'stopped'
        user.stoppedAt = Date.now()
        changed = true
        console.log(
          `[usage-limit] ${address} reached ${limit}min daily limit, container stopped (grace ${grace}s)`,
        )
        dataService.logOperation('system_usage_limit_stop', {
          address,
          operator: 'system',
          dailyLimitMinutes: limit,
        })
      }
      if (changed) await this._saveState()
    } finally {
      this._usageCheckRunning = false
    }
  },
}
