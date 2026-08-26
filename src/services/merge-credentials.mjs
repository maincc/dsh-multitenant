#!/usr/bin/env node
/**
 * .credentials.yaml 合并工具（在租户镜像的辅助容器内运行）
 *
 * DSH 的凭据文件（$DSH_HOME/.credentials.yaml）是 versioned YAML 文档：
 *
 *   version: 1
 *   refs:
 *     SOME_API_KEY: "value"
 *
 * 约束严格（credentials-local 校验）：根必须是 `version` + `refs` 映射；
 * `refs` 下每个引用名必须是 POSIX 标识符（^[A-Za-z_][A-Za-z0-9_]*$），
 * 值必须是字符串；空值、非法键、非字符串值都会导致 DSH 拒绝加载整个文件。
 *
 * 历史上（pre-release）曾使用扁平布局（顶层 KEY: value），当前 DSH 会
 * 拒绝这种文件并提示 "Add version: 1 and nest the existing 1 entry under
 * refs:"。本工具读写一律采用 versioned 嵌套布局；读取到旧扁平文件时
 * 自动迁移为嵌套布局再写回，保证 DSH 每次都能加载。
 *
 * 本工具按行做最小合并，避免引入 YAML 解析依赖，保证：
 *   - set：替换 refs 下已有同键条目，没有则追加（原子写：临时文件 + rename）
 *   - del：删除 refs 下同键条目
 *   - get：只输出 configured / absent（绝不输出值）
 *   - list：只输出所有已配置的引用名（JSON 数组，绝不输出值）
 * 顶层注释行会保留在文件头部。
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

/** 去掉 YAML 标量的引号包装（双引号按 JSON 转义解析，单引号按字面） */
function yamlUnquote(raw) {
  const s = raw.trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'")
  }
  return s
}

/** 顶层引用行：KEY: value */
const REF_RE = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/
/** 缩进引用行：  KEY: value（refs 块内） */
const INDENTED_REF_RE = /^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/

/**
 * 解析文档为 { entries, comments, hadRefs, hadVersion }。
 * 同时识别两种历史布局，统一收进 entries：
 *   - versioned 嵌套：version: 1 + refs: 块
 *   - pre-release 扁平：顶层 KEY: value
 */
function parseDocument(text) {
  const lines = text.split('\n')
  const entries = new Map()
  const comments = []
  let hadRefs = false
  let hadVersion = false
  let inRefs = false
  let refsIndent = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (!inRefs) comments.push(line)
      continue
    }
    if (trimmed.startsWith('#')) {
      comments.push(line)
      continue
    }
    if (!inRefs && /^refs:\s*(\{\})?\s*$/.test(trimmed)) {
      hadRefs = true
      inRefs = true
      refsIndent = line.length - line.trimStart().length
      continue
    }
    if (inRefs) {
      // refs 块内：缩进的 KEY: value 条目
      const m = line.match(INDENTED_REF_RE)
      if (m && line.length - line.trimStart().length > refsIndent) {
        entries.set(m[2], yamlUnquote(m[3]))
        continue
      }
      // 缩进结束（回到顶层）：退出 refs 块，按顶层行继续处理
      inRefs = false
      if (/^\S/.test(line)) refsIndent = 0
      else comments.push(line)
    }
    if (/^version:\s*\S/.test(trimmed)) {
      hadVersion = true
      // 渲染时统一输出 version: 1，不保留输入里的 version 行（避免重复）
      continue
    }
    // 顶层引用行（扁平布局或 refs 外的孤儿条目）
    const top = line.match(REF_RE)
    if (top) {
      entries.set(top[1], yamlUnquote(top[2]))
      continue
    }
    comments.push(line)
  }
  return { entries, comments, hadRefs, hadVersion }
}

/** 渲染成 versioned 嵌套布局（注释保留在头部） */
function renderDocument({ entries, comments }) {
  const out = [...comments]
  out.push('version: 1')
  if (entries.size === 0) {
    out.push('refs: {}')
  } else {
    out.push('refs:')
    for (const [k, v] of entries) {
      out.push(`${'  '}${k}: ${yamlQuote(v)}`)
    }
  }
  return out.join('\n') + '\n'
}

function readParsed() {
  if (!existsSync(file)) return { entries: new Map(), comments: [] }
  return parseDocument(readFileSync(file, 'utf8'))
}

function writeParsed(doc) {
  const tmp = join(dirname(file), `.${key}.${process.pid}.tmp`)
  writeFileSync(tmp, renderDocument(doc), { mode: 0o600 })
  renameSync(tmp, file)
}

if (action === 'get') {
  const { entries } = readParsed()
  console.log(entries.has(key) ? 'configured' : 'absent')
  process.exit(0)
}

if (action === 'list') {
  // 只输出非空引用名（绝不输出值）
  const refs = []
  for (const [k, v] of readParsed().entries) {
    const s = String(v).trim()
    if (s !== '' && s.toLowerCase() !== 'null') refs.push(k)
  }
  console.log(JSON.stringify(refs))
  process.exit(0)
}

if (action === 'del') {
  const doc = readParsed()
  if (!doc.entries.has(key)) {
    console.log('absent')
    process.exit(0)
  }
  doc.entries.delete(key)
  writeParsed(doc)
  console.log('deleted')
  process.exit(0)
}

// action === 'set'
const doc = readParsed()
doc.entries.set(key, String(value))
writeParsed(doc)
console.log('written')
