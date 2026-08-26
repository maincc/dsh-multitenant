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
