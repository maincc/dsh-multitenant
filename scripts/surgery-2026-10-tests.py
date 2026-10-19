# 测试层拆除脚本（CWT + VC 联动，2026-10 大拆除）。断言先行，全成才写盘。

FILES = {}

def load(p):
    if p not in FILES:
        FILES[p] = open(p).read().splitlines(keepends=True)
    return FILES[p]

def find(lines, sub, frm=0):
    for i in range(frm, len(lines)):
        if sub in lines[i]:
            return i
    raise AssertionError(f'未找到: {sub!r} in file')

def cut(lines, a, b):
    return lines[:a] + lines[b + 1 :]

def rm(lines, marker):
    a = find(lines, marker)
    return cut(lines, a, a)

def rm_block(lines, start_marker, end_marker):
    a = find(lines, start_marker)
    b = find(lines, end_marker, a)
    return cut(lines, a, b)

def rm_case(lines, title_sub):
    """删除 it('title…', …) 整个用例：从 it( 行到首个 '  })' 行（含），并吃掉后面空行。"""
    a = find(lines, title_sub)
    b = find(lines, '  })', a)
    if b + 1 < len(lines) and lines[b + 1].strip() == '':
        b += 1
    return cut(lines, a, b)

# ════════════ test/usage-limit.test.js ════════════
p = 'test/usage-limit.test.js'
L = load(p)
L = rm_case(L, "it('isUsageExempt：cwtAuthorizedAt")
L = rm_case(L, "it('ensureUsageAllowed：豁免用户超限也放行'")
L = rm_case(L, "it('checkUsageLimitAndStop：豁免用户不停'")
FILES[p] = L

# ════════════ test/config-test-guard.test.js ════════════
p = 'test/config-test-guard.test.js'
txt = ''.join(load(p))
assert 'expect(CONFIG.vc).toBeTruthy()' in txt
txt = txt.replace(
    "it('降档不破坏其他 config 域（vc/shelf 仍在）', () => {\n    expect(CONFIG.vc).toBeTruthy()\n    expect(typeof CONFIG.vc.namespace).toBe('string')",
    "it('降档不破坏其他 config 域（usageLimit/tiers 仍在）', () => {\n    expect(CONFIG.usageLimit).toBeTruthy()\n    expect(CONFIG.tiers).toBeTruthy()",
)
FILES[p] = txt.splitlines(keepends=True)

# ════════════ test/mongo-store.test.js ════════════
p = 'test/mongo-store.test.js'
L = load(p)
txt = ''.join(L)
txt = txt.replace(
    "it('集合合同锁定为设计定稿的 9 个', () => {\n    expect(COLLECTIONS).toHaveLength(9)",
    "it('集合合同锁定为设计定稿的 7 个（2026-10 大拆除后）', () => {\n    expect(COLLECTIONS).toHaveLength(7)",
)
L = txt.splitlines(keepends=True)
L = rm(L, "        'cwt_applications',\n".rstrip()) if False else L
L = rm(L, "'cwt_applications',")
L = rm(L, "'cwt_registry',")
L = rm(L, "expect(COLLECTIONS).not.toContain('cwt_records')")
a = find(L, "it('事务提交：多文档原子落库'")
b = a
while L[b].rstrip() != '  })':
    b += 1
newtx = (
    "  it('事务提交：多文档原子落库', async (ctx) => {\n"
    "    if (!skip(ctx)) return\n"
    "    if ((await store.health()).topology !== 'replset') return ctx.skip()\n"
    "    await store.withTransaction(async (session) => {\n"
    "      await store.col('audit').insertOne({ _id: 'jtx', kind: 'ops', at: new Date() }, { session })\n"
    "      await store\n"
    "        .col('users')\n"
    "        .updateOne({ _id: 'jtx' }, { $set: { tier: 9 } }, { upsert: true, session })\n"
    "    })\n"
    "    expect(await store.count('audit', { _id: 'jtx' })).toBe(1)\n"
    "    expect(await store.count('users', { _id: 'jtx' })).toBe(1)\n"
    "  })\n"
).splitlines(keepends=True)
L = L[:a] + newtx + L[b + 1 :]
FILES[p] = L

