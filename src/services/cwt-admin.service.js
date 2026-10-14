/**
 * CWT 申请-审批-出示 业务服务（M0 后端）
 *
 * 流程（与 docs/cwt-verification-design.md 一致）：
 *   ① 申请  用户 cwt_sign 签 token → submitApplication：解析 + 预验签，过签进待审批队列
 *   ② 审批  管理员复核验签 → approveApplication 写注册表 cwtRegistry + 授权标记 + 审计
 *   ③ 出示  verifyCwtForAccess（cwt.service.js 薄封装）：验签 + 注册表状态判定 → 豁免限时
 *
 * 数据存储：cwtStore（data/cwt/registry.json + applications.json + records.log），
 * 与 data/ 其他业务数据统一；不再写入根目录 state.json。
 * 记录策略：pending / approved 申请永久保留（授权来源证据），rejected 保留最近 100 条。
 * 防洪泛：pending 有**总条数上限**（cwt.maxPending，默认 500，超限 503）+
 *         token 有**字节上限**（cwt.maxTokenBytes，默认 8192）+ 接口按 IP 限流。
 */

import { randomUUID } from 'node:crypto'
import { CONFIG } from '../config/config.js'
import { userService } from './user.service.js'
import { cwtStore } from './cwt.store.js'
import { dataService } from './data.service.js'
import { cwtService } from './cwt.service.js'
import { normalizeAddress } from '../utils/address.js'
import {
  AppError,
  BadRequestError,
  NotFoundError,
  ConflictError,
  InternalError,
  PayloadTooLargeError,
} from '../utils/errors.js'

/** 单个 CWT token 的字节上限（正常 CWT 约 1–2KB；防超大 payload 撑爆磁盘/CPU） */
const DEFAULT_MAX_TOKEN_BYTES = 8192
/**
 * 待审批申请总条数上限（未认证洪泛的硬边界）。
 *
 * 为什么必须有：`POST /api/user/cwt/apply` 是**未认证**端点，token 由调用方
 * 自签（零成本）。加固前 pending 无任何总条数上限、且每次入队都全量重写
 * applications.json —— 可被刷爆磁盘并灌满管理端审批队列。超限直接 503 卸载
 * （fail-closed），而不是继续入队。
 */
const DEFAULT_MAX_PENDING_APPLICATIONS = 500

/** 取正整数配置；非法/缺失回退默认值（防 maxPending:0 之类把功能整个关死） */
function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

class CwtAdminService {
  constructor() {
    const cfg = CONFIG.cwt ?? {}
    // 实例字段（便于测试注入小值），来源：config.json 的 cwt.maxTokenBytes / cwt.maxPending
    this.maxTokenBytes = positiveInt(cfg.maxTokenBytes, DEFAULT_MAX_TOKEN_BYTES)
    this.maxPendingApplications = positiveInt(cfg.maxPending, DEFAULT_MAX_PENDING_APPLICATIONS)
  }

  /** CWT 配置（回退 CONFIG） */
  cwtConfig() {
    return CONFIG.cwt ?? {}
  }

  /**
   * ① 提交申请：解析 + 预验签；只有验签通过的 token 才进待审批队列。
   */
  async submitApplication(token) {
    const cfg = this.cwtConfig()
    if (!cfg.enabled) throw new InternalError('CWT 验证体系未开启（config.json cwt.enabled=false）')

    if (typeof token !== 'string' || !token.includes('.')) {
      throw new BadRequestError('缺少有效的 cwt token')
    }
    // 尺寸上限：先于任何解析/验签（防超大 payload 撑爆磁盘与 CPU）
    if (Buffer.byteLength(token, 'utf8') > this.maxTokenBytes) {
      throw new PayloadTooLargeError(`token 过大（上限 ${this.maxTokenBytes} 字节）`)
    }
    // 队列上限：**刻意放在验签之前** —— 队列满时连密码学开销都不付，直接卸载。
    // pending 计数口径与 cwtStore 的裁剪策略一致（rejected 会被裁到 100 条）。
    const pendingCount = cwtStore
      .getApplications()
      .reduce((n, a) => (a.status === 'pending' ? n + 1 : n), 0)
    if (pendingCount >= this.maxPendingApplications) {
      throw new AppError(
        'OVERLOAD',
        `待审批申请已达上限（${this.maxPendingApplications}），请等待管理员处理后再试`,
        503,
      )
    }

    const result = await cwtService.verify(token, { ttlMs: cfg.ttlMs })
    if (!result.valid) {
      throw new BadRequestError(`token 无效：${result.error}`)
    }

    const address = normalizeAddress(result.address)

    // 已授权 → 不重复申请
    const reg = cwtStore.getRegistry()[address]
    if (reg?.status === 'approved') {
      throw new ConflictError('该地址已通过 CWT 授权，无需重复申请')
    }
    // 已有待审批申请 → 提示
    const pending = cwtStore
      .getApplications()
      .find((a) => a.parsed?.address === address && a.status === 'pending')
    if (pending) {
      throw new ConflictError(`已存在待审批申请（${pending.id}），请等待管理员处理`)
    }

    const app = {
      id: randomUUID().slice(0, 8),
      token,
      parsed: {
        usr: result.usr,
        time: result.time,
        address,
        alg: result.alg,
        chain: result.chain,
      },
      sigOk: true,
      submittedAt: Date.now(),
      status: 'pending',
    }
    await cwtStore.addApplication(app)
    // P2 留痕：申请入队也进时间线（此前 cwt 轨只有 approve/reject/revoke）
    dataService.logOperation('cwt_apply', {
      address,
      usr: result.usr,
      applicationId: app.id,
    })
    console.log(`[cwt] new application from ${address} (usr=${result.usr}, alg=${result.alg})`)
    return { ok: true, applicationId: app.id, parsed: app.parsed }
  }

