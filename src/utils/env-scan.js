/**
 * env-scan — 随行包启发式检测库（纯函数，零依赖，无网络承诺）
 *
 * 定位（诚实措辞写进审件页，别越过）：**帮管理员省力的提示器，不是安全判定**。
 * 绿≠安全，命中≠有罪——抽查义务在人。服务器纯内网：外部威胁情报无源可查。
 *
 * 两类输出：
 *  - secrets：密钥残留（本库最高价值项——"作者无意带钥匙、钥匙写死在代码里"
 *    的发生率远高于蓄意投毒；命中即红条 + 建议驳回重格）
 *  - hits：可疑行为模式（反弹 shell/管道执行/计划任务写改/敏感路径读取/混淆形态）
 *
 * 模式统一字符串源 + 启动期一次编译：字面量含 / 撕裂正则的历史教训（2026-10-27）。
 */
import { openSync, readSync, closeSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

export const RULES_VERSION = 1

const compile = (list) => list.map((x) => ({ ...x, re: new RegExp(x.source, x.flags || '') }))

const SECRET_PATTERNS = compile([
  { kind: 'private-key', source: '-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----' },
  { kind: 'aws-akia', source: '\\bAKIA[0-9A-Z]{16}\\b' },
  { kind: 'openai-style', source: '\\bsk-[A-Za-z0-9_-]{20,}\\b' },
  { kind: 'github', source: '\\bgh[pousr]_[A-Za-z0-9]{36,}\\b' },
  { kind: 'jwt-ish', source: '\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.' },
  { kind: 'slack', source: '\\bxox[baprs]-[0-9A-Za-z-]{10,}\\b' },
  {
    kind: 'generic-token-assign',
    source:
      '(?:(?:api|auth|access|secret|client)[_-]?key|token)["\']?\\s*[:=]\\s*["\'][A-Za-z0-9+/_-]{24,}["\']',
    flags: 'i',
  },
])

const BEHAVIOR_PATTERNS = compile([
  {
    id: 'curl-pipe-sh',
    source: '\\b(?:curl|wget)[^\\n|]*\\|\\s*(?:ba)?sh\\b',
    hint: '管道执行远程脚本',
  },
  {
    id: 'reverse-shell',
    source: '(?:/dev/tcp/|\\bnc\\s+-[a-z]*e\\b|\\bncat\\s+--sh-exec\\b|socat[^\\n]*EXEC:)',
    hint: '反弹 shell 特征',
  },
  { id: 'cron-write', source: '(?:/etc/cron[.\\w]*|\\bcrontab\\s+-)', hint: '写计划任务' },
  {
    id: 'systemd-unit',
    source: '(?:/etc/systemd/system/|systemctl\\s+enable)',
    hint: '写 systemd 单元',
  },
  { id: 'ld-preload', source: 'LD_PRELOAD|/etc/ld\\.so\\.preload', hint: '动态库劫持' },
  {
    id: 'ssh-dir-read',
    source: '(?:/root/\\.ssh/|/dsh-home/credentials|\\.dsh/credentials)',
    hint: '读取凭证目录',
  },
  {
    id: 'listen-backdoor',
    source: '\\b(?:nc|ncat|socat)\\b[^\\n]*(?:-l\\b|--listen)',
    hint: '监听后门',
  },
  { id: 'base64-blob', source: '[A-Za-z0-9+/]{120,}={0,2}', hint: '长 base64 块（可能编码载荷）' },
  {
    id: 'rm-rootwide',
    source: '\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*f[^\\n]*\\s/(?:\\s|$|\\*)',
    hint: 'rm -rf / 形态',
  },
])

const TEXT_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.yml',
  '.yaml',
  '.json',
  '.md',
  '.txt',
  '.toml',
  '.ini',
  '.conf',
  '.env',
  '.csv',
  '.pl',
  '.rb',
  '.php',
  '.html',
  '.css',
])
const TEXT_BASENAME = new Set(['bashrc', 'profile', 'envrc', 'zshrc', '.env'])

const isTextish = (p) => TEXT_EXT.has(extname(p).toLowerCase()) || TEXT_BASENAME.has(basename(p))

/**
 * 扫一个随行包目录（宿主侧跑，bundle 解压前的存放目录）。
 * files=[{p,size}]（账本 bundle.files 同款形态）。>2MB 或非文本形态跳过并列
 * stats.skipped——诚实：跳过什么可数。单文件只读前 previewBytes 判。
 */
export function scanBundle(dir, files, { previewBytes = 256 * 1024 } = {}) {
  const hits = []
  const secrets = []
  const stats = { scanned: 0, skipped: 0, longLines: [] }
  for (const f of files) {
    if (!isTextish(f.p) || f.size > 2 * 1024 * 1024) {
      stats.skipped++
      continue
    }
    let buf
    try {
      const fd = openSync(join(dir, f.p), 'r')
      try {
        const b = Buffer.alloc(Math.min(f.size, previewBytes))
        const n = readSync(fd, b, 0, b.length, 0)
        buf = b.subarray(0, n).toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      stats.skipped++
      continue
    }
    stats.scanned++
    const lines = buf.split('\n')
    if (lines.some((l) => l.length > 4000)) stats.longLines.push(f.p)
    lines.forEach((line, i) => {
      const probe = line.length > 8192 ? line.slice(0, 8192) : line // 截判防 ReDoS 面
      for (const s of SECRET_PATTERNS) {
        try {
          if (s.re.test(probe))
            secrets.push({ file: f.p, kind: s.kind, line: i + 1, snippet: line.slice(0, 80) })
        } catch {
          /* 规则写坏不拖垮整扫 */
        }
      }
      for (const b of BEHAVIOR_PATTERNS) {
        try {
          if (b.re.test(probe))
            hits.push({
              rule: b.id,
              hint: b.hint,
              file: f.p,
              line: i + 1,
              snippet: line.slice(0, 80),
            })
        } catch {
          /* 同上 */
        }
      }
    })
  }
  return { rulesVer: RULES_VERSION, at: new Date().toISOString(), hits, secrets, stats }
}
