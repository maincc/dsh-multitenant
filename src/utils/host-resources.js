/**
 * 平台资源探针（F1 预检改造，2026-09 磁盘防复发方案）
 *
 * 背景（.dshArchive/2026-09-24/f7e46f0d/disk-fix-final-plan.md）：
 *   - 旧内存预检用 `sysctl hw.memsize`（macOS 专有），Linux 上抛错被
 *     catch 成 true —— 生产（Linux）内存保护形同虚设（roadmap P1-4"恒真"）。
 *   - 本模块把"读得到就报数、读不到就报 null"的探针逻辑独立出来，
 *     让 preflight 的策略（fail-open/closed、水位）与采集分离、可测。
 */

import { readFile } from 'node:fs/promises'

/** 供应一个新容器需要的额外内存余量（DSH web 自身 + docker 开销） */
export const MEM_HEADROOM_BYTES = 512 * 1024 * 1024

/**
 * Linux 真实可用内存（KB）。非 Linux / 读不到 / 解析失败 → null。
 * 注意：这里"读不到"不等于"内存不足"——策略（fail-closed 还是放行）
 * 由调用方结合 preflightMode 决定，探针只讲事实。
 */
export async function readMemAvailableKB() {
  if (process.platform !== 'linux') return null
  try {
    const text = await readFile('/proc/meminfo', 'utf8')
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/**
 * 把 "512m" / "1g" / "2G" / 纯数字（按字节）解析成字节数。
 * 解析不出返回 null（调用方按缺省档位处理）。
 */
export function parseMemorySpecToBytes(spec) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(String(spec ?? '').trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit]
  return Math.round(n * mult)
}