  /**
   * 我的注册状态 / 申请进度（对用户无敏感情报）
   */
  getStatus(addressRaw) {
    const address = normalizeAddress(addressRaw)
    const registry = cwtStore.getRegistry()[address] ?? null
    const applications = cwtStore
      .getApplications()
      .filter((a) => a.parsed?.address === address)
      .map((a) => ({
        id: a.id,
        status: a.status,
        submittedAt: a.submittedAt,
        usr: a.parsed?.usr,
        alg: a.parsed?.alg,
      }))
      .sort((a, b) => b.submittedAt - a.submittedAt)

    return {
      address,
      authorized: Boolean(registry && registry.status === 'approved'),
      exempt: userService.isUsageExempt(address),
      registry: registry
        ? {
            usr: registry.usr,
            status: registry.status,
            approvedAt: registry.approvedAt,
            approvedBy: registry.approvedBy,
          }
        : null,
      applications,
    }
  }

  /**
   * ② 管理员批准：复核签名（防记录篡改，不校验时效）→ 写注册表 → 授权标记 → 审计
   * approved 申请永久保留（cwtStore 只裁剪 rejected）
   */
  async approveApplication(id, adminAddress) {
    const app = cwtStore.getApplications().find((a) => a.id === id)
    if (!app) throw new NotFoundError(`申请不存在：${id}`)
    if (app.status !== 'pending') throw new ConflictError(`申请状态为 ${app.status}，不能批准`)

    // 批准时复核验签：校验签名有效性（防记录被篡改），但**不校验时效**。
    // 理由：申请时刻已校验过新鲜度；审批是人工异步流程，5 分钟窗口会让管理员
    // 每次审批都失败（用户被迫反复重新提交）。且注册表"无注册时效"（批准即永久
    // 豁免），审批动作受短时效约束自相矛盾。管理员可据列表中的提交时间自行判断。
    const result = await cwtService.verify(app.token, { checkFreshness: false })
    if (!result.valid) {
      throw new BadRequestError(`复核验签失败（签名无效或记录被篡改）：${result.error}`)
    }
    const address = normalizeAddress(result.address)
    const now = Date.now()

    // §5.2 边界①：批准 = registry/applications/用户冗余标记/审计【四方单事务】——
    // 文件时代三次独立落盘留有的"半审批态"窗口，mongodb 形态在这里收口。
    await cwtStore.runTxn(async (session) => {
      await cwtStore.setRegistryEntry(
        address,
        {
          usr: result.usr,
          wallet: address,
          approvedAt: now,
          approvedBy: adminAddress,
          status: 'approved',
        },
        { session },
      )
      app.status = 'approved'
      await cwtStore.saveApplications({ session })
      // 授权标记（运行时豁免展示；豁免判定以注册表为准，此字段为冗余）
      if (userService.state.swtcUsers?.[address]) {
        userService.state.swtcUsers[address].cwtAuthorizedAt = now
        await userService._saveState({ session })
      }
      await cwtStore.appendRecord(
        {
          address,
          usr: result.usr,
          token: app.token,
          alg: result.alg,
          action: 'approve',
          at: now,
          by: adminAddress,
        },
        { session },
      )
    })
    console.log(`[cwt] approved ${address} (usr=${result.usr}) by ${adminAddress}`)
    return { ok: true, address, applicationId: id }
  }

