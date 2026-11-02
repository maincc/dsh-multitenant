#!/usr/bin/env node
/**
 * env-install.mjs — 随行包装入（挂接收者卷 rw + 包目录 /out ro 的 helper 内运行）
 * 入参 args[0] = base64(JSON { dryRun:bool })；/out 内有 bundle.tar.gz
 * 出参 stdout = { ok, copied:[…], conflicts:[{p,size}] } 或 { error }
 * 纪律：
 *  - 完整性：解到临时区后逐文件比对账本 expected sha256——包被外力换过即中止
 *  - 目标净化：dest 相对路径必须在 /dsh-home 内且不在 DENY 段（接收者的
 *    钥匙/会话任何模板都写不进——服务端第二道闸，作者卷说了不算）
 *  - dryRun：只报冲突（dest 已存在），零写入——接收者确认弹层的数据源
 *  - 真装：冲突项覆盖（接收者看过清单并确认）；不做删除动作（只加不减）
 */
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, normalize, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const HOME = '/dsh-home'
const TMP = '/tmp/bundle'
const DENY_SEG = ['credentials', 'sessions', 'storages', 'settings', 'keys']
const ALLOW_PREFIX = ['skills/', 'plugins/']

function listFiles(dir, base) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else out.push(p.slice(base.length + 1))
    }
  }
  return out
}
function main() {
  let arg
  try {
    arg = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'))
  } catch {
    return { error: 'bad-arg' }
  }
  spawnSync('rm', ['-rf', TMP])
  // 判例（2026-10 装包首跑）：tar 的 -C 目录不存在直接 "Cannot open" 退出——
  // rm 之后必须把暂存目录建回来（export 侧同款肌肉，这里曾漏写）
  const mk = spawnSync('mkdir', ['-p', TMP])
  if (mk.status !== 0) return { error: `mkdir-tmp-failed:${String(mk.stderr || '').slice(0, 120)}` }
  if (Array.isArray(arg.plan) && arg.plan.length) {
    // CAS 模式（判例 56）：字节块从 /blobs 只读取，名=内容；落位前逐块复验哈希——
    // 挂载面被换/块被腐都在这里现形，不给半成品留进卷的机会。
    for (const it of arg.plan) {
      if (!it?.p || !it?.sha || !/^[0-9a-f]{64}$/.test(it.sha)) return { error: 'bad-plan' }
      const rel = normalize(it.p)
      if (!rel || rel.startsWith('/') || rel.includes('..')) return { error: 'bad-plan' }
      const src = join('/blobs', it.sha.slice(0, 2), it.sha.slice(2))
      const dst = join(TMP, rel)
      try {
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
        const h = createHash('sha256').update(readFileSync(dst)).digest('hex')
        if (h !== it.sha) return { error: `blob-tampered:${rel}` }
      } catch {
        return { error: `blob-missing:${rel}` }
      }
    }
  } else {
    const u = spawnSync('tar', ['-xzf', '/out/bundle.tar.gz', '-C', TMP])
    if (u.status !== 0) return { error: `untar-failed:${String(u.stderr || '').slice(0, 200)}` }
  }
  const files = listFiles(TMP, TMP).sort()
  if (!files.length) return { error: 'empty-bundle' }
  // 账本清单核验（服务端权威）：解出物与 expected 列表逐一对不上=包被外力
  // 调换/重打包，中止——helper 与宿主 verify 各一道，两侧都不信前端。
  if (Array.isArray(arg.expect)) {
    const exp = [...arg.expect].map((e) => normalize(e)).sort()
    if (exp.length !== files.length || exp.some((e, i) => e !== files[i]))
      return { error: 'expect-mismatch' }
  }
  const copied = []
  const conflicts = []
  for (const rel of files) {
    const norm = normalize(rel)
    if (norm.startsWith('/') || norm.includes('..')) return { error: `bad-path:${rel}` }
    const segs = norm.split(sep)
    if (segs.some((s) => DENY_SEG.includes(s) || s.startsWith('.env')))
      return { error: `denied-target:${rel}` }
    const okRoot = ALLOW_PREFIX.some((p) => (norm + sep).startsWith(p) || norm === p.slice(0, -1))
    if (!okRoot) return { error: `root-not-allowed:${rel}` }
    const dest = join(HOME, norm)
    const src = join(TMP, norm)
    const st = statSync(src)
    if (st.size > 50 * 1024 * 1024) return { error: `file-too-big:${rel}` }
    let exists = false
    try {
      exists = !!lstatSync(dest)
    } catch {
      exists = false
    }
    if (exists) conflicts.push({ p: norm, size: st.size })
    copied.push({ p: norm, size: st.size })
    if (!arg.dryRun && !exists) {
      mkdirSync(join(dest, '..'), { recursive: true })
      cpSync(src, dest)
    } else if (!arg.dryRun) {
      mkdirSync(join(dest, '..'), { recursive: true })
      cpSync(src, dest, { force: true }) // 覆盖确认过的那份
    }
  }
  spawnSync('rm', ['-rf', TMP])
  return { ok: true, dryRun: !!arg.dryRun, copied, conflicts }
}
try {
  process.stdout.write(JSON.stringify(main()))
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err && err.message) }))
  process.exit(1)
}