# ════════════ test/state-store.test.js ════════════
p = 'test/state-store.test.js'
L = load(p)
txt = ''.join(L)
txt = txt.replace("jb: { port: 31002, containerStatus: 'stopped', cwtAuthorizedAt: 999 }", "jb: { port: 31002, containerStatus: 'stopped', pinnedImage: 'img:jb' }")
txt = txt.replace('expect(back.swtcUsers.jb.cwtAuthorizedAt).toBe(999)', "expect(back.swtcUsers.jb.pinnedImage).toBe('img:jb')")
txt = txt.replace(
    '    // cwt-admin 往缓存写的标记字段——漏一个，重启水合就丢、下次存盘还 $unset\n    expect(USER_OWNED_FIELDS).toContain(\'cwtAuthorizedAt\')\n    expect(USER_OWNED_FIELDS).toContain(\'cwtVerifiedAt\')\n',
    '    // 缓存往 user 写的标记字段——漏一个，重启水合就丢、下次存盘还 $unset\n',
)
txt = txt.replace(
    '{ $set: { profile: { nickname: \'keepme\' }, cwtVerifiedAt: 777 } }',
    "{ $set: { profile: { nickname: 'keepme' }, legacyMarker: 777 } }",
)
txt = txt.replace(
    "    // cwtVerifiedAt 在 USER_OWNED（缓存权威）但 fixture 没带 → 按纪律 $unset 传播\n    expect(ja.cwtVerifiedAt).toBe(undefined)",
    '    // 白名单外的库侧字段：扇出既不抹也不改\n    expect(ja.legacyMarker).toBe(777)',
)
txt = txt.replace('（profile/迁移回填值）', '（profile/历史遗留值）')
FILES[p] = txt.splitlines(keepends=True)

# ════════════ test/migration.test.js ════════════
p = 'test/migration.test.js'
L = load(p)
L = rm_block(L, '  cwtRegistry: {', '  cwtRecords: [{ address: \'jbbb\', action: \'approve\', at: 555, by: \'jaaa\' }],')
txt = ''.join(L)
txt = txt.replace(
    "it('users：profile 并入 + cwtVerifiedAt 只认 approved + 缺字段归 null'",
    "it('users：profile 并入 + pinnedImage 保留 + 缺字段归 null'",
)
txt = txt.replace('    expect(a.cwtVerifiedAt).toBe(777) // approved 的 approvedAt 冗余\n', '')
txt = txt.replace('    expect(b.cwtVerifiedAt).toBe(null) // revoked 不算\n', '')
txt = txt.replace("it('audit：双日志合一，时间归 at（Date，ttl_90d 生效前提），ops 拉平 actor（P6）'", "it('audit：ops 日志入表，时间归 at（Date，ttl_90d 生效前提），拉平 actor（P6）'")
txt = txt.replace('expect(audit).toHaveLength(2)', 'expect(audit).toHaveLength(1)')
txt = txt.replace('    const cwt = audit.find((a) => a.kind === \'cwt\')\n    expect(Number(cwt.at)).toBe(555)\n', '')
txt = txt.replace(
    "it('expectedCounts 覆盖 9 集合并求和', () => {\n    const counts = expectedCounts(buildCollections(fx()))\n    expect(Object.keys(counts)).toHaveLength(9)\n    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(2 + 4 + 3 + 2 + 1 + 2 + 1 + 1 + 1)",
    "it('expectedCounts 覆盖 7 集合并求和', () => {\n    const counts = expectedCounts(buildCollections(fx()))\n    expect(Object.keys(counts)).toHaveLength(7)\n    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(2 + 4 + 3 + 2 + 1 + 1 + 1)",
)
txt = txt.replace('        cwt_registry: 0,\n        cwt_applications: 0,\n', '')
txt = txt.replace("      mkdirSync(join(dir, 'data', 'cwt'), { recursive: true })\n", '')
txt = txt.replace('      writeFileSync(join(dir, \'data\', \'cwt\', \'records.log\'), \'{"address":"ja1","at":7}\\n坏行不炸\\n\')\n', '')
txt = txt.replace('      expect(c.audit).toHaveLength(1)', '      expect(c.audit).toHaveLength(0)')
txt = txt.replace('    expect(schema.sourceStats.cwt_registry).toBe(2)\n', '')
txt = txt.replace('    expect(a.cwtVerifiedAt).toBe(777)\n', "    expect(a.profile).toEqual({ nickname: 'me' })\n")
txt = txt.replace(
    "    broken.cwtApplications = [\n      { id: 'dup', status: 'pending' },\n      { id: 'dup', status: 'pending' },\n    ]",
    "    broken.skillsIndex = { entries: [{ name: 'dup', version: 1 }, { name: 'dup', version: 2 }] }",
)
txt = txt.replace(
    "for (const name of ['users', 'sessions', 'audit', 'cwt_applications', 'meta']) {",
    "for (const name of ['users', 'sessions', 'audit', 'skills', 'meta']) {",
)
FILES[p] = txt.splitlines(keepends=True)

