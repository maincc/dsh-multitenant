# 巨型文件拆分方案（技术债清偿）

> 状态：§P1 §P2 ✅（2026-11-24 落地，判例 59/60 入册）｜§P3 ⏸ 暂缓（2026-11-24 用户裁定：移动端仍在活跃改动 UserCenter.vue，等移动 tab 合回稳定后另立窗口启动——§五 红线生效）
> 目标文件：`user.service.js`(3281) / `admin.routes.js`(2007) / `UserCenter.vue`(4106) / `AdminPanel.vue`(4084)
> 上位纪律：五条判权不变量（README）不动；判例 58"半拉子不对称"是本方案要**结构性根除**的对象——
> 用结构保证代替"修一条先 grep 孪生面"的人肉纪律。

## 〇、前提修正（2026-11 实测）

审查时点与现状有出入，先钉正，防止方案打空靶：

| 先前论断                           | 实测现状                                                                                                                       | 结论                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| signAdminOperation 有 4 份手工副本 | 已收敛 `frontend/src/api/adminSign.js` 单实现；AdminPanel 内仅剩薄封装（加 hasCCDAO 判断 + 错误友好化，`AdminPanel.vue:1866`） | P3"三份孪生收敛"**已完结**，不再立项 |
| 前端无统一 API 层                  | `api/` 已有 connect/skills/wallet/adminSign 四件，但 views+components 仍有 **84 处**、mobile 仍有 **41 处** axios 直调         | 立项（§4.3）                         |
| `friendlyPluginError` 单点         | `UserCenter.vue:1810` 与 `AdminPanel.vue` 各一份（后者被 sign 封装调用）                                                       | 孪生，随 §4.1 收编                   |

真正的结构性风险残余 = **路由守卫逐分支手挂**（§2）+ **单体 service 状态揉团**（§3）+ **巨型视图孪生温床**（§4）。

## 一、总原则（每个 commit 都守）

1. **搬运与改语义分离**：任何 commit 只做"纯移动 + 重导出"或只做语义改动，绝不混装——
   revert 单点化，出问题一眼定位。
2. **每步全绿**：1035 用例（63 文件，实测 90s）是 pre-commit 硬闸；拆分过程中它同时是
   行为不变的证明。禁止"先拆完再修测试"。
3. **门面稳定**：`user.service.js` / `handleAdminRoutes` 的对外 import 签名不变——
   26 个测试文件引用 userService（静态 import 18 + 动态 4 + 仅 vi.mock 5）、9 个 import 路由 handler，一个都不改它们的 import。（P2 审查 L5 订正计数）
4. **默认拒绝**：新结构必须让"漏加守卫"从*会被遗忘*变成*不可能编译/通不过测试*（§2.2）。
5. **不动判权语义**：凭证链路、签名用途绑定、cookie 剥离逻辑原样搬运；行号变了但
   `git log --follow` 可追。凡搬运块，文件头保留原注释（含事故判例援引）。

## 二、P1 后端路由 → 守卫注册表（最高优先，直接根除 S1 级漏洞模式）

### 2.1 现状证据

- `admin.routes.js` 2007 行 / **41 个 if-path 分支**，`requireAdmin` 30+ 处逐分支手挂；
- 已存在两种返回风格混用：绝大多数 `return true`，但 `:578/:593` 是裸 `return`——
  今天无害（`requireAdmin` 拒绝时必已写响应，`auth.middleware.js:36-44`），但它依赖
  "上一个守卫一定写过响应"这条**隐式约定**，哪天换个不写响应的守卫就是 fallthrough；
- 2026-11-10 审计 S1 的成因正是"2026-10 大加固逐条补守卫，user.routes 补了、
  skill.routes 两条 GET 漏了"——41+25 分支的 if 链里，漏挂是概率必然。

### 2.2 目标结构

```
src/routes/
├── registry.js                 # ~80 行：路由表 + dispatch
└── admin/
    ├── index.js                # 汇总导出 handleAdminRoutes（签名不变）
    ├── users.routes.js         # /api/users /api/stats /promote /demote /force-stop…
    ├── volumes.routes.js       # orphan-volumes / cleanup / delete-volume / disk-scan
    ├── cwt.routes.js           # cwt-applications 及审批
    ├── env.routes.js           # env-commit/publish/revoke/apply/inventory/browse/scan/reject
    ├── dsh.routes.js           # dsh/* 全家（现 1293-2007，~700 行，本就是一域）
    └── session.routes.js       # challenge/login/logout/check/tenant-url/gateway-ports
```

