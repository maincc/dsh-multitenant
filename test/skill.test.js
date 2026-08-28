import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertSkillName,
  nameCandidateFromFilename,
  parseFrontmatter,
  parseSkillBoolean,
  rewriteSkillName,
  validateSkill,
} from '../src/utils/skill.js'
import { SkillService, MAX_ACTIVE_PUBLISHED } from '../src/services/skill.service.js'
import { tenantConfigService } from '../src/services/tenant-config.service.js'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../src/utils/errors.js'

/** 生成一个合法的 skill 文件文本 */
function skillText(name = 'my-skill', extra = '') {
  return [
    '---',
    `name: ${name}`,
    'description: 测试技能',
    'whenToUse: 测试场景',
    ...extra.split('\n').filter(Boolean),
    '---',
    '# 正文',
    '按规范执行。',
  ].join('\n')
}

function base64(s) {
  return Buffer.from(s, 'utf8').toString('base64')
}

/** 构造隔离存储的服务实例（卷脚本 mock） */
function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'skill-test-'))
  const svc = new SkillService({
    storeDir: join(dir, 'store'),
    installsFile: join(dir, 'installs.json'),
  })
  return { dir, svc }
}

function mockExtract(svc, text) {
  vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue(
    JSON.stringify({
      ok: true,
      name: 'irrelevant',
      kind: 'bundle',
      bodyBase64: base64(text),
      bytes: Buffer.byteLength(text),
      sha256: 'mock',
      hasResources: false,
    }),
  )
}

