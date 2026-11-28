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
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

const SKILLS_DIR = '/dsh-home/skills'
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

const names = []
const hashes = new Map() // name → 卷内实物的 sha256（判例 53：差异以容器实际为主）
const flatBases = new Set()
const hashOf = (file) => {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

try {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) {
      const bundle = join(SKILLS_DIR, e.name, 'SKILL.md')
      try {
        if (readdirSync(join(SKILLS_DIR, e.name)).includes('SKILL.md')) {
          if (NAME_RE.test(e.name) && e.name.length <= 64) {
            names.push(e.name)
            hashes.set(e.name, hashOf(bundle))
          }
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
    if (!dirSet.has(base) && NAME_RE.test(base) && base.length <= 64) {
      names.push(base)
      hashes.set(base, hashOf(join(SKILLS_DIR, `${base}.md`)))
    }
  }
} catch {
  // /dsh-home/skills 不存在 → 空列表
}

// ---- 插件槽位实物（判例 55：插件=无账实物，以卷为断；候选链与 env-inventory 同套）----
const HOME = '/dsh-home'
const plugins = []
let pluginsDir = null
const walkCount = (d, acc) => {
  let files = 0
  let bytes = 0
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name)
    if (e.isDirectory()) {
      const sub = walkCount(f, acc)
      files += sub.files
      bytes += sub.bytes
    } else if (e.isFile()) {
      files++
      try {
        bytes += statSync(f).size
      } catch {
        /* 读不到大小记 0，不虚报 */
      }
    }
  }
  return { files, bytes }
}
const readManifest = (dir) => {
  for (const mf of ['plugin.json', 'manifest.json']) {
    try {
      const j = JSON.parse(readFileSync(join(dir, mf), 'utf8'))
      return { version: j.version || '', description: j.description || '' }
    } catch {
      /* 无清单/坏 JSON：如实空字段 */
    }
  }
  return { version: '', description: '' }
}
for (const cand of ['plugins', '.dsh/plugins', 'plugin-bundles']) {
  try {
    const p = join(HOME, cand)
    if (!lstatSync(p).isDirectory()) continue
    pluginsDir = cand
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const ep = join(p, e.name)
      if (e.isDirectory()) {
        const { files, bytes } = walkCount(ep, null)
        const mf = readManifest(ep)
        plugins.push({ name: e.name, kind: 'dir', fileCount: files, bytes, ...mf })
      } else if (e.isFile()) {
        let bytes = 0
        let sha8 = null
        try {
          bytes = statSync(ep).size
          sha8 = hashOf(ep)?.slice(0, 8) ?? null
        } catch {
          /* 同上 */
        }
        plugins.push({ name: e.name, kind: 'file', fileCount: 1, bytes, sha8 })
      }
    }
    break
  } catch {
    /* 候选不存在→下一个 */
  }
}

console.log(
  JSON.stringify({
    ok: true,
    names,
    items: names.map((name) => ({ name, sha256: hashes.get(name) ?? null })),
    pluginsDir,
    plugins,
  }),
)
