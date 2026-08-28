/**
 * skill 工具函数（纯函数，无副作用，可单测）
 *
 * 职责：与 DSH skill-filesystem provider 对齐的技能命名与 frontmatter 校验。
 * 说明：不使用 yaml 依赖（仅 devDependency），按 DSH frontmatter 的平铺
 * 键值形态做最小自研解析；只认白名单字段，未知键忽略。
 */

import { createHash } from 'node:crypto'

/** 技能名：kebab-case，≤64 字符（与 DSH 的命名规则一致） */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const MAX_NAME_LENGTH = 64
/** 正文最大字节数（防止超大 payload 入仓/入卷） */
export const MAX_BODY_BYTES = 64 * 1024
/** description / whenToUse 最大长度 */
export const MAX_DESC_LENGTH = 2000

/** frontmatter 白名单字段（其余未知键忽略，与 DSH 行为一致） */
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'whenToUse',
  'metadata',
  'disable-model-invocation',
  'user-invocable',
])
/** DSH 拒绝的过时驼峰拼写 */
const LEGACY_KEYS = new Map([
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
])

/** 校验技能名，非法抛出 TypeError；合法返回原值 */
export function assertSkillName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(
      `技能名非法（须 kebab-case 且不超过 ${MAX_NAME_LENGTH} 字符）: ${String(name)}`,
    )
  }
  return name
}

/** 布尔字段可接受的 YAML 写法（与 DSH frontmatterBoolean 对齐） */
const BOOLEAN_FORMS = new Map([
  ['true', true],
  ['false', false],
  ['yes', true],
  ['no', false],
  ['on', true],
  ['off', false],
  ['1', true],
  ['0', false],
])

function parseBooleanValue(key, raw) {
  const v = BOOLEAN_FORMS.get(String(raw).toLowerCase())
  if (v === undefined) {
    throw new TypeError(`frontmatter 字段 "${key}" 必须是布尔值（true/false/yes/no/on/off/1/0）`)
  }
  return v
}

function unquote(s) {
  const t = s.trim()
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * 解析 SKILL.md 正文的 frontmatter。
 * @param {string} text 完整文件内容
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 * @throws TypeError 无 frontmatter / 结构非法
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') throw new TypeError('skill 内容必须是字符串')
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    throw new TypeError('缺少 YAML frontmatter（必须以 --- 开头）')
  }
  // 找闭合的 --- 行（第二行起）
  const lines = text.split(/\r?\n/)
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) throw new TypeError('frontmatter 缺少闭合的 --- 行')

  const frontmatter = {}
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue // 无冒号的行忽略（容忍）
    const key = line.slice(0, sep).trim()
    const rawValue = line.slice(sep + 1).trim()
    if (!key) continue
    // 去行尾注释（值以 # 开头才算注释行，行内 # 属于值的一部分，保持简单）
    if (LEGACY_KEYS.has(key)) {
      throw new TypeError(`frontmatter 字段 "${key}" 已弃用，请使用 "${LEGACY_KEYS.get(key)}"`)
    }
    if (rawValue === '' || rawValue.startsWith('#')) {
      frontmatter[key] = null
      continue
    }
    // 字符串/布尔/数字统一先按字符串收，字段语义由调用方（validateSkill）判定
    frontmatter[key] = unquote(rawValue)
  }
  return {
    frontmatter,
    body: lines
      .slice(closeIdx + 1)
      .join('\n')
      .replace(/^\n/, ''),
  }
}

/**
 * 完整校验技能（命名 + frontmatter 字段语义）。
 * @param {object} param0
 * @param {string} param0.text skill 文件完整内容
 * @param {string} [param0.expectedName] 期望的技能名（目录名/请求名），校验 frontmatter.name 一致
 * @returns {{ name, description, whenToUse, disableModelInvocation, userInvocable, metadata, body, bodyBytes, sha256 }}
 * @throws TypeError 具体字段错误
 */
export function validateSkill({ text, expectedName } = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('技能内容为空')
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_BODY_BYTES) {
    throw new TypeError(`技能正文超过大小上限（${MAX_BODY_BYTES} 字节）`)
  }
  const { frontmatter, body } = parseFrontmatter(text)

  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
  if (!name) throw new TypeError('frontmatter 缺少必填字段 name')
  if (!SKILL_NAME_RE.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(
      `frontmatter name 非法（须 kebab-case 且不超过 ${MAX_NAME_LENGTH} 字符）: ${name}`,
    )
  }
  if (expectedName !== undefined && expectedName !== null && name !== expectedName) {
    throw new TypeError(`frontmatter name "${name}" 与请求的技能名 "${expectedName}" 不一致`)
  }
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
  if (!description) throw new TypeError('frontmatter 缺少必填字段 description')
  if (description.length > MAX_DESC_LENGTH) {
    throw new TypeError(`description 过长（超过 ${MAX_DESC_LENGTH} 字符）`)
  }

  let whenToUse = ''
  if (frontmatter['whenToUse'] != null) {
    whenToUse = String(frontmatter['whenToUse']).trim()
    if (whenToUse.length > MAX_DESC_LENGTH) {
      throw new TypeError(`whenToUse 过长（超过 ${MAX_DESC_LENGTH} 字符）`)
    }
  }

  // 布尔字段：提供即必须是合法布尔
  let disableModelInvocation = false
  let userInvocable = true
  if (frontmatter['disable-model-invocation'] != null) {
    disableModelInvocation = parseBooleanValue(
      'disable-model-invocation',
      frontmatter['disable-model-invocation'],
    )
  }
  if (frontmatter['user-invocable'] != null) {
    userInvocable = parseBooleanValue('user-invocable', frontmatter['user-invocable'])
  }

  let metadata
  if (frontmatter.metadata != null) metadata = frontmatter.metadata

  return {
    name,
    description,
    whenToUse,
    disableModelInvocation,
    userInvocable,
    metadata,
    body,
    bodyBytes: bytes,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  }
}

/** 从技能文件内容提取安全的命名候选（文件名前缀），非法返回 null */
export function nameCandidateFromFilename(fileName) {
  if (typeof fileName !== 'string') return null
  const base = fileName.replace(/\.md$/i, '').trim().toLowerCase()
  return SKILL_NAME_RE.test(base) && base.length <= MAX_NAME_LENGTH ? base : null
}

/**
 * 重写技能 frontmatter 的 name（共享时换名用）。
 * 只改 frontmatter 区内第一处 `name:` 行，正文不动；内容自洽后再整体校验。
 * @param {string} text 技能文件完整内容
 * @param {string} newName 新名称（kebab-case）
 * @returns {string} 重写后的内容
 * @throws TypeError frontmatter 缺失 / 无 name 行 / 名称非法
 */
export function rewriteSkillName(text, newName) {
  assertSkillName(newName)
  const { frontmatter } = parseFrontmatter(text)
  if (frontmatter.name === newName) return text
  const lines = text.split(/\r?\n/)
  let nameLine = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break // 离开 frontmatter 区
    if (/^\s*name\s*:/.test(lines[i])) {
      nameLine = i
      break
    }
  }
  if (nameLine === -1) {
    throw new TypeError('frontmatter 缺少 name 字段，无法重命名')
  }
  lines[nameLine] = `name: ${newName}`
  return lines.join('\n')
}

/** kebab-case 布尔校验用的导出（供解析/测试） */
export function parseSkillBoolean(key, raw) {
  return parseBooleanValue(key, raw)
}
