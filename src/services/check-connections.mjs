#!/usr/bin/env node
/**
 * 容器活跃连接检测：统计容器内非回环的 ESTABLISHED TCP 连接数
 *
 * 在租户镜像的辅助容器内运行，且必须共享租户容器的网络命名空间：
 *   docker run --rm --network container:<tenant> ... node check-connections.mjs
 * 此时 /proc/net/tcp 看到的就是租户容器的连接表：
 *   - 浏览器开着 DSH 页面 → 与容器内 webserver 的 WebSocket 长连接（非回环）
 *   - DSH 正在调用外部 LLM API → 出站连接（非回环）
 * 两者都说明"用户/任务在用这个容器"；排除 127.0.0.1/::1 回环（DSH 内部 RPC）。
 *
 * 用法（支持传文件路径，便于测试）：
 *   node check-connections.mjs [/proc/net/tcp] [/proc/net/tcp6]
 *
 * 输出（stdout，JSON）：
 *   { "established": <非回环 ESTABLISHED 连接数> }
 */
import { existsSync, readFileSync } from 'node:fs'

const tcpFile = process.argv[2] || '/proc/net/tcp'
const tcp6File = process.argv[3] || '/proc/net/tcp6'

/** 把 /proc/net/tcp 里的 hex 小端 IP 转成可读形式（取最后 4/16 字节小端） */
function hexIpToDotted(hex) {
  const bytes = []
  for (let i = hex.length - 2; i >= 0; i -= 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16))
  }
  return bytes.join('.')
}

function countEstablished(file, isV6) {
  if (!existsSync(file)) return 0
  try {
    const lines = readFileSync(file, 'utf8').split('\n')
    let n = 0
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 4 || parts[0] === 'sl') continue
      if (parts[3] !== '01') continue // 01 = ESTABLISHED
      const remoteHex = parts[2]
      const ipHex = remoteHex.split(':')[0]
      const ip = isV6 ? ipHex : hexIpToDotted(ipHex)
      if (isV6) {
        if (ipHex === '00000000000000000000000001000000') continue // ::1
      } else if (ip === '127.0.0.1') {
        continue
      }
      n += 1
    }
    return n
  } catch {
    return 0
  }
}

const established = countEstablished(tcpFile, false) + countEstablished(tcp6File, true)
console.log(JSON.stringify({ established }))
process.exit(0)
