/**
 * 把 randomuuid-shim.js 注入到 DSH web 前端 index.html 的 </head> 前
 *
 * 用法：node inject-shim.mjs <index.html 路径>
 * 由 Dockerfile 在 npm install 之后调用；也可本地对 dist/index.html 手动执行。
 * 幂等：重复执行只是再次在 </head> 前插入同一段 script（guard 保证运行时无副作用）。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const html = process.argv[2]
if (!html) {
  console.error('usage: node inject-shim.mjs <index.html>')
  process.exit(1)
}

const shim =
  '<script>' + readFileSync('/patches/shims/randomuuid-shim.js', 'utf8') + '</script>'

let s = readFileSync(html, 'utf8')
if (!s.includes('</head>')) {
  console.error('no </head> anchor: ' + html)
  process.exit(1)
}
writeFileSync(html, s.replace('</head>', shim + '</head>', 1))
console.log('>> injected crypto.randomUUID shim into ' + html)