注册表契约（核心是**守卫必填、default-deny**）：

```js
// registry.js
export const ROUTES = [];
export function route({ method, path, guard, rateLimit, handler }) {
  // guard 必填：'public' | 'user' | 'admin' | ['admin-sign', operation] | 'custom'（须附理由注释）
  if (!guard) throw new Error(`route ${method} ${path} 缺 guard 声明`);
  ROUTES.push({ method, path, guard, rateLimit, handler });
}
export function dispatch(routes, req, res, path, url) {
  for (const r of routes) {
    if (!match(r, method, path)) continue;
    if (!(await runGuard(r.guard, req, res))) return true;   // 守卫统一在此挂
    if (r.rateLimit && !rateLimit(req, res, r.rateLimit)) return true;
    await r.handler(req, res, path, url);
    return true;                                              // 统一 return true，消灭混风格
  }
  return false;
}
```

- 破坏性操作的 `requireAdminSignature(op, binding)` 由 `guard: ['admin-sign', 'promote']`
  声明，op 字符串**从注册即校验在 `ADMIN_SIGNED_OPERATIONS` 白名单内**（现状是运行时才知）。
- `/api/admin/*` 前缀下**未注册**的 method+path 组合 → 统一 405/404 JSON，不再可能
  漏进 SPA fallback（dispatch 返回 false 后 server.js 的 `/api/` 兜底 404 保留，双保险）。

> **实施勘误（P1 审查 L3 钉正，落地态以此为准）**：蓝图与实物有四处差异——
> ① dispatch 次序实为 **rateLimit 先于 guard**（旧 /api/admin/check 首句限流，行为对齐优先；
> 上文代码块的 runGuard 在前是设计期笔误，registry.js:27 红线注释早已声明）；
> ② admin-sign 未做 guard 数组形态，落地为**独立 `signOp` 字段**（注册即校验白名单）+
> handler 内原位 `requireAdminSignature` 调用（attach/verify 的 binding 形状各异，收进
> 通用 guard 反而丢真）；
> ③ §2.4 承诺的 `test/route-registry.test.js` 实拆为 **admin-registry.test.js +
> user-skill-registry.test.js** 两文件；
> ④ 未注册组合的收口实际只有 server.js 兜底 **404**（无 405——与旧 if 链行为逐字一致，
> 加 405 属语义变更，未夹带进搬运 commit）。
> 另：匹配器形态比蓝图多两类——`prefix`/`pattern`/`match(fn)`（catch-all 专用，
> 必须殿后，first-match-wins=注册序）。

### 2.3 实施步骤（每步一个 commit，全绿）

1. 建 `registry.js` + 单测（match/runcGuard/dispatch 纯逻辑，mock req/res）；
2. 先迁 **session.routes.js**（7 条，含免守卫的 login 三件套——guard:'public' 显式声明，
   从此"免守卫"也要写明，review 时一眼可见）；
3. 按域逐个迁：users → volumes → cwt → env → dsh（dsh 域最大，单独一步）；
4. 收编 `handleAdminRoutes` 为 dispatch 包装，删除 if 链；
5. 同法处理 `user.routes.js`（25 分支）与 `skill.routes.js`（顺带把审计 S1 的归属闸
   写成 guard 声明）；`tenant.routes.js` / `server.js` dispatch 列表**本次不动**
   （路径非 `/api/admin|user|skills` 前缀语义、且 `/connect` 流程有判例锚着，收益低风险高）。

### 2.4 结构性防回归测试（新增 `test/route-registry.test.js`）

- 遍历 ROUTES：guard 缺失 / admin-sign 的 op 不在白名单 → 测试红；
- 从 `docs/api.md` 端点表提取路径，断言全部已注册（文档即合同，防"建文件不注册"老坑）；
- 断言不存在返回 `undefined` 的路由 handler 路径（消灭 §2.1 的混风格再犯）。

## 三、P2 user.service.js → 域模块（物理拆分，语义零改动）✅ 已完成

### 3.1 现状与切分线

单 class 65 个成员（含 constructor）· P2 审查实测、一个大 `state`（swtcUsers 端口账本 + usages 限时账 + cleanupPolicy +
等待队列）。按既有方法聚类，天然切五域（行号为现状锚点）：

