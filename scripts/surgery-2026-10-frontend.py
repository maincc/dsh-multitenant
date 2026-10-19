# 前端拆除脚本 v2（断言先行，全成才写盘）
FILES = {}

def load(p):
    if p not in FILES:
        FILES[p] = open(p).read().splitlines(keepends=True)
    return FILES[p]

def find(lines, sub, frm=0):
    for i in range(frm, len(lines)):
        if sub in lines[i]:
            return i
    raise AssertionError(f'未找到: {sub!r}')

def cut(lines, a, b):
    return lines[:a] + lines[b + 1 :]

def rm(lines, marker):
    a = find(lines, marker)
    return cut(lines, a, a)

def rm_to(lines, start_sub, stop_sub):  # 半开 [start, stop)——stop 行保留！
    a = find(lines, start_sub)
    b = find(lines, stop_sub, a + 1)
    return cut(lines, a, b - 1)

def rm_block(lines, func_anchor, stop_sub, back=8):
    """删 [该函数的 /** 文档起始, stop_sub)。从 func_anchor 行回看 back 行找 /**。"""
    a = find(lines, func_anchor)
    s = a
    for i in range(a, max(-1, a - back), -1):
        if lines[i].strip().startswith('/**'):
            s = i
            break
    b = find(lines, stop_sub, a + 1)
    return cut(lines, s, b - 1)

def rm_tab(lines, key):
    a = find(lines, f"    key: '{key}',") - 1
    b = a
    while lines[b].rstrip() != '  },':
        b += 1
    return cut(lines, a, b)

def rm_template_block(lines, tab, next_tab=None, next_is_else=True):
    """删 [本块注释行, 下一块注释行)；下一块锚点用 activeTab div 行（唯一）。"""
    dv = find(lines, f"v-else-if=\"activeTab === '{tab}'\"")
    start = dv - 1
    if next_tab:
        dv2 = find(lines, f"v-else-if=\"activeTab === '{next_tab}'\"", dv)
    else:
        dv2 = find(lines, '<div v-else class="tab-content">', dv)
    stop = dv2 - 1  # 下一块的注释行（保留）
    assert '══' in lines[start] or '<!--' in lines[start], f'{tab} 块起点不是注释行: {lines[start]!r}'
    return cut(lines, start, stop - 1)

# ══════════════════════════ UserCenter.vue ══════════════════════════
p = 'frontend/src/views/UserCenter.vue'
L = load(p)
L = rm_template_block(L, 'identity', next_tab='cwt')
L = rm_template_block(L, 'cwt', next_tab=None, next_is_else=True)
L = rm_tab(L, 'identity')
L = rm_tab(L, 'cwt')
L = rm(L, '  signFileBytes,')
L = rm(L, '  getIpfsPublicKey,')
# 数字身份 ref 群 + copyText/bytesToB64 + acquire/download/apply/claim 全链 → 直到 loginAttempted
L = rm_to(L, '// ---- 数字身份（VC）tab', 'const loginAttempted = ref(false)')
# manualRelogin + identityTimer + refreshIdentity + onIdentityVisible → 直到 fetchUsage
L = rm_to(L, 'const manualRelogin = async () => {', 'const fetchUsage = async (address) => {')
# CWT 脚本段 → 直到模型配置
L = rm_to(L, '// ---- CWT 验证状态', '// ---- 模型配置')
# 断线重置流里的 cwt 缓存清理（fetchCwtStatus 定义段已删）
L = [l for l in L if 'cwtStatus.value = null' not in l]
L = [l for l in L if 'fetchCwtStatus(' not in l]
# fetchUsage 去 identityInfo/claimState（保留 usage 与 sessionLost 自动登录逻辑）
txt = ''.join(L)
fu_old = (
    '  try {\n'
    "    const res = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)\n"
    '    usageInfo.value = res.data.usage || null\n'
    '    identityInfo.value = {\n'
    '      credential: res.data.credential ?? null,\n'
    '      tier: res.data.tier ?? 1,\n'
    '      // 会话失效时 connect-status 走非本人隐私门分支（无 tier 字段）——不是"没有凭证"\n'
    "      sessionLost: res.data.exists === true && !('tier' in res.data),\n"
    '    }\n'
)
fu_new = (
    '  try {\n'
    '    const res = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)\n'
    '    usageInfo.value = res.data.usage || null\n'
)
assert fu_old in txt, 'fetchUsage 头部形状不符'
txt = txt.replace(fu_old, fu_new)
txt = txt.replace(
    "    if (res.data.credential?.claimedAt && claimState.value === 'idle') claimState.value = 'done' // 账本恢复领取态\n",
    '',
)
txt = txt.replace('    usageInfo.value = null\n    identityInfo.value = null\n', '    usageInfo.value = null\n')
L = txt.splitlines(keepends=True)
# onMounted / onUnmounted 接线
L = rm(L, 'identityTimer = setInterval(refreshIdentity')
L = rm(L, "document.addEventListener('visibilitychange', onIdentityVisible)")
L = rm(L, 'if (identityTimer) clearInterval(identityTimer)')
L = rm(L, "document.removeEventListener('visibilitychange', onIdentityVisible)")
import re
txt = ''.join(L)
for m in re.finditer(
    r'identityInfo|claimCredential|acquireCredential|refreshIdentity|signFileBytes|getIpfsPublicKey|cwtStatus|fetchCwtStatus|applyCwt|manualRelogin|identityTimer|onIdentityVisible',
    txt,
):
    ln = txt[: m.start()].count('\n') + 1
    raise AssertionError(f'UserCenter:{ln} 残留 {m.group()}: {txt.splitlines()[ln-1].strip()[:70]}')
