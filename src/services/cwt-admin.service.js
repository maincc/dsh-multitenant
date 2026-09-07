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
 */

import { randomUUID } from 'node:crypto'
import { CONFIG } from '../config/config.js'
import { userService } from './user.service.js'
import { dataService } from './data.service.js'
import { cwtStore } from './cwt.store.js'
import { cwtService } from './cwt.service.js'
import { normalizeAddress } from '../utils/address.js'
import { BadRequestError, NotFoundError, ConflictError, InternalError } from '../utils/errors.js'

class CwtAdminService {
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
    cwtStore.addApplication(app)
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
   * ② 管理员批准：复核验签（防批准过期 token）→ 写注册表 → 授权标记 → 审计
   * approved 申请永久保留（cwtStore 只裁剪 rejected）
   */
  async approveApplication(id, adminAddress) {
    const cfg = this.cwtConfig()
    const app = cwtStore.getApplications().find((a) => a.id === id)
    if (!app) throw new NotFoundError(`申请不存在：${id}`)
    if (app.status !== 'pending') throw new ConflictError(`申请状态为 ${app.status}，不能批准`)

    // 批准时复核验签（token 可能在申请后过期）
    const result = await cwtService.verify(app.token, { ttlMs: cfg.ttlMs })
    if (!result.valid) {
      throw new BadRequestError(`复核验签失败，请让用户重新提交：${result.error}`)
    }
    const address = normalizeAddress(result.address)
    const now = Date.now()

    cwtStore.setRegistryEntry(address, {
      usr: result.usr,
      wallet: address,
      approvedAt: now,
      approvedBy: adminAddress,
      status: 'approved',
    })
    app.status = 'approved'
    cwtStore.saveApplications()

    // 授权标记（运行时豁免展示；豁免判定以注册表为准，此字段为冗余）
    if (userService.state.swtcUsers?.[address]) {
      userService.state.swtcUsers[address].cwtAuthorizedAt = now
      dataService.saveState(userService.state)
    }

    cwtStore.appendRecord({
      address,
      usr: result.usr,
      token: app.token,
      alg: result.alg,
      action: 'approve',
      at: now,
      by: adminAddress,
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

    app.status = 'rejected'
    cwtStore.saveApplications()
    cwtStore.appendRecord({
      address: app.parsed?.address ?? null,
      usr: app.parsed?.usr ?? null,
      token: app.token,
      alg: app.parsed?.alg ?? null,
      action: 'reject',
      at: Date.now(),
      by: adminAddress,
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

    reg.status = 'revoked'
    reg.revokedAt = Date.now()
    cwtStore.setRegistryEntry(address, reg)
    if (userService.state.swtcUsers?.[address]) {
      delete userService.state.swtcUsers[address].cwtAuthorizedAt
      delete userService.state.swtcUsers[address].cwtVerifiedAt
      dataService.saveState(userService.state)
    }
    cwtStore.appendRecord({
      address,
      usr: reg.usr,
      token: null,
      alg: null,
      action: 'revoke',
      at: Date.now(),
      by: adminAddress,
    })
    console.log(`[cwt] revoked ${address} by ${adminAddress}`)
    return { ok: true, address, status: 'revoked' }
  }

  // ---------- 查询 ----------

  listApplications() {
    return cwtStore.getApplications().slice().reverse()
  }

  listRegistry() {
    return Object.entries(cwtStore.getRegistry()).map(([address, entry]) => ({
      address,
      ...entry,
    }))
  }

  listRecords(limit = 200) {
    return cwtStore.listRecords(limit)
  }
}

export const cwtAdminService = new CwtAdminService()