| 模块                      | 迁入方法                                                                                                                                                                                                                                                                                                                                    | 约行数       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `user/ports.js`           | allocateInternalPort, findFreePublicPort, probeBindable, reclaimDestroyedPorts, hasReclaimablePorts, tenantPortRanges, internalForPublic, recordOccupation, portInRange                                                                                                                                                                     | 207（实测）  |
| `user/usage.js`           | usageLimitConfig, settleUsage, getUsedMinutes, ensureUsageAllowed, checkUsageLimitAndStop, todayStr, dayStartMs, usageRecMs                                                                                                                                                                                                                 | 159（实测）  |
| `user/queue.js`           | addToWaitQueue, pruneWaitQueue, removeFromWaitQueue, getQueuePosition, processWaitQueue, preflightCheck, preflightMode                                                                                                                                                                                                                      | 232（实测）  |
| `user/resources.js`       | monitorResources, collectDiskUsage, scanVolumeUsage                                                                                                                                                                                                                                                                                         | 182（实测）  |
| `user/queries.js`         | getUserInfo, getAllUsers, _computeAllUsers, invalidateUsersCache, getStats                                                                                                                                                                                                                                                                  | 170（实测）  |
| （留守）`user.service.js` | ensureContainer, finalizeTenant, restart/reset/stop/destroy 生命周期主干, rollback/heal, syncTenantPatches, workspace 快照, adopt/unpin, _saveState, init/restore；**实施时钉正**：resolveTenantCapability/getTenantDshVersion 亦留守（网关热路径探针，非用户查询）；todayStr/dayStartMs/usageRecMs 入 usage.js（调用点 grep 证明域内独占） | 2423（实测） |

### 3.2 拆法：mixin 组装，不碰 this 语义

26 个测试文件引用 userService（18 静态 import + 4 动态 + 5 仅 mock）——全部不动。做法：

```js
// user/ports.js 导出普通对象（方法可互访 this）
export const portsMixin = { allocateInternalPort(...){...}, ... };
// user.service.js
import { portsMixin } from './user/ports.js'
class UserService { constructor(){...} }
Object.assign(UserService.prototype, portsMixin, usageMixin, queueMixin, ...);
export const userService = new UserService();
```

- 纯搬运：方法体**逐字节移动**，`this.x` 语义不变（state 仍在实例上）；
- 每域一个 commit；域间若有私有工具互借，暂时允许 `import { __todayStr } from` 丑线，
  P2 收尾再收进 `user/shared.js`；
- 生命周期主干（ensureContainer/finalizeTenant ~900 行）留守第一阶段——它是判例最密集区
  （端口劫持竞态、钉镜像、自愈回滚都有实名测试钉着），最后再动或不动。

### 3.3 验收

- `git diff --stat` 每步：user.service.js 减行 ≈ 新文件加行，且 24 个 import 方零改动；
- 全量测试绿；finalize-tenant.test.js（真容器链）重点盯 ensureContainer 域；
- 圈复杂度粗测：任意函数 ≤60 行，任意文件 ≤1000 行。（**口径注·P2 审查 L7**：本线针对 P3 收口终态。P2 阶段 main 留守 2423 行属 §3.1 设计内——生命周期主干『最后再动或不动』；>60 行方法 13→12，搬运刀只消掉 preflightCheck。若终验仍不达标须另立 P4 拆生命周期，不在本轮 ✅ 语义内。）

## 四、P3 前端巨型视图 → tab 组件化（移动/桌面共享内核）

### 4.1 AdminPanel.vue（4084）→ 7 个 tab 组件 + 共享 composable

模板已有天然切线（`v-if="activeTab === …"` 七块，envtpl 已组件化为 EnvTemplatesAdmin
的先例照抄）：

```
frontend/src/components/admin/
├── AdminOverviewTab.vue    # 68-154
├── AdminUsersTab.vue       # 155-294
├── AdminQuotaTab.vue       # 295-337
├── AdminMonitorTab.vue     # 338-551
├── AdminEnvTplTab.vue      # 直接复用 EnvTemplatesAdmin
├── AdminDshTab.vue         # 559-1086（模板最大块）+ script 里 dsh* 全家（~8 个 ref 组）
└── AdminCredTab.vue        # 1087-1363
frontend/src/composables/useAdminData.js   # users/stats/badge/轮询共享态（provide/inject）
frontend/src/composables/useAdminSign.js   # AdminPanel:1866 的薄封装上提（含 friendlyPluginError），
                                           # UserCenter:1810 的同名孪生改从此处 import——两孪生合一
```

