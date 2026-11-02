#!/usr/bin/env node
/**
 * env-browse.mjs — 卷内容分层浏览（作者选随行文件的选择器数据面）
 * 入参 args[0] = base64(JSON { dir: "plugins" | "skills/x" | "" })
 * 出参 stdout  = JSON { dir, items:[{name,type,size,mtime,entries?}] } 或 { error }
 * 纪律：DENY 首段整体隐身；路径净化后必须仍在 /dsh-home 内；symlink 当文件；
 * 单页 500 条封顶（total 报真实数，前端提示截断）。
 */
import { readdirSync, lstatSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'

const HOME = '/dsh-home'
const DENY_FIRST = ['credentials', 'sessions', 'storages', 'settings', 'keys']
const PAGE = 500

function main() {
  let arg
  try {
    arg = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'))
  } catch {
    return { error: 'bad-arg' }
  }
  const rel = normalize(String(arg.dir || '')).replace(/^(\.\.(\/|\\|$))+/, '')
  if (rel.startsWith('/') || rel.includes('..')) return { error: 'bad-path' }
  const first = rel.split(sep)[0]
  if (rel !== '' && DENY_FIRST.includes(first)) return { error: 'denied' }
  const full = join(HOME, rel)
  if (!full.startsWith(HOME + sep) && full !== HOME) return { error: 'escape' }
  const out = { dir: rel, items: [], total: 0 }
  let ents
  try {
    ents = readdirSync(full)
  } catch {
    return { error: 'not-found' }
  }
  out.total = ents.length
  for (const name of ents.slice(0, PAGE)) {
    if (rel === '' && DENY_FIRST.includes(name)) continue // 顶层：禁区连名隐身
    try {
      const st = lstatSync(join(full, name))
      out.items.push({
        name,
        type: st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f',
        size: st.size,
        mtime: st.mtime.toISOString(),
      })
    } catch {
      out.items.push({ name, type: '?', size: 0, mtime: null })
    }
  }
  return out
}
try {
  process.stdout.write(JSON.stringify(main()))
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err && err.message) }))
  process.exit(1)
}
