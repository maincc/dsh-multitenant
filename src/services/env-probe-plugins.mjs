#!/usr/bin/env node
/**
 * env-probe-plugins.mjs — 插件槽位内容核对（挂接收者卷只读 helper 内运行）
 * 入参 args[0] = base64(JSON { expect: {插件名: {相对路径: sha256}} })
 * 出参 stdout = {插件名: bool}——true=槽位实物与我当初放的字节**全等**
 * （文件集合相等且逐一 sha256 相等；多出/缺失/改过一个字节都不算）。
 * 判例 55（裁定"插件可能来自 GitHub/官网/自写"）：退场清扫删除的**唯一前提**
 * 是这条核对通过——出身隐形没关系，字节指纹就是"我放的"的证据。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = '/dsh-home/plugins'
let arg
try {
  arg = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'))
} catch {
  console.log(JSON.stringify({ __error: 'bad-arg' }))
  process.exit(0)
}
const expect = (arg && arg.expect) || {}
const out = Object.create(null) // 同名 '__proto__' 不许写穿全局原型（判例 57 H2）
for (const [name, map] of Object.entries(expect)) {
  let ok = true
  const seen = new Set()
  const root = join(ROOT, name)
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.isFile()) {
        const rel = relative(root, f)
        seen.add(rel)
        try {
          const h = createHash('sha256').update(readFileSync(f)).digest('hex')
          if (map[rel] !== h) ok = false
        } catch {
          ok = false
        }
      } else {
        ok = false // 符号链接/特殊文件：不是安装管线放的东西
      }
    }
  }
  try {
    walk(root)
  } catch {
    ok = false // 目录没了=实物早就不在
  }
  for (const rel of Object.keys(map)) if (!seen.has(rel)) ok = false
  out[name] = ok
}
console.log(JSON.stringify({ checked: out }))
