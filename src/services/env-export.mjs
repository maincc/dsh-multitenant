#!/usr/bin/env node
/**
 * env-export.mjs — 随行包导出（挂源租户卷 + /out 宿主目录的 helper 内运行）
 * 入参 args[0] = base64(JSON { items:[{root,name}] })；root ∈ skills|plugins
 * 产物：/out/bundle.tar.gz（卷内相对路径）+ /out/manifest.json（逐文件 size/sha256）
 * stdout：{ ok, bytes, files } 或 { error }
 * 纪律：
 *  - **默认拒绝**：只认白名单根（skills/plugins）；DENY 段二次硬拦——
 *    inventory 那边已经隐藏，这里是"前端不是防线"的后端闸
 *  - 路径净化：normalize 后必须仍在根内；symlink 拒收（tar 不跟随打包）
 *  - 限额：单文件 50MB / 包总量 200MB / 条目 200，超限整体拒绝（不留半包）
 */
import { readdirSync, statSync, lstatSync, writeFileSync, readFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const HOME = '/dsh-home'
const ALLOW_ROOTS = ['skills', 'plugins']
const DENY_SEG = ['credentials', 'sessions', 'storages', 'settings', 'keys']
const FILE_CAP = 50 * 1024 * 1024
const TOTAL_CAP = 200 * 1024 * 1024
const ITEMS_CAP = 200

function listFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) continue // 链接不带走（穿透面）
      if (e.isDirectory()) stack.push(p)
      else out.push(p)
    }
  }
  return out
}

function sha256(p) {
  const h = createHash('sha256')
  h.update(readFileSync(p))
  return h.digest('hex')
}

function main() {
  let arg
  try {
    arg = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'))
  } catch {
    return { error: 'bad-arg' }
  }
  const items = Array.isArray(arg.items) ? arg.items.slice(0, ITEMS_CAP + 1) : []
  if (items.length > ITEMS_CAP) return { error: 'too-many-items' }
  const rels = []
  for (const it of items) {
    const root = String(it && it.root)
    if (!ALLOW_ROOTS.includes(root)) return { error: `root-not-allowed:${root}` }
    const name = normalize(String((it && it.name) || '')).replace(/^(\.\.(\/|\\|$))+/, '')
    if (!name || name.startsWith('/') || name.includes('..')) return { error: 'bad-path' }
    const segs = name.split(sep)
    if (segs.some((s) => DENY_SEG.includes(s) || s.startsWith('.env'))) return { error: 'denied' }
    const full = join(HOME, root, name)
    if (!full.startsWith(join(HOME, root) + sep) && full !== join(HOME, root))
      return { error: 'escape' }
    let st
    try {
      st = lstatSync(full)
    } catch {
      return { error: `not-found:${root}/${name}` } // 勾了不存在=定格中止（半包不留）
    }
    if (st.isSymbolicLink()) return { error: `symlink:${root}/${name}` }
    if (st.isDirectory()) {
      for (const f of listFiles(full)) {
        const s = statSync(f)
        if (s.size > FILE_CAP) return { error: `file-too-big:${f}` }
        rels.push(f)
      }
    } else {
      if (st.size > FILE_CAP) return { error: `file-too-big:${root}/${name}` }
      rels.push(full)
    }
  }
  if (!rels.length) return { error: 'empty' }
  const manifest = []
  let bytes = 0
  for (const abs of rels) {
    const st = statSync(abs)
    bytes += st.size
    if (bytes > TOTAL_CAP) return { error: 'bundle-too-big' }
    manifest.push({
      p: abs.slice(HOME.length + 1),
      size: st.size,
      sha256: sha256(abs),
    })
  }
  const t = spawnSync('tar', [
    '-czf',
    '/out/bundle.tar.gz',
    '-C',
    HOME,
    ...manifest.map((m) => m.p),
  ])
  if (t.status !== 0) return { error: `tar-failed:${String(t.stderr || '').slice(0, 200)}` }
  writeFileSync('/out/manifest.json', JSON.stringify(manifest))
  return { ok: true, bytes, files: manifest.length }
}
try {
  process.stdout.write(JSON.stringify(main()))
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err && err.message) }))
  process.exit(1)
}
