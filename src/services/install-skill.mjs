#!/usr/bin/env node
/**
 * 技能安装/写入脚本（在租户镜像的辅助容器内运行，/dsh-home 为租户数据卷）
 *
 * 把技能正文写入 /dsh-home/skills/<name>/SKILL.md（原子：临时文件 + rename）。
 * 写入后该目录会立即被容器内 DSH 的 skill 文件 watcher 发现。
 * 若之前以 flat 形态（<name>.md）存在，一并删除，避免同名单份重复发现。
 * stdout 输出 JSON：{ ok, path, bytes, sha256 }
 *
 * 用法：node install-skill.mjs <skillName> <bodyBase64>
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const name = process.argv[2] || ''
const b64 = process.argv[3] || ''
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
  console.error('invalid skill name')
  process.exit(2)
}
if (!b64) {
  console.error('missing body')
  process.exit(2)
}
let body
try {
  body = Buffer.from(b64, 'base64')
} catch {
  console.error('invalid base64 body')
  process.exit(2)
}

const SKILLS_DIR = '/dsh-home/skills'
const file = join(SKILLS_DIR, name, 'SKILL.md')
mkdirSync(dirname(file), { recursive: true })

// 清掉旧的 flat 形态 <name>.md，避免 bundle/flat 同名单份重复发现
const flat = join(SKILLS_DIR, `${name}.md`)
if (existsSync(flat)) rmSync(flat, { force: true })

const tmp = `${file}.tmp.${process.pid}`
writeFileSync(tmp, body, { mode: 0o644 })
renameSync(tmp, file)

console.log(
  JSON.stringify({
    ok: true,
    path: file,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  }),
)
process.exit(0)