# ════════════ test/admin-signature.test.js ════════════
p = 'test/admin-signature.test.js'
L = load(p)
L = rm(L, "import { cwtAdminService }")
for m in ['loadCwtRegistry:', 'loadCwtApplications:', 'saveCwtRegistry:', 'saveCwtApplications:']:
    L = rm(L, m)
a = find(L, "vi.mock('../src/services/cwt-admin.service.js'")
b = find(L, '}))', a)
L = cut(L, a, b)
L = rm_case(L, "it('cwt/approve 绑定申请 id（非地址）'")
L = rm_case(L, "it('cwt/revoke 绑定地址'")
txt = ''.join(L)
txt = txt.replace("describe('收口：CWT 审批 + 孤儿卷清理也要求当场签名', () => {", "describe('收口：孤儿卷清理要求当场签名', () => {")
# callCwtApprove 辅助函数整体删除（精确行尾匹配防 '  }' 子串误伤）
B = txt.splitlines(keepends=True)
a = find(B, '  async function callCwtApprove')
b = a
while B[b].rstrip() != '  }':
    b += 1
B = cut(B, a, b)
L = rm_case(B, "it('CWT approve：只有会话无签名")
L = rm_case(L, "it('CWT approve：签名正确")
L = rm_case(L, "it('CWT approve：签 app-2 却执行 app-3")
FILES[p] = L

# ════════════ test/routes.test.js ════════════
p = 'test/routes.test.js'
L = load(p)
a = find(L, '// ---------- CWT 申请防洪泛（P1-7） ----------')
b = find(L, "expect(JSON.parse(last.body).code).toBe('RATE_LIMITED')")
b = find(L, '  })', b)
L = cut(L, a, b)
txt = ''.join(L)
txt = txt.replace(
    '    loadCwtRegistry: vi.fn(() => ({})),\n    loadCwtApplications: vi.fn(() => []),\n',
    '',
)
txt = txt.replace('    saveCwtRegistry: vi.fn(() => {}),\n', '')
txt = txt.replace('    saveCwtApplications: vi.fn(() => {}),\n', '')
txt = txt.replace('同时保留 loadCwt* 等只读方法的行为（routes.test.js 不涉及 CWT 用例，空值即可）', '只读探测方法置空即可')
txt = txt.replace('create(address, ttl) 使用自定义 TTL（CWT 入场 30min）', 'create(address, ttl) 使用自定义 TTL')
FILES[p] = txt.splitlines(keepends=True)

# ── usage-limit 头注释补丁 ──
p = 'test/usage-limit.test.js'
L = rm(FILES[p], '*   - isUsageExempt：CWT 授权/验证用户豁免')
txt = ''.join(L)
txt = txt.replace('超限抛 USAGE_LIMIT_REACHED、豁免放行、开关关闭放行', '超限抛 USAGE_LIMIT_REACHED、开关关闭放行')
txt = txt.replace('超限优雅停止、豁免不停、未超限不停', '超限优雅停止、未超限不停')
FILES[p] = txt.splitlines(keepends=True)

# ════════════ 断言零残留 ════════════
import re
for p, L in FILES.items():
    t = ''.join(L)
    for m in re.finditer(r'(?i)cwt', t):
        line = t[:m.start()].count('\n') + 1
        raise AssertionError(f'{p}:{line} 仍有 cwt 引用: {t.splitlines()[line-1].strip()[:60]}')
for p, L in FILES.items():
    open(p, 'w').write(''.join(L))
    print('已写:', p)
print('测试层手术完成')
