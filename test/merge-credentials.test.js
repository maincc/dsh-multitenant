/**
 * merge-credentials.mjs 脚本级测试（子进程）
 *
 * 覆盖 DSH 凭证文件（version: 1 + refs: 嵌套布局）的 get/set/del/list 语义：
 *   - 新建文件写出 versioned 嵌套布局（DSH credentials-local 要求的格式）
 *   - 保留已有其他 refs 条目与顶层注释
 *   - 旧 pre-release 扁平布局自动迁移为嵌套布局
 *   - 空 refs 写 refs: {}（DSH 接受）
 *   - get/list 绝不输出值
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'

const SCRIPT = join(process.cwd(), 'src', 'services', 'merge-credentials.mjs')

function run(...args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }).trim()
}

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-test-'))
  const file = join(dir, '.credentials.yaml')
  return { dir, file }
}

describe('merge-credentials.mjs', () => {
  it('set 新建文件写出 versioned 嵌套布局', () => {
    const { dir, file } = tmpFile()
    try {
      run('set', file, 'CUSTOM_1787734884707_0_API_KEY', 'sk-abc')
      const text = readFileSync(file, 'utf8')
      expect(text).toContain('version: 1')
      expect(text).toMatch(/^refs:$/m)
      expect(text.trim()).toBe('version: 1\nrefs:\n  CUSTOM_1787734884707_0_API_KEY: "sk-abc"')
      expect(run('get', file, 'CUSTOM_1787734884707_0_API_KEY')).toBe('configured')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set 保留已有其他 refs 条目与顶层注释', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(
        file,
        '# managed by dsh\nversion: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-ds\n  QWEN_API_KEY: "sk-qw"\n',
      )
      run('set', file, 'CUSTOM_1787734884707_0_API_KEY', 'sk-custom')
      const text = readFileSync(file, 'utf8')
      expect(text).toContain('# managed by dsh')
      expect(text).toContain('DEEPSEEK_API_KEY: "sk-ds"')
      expect(text).toContain('QWEN_API_KEY: "sk-qw"')
      expect(text).toContain('CUSTOM_1787734884707_0_API_KEY: "sk-custom"')
      expect(run('get', file, 'DEEPSEEK_API_KEY')).toBe('configured')
      expect(run('get', file, 'CUSTOM_1787734884707_0_API_KEY')).toBe('configured')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set 覆盖已有同键条目', () => {
    const { dir, file } = tmpFile()
    try {
      run('set', file, 'K1', 'v1')
      run('set', file, 'K1', 'v2')
      const text = readFileSync(file, 'utf8')
      const hits = text.match(/K1: "v2"/g)
      expect(hits).toHaveLength(1)
      expect(text).not.toContain('K1: "v1"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set：旧扁平布局自动迁移为嵌套布局', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, 'CUSTOM_OLD_API_KEY: sk-old\nQWEN_API_KEY: "sk-qw"\n')
      run('set', file, 'CUSTOM_1787734884707_0_API_KEY', 'sk-custom')
      const text = readFileSync(file, 'utf8')
      expect(text).toContain('version: 1')
      expect(text).toMatch(/^refs:$/m)
      expect(text).toContain('CUSTOM_OLD_API_KEY: "sk-old"')
      expect(text).toContain('QWEN_API_KEY: "sk-qw"')
      expect(text).toContain('CUSTOM_1787734884707_0_API_KEY: "sk-custom"')
      // 迁移后不应再有顶格 KEY: value 行（除 version/refs 外）
      expect(text).not.toMatch(/^CUSTOM_OLD_API_KEY:/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('get：缺失键返回 absent，文件不存在返回 absent', () => {
    const { dir, file } = tmpFile()
    try {
      expect(run('get', file, 'NOPE')).toBe('absent')
      run('set', file, 'K1', 'v1')
      expect(run('get', file, 'K1')).toBe('configured')
      expect(run('get', file, 'NOPE')).toBe('absent')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('list 只输出所有已配置引用名（不含 version/值）', () => {
    const { dir, file } = tmpFile()
    try {
      run('set', file, 'A_KEY', 'va')
      run('set', file, 'B_KEY', 'vb')
      const out = JSON.parse(run('list', file))
      expect(out).toEqual(expect.arrayContaining(['A_KEY', 'B_KEY']))
      expect(out).not.toContain('version')
      expect(out).not.toContain('refs')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('del 删除条目，保留其他条目与注释', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, '# note\nversion: 1\nrefs:\n  KEEP: "k"\n  GONE: "g"\n')
      expect(run('del', file, 'GONE')).toBe('deleted')
      const text = readFileSync(file, 'utf8')
      expect(text).toContain('# note')
      expect(text).toContain('KEEP: "k"')
      expect(text).not.toContain('GONE')
      expect(run('get', file, 'GONE')).toBe('absent')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('del：条目不存在返回 absent 且不改文件', () => {
    const { dir, file } = tmpFile()
    try {
      expect(run('del', file, 'GONE')).toBe('absent')
      writeFileSync(file, 'version: 1\nrefs:\n  KEEP: "k"\n')
      expect(run('del', file, 'GONE')).toBe('absent')
      expect(readFileSync(file, 'utf8')).toContain('KEEP: "k"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('del 删除最后一个条目后写出 refs: {}（DSH 接受空容器）', () => {
    const { dir, file } = tmpFile()
    try {
      run('set', file, 'ONLY', 'v')
      run('del', file, 'ONLY')
      const text = readFileSync(file, 'utf8')
      expect(text).toContain('version: 1')
      expect(text).toContain('refs: {}')
      expect(JSON.parse(run('list', file))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非法引用名拒绝（exit 2）', () => {
    const { dir, file } = tmpFile()
    try {
      expect(() => run('set', file, 'bad name!', 'v')).toThrow()
      expect(() => run('get', file, '1bad')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set 后文件可被 DSH credentials-local 解析（关键兼容）', () => {
    const { dir, file } = tmpFile()
    try {
      run('set', file, 'CUSTOM_1787734884707_0_API_KEY', 'sk-abc')
      // 与 DSH 的自检保持一致：凭证文档必须是"引用名 -> 字符串"映射，
      // 且不包含扁平布局。此处校验渲染结果结构，等价于 DSH 的解析约束。
      const text = readFileSync(file, 'utf8')
      const versionLine = text.split('\n').find((l) => /^version:/.test(l))
      const refsLine = text.split('\n').find((l) => /^refs:/.test(l))
      expect(versionLine).toBe('version: 1')
      expect(!!refsLine).toBe(true)
      // 扁平布局的特征：顶格 KEY: value（非 version/refs）不应出现
      for (const line of text.split('\n')) {
        if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(line) && !/^(version|refs):/.test(line)) {
          throw new Error('flat layout line leaked: ' + line)
        }
      }
      expect(existsSync(file)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 回归：凭据文件被写坏（线上实测故障）
//
// 故障链条：DSH ≥0.1.5 会自己往 .credentials.yaml 写
// `client-connection/browser-session`（认证 cookie 签名密钥靠它持久化）；
// 旧实现"整篇解析 → 重新渲染"，把不认识的行当注释收集后**搬到文件开头**，
// 且 refs 块结束分支缺 continue 导致同一行被 push 两次 → 重复键 /
// 缩进行跑到文档开头 → YAML 非法 → DSH credentials-local 拒绝加载 →
// 容器退出 1 → 平台只看到"容器未能就绪"。
//
// 用真正的 YAML 解析器断言"文件合法"，因为这就是当时的失败表现。
// ---------------------------------------------------------------------------
describe('merge-credentials.mjs：不破坏 DSH 自己写入的内容（回归）', () => {
  it('保留 DSH 的 client-connection 嵌套块，且位置不被搬到文件开头', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(
        file,
        'version: 1\nrefs:\n  DEEPSEEK_API_KEY: "sk-a"\n' +
          'client-connection:\n  browser-session:\n    signingKey: "deadbeef"\n',
      )

      run('set', file, 'NEW_KEY', 'sk-new')

      const parsed = YAML.parse(readFileSync(file, 'utf8'))
      expect(parsed.refs.NEW_KEY).toBe('sk-new')
      expect(parsed.refs.DEEPSEEK_API_KEY).toBe('sk-a')
      // 会话签名密钥必须原样活着（丢了就等于强制所有人重新登录）
      expect(parsed['client-connection']).toEqual({
        'browser-session': { signingKey: 'deadbeef' },
      })

      // 位置：嵌套块仍在 refs 之后，没有被搬到文档开头
      const lines = readFileSync(file, 'utf8').split('\n')
      const refsAt = lines.findIndex((l) => l === 'refs:')
      const ccAt = lines.findIndex((l) => l.startsWith('client-connection:'))
      expect(refsAt).toBeGreaterThanOrEqual(0)
      expect(ccAt).toBeGreaterThan(refsAt)
      expect(lines[0]).toBe('version: 1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refs 里带连字符的键不再产生重复键（旧实现的双 push 缺陷）', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, 'version: 1\nrefs:\n  MY-KEY: "v1"\n')

      run('set', file, 'OK_KEY', 'v2')

      const text = readFileSync(file, 'utf8')
      const parsed = YAML.parse(text) // 重复键会在这里抛错
      expect(parsed.refs['MY-KEY']).toBe('v1')
      expect(parsed.refs.OK_KEY).toBe('v2')
      // 同一个键只出现一次
      expect(text.split('\n').filter((l) => l.includes('MY-KEY')).length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('反复 set 不累积垃圾行（旧实现会把未知/未识别内容越堆越多）', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(
        file,
        'version: 1\nrefs:\n  A: "1"\nclient-connection:\n  browser-session:\n    signingKey: "k"\n',
      )

      run('set', file, 'A', '2')
      run('set', file, 'A', '3')
      run('set', file, 'B', '4')

      const lines = readFileSync(file, 'utf8').split('\n')
      expect(lines.filter((l) => l.startsWith('version:'))).toHaveLength(1)
      expect(lines.filter((l) => l === 'refs:')).toHaveLength(1)
      expect(lines.filter((l) => l.startsWith('client-connection:'))).toHaveLength(1)
      expect(YAML.parse(lines.join('\n')).refs).toEqual({ A: '3', B: '4' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('裸标量值被规范化为字符串（DSH 要求 refs 值是字符串，123 会变数字）', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, 'version: 1\nrefs:\n  NUM_KEY: 123\n  NULL_KEY: null\n')

      run('set', file, 'OTHER', 'x')

      const parsed = YAML.parse(readFileSync(file, 'utf8'))
      expect(parsed.refs.NUM_KEY).toBe('123')
      expect(parsed.refs.NULL_KEY).toBe('null')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 回归：多行折叠值不能被"规范化"改坏
//
// 实测真实文件（DSH 自己写的）：API Key 的值是**跨行折叠的引号标量**
//     CUSTOM_xxx_API_KEY: "sk-sp-AAAA
//       BBBB...ZZZZ"
// 第二行是同一个值的延续（缩进更深）。旧实现按单行取值再重新加引号，会把
// 值截断、并留下孤立残行 → YAML 非法 —— 正是"保存 Key 反而写坏文件"的翻版。
//
// 约束：只对**完整单行裸标量**补引号；跨行折叠值原样保留；替换/删除条目时
// 必须连续行一起处理。
// ---------------------------------------------------------------------------
describe('merge-credentials.mjs：多行折叠值（回归）', () => {
  const MULTILINE =
    'version: 1\n' +
    'refs:\n' +
    '  CUSTOM_MULTI_API_KEY: "sk-sp-AAAA\n' +
    '    BBBBCCCCDDDD"\n' +
    'records:\n' +
    '  client-connection/browser-session:\n' +
    '    kind: grant\n' +
    '    payload:\n' +
    '      version: 1\n' +
    '      secret: s3cr3t\n'

  it('保存新 Key 时，多行折叠值的原值与续行都保持不动', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, MULTILINE)
      const before = YAML.parse(MULTILINE)

      run('set', file, 'NEW_KEY', 'sk-new')

      const text = readFileSync(file, 'utf8')
      const after = YAML.parse(text) // 非法 YAML 会在这里抛错
      expect(after.refs.NEW_KEY).toBe('sk-new')
      expect(after.refs.CUSTOM_MULTI_API_KEY).toBe(before.refs.CUSTOM_MULTI_API_KEY)
      // 续行必须还在（不能被吞掉，也不能变成孤立残行）
      expect(text).toContain('BBBBCCCCDDDD"')
      // DSH 自己的 records 块不受影响
      expect(after.records['client-connection/browser-session'].payload.secret).toBe('s3cr3t')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('重存同一个多行 Key → 折叠值被替换成单行，且不留续行残骸', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, MULTILINE)

      run('set', file, 'CUSTOM_MULTI_API_KEY', 'sk-replaced')

      const text = readFileSync(file, 'utf8')
      const after = YAML.parse(text)
      expect(after.refs.CUSTOM_MULTI_API_KEY).toBe('sk-replaced')
      // 旧值的残骸不能留在文件里
      expect(text).not.toContain('BBBBCCCCDDDD')
      expect(after.records['client-connection/browser-session'].payload.secret).toBe('s3cr3t')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('删除多行 Key → 连续行一起删掉，refs 变 {}，records 保留', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, MULTILINE)

      run('del', file, 'CUSTOM_MULTI_API_KEY')

      const text = readFileSync(file, 'utf8')
      const after = YAML.parse(text)
      expect(after.refs).toEqual({})
      expect(text).not.toContain('BBBBCCCCDDDD')
      expect(after.records['client-connection/browser-session']).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 结构自检（fail closed）：看不懂就拒写，绝不二次破坏
//
// 实测真实损坏形态：DSH 的 records 块被塞进 refs 内部，出现 `records: ""`
// 却带着更深的子级 → DSH 完全起不来（容器 120s 不就绪 → 回滚 → 界面"已销毁"）。
// 本工具是"按行编辑"，遇到这种输入必须拒绝写入，而不是继续加工。
// ---------------------------------------------------------------------------
describe('merge-credentials.mjs：结构异常时拒绝写入', () => {
  const CORRUPT =
    'version: 1\n' +
    'refs:\n' +
    '  records: ""\n' +
    '  client-connection/browser-session:\n' +
    '    kind: "grant"\n' +
    '    payload: ""\n' +
    '      version: 1\n' +
    '      secret: SESSION-SECRET-TEST-ONLY-AAAA\n' +
    '  DEEPSEEK_API_KEY: "sk-TEST-ONLY-NOT-A-REAL-KEY"\n'

  it('set：结构异常 → 非零退出且文件原样不动', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, CORRUPT)
      expect(() => run('set', file, 'NEW_KEY', 'sk-x')).toThrow()
      expect(readFileSync(file, 'utf8')).toBe(CORRUPT) // 一个字节都没改
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('del：结构异常 → 同样拒绝', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, CORRUPT)
      expect(() => run('del', file, 'DEEPSEEK_API_KEY')).toThrow()
      expect(readFileSync(file, 'utf8')).toBe(CORRUPT)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('健康文件不受影响（自检不能误伤正常结构）', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, 'version: 1\nrefs:\n  A: "1"\n')
      run('set', file, 'B', 'two')
      const parsed = YAML.parse(readFileSync(file, 'utf8'))
      expect(parsed.refs).toEqual({ A: '1', B: 'two' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 回归：DSH 在【没有 API Key】时写的文件没有 refs 块，只有 records
//
// 实测形状（这就是线上"保存 Key 反而把文件写坏"的真正来源）：
//     version: 1
//     records:
//       client-connection/browser-session: …
// 旧实现的"旧扁平布局迁移"把 `records:`（无值 + 带更深子级的**块头**）误当成
// 凭据条目迁进 refs，子级随即变成 refs 下的孤儿 → 文件损坏 → DSH 起不来。
// ---------------------------------------------------------------------------
describe('merge-credentials.mjs：无 refs 块（DSH 空凭据文件）', () => {
  const NO_REFS =
    'version: 1\n' +
    'records:\n' +
    '  client-connection/browser-session:\n' +
    '    kind: grant\n' +
    '    payload:\n' +
    '      version: 1\n' +
    '      secret: SESSION-SECRET-TEST-ONLY-BBBB\n'

  it('set：追加 refs 块，records 原样保留，文件仍合法', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, NO_REFS)
      const before = YAML.parse(NO_REFS)

      run('set', file, 'DEEPSEEK_API_KEY', 'sk-test')

      const after = YAML.parse(readFileSync(file, 'utf8')) // 非法会抛错
      expect(after.refs.DEEPSEEK_API_KEY).toBe('sk-test')
      // DSH 的 records（含会话签名密钥）必须完好 —— 丢了等于强制所有人重登
      expect(after.records).toEqual(before.records)
      // 不能把 records 当成凭据条目写进去
      expect(after.refs.records).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('list：records/records 的子键都不算凭据', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, NO_REFS)
      expect(JSON.parse(run('list', file))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('get records → absent（块头不是凭据，不能被读出来）', () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(file, NO_REFS)
      expect(run('get', file, 'records')).toBe('absent')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
