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
 * 本工具只做**原地最小编辑**：定位 `refs:` 块，只增删改块内的目标条目，
 * 文件其余内容（注释、其它顶层块、DSH 自己写入的嵌套记录）一律逐字节保留、
 * 位置不动。
 *
 * 为什么必须原地编辑（真实故障）：旧实现是"整篇解析 → 重新渲染"，
 * 把不认识的行当作注释收集，渲染时又把这些行**搬到文件开头**；且
 * `inRefs` 结束分支缺少 `continue`，导致同一行被 push 两次 →
 * 重复键 / 缩进行跑到文档开头 → YAML 非法。
 * 触发条件很现实：DSH ≥0.1.5 会自己往本文件写
 * `client-connection/browser-session`（认证 cookie 签名密钥靠它持久化），
 * 旧解析器不认识这个嵌套块；此后用户只要在「模型配置」保存一次 API Key，
 * 文件就被写坏 → DSH 启动时 credentials-local 解析失败 → 容器退出 1 →
 * 平台只能看到"容器未能就绪"。
 *
 * 约束（credentials-local 校验）：根是 version + refs 映射；refs 值必须是
 * 字符串。引用名放宽到 ^[A-Za-z_][A-Za-z0-9_.-]*$ —— 键名允许 . 与 -
 * （旧实现只认 POSIX 标识符，会把合法的 `MY-KEY` 条目当"不认识的行"处理）。
 *
 * 原子写：临时文件 + rename，权限 0600。
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
  process.exit(1)
}

/** 引用名：允许 . 与 -（DSH 自己写的键就含连字符） */
const REF_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/
if (action !== 'list' && !REF_NAME_RE.test(String(key ?? ''))) {
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

/** 顶层 `refs:` 头（可为 `refs:` 或 `refs: {}`） */
const REFS_HEADER_RE = /^(\s*)refs:\s*(\{\})?\s*$/
/** 条目行：缩进 + KEY: value */
const ENTRY_LINE_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*):[ \t]*(.*?)[ \t]*$/
/** 顶层 version 行 */
const VERSION_LINE_RE = /^version:\s*\S/

const indentOf = (line) => (line.match(/^\s*/) || [''])[0]

function readLines() {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n')
}

/** 原子写回（保持 0600） */
function writeLines(lines) {
  // fail closed：结构异常时拒绝写入，绝不在已损坏的文件上继续加工
  const problems = assertWellFormed(lines)
  if (problems.length > 0) {
    console.error('merge-credentials: 拒绝写入（凭据文件结构异常，继续写会损坏它）：')
    for (const p of problems.slice(0, 5)) console.error('  - ' + p)
    process.exit(3)
  }
  const tmp = join(dirname(file), `.${key}.${process.pid}.tmp`)
  writeFileSync(tmp, lines.join('\n'), { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * 定位顶层 refs 块。
 * @returns {{headerIndex:number, headerIndent:string, entryIndent:string, endIndex:number}|null}
 *   endIndex = 块内容结束后的第一行下标（块内 = headerIndex+1 .. endIndex-1）
 */
function findRefsBlock(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]) !== '') continue // 必须是顶层
    const m = lines[i].match(REFS_HEADER_RE)
    if (!m) continue
    let end = i + 1
    let entryIndent = null
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim() === '') break
      if (indentOf(line) === '') break // 回到顶层 → 块结束
      if (entryIndent === null) entryIndent = indentOf(line)
      end++
    }
    return {
      headerIndex: i,
      headerIndent: '',
      entryIndent: entryIndent ?? '  ',
      endIndex: end,
    }
  }
  return null
}

/** 在块内查找某个键的行号（-1 = 不存在） */
function findEntryLine(lines, block, name) {
  for (let i = block.headerIndex + 1; i < block.endIndex; i++) {
    const m = lines[i].match(ENTRY_LINE_RE)
    if (m && m[2] === name) return i
  }
  return -1
}

/** 块内已有的条目名（供 del 后判断是否需要写回 `refs: {}`） */
function entryLinesInBlock(lines, block) {
  const out = []
  for (let i = block.headerIndex + 1; i < block.endIndex; i++) {
    if (ENTRY_LINE_RE.test(lines[i])) out.push(i)
  }
  return out
}

/**
 * 写入前的结构自检（fail closed）。
 *
 * 为什么需要：本工具是"按行编辑"，对不认识的结构只能尽力而为。若输入文件
 * 本身已被搅乱（实测形态：records 块被塞进 refs 内部，出现 `records: ""`
 * 却带着更深的子级），继续写只会让它更糟，而 DSH 会因此完全起不来
 * （表现为容器 120s 不就绪 → 被回滚 → 界面显示"已销毁"）。
 * 这里做**廉价但关键**的断言：不通过就拒绝写入并报错，绝不二次破坏。
 *
 * @returns {string[]} 问题列表（空 = 通过）
 */