  /**
   * ② 管理员拒绝
   */
  async rejectApplication(id, adminAddress) {
    const app = cwtStore.getApplications().find((a) => a.id === id)
    if (!app) throw new NotFoundError(`申请不存在：${id}`)
    if (app.status !== 'pending') throw new ConflictError(`申请状态为 ${app.status}，不能拒绝`)

    await cwtStore.runTxn(async (session) => {
      app.status = 'rejected'
      await cwtStore.saveApplications({ session })
      await cwtStore.appendRecord(
        {
          address: app.parsed?.address ?? null,
          usr: app.parsed?.usr ?? null,
          token: app.token,
          alg: app.parsed?.alg ?? null,
          action: 'reject',
          at: Date.now(),
          by: adminAddress,
        },
        { session },
      )
    })
    console.log(`[cwt] rejected application ${id} by ${adminAddress}`)
    return { ok: true, applicationId: id }
  }

  /**
   * ② 撤销授权：注册表状态 revoked（历史保留），清除豁免标记 → 该地址回到受限（限时生效）
   */
  async revokeRegistry(addressRaw, adminAddress) {
    const address = normalizeAddress(addressRaw)
    const reg = cwtStore.getRegistry()[address]
    if (!reg) throw new NotFoundError(`注册表无此地址：${address}`)

    const revokedAt = Date.now()
    await cwtStore.runTxn(async (session) => {
      reg.status = 'revoked'
      reg.revokedAt = revokedAt
      await cwtStore.setRegistryEntry(address, reg, { session })
      if (userService.state.swtcUsers?.[address]) {
        delete userService.state.swtcUsers[address].cwtAuthorizedAt
        delete userService.state.swtcUsers[address].cwtVerifiedAt
        await userService._saveState({ session })
      }
      await cwtStore.appendRecord(
        {
          address,
          usr: reg.usr,
          token: null,
          alg: null,
          action: 'revoke',
          at: revokedAt,
          by: adminAddress,
        },
        { session },
      )
    })
    console.log(`[cwt] revoked ${address} by ${adminAddress}`)
    return { ok: true, address, status: 'revoked' }
  }

  // ---------- 查询 ----------

  listApplications() {
    return cwtStore.getApplications().slice().reverse()
  }

  /**
   * 分页查询申请列表（供管理端 HTTP 接口使用）。
   * 排序：按入队时间倒序（最新在前）；支持按状态筛选。
   * @param {object} [opts]
   * @param {number} [opts.limit] 每页条数（默认 50，调用方负责上下限钳制）
   * @param {number} [opts.offset] 偏移量（默认 0）
   * @param {string|null} [opts.status] 状态筛选：pending | approved | rejected；null/'all' 为全部
   * @returns {{ items: object[], total: number }}
   */
  queryApplications({ limit = 10, offset = 0, status = null } = {}) {
    let list = cwtStore.getApplications().slice().reverse()
    if (status && status !== 'all') {
      list = list.filter((a) => a.status === status)
    }
    const total = list.length
    const start = Math.max(0, offset)
    return { items: list.slice(start, start + Math.max(0, limit)), total }
  }

  /**
   * 分页查询授权注册表（供管理端 HTTP 接口使用）。
   * 排序：按批准时间倒序（最新批准在前；无 approvedAt 的排最后）。
   * @param {object} [opts]
   * @param {number} [opts.limit] 每页条数（默认 50，调用方负责上下限钳制）
   * @param {number} [opts.offset] 偏移量（默认 0）
   * @returns {{ items: object[], total: number }}
   */
  queryRegistry({ limit = 10, offset = 0 } = {}) {
    const list = Object.entries(cwtStore.getRegistry())
      .map(([address, entry]) => ({ address, ...entry }))
      .sort((a, b) => (b.approvedAt ?? 0) - (a.approvedAt ?? 0))
    const total = list.length
    const start = Math.max(0, offset)
    return { items: list.slice(start, start + Math.max(0, limit)), total }
  }

  /**
   * 分页读取审计记录（新 → 旧）
   * @param {number} [limit] 本页条数
   * @param {number} [offset] 偏移（0 = 最新一条开始）
   * @returns {{ records: object[], hasMore: boolean }}
   */
  listRecords(limit = 10, offset = 0) {
    return cwtStore.listRecords(limit, offset) // json=同步值 mongo=Promise，消费方 await 兼容两态
  }
}

export const cwtAdminService = new CwtAdminService()
