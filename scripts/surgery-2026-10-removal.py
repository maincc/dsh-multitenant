# 一次性拆除脚本（CWT + DID/VC 渠道，2026-10 大拆除）。
# 全部断言先行，任一 marker 不匹配即整体不写盘。
import sys

FILES = {}

def load(p):
    if p not in FILES:
        FILES[p] = open(p).read().splitlines(keepends=True)
    return FILES[p]

def find(lines, sub, frm=0):
    for i in range(frm, len(lines)):
        if sub in lines[i]:
            return i
    raise AssertionError(f'未找到 marker: {sub!r}')

def cut(lines, a, b):  # inclusive, 0-based
    return lines[:a] + lines[b + 1 :]

def rm_line(lines, marker):
    a = find(lines, marker)
    return cut(lines, a, a)

# ───────────────────────── src/routes/user.routes.js ─────────────────────────
p = 'src/routes/user.routes.js'
L = load(p)
a = find(L, '// POST /api/user/cwt/apply -')
b = find(L, '// ── 用户中心钱包签名登录')
L = cut(L, a, b - 1)
for m, stop in [
    ('POST /api/user/vc-claim-ack', '「升级我的凭证」'),
    ('POST /api/user/vc-upgrade', 'GET /api/user/cwt/status'),
    ('GET /api/user/cwt/status', 'GET /api/user/session-info'),
    ('POST /api/cwt/gateway-enter', 'POST /api/user/config-challenge'),
]:
    a = find(L, m)
    b = find(L, stop)
    L = cut(L, a, b - 1)
L = rm_line(L, 'userService.autoMintOnLogin(addrLower)')
for m in ['import { cwtAdminService }', 'import { cwtService }', 'import { cwtStore }']:
    L = rm_line(L, m)
FILES[p] = L

# ───────────────────────── src/routes/admin.routes.js ─────────────────────────
p = 'src/routes/admin.routes.js'
L = load(p)
a = find(L, '// GET /api/admin/cwt/applications -')
b = find(L, '// POST /api/admin/delete-volume/:address')
L = cut(L, a, b - 1)
L = rm_line(L, 'import { vcUrn }')
L = rm_line(L, 'import { cwtAdminService }')
FILES[p] = L

# ───────────────────────── src/services/user.service.js ─────────────────────────
p = 'src/services/user.service.js'
L = load(p)
# VC 方法群：_maybeMintVc（doc 开头）→ reconcileVcShelf 尾（} + 空行）
a = find(L, '首登自动铸基础卡（did-vc-runbook 步骤3') - 1
b = find(L, 'return { removedExpired, removedOrphan, repaired }') + 2
L = cut(L, a, b)
# isUsageExempt 方法（doc → } + 空行）
a = find(L, 'CWT 授权用户豁免每日限时') - 1
b = find(L, 'return Boolean(user && (user.cwtAuthorizedAt') + 2
L = cut(L, a, b)
L = rm_line(L, 'this._maybeMintVc(address) //')
for m in ['import { vcUrn }', 'import { cwtStore }', 'import { isIssuerEnabled }']:
    L = rm_line(L, m)
a = find(L, '注：CWT 数据（cwtRegistry')
L = cut(L, a, a + 1)
L = [l for l in L if 'if (this.isUsageExempt(address)) return' not in l]
# tier 查表两行注释 + tierCfg + 不限短路
a = find(L, '★步骤4（ADR-17 tier 查表）')
b = find(L, 'if (tierCfg.dailyMinutes === null) return // 升级卡=不限')
L = cut(L, a, b)
txt = ''.join(L)
assert 'const limit = cfg.dailyMinutes ?? tierCfg.dailyMinutes' in txt
txt = txt.replace(
    'const limit = cfg.dailyMinutes ?? tierCfg.dailyMinutes', 'const limit = cfg.dailyMinutes'
)
txt = txt.replace('（CWT 授权豁免、开关关闭则放行）', '（开关关闭则放行）')
txt = txt.replace('，请明日再试，或完成 CWT 验证解锁', '，请明日再试')
FILES[p] = txt.splitlines(keepends=True)