function assertWellFormed(lines) {
  const problems = []
  const refsIdx = lines.findIndex((l) => indentOf(l) === '' && REFS_HEADER_RE.test(l))
  if (refsIdx === -1) return ['找不到顶层 refs:']

  const seen = new Set()
  let entryIndent = null
  let i = refsIdx + 1
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const ind = indentOf(line)
    if (ind === '') break // 块结束（records: 等顶层结构）
    const m = line.match(ENTRY_LINE_RE)
    if (entryIndent === null) entryIndent = ind
    if (ind === entryIndent && m) {
      if (seen.has(m[2])) problems.push(`refs 内重复键 ${m[2]}`)
      seen.add(m[2])
      // "完整单行标量"的条目后面不应再有更深的子行 —— 那说明结构被搅乱了
      const multiline = isMultilineScalar(m[3])
      let j = i + 1
      while (
        j < lines.length &&
        lines[j].trim() !== '' &&
        indentOf(lines[j]).length > entryIndent.length
      ) {
        if (!multiline) {
          problems.push(`条目 ${m[2]} 的值是单行标量，却跟着更深的子行：${lines[j].trim().slice(0, 30)}`)
        }
        j++
      }
      i = j
      continue
    }
    problems.push(`refs 内出现无法识别的行：${line.trim().slice(0, 40)}`)
    i++
  }
  return problems
}

/**
 * 确保存在顶层 `version: 1`（DSH 只接受 versioned 布局）。
 * 已存在同名行则原样保留；缺失则插到文件头注释之后。
 * @returns {number} version 行的下标
 */
function ensureVersionLine(lines) {
  const idx = lines.findIndex((l) => indentOf(l) === '' && VERSION_LINE_RE.test(l.trim()))
  if (idx >= 0) return idx
  let at = 0
  while (at < lines.length && (lines[at].trim() === '' || lines[at].trim().startsWith('#'))) at++
  lines.splice(at, 0, 'version: 1')
  return at
}

/**
 * 条目的"范围"：从条目行到它的**续行**结束（不含）。
 *
 * 为什么需要：YAML 的引号标量可以跨行折叠。DSH 自己写出的 API Key 就是这种
 * 形状（实测真实文件）：
 *     CUSTOM_xxx_API_KEY: "sk-sp-AAAA
 *       BBBB...ZZZZ"
 * 第二行是**同一个值**的延续（缩进比条目行更深）。按单行处理会把值截断、
 * 并在文件里留下孤立残行 → YAML 非法（正是本工具曾经写坏文件的那类事故）。
 *
 * @returns {number} 结束下标（不含）
 */
function entryExtent(lines, block, i) {
  const indent = indentOf(lines[i]).length
  let j = i + 1
  while (j < block.endIndex) {
    const line = lines[j]
    if (line.trim() === '') break
    if (indentOf(line).length <= indent) break // 回到同级/顶层 → 本条目结束
    j++
  }
  return j
}

/**
 * 值是否为"跨行的"标量（起始引号在本行未闭合）。
 * 这种值一律**原样保留**：它已经是带引号的字符串，不需要补引号，
 * 而任何按单行的重写都会把它改坏。
 */
function isMultilineScalar(rawValue) {
  const v = String(rawValue ?? '').trim()
  if (v.length < 2) return false
  const q = v[0]
  if (q !== '"' && q !== "'") return false
  return !v.endsWith(q)
}

/**
 * 把 refs 块内的**完整单行**裸标量规范化为 `KEY: "value"`。
 *
 * 为什么需要规范化：YAML 的裸标量按类型解析 —— `sk-123` 尚可，但 `123` 会
 * 变成数字、`null`/`~` 会变成空值，而 DSH 的 credentials-local 要求 refs 的
 * 值**必须是字符串**，否则拒绝加载整个文件。
 *
 * 安全边界：只改"单行裸标量"；已是完整引号串的、以及跨行折叠的值都不动，
 * 并且会跳过续行（见 entryExtent），绝不留下孤立残行。
 */
function normalizeBlockEntries(lines, block) {
  let i = block.headerIndex + 1
  while (i < block.endIndex) {
    const m = lines[i].match(ENTRY_LINE_RE)
    if (m) {
      if (!isMultilineScalar(m[3])) {
        lines[i] = `${m[1]}${m[2]}: ${yamlQuote(yamlUnquote(m[3]))}`
      }
      i = entryExtent(lines, block, i) // 跳过续行
    } else {
      i += 1
    }
  }
}

/**
 * 读取所有条目（仅用于 get / list）。
 * 优先 refs 块；兼容历史扁平布局（顶层 KEY: value）。
 * @returns {Map<string,string>}
 */
