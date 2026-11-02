#!/usr/bin/env node
/**
 * env-inventory.mjs — 随行包清单发现（挂卷只读 helper 内运行）
 *
 * 输出 JSON：{ skills:[{name,size}], pluginsDir, plugins:[{name,size,sha8}],
 *              roots:[{name,files,bytes}]（一级目录统计） }
 * 纪律：
 *  - DENY 首段目录**连名字都不出现**（文件名本身是情报，"XX持仓.xlsx"式泄露）
 *  - symlink 不跟随（lstat 直出，目录遍历遇 link 当文件列）
 *  - 限量：单目录 walk 2000 文件封顶，roots 40 项封顶——防巨卷憋死 helper
 */
import { readdirSync, statSync, lstatSync, existsSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const HOME = '/dsh-home'
const DENY_FIRST = ['credentials', 'sessions', 'storages', 'settings', 'keys']
const WALK_CAP = 2000
const sha8 = (p) => {
  const h = createHash('sha256')
  return new Promise((res) => {
    const s = createReadStream(p)
    s.on('data', (b) => h.update(b))
    s.on('end', () => res(h.digest('hex').slice(0, 8)))
    s.on('error', () => res('--------'))
  })
}
const denied = (name) => DENY_FIRST.includes(name) || name.startsWith('.env')

function walkStats(dir) {
  let files = 0
  let bytes = 0
  let truncated = false
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let ents
    try {
      ents = readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (e.isSymbolicLink()) {
        files++
        continue
      }
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else {
        try {
          bytes += statSync(p).size
          files++
        } catch {
          /* 不可读个体跳过 */
        }
      }
      if (files > WALK_CAP) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }
  return { files, bytes, truncated }
}

async function main() {
  const out = { skills: [], pluginsDir: null, plugins: [], roots: [] }
  // 技能实物（正文文件；"装了没"的权威在宿主台账，这里给实物对照）
  const sk = join(HOME, 'skills')
  if (existsSync(sk)) {
    for (const e of readdirSync(sk, { withFileTypes: true })) {
      const p = join(sk, e.name)
      const name = e.name.replace(/\.md$/, '')
      const sz = e.isDirectory() ? walkStats(p).bytes : statSync(p).size
      out.skills.push({ name, size: sz })
    }
  }
  // 插件目录探测（harness 布局候选；探不到=列表空，不装懂）
  for (const cand of ['plugins', '.dsh/plugins', 'plugin-bundles']) {
    const p = join(HOME, cand)
    if (existsSync(p) && lstatSync(p).isDirectory()) {
      out.pluginsDir = cand
      for (const e of readdirSync(p)) {
        const ep = join(p, e)
        try {
          const st = lstatSync(ep)
          out.plugins.push({
            name: e,
            size: st.isDirectory() ? walkStats(ep).bytes : st.size,
            sha8: st.isFile() ? await sha8(ep) : '--------',
          })
        } catch {
          /* skip */
        }
      }
      break
    }
  }
  // 一级目录总览（DENY 整名消失）
  for (const e of readdirSync(HOME, { withFileTypes: true })) {
    if (denied(e.name)) continue
    if (!e.isDirectory()) continue
    const s = walkStats(join(HOME, e.name))
    out.roots.push({ name: e.name, files: s.files, bytes: s.bytes, truncated: s.truncated })
    if (out.roots.length >= 40) break
  }
  process.stdout.write(JSON.stringify(out))
}
main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: String(err && err.message) }))
  process.exit(1)
})
