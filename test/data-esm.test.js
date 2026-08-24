/**
 * 真实 Node ESM 回归测试
 *
 * data.service.js 曾在内联使用 require('node:fs') —— 在真实 Node ESM
 * （package.json "type": "module"）下会抛 "require is not defined"，
 * 但 Vitest 的运行器注入了 require polyfill，导致旧测试全部通过却掩盖了
 * 生产运行时的崩溃（logOperation 静默失败、操作日志从未写入）。
 *
 * 本测试用子进程 + 真实 node 执行（--input-type=module），验证这些方法
 * 在无 polyfill 环境下可用，防止该问题回归。
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

describe('data.service.js 在真实 Node ESM 下可用', () => {
  const tmp = join(process.cwd(), 'test-data', 'esm-regression')

  it('logOperation / saveUser / getAllUsers / deleteUserFile 不抛 require is not defined', () => {
    rmSync(tmp, { recursive: true, force: true })

    const script = `
      import { mkdirSync } from 'node:fs'
      import { DataService } from './src/services/data.service.js'
      const s = new DataService()
      s.dataDir = ${JSON.stringify(tmp)}
      mkdirSync(${JSON.stringify(join(tmp, 'users'))}, { recursive: true })
      mkdirSync(${JSON.stringify(join(tmp, 'config'))}, { recursive: true })
      s.logOperation('esm_check', { phase: 'regression' })
      s.saveUser('jtestaddr1234567890123456789012345', { address: 'x' })
      const n = s.getAllUsers().length
      s.deleteUserFile('jtestaddr1234567890123456789012345')
      if (n !== 1) throw new Error('expected 1 user, got ' + n)
      console.log('ESM_OK')
    `

    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    expect(out).toContain('ESM_OK')
    expect(out).not.toContain('require is not defined')
    rmSync(tmp, { recursive: true, force: true })
    expect(existsSync(tmp)).toBe(false)
  })
})
