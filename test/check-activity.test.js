/**
 * check-activity.mjs 脚本级测试
 *
 * 验证：扫描 sessions/ 目录，正确报告最新会话文件的修改时间与文件数
 * （非 session 文件不计入；目录缺失返回 0）。
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'src', 'services', 'check-activity.mjs')
const run = (root) => execFileSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' }).trim()

describe('check-activity.mjs', () => {
  it('sessions 目录不存在 → 0 / 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-test-'))
    try {
      expect(JSON.parse(run(join(dir, 'missing')))).toEqual({
        latestSessionMtime: 0,
        sessionCount: 0,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('报告最新会话文件的修改时间（跨工作区/目录递归）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-test-'))
    try {
      const oldDir = join(dir, 'sessions', 'ws1', 'session-old')
      const freshDir = join(dir, 'sessions', 'ws2', 'session-fresh')
      mkdirSync(oldDir, { recursive: true })
      mkdirSync(freshDir, { recursive: true })
      const oldFile = join(oldDir, 'session.jsonl.zstd')
      const freshFile = join(freshDir, 'session.jsonl')
      writeFileSync(oldFile, 'x')
      writeFileSync(freshFile, 'x')
      const oldT = Date.now() - 600000
      const freshT = Date.now() - 1000
      utimesSync(oldFile, new Date(oldT), new Date(oldT))
      utimesSync(freshFile, new Date(freshT), new Date(freshT))

      const out = JSON.parse(run(join(dir, 'sessions')))
      expect(out.sessionCount).toBe(2)
      expect(Math.abs(out.latestSessionMtime - freshT)).toBeLessThan(2000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 session 文件不计入', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-test-'))
    try {
      const s = join(dir, 'sessions', 'ws')
      mkdirSync(s, { recursive: true })
      writeFileSync(join(s, 'other.txt'), 'x')
      writeFileSync(join(s, 'session.jsonl'), 'x')
      const out = JSON.parse(run(join(dir, 'sessions')))
      expect(out.sessionCount).toBe(1)
      expect(out.latestSessionMtime).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