# ───────────────────────── src/routes/tenant.routes.js ─────────────────────────
p = 'src/routes/tenant.routes.js'
L = load(p)
a = find(L, 'const idle = Date.now() - user.lastSeenAt')
b = find(L, 'exempt || tierUnlimited || limit === null')
assert a < b
newblock = (
    '    const idle = Date.now() - user.lastSeenAt\n'
    '    const usageCfg = userService.usageLimitConfig()\n'
    '    const used = userService.getUsedMinutes(address)\n'
    '    // 权益判定与凭证体系解耦（2026-10 大拆除）：全员统一按 usageLimit 默认档\n'
    '    const limit = usageCfg.enabled ? usageCfg.dailyMinutes : null\n'
    '    const unlimited = limit === null || !Number.isFinite(limit) || limit <= 0\n'
).splitlines(keepends=True)
L = L[:a] + newblock + L[b + 1 :]
# tier 恒 1 + credential 投影块删除
a = find(L, "tier: user.vc && user.vc.status !== 'revoked'")
assert '// 凭证摘要（用户中心' in L[a + 1]
c = find(L, ': null,', a)  # credential: … ? {…} : null,
L = cut(L, a + 1, c)
L[a] = '        tier: 1,\n'
txt = ''.join(L)
txt = txt.replace('请明日再试，或完成 CWT 验证解锁', '请明日再试')
FILES[p] = txt.splitlines(keepends=True)

# ───────────────────────── src/server.js ─────────────────────────
p = 'src/server.js'
L = load(p)
# 定时器函数（doc → console.log 尾行 + } + 空行）
a = find(L, '启动凭证货架对账定时器') - 1
b = find(L, '[vc] 货架对账定时器启动') + 2
L = cut(L, a, b)
L = rm_line(L, '  startVcReconcileTimer()')
L = rm_line(L, "import { cwtStore } from './services/cwt.store.js'")
L = rm_line(L, 'await cwtStore.init()')
txt = ''.join(L)
assert "path.startsWith('/api/cwt/')" in txt
txt = txt.replace(
    "      path.startsWith('/api/upgrade/') ||\n      path.startsWith('/api/cwt/')\n",
    "      path.startsWith('/api/upgrade/')\n",
)
txt = txt.replace(
    ', daily limit ${minutes}min, CWT authorized users exempt',
    ', daily limit ${minutes}min',
)
FILES[p] = txt.splitlines(keepends=True)

# ───────────────────────── src/config/config.js ─────────────────────────
p = 'src/config/config.js'
L = load(p)
a = find(L, '  cwt: {')
b = find(L, 'maxTokenBytes: 8192,')
b2 = find(L, '  },', b)
L = cut(L, a, b2)
a = find(L, '// ── DID/VC 签发侧')
b = find(L, '  docker: {')
L = cut(L, a, b - 1)
txt = ''.join(L)
txt = txt.replace('（分钟），CWT 授权用户豁免', '（分钟）')
FILES[p] = txt.splitlines(keepends=True)

# ───────────────────────── src/middleware/admin-signature.middleware.js ─────────────────────────
p = 'src/middleware/admin-signature.middleware.js'
L = load(p)
txt = ''.join(L)
for op in ["'cwt/approve',", "'cwt/reject',", "'cwt/revoke',", "'vc/revoke',", "'vc/restripe',", "'vc/reconcile',"]:
    s = f'  {op}\n'
    assert s in txt, op
    txt = txt.replace(s, '')
L = txt.splitlines(keepends=True)
a = find(L, "case 'cwt/approve':")
b = find(L, 'return addr && tier ? `vc/restripe:address=${addr}:tier=${tier}` : null') + 1
L = cut(L, a, b)
FILES[p] = L

