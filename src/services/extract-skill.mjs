#!/usr/bin/env node
/**
 * 技能提取脚本（在租户镜像的辅助容器内运行，/dsh-home 为租户数据卷）
 *
 * 从 /dsh-home/skills/<name>/ 提取技能文件内容，通过 stdout 输出 JSON：
 *   { ok, name, kind, path, bodyBase64, bytes, sha256, hasResources }
 * 找不到技能时输出 { ok:false, reason:'not-found' }（退出码 0，属正常结果）。
 *
 * 用法：node extract-skill.mjs <skillName>
 */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const name = process.argv[2] || ''
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
  console.log(JSON.stringify({ ok: false, reason: 'invalid-name', name }))
  process.exit(0)
}

const SKILLS_DIR = '/dsh-home/skills'
const bundle = join(SKILLS_DIR, name, 'SKILL.md')
const flat = join(SKILLS_DIR, `${name}.md`)

let foundPath = null
let kind = null
if (existsSync(bundle)) {
  foundPath = bundle
  kind = 'bundle'
} else if (existsSync(flat)) {
  foundPath = flat
  kind = 'flat'
}

if (!foundPath) {
  console.log(JSON.stringify({ ok: false, reason: 'not-found', name }))
  process.exit(0)
}

const content = readFileSync(foundPath)
const hasResources =
  kind === 'bundle' &&
  ['references', 'scripts', 'assets'].some((d) => existsSync(join(SKILLS_DIR, name, d)))

console.log(
  JSON.stringify({
    ok: true,
    name,
    kind,
    path: foundPath,
    bodyBase64: content.toString('base64'),
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    hasResources,
  }),
)
process.exit(0)
