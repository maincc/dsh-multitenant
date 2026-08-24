/**
 * merge-settings.mjs 脚本级测试（子进程 + 宿主编译环境 yaml 兜底路径）
 *
 * 覆盖 llm-deepseek 段的 get/set/del 语义：
 *   - 保留文档其他段与注释
 *   - baseURL 空串 / models 空数组 = 删除字段（回默认）
 *   - 段内无内容时整段删除
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'src', 'services', 'merge-settings.mjs')

function run(...args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }).trim()
}

function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), 'ms-test-'))
  const file = join(dir, 'settings.yaml')
  return { dir, file }
}

describe('merge-settings.mjs', () => {
  it('get：文件不存在返回空配置', () => {
    const { dir, file } = tmpHome()
    try {
      expect(JSON.parse(run('get', file))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set 写入后 get 能读回', () => {
    const { dir, file } = tmpHome()
    try {
      run(
        'set',
        file,
        JSON.stringify({
          baseURL: 'https://gw.example.com/v1',
          models: [{ id: 'm1', name: 'M1', contextWindow: 128000, maxTokens: 8192 }],
        }),
      )
      expect(JSON.parse(run('get', file))).toEqual({
        baseURL: 'https://gw.example.com/v1',
        models: [{ id: 'm1', name: 'M1', contextWindow: 128000, maxTokens: 8192 }],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set 保留文档其他段与注释', () => {
    const { dir, file } = tmpHome()
    try {
      writeFileSync(
        file,
        '# 顶部注释\ntelemetry:\n  enabled: false\n\nllm-deepseek:\n  baseURL: https://old.com\n',
      )
      run('set', file, JSON.stringify({ baseURL: 'https://new.com' }))
      const text = readFileSync(file, 'utf8')
      expect(text).toContain('# 顶部注释')
      expect(text).toContain('telemetry:\n  enabled: false')
      expect(text).toContain('baseURL: https://new.com')
      expect(text).not.toContain('https://old.com')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set：baseURL 空串删除该字段（回官方端点）', () => {
    const { dir, file } = tmpHome()
    try {
      writeFileSync(file, 'llm-deepseek:\n  baseURL: https://old.com\n')
      run('set', file, JSON.stringify({ baseURL: '' }))
      expect(JSON.parse(run('get', file))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set：models 空数组删除该字段（回默认模型）', () => {
    const { dir, file } = tmpHome()
    try {
      writeFileSync(file, 'llm-deepseek:\n  baseURL: https://old.com\n  models:\n    - id: m1\n')
      run('set', file, JSON.stringify({ models: [] }))
      const parsed = JSON.parse(run('get', file))
      expect(parsed.baseURL).toBe('https://old.com')
      expect(parsed.models).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set：段内无剩余内容时整段删除', () => {
    const { dir, file } = tmpHome()
    try {
      writeFileSync(file, 'llm-deepseek:\n  baseURL: https://old.com\n')
      run('set', file, JSON.stringify({ baseURL: '', models: [] }))
      expect(JSON.parse(run('get', file))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('del 删除 llm-deepseek 段并保留其他内容', () => {
    const { dir, file } = tmpHome()
    try {
      writeFileSync(file, '# 注释\nother:\n  k: v\nllm-deepseek:\n  baseURL: https://x.com\n')
      expect(run('del', file)).toBe('deleted')
      const text = readFileSync(file, 'utf8')
      expect(text).toContain('# 注释')
      expect(text).toContain('other:\n  k: v')
      expect(text).not.toContain('llm-deepseek')
      expect(existsSync(file)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('del：文件不存在返回 absent', () => {
    const { dir, file } = tmpHome()
    try {
      expect(run('del', file)).toBe('absent')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set：非法 JSON 拒绝（exit 2）', () => {
    const { dir, file } = tmpHome()
    try {
      expect(() => run('set', file, 'not-json')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set：空文档写入空值不产生损坏文件（yaml 空文档 toString 为 null 的回归）', () => {
    const { dir, file } = tmpHome()
    try {
      run('set', file, JSON.stringify({ baseURL: '', models: [] }))
      expect(existsSync(file)).toBe(false)
      // 接着在"空文档"上写真实值不应崩溃
      run('set', file, JSON.stringify({ baseURL: 'https://x.com' }))
      expect(JSON.parse(run('get', file)).baseURL).toBe('https://x.com')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set：损坏的 null 根文档按空文档处理（不崩溃）', () => {
    const { dir, file } = tmpHome()
    try {
      writeFileSync(file, 'null\n')
      run('set', file, JSON.stringify({ baseURL: 'https://fix.com' }))
      expect(JSON.parse(run('get', file)).baseURL).toBe('https://fix.com')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('set：段内部分字段删除保留其他字段', () => {
    const { dir, file } = tmpHome()
    try {
      run('set', file, JSON.stringify({ baseURL: 'https://x.com', models: [{ id: 'm1' }] }))
      run('set', file, JSON.stringify({ baseURL: '' }))
      const parsed = JSON.parse(run('get', file))
      expect(parsed.baseURL).toBeUndefined()
      expect(parsed.models).toEqual([{ id: 'm1' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('llm-pi-ai providers：按 route 合并 / null 删除 / 全量回读', () => {
    const { dir, file } = tmpHome()
    try {
      run(
        'set',
        file,
        JSON.stringify({ providers: { gw1: { displayName: 'A', baseURL: 'https://a.com' } } }),
        'llm-pi-ai',
      )
      run(
        'set',
        file,
        JSON.stringify({
          providers: { gw1: null, gw2: { displayName: 'B', baseURL: 'https://b.com' } },
        }),
        'llm-pi-ai',
      )
      const parsed = JSON.parse(run('get', file, 'llm-pi-ai'))
      expect(Object.keys(parsed.providers)).toEqual(['gw2'])
      expect(parsed.providers.gw2.displayName).toBe('B')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