afterAll(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// utils/skill.js
// ---------------------------------------------------------------------------

describe('技能名校验', () => {
  it('合法 kebab-case 通过', () => {
    expect(assertSkillName('my-skill')).toBe('my-skill')
    expect(assertSkillName('a')).toBe('a')
    expect(assertSkillName('hello-world-2')).toBe('hello-world-2')
  })

  it('非法命名被拒绝', () => {
    for (const bad of [
      'MySkill',
      'my_skill',
      'my skill',
      'my/skill',
      '../etc',
      '',
      'a'.repeat(65),
      null,
      undefined,
    ]) {
      expect(() => assertSkillName(bad)).toThrow(TypeError)
    }
  })

  it('文件名候选：去 .md 后缀并转小写，非法返回 null', () => {
    expect(nameCandidateFromFilename('My-Skill.md')).toBe('my-skill')
    expect(nameCandidateFromFilename('a_b.md')).toBeNull()
    expect(nameCandidateFromFilename('x')).toBe('x')
  })
})

describe('frontmatter 解析', () => {
  it('解析 name/description/whenToUse 与正文', () => {
    const { frontmatter, body } = parseFrontmatter(skillText())
    expect(frontmatter.name).toBe('my-skill')
    expect(frontmatter.description).toBe('测试技能')
    expect(frontmatter['whenToUse']).toBe('测试场景')
    expect(body).toContain('# 正文')
  })

  it('缺失 frontmatter 或闭合行报错', () => {
    expect(() => parseFrontmatter('# no frontmatter')).toThrow(TypeError)
    expect(() => parseFrontmatter('---\nname: x\n')).toThrow(TypeError) // 无闭合 ---
  })

  it('过时驼峰字段被拒绝', () => {
    const text = '---\nname: x\ndescription: d\ndisableModelInvocation: true\n---\nbody'
    expect(() => parseFrontmatter(text)).toThrow(/已弃用/)
  })

  it('布尔字段非法值被拒绝，合法值通过', () => {
    const ok = validateSkill({
      text: '---\nname: x\ndescription: d\nuser-invocable: no\ndisable-model-invocation: yes\n---\nbody',
      expectedName: 'x',
    })
    expect(ok.userInvocable).toBe(false)
    expect(ok.disableModelInvocation).toBe(true)
    expect(() => parseSkillBoolean('user-invocable', 'banana')).toThrow(TypeError)
    expect(() =>
      validateSkill({ text: '---\nname: x\ndescription: d\nuser-invocable: banana\n---\nbody' }),
    ).toThrow(TypeError)
  })
})

describe('validateSkill 完整校验', () => {
  it('缺 description 报错', () => {
    expect(() => validateSkill({ text: '---\nname: x\n---\nbody' })).toThrow(/description/)
  })

  it('name 与期望不一致报错', () => {
    expect(() => validateSkill({ text: skillText('a'), expectedName: 'b' })).toThrow(/不一致/)
  })

  it('非法 name（非 kebab）报错', () => {
    expect(() => validateSkill({ text: '---\nname: A_B\n---\nbody' })).toThrow(/kebab/)
  })

  it('超大体上报错', () => {
    const big = '---\nname: x\ndescription: d\n---\n' + 'a'.repeat(70 * 1024)
    expect(() => validateSkill({ text: big })).toThrow(/大小上限/)
  })

  it('计算 bodyBytes 与 sha256', () => {
    const text = skillText()
    const v = validateSkill({ text, expectedName: 'my-skill' })
    expect(v.bodyBytes).toBe(Buffer.byteLength(text))
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('rewriteSkillName 重命名', () => {
  it('改写 frontmatter name，正文不动；同名无操作', () => {
    const text = skillText('old-name')
    const renamed = rewriteSkillName(text, 'new-name')
    expect(renamed).toContain('name: new-name')
    expect(renamed).toContain('# 正文')
    expect(parseFrontmatter(renamed).frontmatter.name).toBe('new-name')
    expect(rewriteSkillName(text, 'old-name')).toBe(text)
    expect(() => rewriteSkillName(text, 'Bad Name')).toThrow(TypeError)
  })
})

// ---------------------------------------------------------------------------
// skill.service.js
// ---------------------------------------------------------------------------

describe('SkillService', () => {
  it('发布：从卷提取 → 校验 → 入仓 → 列表可见', async () => {
    const { svc } = makeService()
    const text = skillText('pub-skill')
    mockExtract(svc, text)
    const entry = await svc.publish('jabcdef1234567890abcdef1234567890abc', 'pub-skill')
    expect(entry.name).toBe('pub-skill')
    expect(entry.description).toBe('测试技能')
    expect(entry.sharer).toBe('jabcdef1234567890abcdef1234567890abc')
    expect(entry.status).toBeUndefined() // toPublic 不含内部字段

    const list = await svc.list()
    expect(list.map((s) => s.name)).toEqual(['pub-skill'])
    const detail = await svc.detail('pub-skill')
    expect(detail.body).toContain('# 正文')
  })

  it('发布：frontmatter 非法被拒（不入仓）', async () => {
    const { svc } = makeService()
    mockExtract(svc, '---\nname: bad\ndescription:\n---\nbody')
    await expect(svc.publish('addr', 'bad')).rejects.toThrow(BadRequestError)
    await expect(svc.list()).resolves.toEqual([])
  })

  it('发布：容器内找不到技能 → NotFoundError', async () => {
    const { svc } = makeService()
    vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue(
      JSON.stringify({ ok: false, reason: 'not-found', name: 'ghost' }),
    )
    await expect(svc.publish('addr', 'ghost')).rejects.toThrow(NotFoundError)
  })

  it('发布：他人占用同名被拒（防劫持）', async () => {
    const { svc } = makeService()
    mockExtract(svc, skillText('shared-name'))
    await svc.publish('jabcdef1234567890abcdef1234567890aaa', 'shared-name')
    mockExtract(svc, skillText('shared-name'))
    await expect(
      svc.publish('jabcdef1234567890abcdef1234567890bbb', 'shared-name'),
    ).rejects.toThrow(ConflictError)
  })

  it('发布：撞名可 renameTo 改名发布，frontmatter name 同步改写', async () => {
    const { svc } = makeService()
    const authorA = 'jabcdef1234567890abcdef1234567890aaa'
    const authorB = 'jabcdef1234567890abcdef1234567890bbb'
    mockExtract(svc, skillText('shared-name'))
    await svc.publish(authorA, 'shared-name')

    mockExtract(svc, skillText('shared-name'))
    await expect(svc.publish(authorB, 'shared-name')).rejects.toThrow(ConflictError)

    mockExtract(svc, skillText('shared-name'))
    const entry = await svc.publish(authorB, 'shared-name', { renameTo: 'shared-name-v2' })
    expect(entry.name).toBe('shared-name-v2')
    expect(entry.sharer).toBe(authorB)

    const names = (await svc.list()).map((s) => s.name)
    expect(names).toContain('shared-name')
    expect(names).toContain('shared-name-v2')

    // 共享副本自洽：frontmatter name 已被改写为共享名
    const detail = await svc.detail('shared-name-v2')
    expect(parseFrontmatter(detail.body).frontmatter.name).toBe('shared-name-v2')
  })

  it('发布：renameTo 仍与现有技能撞名被拒', async () => {
    const { svc } = makeService()
    const authorA = 'jabcdef1234567890abcdef1234567890aaa'
    const authorB = 'jabcdef1234567890abcdef1234567890bbb'
    mockExtract(svc, skillText('taken-a'))
    await svc.publish(authorA, 'taken-a')
    mockExtract(svc, skillText('taken-a'))
    await expect(svc.publish(authorB, 'taken-a', { renameTo: 'taken-a' })).rejects.toThrow(
      ConflictError,
    )
  })

  it('发布：renameTo 非法命名被拒', async () => {
    const { svc } = makeService()
    mockExtract(svc, skillText('src-name'))
    await expect(
      svc.publish('jabcdef1234567890abcdef1234567890abc', 'src-name', { renameTo: 'Bad Name' }),
    ).rejects.toThrow(TypeError)
  })

  it('发布：自己同名原样重发 = 覆盖更新（不要求改名）', async () => {
    const { svc } = makeService()
    const addr = 'jabcdef1234567890abcdef1234567890ccc'
    mockExtract(svc, skillText('upd'))
    await svc.publish(addr, 'upd')
    mockExtract(svc, skillText('upd', 'note: v2'))
    await svc.publish(addr, 'upd')
    expect((await svc.list()).length).toBe(1)
    expect((await svc.detail('upd')).body).toContain('note: v2')
  })

  it('发布：超过活跃配额被拒', async () => {
    const { svc } = makeService()
    const addr = 'jabcdef1234567890abcdef1234567890ccc'
    for (let i = 0; i < MAX_ACTIVE_PUBLISHED; i++) {
      mockExtract(svc, skillText(`skill-${i}`))
      await svc.publish(addr, `skill-${i}`)
    }
    mockExtract(svc, skillText('one-more'))
    await expect(svc.publish(addr, 'one-more')).rejects.toThrow(BadRequestError)
  })

  it('安装：写入卷 + 记录 installs + 列表标记已安装', async () => {
    const { svc } = makeService()
    const text = skillText('inst-skill')
    mockExtract(svc, text)
    const addr = 'j' + 'a'.repeat(30) // 合法 SWTC 地址（j 后 29-34 位）
    await svc.publish(addr, 'inst-skill')
    vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue(JSON.stringify({ ok: true }))
    const result = await svc.install(addr, 'inst-skill')
    expect(result.installed).toBe(true)
    expect(tenantConfigService.runScript).toHaveBeenCalledWith(addr, 'install-skill.mjs', [
      'inst-skill',
      base64(text),
    ])
    const list = await svc.list({ address: addr })
    expect(list[0].installed).toBe(true)
  })

  it('安装：已下架技能不可安装', async () => {
    const { svc } = makeService()
    mockExtract(svc, skillText('gone'))
    const addr = 'jabcdef1234567890abcdef1234567890eee'
    await svc.publish(addr, 'gone')
    await svc.unpublish(addr, 'gone', { admin: false })
    vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue(JSON.stringify({ ok: true }))
    await expect(svc.install(addr, 'gone')).rejects.toThrow(NotFoundError)
  })

  it('安装：每地址每小时限流', async () => {
    const { svc } = makeService()
    mockExtract(svc, skillText('rate'))
    const addr = 'jabcdef1234567890abcdef1234567890fff'
    await svc.publish(addr, 'rate')
    vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue(JSON.stringify({ ok: true }))
    for (let i = 0; i < 10; i++) await svc.install(addr, 'rate')
    await expect(svc.install(addr, 'rate')).rejects.toThrow(/过于频繁/)
  })

  it('本地导入：写入卷 + source=import + name 不匹配被拒', async () => {
    const { svc } = makeService()
    const addr = 'jabcdef1234567890abcdef1234567890000'
    vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue(JSON.stringify({ ok: true }))
    const res = await svc.importSkill(addr, 'local-tool', skillText('local-tool'))
    expect(res.name).toBe('local-tool')
    const mine = await svc.mine(addr)
    expect(mine.installed[0]).toMatchObject({ name: 'local-tool', source: 'import' })
    await expect(svc.importSkill(addr, 'local-tool', skillText('other-name'))).rejects.toThrow(
      BadRequestError,
    )
  })

  it('mine：返回容器内可共享技能列表（自写 + 导入）', async () => {
    const { svc } = makeService()
    const addr = 'jabcdef1234567890abcdef1234567890aab'
    vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue(
      JSON.stringify({ ok: true, names: ['my-tool', 'my-other'] }),
    )
    const mine = await svc.mine(addr)
    expect(mine.inContainer).toEqual(['my-tool', 'my-other'])
  })

  it('mine：容器列表脚本失败不阻塞（返回空数组）', async () => {
    const { svc } = makeService()
    vi.spyOn(tenantConfigService, 'runScript').mockRejectedValue(new Error('docker down'))
    const mine = await svc.mine('jabcdef1234567890abcdef1234567890aac')
    expect(mine.inContainer).toEqual([])
  })

  it('mineView：免签名个人视图，不调用卷脚本', async () => {
    const { svc } = makeService()
    const addr = 'jabcdef1234567890abcdef1234567890aad'
    // 不 mock runScript：mineView 若误调 docker 会抛错 → 测试失败（回归护栏）
    const view = await svc.mineView(addr)
    expect(view.published).toEqual([])
    expect(view.installed).toEqual([])
    expect(view.inContainer).toBeUndefined()
  })

  it('卸载：删除卷文件并清除安装记录', async () => {
    const { svc } = makeService()
    const addr = 'jabcdef1234567890abcdef1234567890111'
    vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue(JSON.stringify({ ok: true }))
    await svc.importSkill(addr, 'gone2', skillText('gone2'))
    await svc.uninstall(addr, 'gone2')
    expect(tenantConfigService.runScript).toHaveBeenLastCalledWith(addr, 'remove-skill.mjs', [
      'gone2',
    ])
    const mine = await svc.mine(addr)
    expect(mine.installed).toEqual([])
  })

  it('取消共享：作者可删，他人被拒，admin 可代下架', async () => {
    const { svc } = makeService()
    const author = 'jabcdef1234567890abcdef1234567890222'
    const other = 'jabcdef1234567890abcdef1234567890333'
    mockExtract(svc, skillText('auth-skill'))
    await svc.publish(author, 'auth-skill')

    await expect(svc.unpublish(other, 'auth-skill')).rejects.toThrow(ForbiddenError)
    await svc.unpublish(author, 'auth-skill')
    await expect(svc.list()).resolves.toEqual([])
    await expect(svc.detail('auth-skill')).rejects.toThrow(NotFoundError)

    mockExtract(svc, skillText('admin-skill'))
    await svc.publish(author, 'admin-skill')
    await svc.unpublish(other, 'admin-skill', { admin: true })
    await expect(svc.list()).resolves.toEqual([])
  })

  it('取消共享后个人视图即消失；再发布同名可恢复（回归：mineView 不再返回已下架）', async () => {
    const { dir, svc } = makeService()
    const author = 'jabcdef1234567890abcdef1234567890444'
    mockExtract(svc, skillText('re-share'))
    await svc.publish(author, 're-share')
    await svc.unpublish(author, 're-share')
    // 市场与"我的共享"都不再出现该技能；共享仓数据被彻底删除
    await expect(svc.list()).resolves.toEqual([])
    const view = await svc.mineView(author)
    expect(view.published).toEqual([])
    expect(existsSync(join(dir, 'store', 're-share'))).toBe(false)
    // 二次取消 → 条目已不存在
    await expect(svc.unpublish(author, 're-share')).rejects.toThrow(NotFoundError)
    // 同名再发布 → 全新条目，恢复 active
    mockExtract(svc, skillText('re-share'))
    await svc.publish(author, 're-share')
    const view2 = await svc.mineView(author)
    expect(view2.published.map((s) => s.name)).toEqual(['re-share'])
    await expect(svc.list()).resolves.toHaveLength(1)
  })

  it('mine：发布者视角与安装更新提示', async () => {
    const { svc } = makeService()
    const addr = 'jabcdef1234567890abcdef1234567890444'
    mockExtract(svc, skillText('mine-skill'))
    await svc.publish(addr, 'mine-skill')
    const mine = await svc.mine(addr)
    expect(mine.published.map((p) => p.name)).toEqual(['mine-skill'])
  })
})