AdminPanel.vue 目标 <400 行：壳（登录态、侧栏、embedded 兼容 props）+ 组件装配。
**embedded 模式（UserCenter 内嵌挂载）与 `/admin` 独立路由两条消费路径都要回归**——
这正是判例 58 型"改一处漏一处"高发面，拆完用测试钉：每 tab 组件独立可挂载（props 注入
而非闭包共享）即是证明。

### 4.2 UserCenter.vue（4106）→ 壳 + 三桌面 tab + 凭证域

- `views/user/`：AccountTab / ModelTab / ContainerTab（模板 193/471/694 三块）；
- **凭证域是最大簇**（credInfo/credApp/credVc/credBusy/credErr/credPopup… 15+ refs、
  script:1272-1321+）→ `useCredentials()` composable + `UserCredentialPanel.vue`；
- 移动壳的 defineAsyncComponent 装配方式已对，保持；壳内目标 <800 行。

### 4.3 API 层收编 125 处 axios 直调

补 `api/user.js`（tenant-config 自助配置、usage、queue 状态）、`api/admin.js`、`api/env.js`；
规则：**views/components 内禁止 import axios**（api 层统一 baseURL/错误面/签名头注入）。
收编顺序跟着 §4.1/§4.2 的 tab 拆分走——搬哪个 tab 顺手收编哪个，不单独立项（防半拉子）。

### 4.4 附带收益

tab 组件边界 = 天然 chunk 边界，移动端按需只载"审批/容器"两 tab 的现状继续改善；
`isMobile` 条件渲染簇（UserCenter 内 10 处）随 tab 拆分自然减量。

## 五、排期与风险

| 阶段          | 工作量估 | 依赖                                                        | 风险与对策                                                                                    |
| ------------- | -------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| P1 路由注册表 | 2-3 天   | 无                                                          | 漏注册→§2.4 测试钉死；行为差异靠 9 个路由测试文件 + 新 registry 单测双网                      |
| P2 后端域拆   | 2-3 天   | 无（与 P1 并行亦可，文件不相交）                            | this 语义/私有函数互借 → mixin 法零重写；丑线允许期 ≤1 周                                     |
| P3 前端拆分   | 4-6 天   | 建议等 cly-phone 移动 P1（"我的"tab）合回后动，否则冲突地狱 | 每 tab 一 commit，`npm run build:frontend` + 手工双路径（独立/嵌入）点验清单进 commit message |
| 收尾          | 1 天     | P1-P3                                                       | 更新本文件状态 → ✅；fixlog 追加一条"拆分判例"（只增不删）                                    |

**并行分支处置**：`cly` / `cly-phone` 等 10 分支若并行进行，先冻结四座大山的 feature 改动
（或全部 feature 先合入），拆分窗口内只允许搬运 commit 进这些文件——两线同时改
UserCenter.vue 必撞逻辑冲突（git 行级合并不了语义）。

**明确不做**（收益 < 风险，另案）：

- 不动凭证链路（credential.service.js）结构——五条不变量保护区，现 2267 行虽有同病，
  但它是判例最密集的承重墙，动它前需单独评审；
- 不引框架/不重写（node:http 手写与 Vue 结构保持）；
- `server.js` 的 dispatch 列表本次保留（README 已把它写成明示约定，且 §2.4 测试把
  "忘注册"的坑填了即可）。

## 六、验收总表

- [ ] 任意 src 文件 ≤2000 行、任意 vue 文件 ≤1500 行（第一阶段门槛，非终点）
- [ ] 任意 `/api/*` 端点必须经 registry 注册且带 guard 声明，`test/route-registry.test.js` 绿
- [ ] ADMIN_SIGNED_OPERATIONS 与注册表 admin-sign guard 双向一致（白名单没注册的 op = 红）
- [ ] 24+9 个既有测试文件的 import 路径零改动
- [ ] views/components 内 `grep "axios\."` 为 0
- [ ] 全量 vitest 绿 + 前端双路径（/admin 独立、UserCenter 嵌入）手点清单归档
- [ ] `git revert` 任一 commit 可独立回退（搬运/语义分离的证明）