function readEntries(lines) {
  const entries = new Map()
  const block = findRefsBlock(lines)
  if (block) {
    for (let i = block.headerIndex + 1; i < block.endIndex; i++) {
      const m = lines[i].match(ENTRY_LINE_RE)
      if (m) entries.set(m[2], yamlUnquote(m[3]))
    }
    return entries
  }
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (VERSION_LINE_RE.test(line.trim())) continue
    if (indentOf(line) !== '') continue // 只认顶层行
    const m = line.match(ENTRY_LINE_RE)
    if (m) entries.set(m[2], yamlUnquote(m[3]))
  }
  return entries
}

if (action === 'get') {
  console.log(readEntries(readLines()).has(key) ? 'configured' : 'absent')
  process.exit(0)
}

if (action === 'list') {
  // 只输出非空引用名（绝不输出值）
  const refs = []
  for (const [k, v] of readEntries(readLines())) {
    const s = String(v).trim()
    if (s !== '' && s.toLowerCase() !== 'null') refs.push(k)
  }
  console.log(JSON.stringify(refs))
  process.exit(0)
}

if (action === 'del') {
  const lines = readLines()
  ensureVersionLine(lines)
  const block = findRefsBlock(lines)
  if (block) {
    const idx = findEntryLine(lines, block, key)
    if (idx === -1) {
      console.log('absent')
      process.exit(0)
    }
    // 整段删除：含多行折叠值的续行
    lines.splice(idx, entryExtent(lines, block, idx) - idx)
    // 删空后写成 `refs: {}`：空的 `refs:` 会解析成 null，DSH 要求是映射
    const after = findRefsBlock(lines)
    if (!after || entryLinesInBlock(lines, after).length === 0) {
      lines[block.headerIndex] = 'refs: {}'
    } else {
      normalizeBlockEntries(lines, after)
    }
    writeLines(lines)
    console.log('deleted')
    process.exit(0)
  }
  // 兼容扁平布局：删掉顶层同键行
  const flatIdx = lines.findIndex((l) => {
    const m = l.match(ENTRY_LINE_RE)
    return m && indentOf(l) === '' && m[2] === key && !VERSION_LINE_RE.test(l.trim())
  })
  if (flatIdx === -1) {
    console.log('absent')
    process.exit(0)
  }
  lines.splice(flatIdx, 1)
  writeLines(lines)
  console.log('deleted')
  process.exit(0)
}

// ---- action === 'set' ----
{
  const lines = readLines()
  ensureVersionLine(lines) // DSH 只接受 versioned 布局
  let block = findRefsBlock(lines)

  if (!block) {
    // 没有 refs 块：把顶层 KEY: value 行就地归拢成一个 refs 块（兼容旧扁平布局），
    // 其余行（注释/version/未知内容）位置一律不动。
    const flatIdx = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      if (indentOf(line) !== '') continue
      if (VERSION_LINE_RE.test(line.trim())) continue
      if (ENTRY_LINE_RE.test(line)) flatIdx.push(i)
    }
    if (flatIdx.length > 0) {
      const entries = flatIdx.map((i) => {
        const m = lines[i].match(ENTRY_LINE_RE)
        return `  ${m[2]}: ${yamlQuote(yamlUnquote(m[3]))}`
      })
      const first = flatIdx[0]
      // 从后往前删，避免下标位移
      for (let k = flatIdx.length - 1; k >= 1; k--) lines.splice(flatIdx[k], 1)
      lines.splice(first, 1, 'refs:', ...entries)
    } else {
      // 空文件 / 只有注释与 version：在 version 之后（或文件末尾）补一个 refs 块
      const versionIdx = lines.findIndex((l) => indentOf(l) === '' && VERSION_LINE_RE.test(l.trim()))
      const insertAt = versionIdx >= 0 ? versionIdx + 1 : lines.length
      lines.splice(insertAt, 0, 'refs:')
    }
    block = findRefsBlock(lines)
  }

  // 既有条目一律规范化为 `KEY: "value"`（保证值是字符串，见 normalizeBlockEntries）
  normalizeBlockEntries(lines, block)
  if (/refs:\s*\{\}\s*$/.test(lines[block.headerIndex])) {
    lines[block.headerIndex] = `${block.headerIndent}refs:`
  }
  const idx = findEntryLine(lines, block, key)
  if (idx >= 0) {
    // 整段替换：多行折叠值的续行必须一起删掉，否则会留下孤立残行
    const end = entryExtent(lines, block, idx)
    const indent = indentOf(lines[idx])
    lines.splice(idx, end - idx, `${indent}${key}: ${yamlQuote(value)}`)
  } else {
    // 追加到块尾（不插到头部，保持既有条目的相对顺序与最小 diff）
    lines.splice(block.endIndex, 0, `${block.entryIndent}${key}: ${yamlQuote(value)}`)
  }
  writeLines(lines)
  console.log('written')
}
