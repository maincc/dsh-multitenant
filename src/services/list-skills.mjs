#!/usr/bin/env node
/**
 * 列出租户卷内的技能（辅助容器内运行，/dsh-home 为租户数据卷）
 *
 * 扫描 /dsh-home/skills/ 下的两种形态：
 *   - 目录技能：<name>/SKILL.md
 *   - 平铺技能：<name>.md（与目录同名时以目录为准，忽略 flat）
 * 只返回 kebab-case 且 ≤64 字符的名字（其余不可共享，直接过滤）。
 * stdout 输出 JSON：{ ok, names: string[] }
 *
 * 用法：node list-skills.mjs
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const SKILLS_DIR = '/dsh-home/skills'
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

const names = []
const flatBases = new Set()

try {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) {
      const bundle = join(SKILLS_DIR, e.name, 'SKILL.md')
      try {
        if (readdirSync(join(SKILLS_DIR, e.name)).includes('SKILL.md')) {
          if (NAME_RE.test(e.name) && e.name.length <= 64) names.push(e.name)
        }
      } catch {
        // 目录不可读则跳过
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      const base = e.name.slice(0, -3)
      if (base && base !== 'SKILL') flatBases.add(base)
    }
  }
  // 目录技能优先：flat 与目录同名时去掉 flat 的候选
  const dirSet = new Set(names)
  for (const base of flatBases) {
    if (!dirSet.has(base) && NAME_RE.test(base) && base.length <= 64) names.push(base)
  }
} catch {
  // /dsh-home/skills 不存在 → 空列表
}

console.log(JSON.stringify({ ok: true, names }))