FILES[p] = L

# ══════════════════════════ AdminPanel.vue ══════════════════════════
p = 'frontend/src/views/AdminPanel.vue'
L = load(p)
L = rm_to(L, '<!-- ════════ CWT 授权 ════════ -->', '<!-- ════════ DSH 版本管理 ════════ -->')
L = rm_tab(L, 'cwt')
L = rm_to(L, '// CWT 授权管理（M1）', '// ---- DSH 版本管理')
L = rm(L, 'const expandedToken = ref(null)')
a = find(L, '// CWT 数据跟随主刷新')
L = cut(L, a, a + 1)
# vc 账本：doc(/**) + vcList..reconcileNow + watch(→cwt) → 直到 adminLogin
L = rm_block(L, 'const vcList = ref([])', 'const adminLogin = async () => {')
# CWT 管理段：节注释 → upgradeUser（保 shortAddr/fmtTime/actionBadge/toggleToken 前缀? actionBadge/toggleToken 也属 CWT）
L = rm(L, '// ---------- CWT 授权管理（M1） ----------')
# actionBadge/toggleToken 仅服务 cwt 记录模板（已删）→ 一并删；但 shortAddr/fmtTime 他页用 → 保留
L = rm_to(L, 'const actionBadge = (action) =>', 'const fetchCwtData =')
L = rm_to(L, 'const fetchCwtData = async () => {', 'const upgradeUser = async (address, tier) => {')
txt = ''.join(L)
for m in re.finditer(
    r'vcList|vcAction|reconcileNow|fetchCwtData|approveCwt|rejectCwt|revokeCwt|cwtApplications|cwtRegistry|cwtRecords|loadVcList|expandedToken',
    txt,
):
    ln = txt[: m.start()].count('\n') + 1
    raise AssertionError(f'AdminPanel:{ln} 残留 {m.group()}: {txt.splitlines()[ln-1].strip()[:70]}')
assert 'const shortAddr =' in txt and 'const fmtTime =' in txt, 'shortAddr/fmtTime 误删'
FILES[p] = L

# ══════════════════════════ Home.vue ══════════════════════════
p = 'frontend/src/views/Home.vue'
L = load(p)
if any('cwt' in l.lower() for l in L):
    L = rm(L, "cwt: $t('home.guide.step3.cwtLabel'),")
FILES[p] = L

for p, L in FILES.items():
    open(p, 'w').write(''.join(L))
    print('已写:', p)
print('前端手术 v2 完成')
