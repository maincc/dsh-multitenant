#!/usr/bin/env node
/**
 * 技能卸载脚本（在租户镜像的辅助容器内运行，/dsh-home 为租户数据卷）
 *
 * 删除 /dsh-home/skills/<name>/（bundle 形态）或 <name>.md（flat 形态）。
 * stdout 输出 JSON：{ ok, name, removed }
 *
 * 用法：node remove-skill.mjs <skillName>
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const name = process.argv[2] || ''
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
  console.error('invalid skill name')
  process.exit(2)
}

const SKILLS_DIR = '/dsh-home/skills'
const dir = join(SKILLS_DIR, name)
const flat = join(SKILLS_DIR, `${name}.md`)

let removed = false
if (existsSync(join(dir, 'SKILL.md'))) {
  rmSync(dir, { recursive: true, force: true })
  removed = true
} else if (existsSync(flat)) {
  rmSync(flat, { force: true })
  removed = true
}

console.log(JSON.stringify({ ok: true, name, removed }))
process.exit(0)
