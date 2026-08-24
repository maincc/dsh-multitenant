#!/usr/bin/env node
/**
 * .credentials.yaml 合并工具（在租户镜像的辅助容器内运行）
 *
 * DSH 的凭据文件（$DSH_HOME/.credentials.yaml）是"凭据引用名 -> 值"的扁平
 * YAML 映射，格式要求严格（非映射根、非法键、空值都会导致拒绝加载）。
 * 本工具按行做最小合并，避免引入 YAML 解析依赖，保证：
 *   - set：替换已有同键条目，没有则追加（原子写：临时文件 + rename）
 *   - del：删除同键条目
 *   - get：只输出 configured / absent（绝不输出值）
 *   - list：只输出所有已配置的引用名（JSON 数组，绝不输出值）
 *
 * 用法：
 *   node merge-credentials.mjs get <file> <key>            # configured | absent
 *   node merge-credentials.mjs set <file> <key> <value>    # 合并写入
 *   node merge-credentials.mjs del <file> <key>            # 删除条目
 *   node merge-credentials.mjs list <file>                 # ["KEY1","KEY2",...]
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [action, file, key, value] = process.argv.slice(2)

if (!['get', 'set', 'del', 'list'].includes(action) || !file) {
  console.error('usage: node merge-credentials.mjs <get|set|del|list> <file> <key> [value]')
  process.exit(2)
}
if (action !== 'list' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
  console.error('invalid credential key: ' + key)
  process.exit(2)
}

/** YAML 双引号字符串（JSON 转义对 API Key 等常规值足够安全） */
const yamlQuote = (v) => JSON.stringify(String(v))

function readLines() {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n')
}

function writeLines(lines) {
  const tmp = join(dirname(file), `.${key}.${process.pid}.tmp`)
  writeFileSync(tmp, lines.join('\n'), { mode: 0o600 })
  renameSync(tmp, file)
}

if (action === 'get') {
  const hit = readLines().some((l) => l.trim().startsWith(`${key}:`))
  console.log(hit ? 'configured' : 'absent')
  process.exit(0)
}

if (action === 'list') {
  // 输出所有非空引用名（绝不输出值）
  const refs = []
  for (const line of readLines()) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
    if (!m) continue
    const v = m[2].trim()
    if (v !== '' && v.toLowerCase() !== 'null') refs.push(m[1])
  }
  console.log(JSON.stringify(refs))
  process.exit(0)
}

if (action === 'del') {
  const lines = readLines()
  const out = []
  let removed = false
  for (const line of lines) {
    if (line.trim().startsWith(`${key}:`)) {
      removed = true
      continue
    }
    out.push(line)
  }
  if (!removed) {
    console.log('absent')
    process.exit(0)
  }
  writeLines(out)
  console.log('deleted')
  process.exit(0)
}

// action === 'set'
const lines = readLines()
const out = []
let replaced = false
for (const line of lines) {
  if (line.trim().startsWith(`${key}:`)) {
    out.push(`${key}: ${yamlQuote(value)}`)
    replaced = true
    continue
  }
  out.push(line)
}
if (!replaced) {
  if (out.length && out[out.length - 1] !== '') out.push('')
  out.push(`${key}: ${yamlQuote(value)}`)
}
writeLines(out)
console.log('written')
