/**
 * P2 装配结构闸（refactor-giant-files §三 · P2 审查 L2 整改）
 *
 * 装配若漏列一个 mixin、或将来 mixin↔class 撞名，Object.assign 语义是**静默后写胜**——
 * 本测试把 prototype 成员集与描述符形态钉死（成本一行断言换一道永不静默的闸）。
 */
import { describe, expect, it } from 'vitest'
import { UserService } from '../src/services/user.service.js'

describe('P2 域拆装配结构闸', () => {
  it('prototype 成员总数恰为 65（基线 class 成员含 constructor，双向差集空——审查实测）', () => {
    expect(Object.getOwnPropertyNames(UserService.prototype)).toHaveLength(65)
  })

  it('五域代表方法与留守方法全部在位（漏列 mixin 在此显形，不再静默后写胜）', () => {
    const proto = UserService.prototype
    for (const name of [
      // 留守域
      'ensureContainer',
      'finalizeTenant',
      '_saveState',
      'restoreFromDocker',
      'resolveTenantCapability',
      'getTenantDshVersion',
      // ports
      'allocateInternalPort',
      'reclaimDestroyedPorts',
      // usage
      'settleUsage',
      'checkUsageLimitAndStop',
      // queue
      'processWaitQueue',
      'preflightCheck',
      // resources
      'monitorResources',
      'collectDiskUsage',
      // queries
      'getAllUsers',
      '_computeAllUsers',
    ]) {
      expect(typeof proto[name], name).toBe('function')
    }
  })

  it('mixin 方法与 class 体描述符语义一致：prototype 零可枚举成员（P2 审查整改钉）', () => {
    // Object.assign 装配会让 29 个 mixin 方法 enumerable（基线 class 方法非枚举）——
    // defineProperty 装配后此处必须为空
    expect(Object.keys(UserService.prototype)).toEqual([])
    const d = Object.getOwnPropertyDescriptor(UserService.prototype, 'getAllUsers')
    expect(d.enumerable).toBe(false)
    expect(d.writable).toBe(true)
    expect(d.configurable).toBe(true)
  })
})
