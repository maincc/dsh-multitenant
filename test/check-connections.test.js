/**
 * check-connections.mjs 脚本级测试
 *
 * 验证：只统计非回环（排除 127.0.0.1 / ::1）的 ESTABLISHED（01）TCP 连接，
 * 其他状态（LISTEN/TIME_WAIT）不计入；文件缺失返回 0。
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'src', 'services', 'check-connections.mjs')

const run = (tcp, tcp6) =>
  execFileSync(process.execPath, [SCRIPT, tcp, tcp6], { encoding: 'utf8' }).trim()

describe('check-connections.mjs', () => {
  it('文件缺失 → 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-test-'))
    try {
      expect(JSON.parse(run(join(dir, 'nope'), join(dir, 'nope6')))).toEqual({ established: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('只统计非回环 ESTABLISHED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-test-'))
    try {
      const tcp = join(dir, 'tcp')
      // /proc/net/tcp 格式：local/remote 为小端 hex，st=01 ESTABLISHED / 0A LISTEN / 06 TIME_WAIT
      const lines = [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        '   0: 0100007F:0C0C 0100007F:1F40 01 00000000:00000000 00:00000000 00000000     0        0 100 1',
        '   1: 0100007F:1F40 0100007F:0C0C 01 00000000:00000000 00:00000000 00000000     0        0 101 1',
        '   2: AC140101:1F40 0A010203:04D2 01 00000000:00000000 00:00000000 00000000     0        0 102 1',
        '   3: 0100007F:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 103 1',
        '   4: 0100007F:1F40 0100007F:0C0C 06 00000000:00000000 00:00000000 00000000     0        0 104 1',
        '   5: AC140101:04D2 08080808:01BB 01 00000000:00000000 00:00000000 00000000     0        0 105 1',
      ]
      writeFileSync(tcp, lines.join('\n') + '\n')
      const out = JSON.parse(run(tcp, join(dir, 'nope6')))
      // 外部 ESTABLISHED：行 2（172.16.1.1 → 10.1.2.3）和行 5（172.16.1.1 → 8.8.8.8）
      // 回环 ESTABLISHED（行 0/1）与 LISTEN/TIME_WAIT 不计入
      expect(out.established).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
