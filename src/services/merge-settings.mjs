#!/usr/bin/env node
/**
 * settings.yaml 的用户配置段合并工具（在租户镜像的辅助容器内运行）
 *
 * DSH 的 settings 文档（$DSH_HOME/settings.yaml）承载每个 provider 的用户可编辑
 * 配置段；settings-file 用 chokidar 监听该文件，外部编辑 ~100ms 热发布，
 * 各 provider 的配置为请求级动态解析（官方 dynamic-config 测试验证：
 * "no restart, no re-registration"），因此改文件即生效，无需重启容器。
 *
 * 支持的段：
 *   - llm-deepseek：官方 provider 的 baseURL（自定义端点）与 models（catalog）
 *   - llm-pi-ai：多 provider 适配器，providers.<route> 注册任意 OpenAI 兼容
 *     端点 —— 段非空时这些 route 实时进入模型选择器，清空即消失。
 *
 * 本工具用 DSH 自带的 yaml 库做文档级合并，保留其他段与注释：
 *   - get：输出指定段的完整 JS 值（JSON），无敏感信息
 *   - set：合并写入字段；null/空串/空数组 = 删除该字段；providers 按 route
 *     合并（route 值为 null = 删除该 route）；未提及字段保留
 *   - del：删除整个段
 * 写回原子（临时文件 + rename，0600），文档为空时直接删除文件。
 *
 * 用法：
 *   node merge-settings.mjs get <file> [section]
 *   node merge-settings.mjs set <file> <json> [section]
 *   node merge-settings.mjs del <file> [section]
 *   section 默认 llm-deepseek（向后兼容）。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(new URL(import.meta.url).pathname)

/** yaml 库候选路径：镜像内 dsh 全局依赖优先，宿主编译环境兜底（测试用）。 */
const YAML_CANDIDATES = [
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/yaml',
  '/usr/local/lib/node_modules/yaml',
  join(here, '..', '..', 'node_modules', 'yaml'),
]

function loadYaml() {
  for (const p of YAML_CANDIDATES) {
    if (!existsSync(p)) continue
    try {
      return require(p)
    } catch {
      // 该候选不可用，试下一个
    }
  }
  console.error('yaml library not found')
  process.exit(3)
}

const yaml = loadYaml()
const { parseDocument } = yaml

const args = process.argv.slice(2)
const action = args[0]
const file = args[1]
let value
let section
if (action === 'set') {
  value = args[2]
  section = args[3] || 'llm-deepseek'
} else {
  // get / del：第三个参数是 section
  section = args[2] || 'llm-deepseek'
}

if (!['get', 'set', 'del'].includes(action) || !file) {
  console.error('usage: node merge-settings.mjs <get|set|del> <file> [json] [section]')
  process.exit(2)
}
if (!/^[a-z0-9-]+$/.test(section)) {
  console.error('invalid section name: ' + section)
  process.exit(2)
}

function readDoc() {
  if (!existsSync(file)) return parseDocument('')
  const doc = parseDocument(readFileSync(file, 'utf8'))
  const root = doc.toJS()
  // 损坏/标量根（如旧版误写的 `null`）按空文档处理，避免 setIn 崩溃
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return parseDocument('')
  return doc
}

/**
 * 原子写回：根为空（null / 空映射，含 yaml 库对空文档的 `{}`/`null` 序列化）
 * 则删除文件，否则临时文件 + rename（0600）
 */
function writeDoc(doc) {
  const root = doc.toJS()
  const isEmpty =
    root === undefined ||
    root === null ||
    (typeof root === 'object' && !Array.isArray(root) && Object.keys(root).length === 0)
  if (isEmpty) {
    if (existsSync(file)) unlinkSync(file)
    return
  }
  const text = doc.toString()
  const tmp = join(dirname(file), `.settings.${process.pid}.tmp`)
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

/** yaml 标量转 JS：存在则返回，否则 null */
function scalar(doc, path) {
  const v = doc.getIn(path)
  return v === undefined ? null : v
}

if (action === 'get') {
  const doc = readDoc()
  const root = doc.toJS()
  const sec = root?.[section]
  if (sec === undefined || sec === null) {
    console.log('{}')
    process.exit(0)
  }
  const out = {}
  // 通用：输出段内所有键的 JS 值（浅层），保证任何段都能回读
  if (typeof sec === 'object' && sec !== null && !Array.isArray(sec)) {
    for (const key of Object.keys(sec)) {
      const v = sec[key]
      if (v !== undefined) out[key] = v
    }
  } else {
    out.value = sec
  }
  console.log(JSON.stringify(out))
  process.exit(0)
}

if (action === 'del') {
  const doc = readDoc()
  const before = doc.get(section)
  if (before === undefined) {
    console.log('absent')
    process.exit(0)
  }
  doc.delete(section)
  writeDoc(doc)
  console.log('deleted')
  process.exit(0)
}

// action === 'set'
let next
try {
  next = JSON.parse(value)
} catch {
  console.error('invalid json payload')
  process.exit(2)
}
if (typeof next !== 'object' || next === null || Array.isArray(next)) {
  console.error('json payload must be an object')
  process.exit(2)
}

const doc = readDoc()
const path = [section]
const isDict = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

for (const [key, v] of Object.entries(next)) {
  if (key === 'providers' && isDict(v)) {
    // 多 provider：按 route 合并；route 值为 null = 删除该 route
    const existing = doc.getIn([...path, 'providers'])
    if (isDict(existing)) {
      for (const [route, rv] of Object.entries(v)) {
        if (rv === null) doc.deleteIn([...path, 'providers', route])
        else doc.setIn([...path, 'providers', route], rv)
      }
    } else {
      // 无现有 providers（含空文档）：过滤掉 null 后整体写入
      const routes = Object.fromEntries(Object.entries(v).filter(([, rv]) => rv !== null))
      if (Object.keys(routes).length > 0) {
        doc.setIn([...path, 'providers'], routes)
      }
    }
    continue
  }
  const targetPath = [...path, key]
  if (v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
    // 删除字段：父段存在且字段存在才 deleteIn（空文档/缺失路径会抛错）
    const sec = doc.getIn(path)
    if (isDict(sec) && doc.getIn(targetPath) !== undefined) {
      doc.deleteIn(targetPath)
    }
  } else {
    // setIn 会自动创建缺失的中间节点，安全
    doc.setIn(targetPath, v)
  }
}

// 段内容为空则删除整个段（用 toJS 判断：getIn 返回 YAML 节点，Object.keys 不可靠）
const rootJs = doc.toJS()
const secJs = rootJs?.[section]
const isEmpty =
  secJs === undefined ||
  (typeof secJs === 'object' && secJs !== null && !Array.isArray(secJs) && Object.keys(secJs).length === 0)
if (isEmpty && secJs !== undefined) doc.deleteIn(path)

writeDoc(doc)
console.log('written')
process.exit(0)
