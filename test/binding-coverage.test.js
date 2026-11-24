/**
 * 签名操作声明面一致性（refactor-giant-files P1 现行战果）
 *
 * 发现记录（2026-11，本分支拆分时）：ADMIN_SIGNED_OPERATIONS 数组漏登
 * env-commit/env-publish/env-revoke/env-apply/env-scan/env-reject/skill-hide 七项
 * ——buildBinding switch 早已实现、路由一直在签，但数组此前无消费方，漂移零报错。
 * P1 注册表把数组变成 signOp 校验源后，这类漂移从"静默"变"注册即抛"。
 *
 * 本测试三面钉死：
 *   ① 数组 ⊆ switch：每个在册 op 用最小合法 payload 走 buildBinding 必须出 binding
 *   ② switch ⊆ 数组：从源码提取全部 case 操作名，反向对账
 *   ③ 注册表 signOp ⊆ 数组（defineRoute 已拦，这里对全量 ADMIN_ROUTES 再验一次）
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../src/services/tenant-config.service.js', () => ({
  tenantConfigService: {
    issueChallenge: vi.fn(),
    consumeChallenge: vi.fn(),
    verifySignature: vi.fn(),
  },
  SIGN_PURPOSE: { ADMIN_OP: 'admin-op' },
  buildSignedMessage: vi.fn(),
}))

import {
  ADMIN_SIGNED_OPERATIONS,
  buildBinding,
} from '../src/middleware/admin-signature.middleware.js'
import { ADMIN_ROUTES } from '../src/routes/admin/index.js'

const ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'

/** 每个 op 的"最小合法载荷"——与 buildBinding 各 case 的必填位对齐 */
const MINIMAL_PAYLOADS = {
  promote: { address: ADDR },
  demote: { address: ADDR },
  'force-stop': { address: ADDR },
  remove: { address: ADDR },
  'delete-volume': { address: ADDR },
  reset: { address: ADDR },
  leave: { address: ADDR },
  restart: { address: ADDR },
  stop: { address: ADDR },
  'user-upgrade': { address: ADDR, tier: '2' },
  'user-downgrade': { address: ADDR, tier: '2' },
  'cleanup-orphan-volumes': { volumes: ['dsh-data-swtc-x'] },
  'dsh/apply': { address: ADDR },
  'dsh/prune-images': { ids: ['deadbeefdead'] },
  'dsh/select': { ref: 'dsh-multitenant:1.0.0' },
  'dsh/build-image': { version: '1.0.0' },
  'cwt/approve': { id: 'app-1', address: ADDR },
  'cwt/reject': { id: 'app-1', address: ADDR },
  'env-commit': { address: ADDR, slug: 'tpl-1', include: {} },
  'env-publish': { id: 'tpl-1' },
  'env-revoke': { id: 'tpl-1' },
  'env-reject': { id: 'tpl-1' },
  'env-scan': { id: 'tpl-1' },
  'env-apply': { id: 'tpl-1', address: ADDR },
  'skill-hide': { name: 'some-skill' },
}

describe('签名操作声明面一致性', () => {
  it('① 数组 ⊆ switch：每个在册 op 都有 buildBinding 实现（最小载荷出 binding）', () => {
    for (const op of ADMIN_SIGNED_OPERATIONS) {
      const payload = MINIMAL_PAYLOADS[op]
      expect(payload, `缺 ${op} 的最小载荷测试夹具`).toBeTruthy()
      expect(buildBinding(op, payload), `buildBinding(${op}) 不应为 null`).not.toBeNull()
    }
  })

  it('② switch ⊆ 数组：源码 case 提取的操作名全部在册（防"实现了但没声明"再漂移）', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/middleware/admin-signature.middleware.js'),
      'utf8',
    )
    const fnBody = src.slice(src.indexOf('export function buildBinding'))
    const cases = [...fnBody.matchAll(/case '([^']+)':/g)].map((m) => m[1])
    const unique = [...new Set(cases)]
    expect(unique.length).toBeGreaterThan(0)
    for (const op of unique) {
      expect(ADMIN_SIGNED_OPERATIONS, `switch 实现了 "${op}" 但数组未声明`).toContain(op)
    }
    // 反向也齐：数组里没有对应 case 的（应为零）
    for (const op of ADMIN_SIGNED_OPERATIONS) {
      expect(unique, `数组声明了 "${op}" 但 switch 无实现`).toContain(op)
    }
  })

  it('③ 注册表全部 signOp 在册且守卫为 admin', () => {
    for (const r of ADMIN_ROUTES) {
      if (!r.signOp) continue
      expect(ADMIN_SIGNED_OPERATIONS, `注册表 signOp "${r.signOp}" 未在白名单`).toContain(r.signOp)
      expect(r.guard, `signOp "${r.signOp}" 必须挂在 admin 守卫上`).toBe('admin')
    }
  })
})