# ───────────────────────── src/services/data.service.js ─────────────────────────
p = 'src/services/data.service.js'
L = load(p)
for m in ["this.cwtFilePath('registry.json'),", "this.cwtFilePath('applications.json'),", "this.cwtFilePath('records.log'),"]:
    L = rm_line(L, m)
L = rm_line(L, "mkdirSync(join(this.dataDir, 'cwt')")
# stripLegacyCwt（doc → 方法尾}）
a = find(L, '移除 state.json 中的 CWT 旧块') - 1
b = find(L, 'this.writeWithLock(this.stateFile, s)') + 2
L = cut(L, a, b)
# CWT 数据节（节注释 → readCwtRecords 尾；止于「原子写入 JSON」doc 前空行）
a = find(L, '// ---------- CWT 数据')
b = find(L, '   * 原子写入 JSON') - 2
L = cut(L, a, b)
txt = ''.join(L)
assert 'cwtFilePath' not in txt, 'cwtFilePath 残留'
txt = txt.replace(
    '/** 审计日志轮转阈值（字节）；超过则由 appendCwtRecord 归档为 records.log.1 */',
    '/** 审计日志轮转阈值（字节） */',
)
assert 'recordsMaxBytes' in txt
L = txt.splitlines(keepends=True)
L = rm_line(L, 'this.recordsMaxBytes = RECORDS_MAX_BYTES')
L = rm_line(L, 'const RECORDS_MAX_BYTES')
FILES[p] = L

# ───────────────────────── src/services/mongo.store.js ─────────────────────────
p = 'src/services/mongo.store.js'
L = load(p)
L = rm_line(L, "'cwt_registry',")
L = rm_line(L, "'cwt_applications',")
a = find(L, '  cwt_applications: [')
b = find(L, '  ],', a)
L = cut(L, a, b)
txt = ''.join(L)
txt = txt.replace('设计 §4.1 定稿的 9 集合', '设计 §4.1 定稿的 9 集合（2026-10 大拆除后 7）')
FILES[p] = txt.splitlines(keepends=True)

# ───────────────────────── src/services/state.store.js ─────────────────────────
p = 'src/services/state.store.js'
L = load(p)
L = rm_line(L, "  'vc', //")
L = rm_line(L, "'cwtVerifiedAt',")
L = rm_line(L, "'cwtAuthorizedAt',")
txt = ''.join(L)
txt = txt.replace('、迁移回填的 cwtVerifiedAt 初值属 CWT 域——', '——')
FILES[p] = txt.splitlines(keepends=True)

# ───────────────────────── src/services/migration.js ─────────────────────────
p = 'src/services/migration.js'
L = load(p)
for m in ['cwtRegistry: {},', 'cwtApplications: [],', 'cwtRecords: [],']:
    L = rm_line(L, m)
for m in [
    "s.cwtRegistry = readJsonAt(root, 'data/cwt/registry.json')",
    "s.cwtApplications = readJsonAt(root, 'data/cwt/applications.json')",
    "s.cwtRecords = readNdjsonAt(root, 'data/cwt/records.log')",
    'const reg = s.cwtRegistry[addr]',
]:
    L = rm_line(L, m)
a = find(L, '// 豁免运行标记：M2 水合合同')
b = find(L, 'cwtVerifiedAt: reg &&')
L = cut(L, a, b)
a = find(L, 'const cwt_registry = Object.entries')
b = find(L, '  }))', a)
L = cut(L, a, b)
L = rm_line(L, "...(s.cwtRecords ?? []).map((r) => ({ ...r, kind: 'cwt', at: toDate(r.at) })),")
L = rm_line(L, '    cwt_registry,')
L = rm_line(L, '    cwt_applications,')
txt = ''.join(L)
assert 'cwt' not in txt.lower(), 'migration.js 仍有 cwt 残留'
FILES[p] = txt.splitlines(keepends=True)

# ───────────────────────── 落盘 ─────────────────────────
for p, L in FILES.items():
    open(p, 'w').write(''.join(L))
    print('已写:', p)
print('全部断言通过，共', len(FILES), '个文件')
