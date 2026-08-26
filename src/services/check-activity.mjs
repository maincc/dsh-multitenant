#!/usr/bin/env node
/**
 * 租户活动检测：扫描 DSH 会话目录，报告最近的活动时间
 *
 * DSH 把每个会话的事件流 append 到卷内 sessions/ 目录的 jsonl 文件
 * （对话流、工具调用、agent 任务每产生一个事件都会写入）。因此：
 *   - 会话文件最近有写入 = 容器内 DSH 正在干活
 *   - 会话文件很久没动 = DSH 内部空闲（即便容器主进程还在运行）
 *
 * 在租户镜像的辅助容器内运行（挂载租户卷到 /dsh-home）：
 *   node check-activity.mjs <sessionsRoot>
 *
 * 输出（stdout，JSON）：
 *   { "latestSessionMtime": <毫秒时间戳，无会话时为 0>, "sessionCount": <文件数> }
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]

if (typeof root !== 'string' || root === '') {
  console.log(JSON.stringify({ latestSessionMtime: 0, sessionCount: 0 }))
  process.exit(0)
}

let latest = 0
let count = 0

function walk(dir) {
  if (!existsSync(dir)) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(p)
      continue
    }
    if (!entry.isFile()) continue
    // 会话记录文件：session.jsonl / session.jsonl.zstd（含压缩变体）
    if (entry.name.startsWith('session.jsonl')) {
      try {
        const st = statSync(p)
        if (st.mtimeMs > latest) latest = st.mtimeMs
        count += 1
      } catch {
        // 单个文件不可读不影响其他
      }
    }
  }
}

walk(root)
console.log(JSON.stringify({ latestSessionMtime: latest, sessionCount: count }))
process.exit(0)
