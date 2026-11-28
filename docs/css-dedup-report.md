---
title: 前端 CSS 公用审查报告（只读审查产物，P3 弹药）
date: 2026-11-25
status: 已整包登记进 §P3 窗口（2026-11-25 用户裁定：不单独先行，与 tab 组件化同窗动）
execution-order-redline: Tier B 骨架全局化必须先于切 tab；Tier B 移动簇等 cly-phone 合回
---

> **P3 启动时本报告即施工图**：§三 三级清单=任务分解，§四 假重复表=禁并红线，
> §五=与 refactor-giant-files §P3 的先后关系。JS 孪生半侧（fmtBytes/shortAddr 44 调用点）
> 已于审查轮先行收敛 frontend/src/utils/format.js 单源（判例 62）；本报告覆盖样式半侧。

# dsh-multitenant frontend/ CSS 公用审查报告

- 日期：2026-11-25｜模式：**只读审查**（仓库零改动）
- 工具：`/tmp/cssreview/parse_css.py`（手写花括号 CSS 解析器：注释/字符串/at-rule 嵌套感知，输出文件级行号）+ `/tmp/cssreview/analyze_dupes.py`（规则级重复检测、设计值统计、跨文件簇分析）
- 中间产物：`/tmp/cssreview/rules.json`（922 条规则全量带 `文件:行号`）、`blocks.json`（16 个 style 块）、`analysis.json`（全部聚合结果）
- 所有行号均为仓库源文件真实行号，可直接复核。

## 结论（TL;DR）

**CSS 可以公用，且收益可观，但必须分三层推进**：

- **Token 层（立即可做，零视觉风险）**：桌面 6,000 行 scoped 样式里 **135 处色值已有现成 `:root` 变量却仍写死字面量**（AdminPanel 48 处、UserCenter 41 处）；另有 297 处无 token 的高频散色值得新建 ~20 个 token。
- **类层（需轻量手术）**：AdminPanel/SkillMarket/UserCenter 三个 view 的"门户外壳"骨架 CSS 近乎整段复制（24 组全等规则、冗余 261 行）；移动六组件间 41 组全等规则、冗余 442 行，但存在 **8+ 个与桌面全局类同名的假重复**（`.card/.btn/.badge/.tab-dot/...`），不先做命名空间/祖先限定就合并必出视觉 bug。
- **组件层（随 P3 做）**：tab 拆分时样式跟模板走；骨架 CSS 若不在拆分前先收敛，复制份数会从 3 份恶化到 5-8 份。

全库可删重复上限 ≈ **764 行**（全部"跨文件逐字全等"规则去掉冗余副本），占 CSS 总量 6,324 行的 **12%**；分阶段现实目标：P3 前先行 ~300 行，P3 后移动命名空间再收 ~420 行。

---

## 一、盘点

### 1.1 样式资产总表（16 块，共 ~6,324 行）

| 文件                                 | style 块起 | scoped | CSS 行数  | 规则数   | @keyframes                         | at-rule 条数*        |
| ------------------------------------ | ---------- | ------ | --------- | -------- | ---------------------------------- | -------------------- |
| src/assets/style.css                 | 全局       | —      | 312       | 45       | spin×1                             | 0                    |
| src/styles/mobile-tokens.css         | 全局       | —      | 46        | 1(:root) | 0                                  | 0                    |
| src/App.vue                          | 41         | ✅     | 97        | 13       | 0                                  | 0                    |
| src/components/GlobalDialog.vue      | 62         | ✅     | 151       | 23       | gd-spin                            | 0                    |
| src/components/EnvTemplatesAdmin.vue | 482        | ✅     | 186       | 35       | 0                                  | 1 条(1100px)         |
| src/components/EnvTemplatesUser.vue  | 937        | ✅     | 408       | 71       | env-spin, envpulse                 | 0                    |
| src/views/AdminPanel.vue             | **2903**   | ✅     | **1,182** | 169      | fadeIn, dsh-spin                   | 3 条                 |
| src/views/UserCenter.vue             | **3048**   | ✅     | **1,059** | 151      | fadeIn, spin, pulse, tab-boot-spin | 7 条                 |
| src/views/Home.vue                   | 306        | ✅     | 364       | 65       | 0                                  | **31 条**(980/620px) |
| src/views/SkillMarket.vue            | 397        | ✅     | 361       | 46       | fadeIn                             | 2 条                 |
| src/views/mobile/MobileApprovals.vue | 489        | ✅     | 374       | 49       | spin                               | 0                    |
| src/views/mobile/MobileContainer.vue | 1266       | ✅     | 478       | 67       | spin                               | 1 条                 |
| src/views/mobile/MobileEnvMarket.vue | 278        | ✅     | 247       | 34       | 0                                  | 0                    |
| src/views/mobile/MobileHome.vue      | 309        | ✅     | 321       | 48       | spin, pulse                        | 3 条                 |
| src/views/mobile/MobileMarket.vue    | 447        | ✅     | 464       | 63       | spin, fadeIn                       | 3 条                 |
| src/views/mobile/MobileMe.vue        | 547        | ✅     | 274       | 42       | spin                               | 1 条                 |

注：1.1 表"@media"列为解析器对 at-rule 上下文的原始计数（含 keyframes 步）。grep 事实以 §2.2 断点行为准：**全库 @media 仅存在于两个文件**——Home.vue:495（980px，4 条规则）/Home.vue:510（620px，27 条规则）与 EnvTemplatesAdmin.vue:531（1100px，1 条规则）；移动六组件、AdminPanel、UserCenter、SkillMarket、GlobalDialog、EnvTemplatesUser、style.css、mobile-tokens.css 均无任何媒体查询（它们 1.1 表里的 media_rules 计数全部来自 keyframes 步）。
（复核命令：`grep -rn "@media" frontend/src`。）

### 1.2 全局样式入口（main.js）

- `main.js:5` → `import './assets/style.css'`（reset + **:root 品牌 token 9 个** + .card/.btn._/.badge._/.search-input/.tab-dot 等全局类 + 全局 @keyframes spin）
- `main.js:8` → `import './styles/mobile-tokens.css'`（**:root `--m-*` token 17 个**，T2 2026-11-10 已落地"移动设计值单一真源"，头注 2-15 行明确记录了已知不一致与"结构性去重刻意未做"的决策）

### 1.3 关键结构性事实

- **所有 14 个 .vue 的 style 块均为 `scoped`，无一个非 scoped 块**。现状下组件间唯一合法的样式共享面 = 两个全局 CSS 文件。
- **`:root` 变量体系已存在但不完整**：桌面 9 token（`style.css:23-32`）+ 移动 17 token（`mobile-tokens.css:19-43`），两族互不相通；**无间距/圆角/阴影/字号/transition/z-index token**——这正是重复的大头。
- vite 无 CSS 预处理依赖（`package.json`：仅 vite+@vitejs/plugin-vue；`vite.config.js` 无 css 配置项）→ 纯 CSS 自定义属性路线零新增依赖。
- 文件内自重复：**0 组**（同文件同选择器同声明体重述不存在——问题全部是跨文件的）。

## 二、重复热点表

### 2.1 规则级：跨文件逐字全等（73 组，冗余 764 行）

Top 热点（组大小 × 可删行数，证据 `文件:行号`）：

| 规则/簇                                                                                                                                                                 | 出现                                     | 所在                                                              | 证据                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.addr-tip[data-full]:hover::after`（tooltip ::after 整段 24 行）                                                                                                       | 3×全等                                   | AP/SM/UC                                                          | AdminPanel.vue:4036、SkillMarket.vue:733、UserCenter.vue:3977                                                                                     |
| `.avatar`（移动头像 11 行）                                                                                                                                             | 5×全等                                   | 移动五组件                                                        | MobileApprovals.vue:544、MobileContainer.vue:1321、MobileHome.vue:364、MobileMarket.vue:502、MobileMe.vue:600                                     |
| `.loading-state`/`.loading-spinner`/`.loading-text`（加载三件套）                                                                                                       | 5×全等各 1 组                            | 移动五组件                                                        | 如 :496/:1273/:316/:454/:553（spinner 505/1282/325/463/562）                                                                                      |
| `.gate-sidebar`+`.sidebar-card`+`.sidebar-nav`+`.sidebar-item{hover,active}`+`.sidebar-icon(:deep(svg))`+`.gate-content`+`.tab-head h4`+`.tab-hint`（**门户外壳骨架**） | 3×逐字节全等                             | AP/SM/UC                                                          | AdminPanel.vue:2989-3094 ≈ SkillMarket.vue:419-513 ≈ UserCenter.vue:3319-3477                                                                     |
| `.modal-mask`(26 行) + `.modal-panel`(20 行)                                                                                                                            | 3×全等                                   | 移动 3 组件                                                       | MobileContainer.vue、MobileEnvMarket.vue、MobileMarket.vue                                                                                        |
| `.ghead`/`.row1`/`.ttl`/`.body`/`.b-green`/`.btn:disabled`                                                                                                              | 4-5×全等                                 | 移动组件群                                                        | 见 rules.json 各 `n=4/5` 组                                                                                                                       |
| `@keyframes spin`（to{rotate(360)}）                                                                                                                                    | **7 文件**定义（全局 1 + scoped 副本 6） | MA/MC/MH/MM/Me/UC                                                 | style.css:265、MobileHome.vue:334、MobileMarket.vue:472、MobileContainer.vue:1291、MobileApprovals.vue:514、MobileMe.vue:571、UserCenter.vue:3202 |
| `@keyframes spin` 别名同体（`dsh-spin`/`tab-boot-spin`/`gd-spin`/`env-spin`）                                                                                           | 4 文件                                   | AP:3654、UC:4026、GlobalDialog.vue:154、EnvTemplatesUser.vue:1192 |
| `@keyframes fadeIn`（from{opacity:0;translateY(10px)}to{}）                                                                                                             | 4×全等                                   | AP:2917、SM:407、UC:3157、MobileMarket.vue:599                    |

### 2.2 设计值级：高频重复值（次数 × 分布文件数，refs 见 analysis.json）

**颜色**（桌面 vue 文件 hex 出现 350 次、移动 82 次、rgba ~130 次；其中 **135 次已有现成 token 可直接替换**）：

| 值                          | 出现     | 文件数  | 已有 token？                 | 抽样证据                                                       |
| --------------------------- | -------- | ------- | ---------------------------- | -------------------------------------------------------------- |
| `#fff`                      | 73       | 12      | ❌（建议 --surface-white）   | style.css:292、AdminPanel.vue:2931…                            |
| `#f8fafc`                   | 30       | 7       | ✅ `--bg-page`(style.css:28) | App.vue:125、AdminPanel.vue:2956、3036…                        |
| `#94a3b8`                   | 29       | 6       | ✅ `--text-faint`(:32)       | AdminPanel.vue:3079、3085、3123、3160…                         |
| `#64748b`                   | 26       | 6       | ✅ `--text-muted`(:31)       | AdminPanel.vue:2946、2982、3029…                               |
| `#e2e8f0`                   | 23       | 6       | ✅ `--border-light`(:29)     | AdminPanel.vue:3111、GlobalDialog.vue:100…                     |
| `#1e293b`                   | 19       | 5       | ✅ `--text-main`(:30)        | AdminPanel.vue:2942、3129…                                     |
| `#6b7bdb`                   | 18       | 6       | ✅ `--brand-text`(:27)       | App.vue:55、AdminPanel.vue:3042、Home.vue:323…                 |
| `#f1f5f9`                   | 17       | 5       | ❌（--surface-soft 候选）    | style.css:90/204/217、AdminPanel.vue:3414…                     |
| `#475569`                   | 16       | 6       | ❌（--text-secondary 候选）  | AdminPanel.vue:3037、3422…（hover 文字色）                     |
| `#334155`                   | 14       | 5       | ❌                           | style.css:17(body 本身都写死)、AdminPanel.vue:2963…            |
| `#dc2626`                   | 10       | 5       | ❌（--danger 桌面支）        | style.css:177、GlobalDialog.vue:167-198、AdminPanel.vue:2951…  |
| `rgba(226,232,240,0.8)`     | 9        | 4       | ❌（卡片描边）               | style.css:40、AdminPanel.vue、SkillMarket、UserCenter          |
| `rgba(15,23,42,0.04)`       | 9        | 4       | ❌（桌面卡片阴影主体）       | style.css:42、AdminPanel.vue:2934/3006/3065、UC:3174/3336/3449 |
| `rgba(60,70,120,0.06/0.08)` | 16       | 5(移动) | ❌（移动阴影族）             | MobileApprovals:651、MobileHome:430/481/514…                   |
| `#e5484d`                   | 跨两世界 | 2       | ❌                           | style.css:308（全局 tab-dot）= MobileContainer.vue:1404/1471   |

**非颜色**：

| 类别             | 值 → 次数/文件数                                                                                                                                                                                           | 判读                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| border-radius    | 12px→41/13f、10px→27/12f、8px→26/11f、16px→21/10f、14px→7/5f、999px→8/4f                                                                                                                                   | 6 个主力值散落 10+ 文件，无 token                                                                                    |
| box-shadow       | `0 1px 3px rgba(15,23,42,.04)`→9/4f（桌面）、`0 2px 8px rgba(60,70,120,.06)`→9/4f、`0 4px 16px rgba(60,70,120,.08)`→7/5f（移动）                                                                           | 桌面 1 款阴影、移动 2 款阴影，各自整串复制                                                                           |
| transition       | `all 0.2s` → **18 次/11 文件**（含 style.css、App、三 view、移动组件）                                                                                                                                     | 唯一全库通用的动效值                                                                                                 |
| font-size        | 移动/控件层 px 制：12px→55/11f、13px→42/11f、14px→40/12f；桌面文字层 rem 制：0.9rem→22/6f、0.85rem→19/5f                                                                                                   | **px/rem 双制式并存**，AdminPanel 甚至混用（sidebar 14px :3027 vs 表格 0.85rem）                                     |
| 间距             | 1rem→51/8f、8px→48/9f、16px→45/9f、12px→40/7f、0.75rem→35/6f…                                                                                                                                              | rem/px 双制式                                                                                                        |
| z-index          | `1000`→5 文件 5 次（遮罩/浮层）                                                                                                                                                                            | 无层级刻度                                                                                                           |
| **媒体查询断点** | Home.vue:495 `980px`、Home.vue:510 `620px`、EnvTemplatesAdmin.vue:531 `1100px`；**移动六组件 0 条 @media**（靠 `useIsMobile.js:10` `MOBILE_BREAKPOINT_PX=768` 路由分发）；style.css/mobile-tokens.css 0 条 | 桌面"各写一套"属实：3 个 CSS 断点 + 1 个 JS 断点，**4 值互不对齐**；不存在"移动媒体查询重复"问题（移动是独立组件树） |

### 2.3 近重复（声明体重叠但不全等）

- **同选择器、体近似**（部分重叠，合并前需对齐）：`.sidebar-item` J=0.93（SkillMarket 少一行 `position:relative`，AP:3018/UC:3383 有）、`.addr-chip` J=0.88（MobileHome:385 vs MobileMe:626）、`.hint` J=0.75（SkillMarket:721 vs UC:3618）、`.action-buttons` J=0.6（AP:3291 vs UC:3596）、`.greet` 3 文件同体+2 文件异体（见 §四）。
- **同声明体、不同选择器**（模式类候选）：24 组。实锤例：①卡片头模式一物四名——`.env-card-head`(EnvTemplatesUser.vue:1012) ≡ `.dsh-row`(AdminPanel.vue:3556) ≡ `.skill-card-head`(SkillMarket.vue:553) ≡ `.cred-head`(UserCenter.vue:4010)；②遮罩模式——`.modal-mask`(EnvTemplatesUser.vue:1124) ≡ `.modal-mask`(SkillMarket.vue:650) ≡ `.import-mask`(UserCenter.vue:3884)；③移动列表模式——`.app-list`(MobileApprovals.vue:666) ≡ `.env-list`(MobileEnvMarket.vue:355) ≡ `.skill-list`(MobileMarket.vue:666)；④移动激活态——`.type-tab.active` ≡ `.filter-btn.active`(MobileApprovals.vue:596/630) ≡ `.sub-tab.active`(MobileContainer.vue:1520)。

### 2.4 AdminPanel ↔ UserCenter 专项（P3 直接相关）

- 共享选择器 **22 个，其中 21 个声明体逐字节全等**（唯一例外 `.action-buttons` J=0.6）；AP 侧占 152 行 = **AP 样式区 12.9%**。全等对：`.gate-shell`(AP:2989/UC:3319)、`.gate-sidebar`(2998/3328)、`.sidebar-card`(3003/3333)、`.sidebar-nav`(3011/3376)、`.sidebar-item`(3018/3383)、`.sidebar-item:hover`(3036/3401)、`.sidebar-item.active`(3041/3406)、`.sidebar-icon`(3046/3411)、`.sidebar-icon :deep(svg)`(3055/3420)、`.gate-content`(3060/3444)、`.tab-content`(3071/3455)、`.tab-head h4`(3075/3459)、`.tab-hint`(3084/3468)、`.btn-large`(2967/3231)、`.btn-small`(2972/3236)、`.state-card`(2929/3169)、`.addr-tip` 三连(4027/4032/4036 ↔ 3967/3973/3977)、fadeIn `from/to`。
- 不看选择器、纯按声明体匹配：**UC 有 24 条规则(167 行，≈UC 样式区 15.8%)与 AP 某条规则全等**。
- SkillMarket 也携同款骨架：AP∩SM 共享选择器 16 个、UC∩SM 22 个——**"三份孪生"实锤**，docs §四把 JS 孪生收敛列为 P3 目标时，样式孪生应同表处理。

## 三、可公用三级清单

### Tier A｜token 级 —— 零风险机械提取，可立即做（建议 1-2 个纯搬运 commit）

1. **桌面已有 token 补引用**（不改一行视觉，纯替换字面量）：`--bg-page/--text-faint/--text-muted/--border-light/--text-main/--brand-text` 已覆盖 **135 处**散写值（AP 48、UC 41、SM 21、EnvTplUser 8、Home 8、GlobalDialog 6、App 3）。
2. **新建桌面 token ~12 个**：`--surface-white(#fff)`、`--surface-soft(#f1f5f9)`、`--text-secondary(#475569)`、`--text-body(#334155)`、`--danger(#dc2626)`、`--success(#10b981)`、`--card-shadow(0 1px 3px rgba(15,23,42,.04))`、`--card-border(rgba(226,232,240,.8))`、`--radius-btn(12px)`、`--radius-card(16px)`、`--radius-control(10px)`、`--transition-fast(all .2s)`、`--z-overlay(1000)` → 再覆盖 ~150 处高频值（合计把 432 处散色压到 <100 处一次性值）。
3. **移动补齐**：剩余 82 处 hex 里高频的 `#fff`、`#e5484d`、`#f2f3f8/#edeff5/#e0e3eb`（软边框族）、`#f6f5ff/#f0f4ff`（软面族）入 mobile-tokens.css；rgba 透明支维持字面量（token 文件头注 :9 已给理由，color-mix 是后续选项）。
4. **keyframes 全局化**：全局 `style.css:265` 已有 spin——删除 7 处 scoped 副本 + 4 个别名副本（`dsh-spin/tab-boot-spin/gd-spin/env-spin` 与 spin 同体，动画名统一引用 `spin`），fadeIn 同样上收（4 处同体）。**Vue scoped 不改引用未在本文件定义的动画名，此操作可构建后目检，零视觉风险。**
5. **断点**：CSS 自定义属性无法用于媒体查询，不引入 postcss 插件的前提下，以 `docs` 一行约定 + JS `MOBILE_BREAKPOINT_PX` 为唯一真源即可（现状 620/768/980/1100 四值各自有场景，**不建议强行统一**——这是产品/布局决策不是重复问题）。

### Tier B｜类级 —— 需改名/限定对齐，1-2 天 + 双路径点验

1. **门户外壳骨架**（`.gate-*`/`.sidebar-*`/`.tab-head`/`.tab-hint`/`.addr-tip*`，AP/SM/UC 三份冗余 261 行 → 全局仅留一份 ~130 行）：
   - 做法：抽入新全局文件（如 `assets/gate-skeleton.css`），用**祖先限定防泄漏**：现有规则天然嵌在 `.gate-shell`/`.admin-panel` 之下，改写为 `.gate-shell .sidebar-item {...}` 即可零模板改动生效（三 view 根类名都在：`.admin-panel`、`.gate-shell` 等）；`.sidebar-icon :deep(svg)` 全局化后改普通 `.gate-shell .sidebar-icon svg`（:deep 三处全等，见 AdminPanel.vue:3055 等）。
   - 前置排雷：`.tab-content` 在 MobileMarket.vue:595 也有同名 scoped 类（`animation:fadein 0.3s` vs 桌面 `0.25s`）——桌面版带 `.gate-shell` 祖先限定后不冲突，**但禁止把移动版并入**。
2. **移动六组件结构件**（.avatar/.ghead/.row1/.ttl/.body/.loading-* 三件套/.modal-mask/.modal-panel/.b-green/.b-purple）：抽 `styles/mobile-shared.css`。**必须先命名空间**（`mobile-tokens.css:12-15` 头注已警告：全局注入 `.card/.btn` 会泄漏进桌面作用域）——方案 a) 逐文件加 `mm-` 前缀类名（横跨 6 个模板，改动面大但最干净）；方案 b) 用现成根类限定（`.mobile-approvals/.mobile-home/...` 每文件不同名 → 需先在模板根统一加一个公共类如 `mm-ui`，1 行/文件）。**等移动端 cly-phone 合回后再动**（P3 §五红线同理）。
3. **toast/弹层模式**：GlobalDialog 已把弹层收敛成组件（.gd-* 命名空间规范可作 Tier B 命名范式），移动 `.modal-mask/.modal-panel` 三份全等属"该组件没组件化"的样式侧投影 → 归入 Tier C 顺手做。

### Tier C｜组件级 —— 随 P3 tab 化一并做

- AP 7 个 tab、UC 3 个 tab + 凭证域拆分时，**样式块跟着模板搬进各 tab 组件的 scoped style**（文件内自重复为 0 的事实说明各 tab 样式互不纠缠，搬运是纯切割）；壳组件保留/引用全局骨架。
- UC 167 行"与 AP 全等"的样式里，凭证面板相关（`.cred-*`、tab-boot 遮罩、`.addr-tip` 族）在 `UserCredentialPanel.vue`/`useAdminSign` 上提时同步收敛（AP:3419-3435 `.orphan-*` 与移动 Home 同名族**不**属此列，见 §四）。

## 四、不能合并清单（同名不同体 = 合并即 bug）

| 选择器                                           | 冲突体                                                                                                                                        | 证据                                                                                                                          | 风险                                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `.tab-dot`                                       | **三种实现**：9px `#e5484d` 带 ring / 10px `#ff4757` 白描边 / 8px inline `var(--m-danger-bright)`                                             | style.css:302、UserCenter.vue:3134、MobileApprovals.vue:636                                                                   | 全局与 UC scoped 当前靠 data-v 特异性并存；合并必改红点尺寸/颜色。UC:3436 注释还特意处理过内嵌 AdminPanel 的双层 padding——同名不同体是有意为之 |
| `.card`                                          | 桌面 white/16px/1.5rem/描边+阴影 vs 移动 white/14px/16px/移动阴影                                                                             | style.css:37 vs MobileContainer.vue:1345、MobileHome.vue:511、MobileMe.vue:660                                                | 移动全局化若无前缀，桌面卡片被移动体覆盖                                                                                                       |
| `.btn`（族）                                     | 桌面基座（rem/12px/0.9rem/inline-flex+gap）vs AP 局部补丁（3302 仅 3 声明）vs 移动 5 种体（padding 10/12/16/20px 混写、13/14px 混写）         | style.css:135、AdminPanel.vue:3302、MobileApprovals:754、MobileContainer:1443、MobileHome:570、MobileMarket:756、MobileMe:751 | 同上，且 `.btn-sm` 三移动文件互相也不同体（MA:769/MC:1568/MM:783）                                                                             |
| `.badge`                                         | 桌面 999px 胶囊/0.8rem vs 移动 12px 圆角/12px 字号/600 粗                                                                                     | style.css:106 vs MA:725、MC:1381、MM:727、Me:707                                                                              | 移动内部 .badge 也非全等（Me 是 999px！Me:707）                                                                                                |
| `.badge-danger`                                  | 桌面 #fee2e2/#991b1b vs EnvTpl 两处异体                                                                                                       | style.css:124 vs EnvTemplatesAdmin.vue:662、EnvTemplatesUser.vue:1322                                                         | 组件级补丁类，勿提全局                                                                                                                         |
| `.search-input(:focus)`                          | 桌面 240px/slate vs 移动 flex:1/12px16px/主色 ring                                                                                            | style.css:284/296 vs MobileMarket.vue:620/630                                                                                 | "2026-10-23 三框一致"注释（style.css:281）指桌面三处，移动不在其列——别顺手把移动也"统一"                                                       |
| `.tab-content`                                   | 桌面三份 0.25s vs MobileMarket 0.3s                                                                                                           | AP:3071/SM:491/UC:3455 vs MobileMarket.vue:595                                                                                | 同动画时长不同                                                                                                                                 |
| `.greet`                                         | 移动 5 文件**三种体**（13px+opacity+line-height / 14px+margin-bottom）                                                                        | MA:556、MC:1333、MH:376、MM:514、Me:612                                                                                       | 移动收敛时只能并 3 文件，MH/Me 另议                                                                                                            |
| `.loading-spinner`                               | UC 仅 `margin-bottom:2rem`(3188) vs 移动完整 spinner 体                                                                                       | 见上                                                                                                                          | UC 同名是历史残留，可删 UC 处而非合并                                                                                                          |
| `.b-red`/`.b-purple`/`.btn-p`/`.close-btn`/`.cd` | 移动**同名不同体**（如 .b-red：`#ffe6e6/var(--m-danger-bright)` vs `var(--m-danger-soft)/#e5484d` vs `var(--m-danger-soft)/var(--m-danger)`） | MA:743、MC:1403、Me:730；.btn-p MC:1459/MH:580/MM:771/Me:766 J=0.17                                                           | **移动世界内部**也有假重复，Tier B 提取时逐类核验，不能按名批量并                                                                              |
| `table` 元素选择器                               | 全局 `style.css:81`（width/1rem 间距/th slate）与 `AdminPanel.vue:3298` scoped 版**当前双重叠加生效**                                         | 两处                                                                                                                          | 已是一处潜在覆写关系，动全局 table 样式前先回归 AP                                                                                             |
| `@keyframes pulse`                               | UC 版含 scale(1.1)（3249）vs MobileHome 纯 opacity（442）                                                                                     | 两处                                                                                                                          | 名字相同体不同，禁止全局化"pulse"                                                                                                              |
| `var(--surface-1/2, fallback)`                   | **悬空 token**：3 处使用、0 处定义，fallback 各不同(#f9fafb / rgba(127,127,127,.05) / #f3f4f6)                                                | UserCenter.vue:4008、4034、4070                                                                                               | 说明曾有人想走 token 路线未竟；Tier A 落地时正式定义或删除 fallback                                                                            |

（完整 46 组清单在 `analysis.json → same_sel_different_false_dupes`。）

## 五、与 P3（docs/refactor-giant-files.md §四）的衔接建议

**推荐"先 token+keyframes 先行，骨架类收敛紧贴拆分第一步，移动类收敛等 cly-phone 合回"三步走，而非一并做**：

1. **P3 窗口外即可先做**（不碰模板、不碰逻辑，与移动活跃改动零冲突面）：Tier A 全部 + keyframes 全局化。AP/SM/UC 样式块先瘦 ~300 行（骨架 261 冗余+keyframes 别名副本，注：spin/fadeIn 副本已计入两簇，别名 4 处另计 ~12 行），P3 拆分时每个 tab 组件少搬 ~15% 行数。
2. **P3 拆分第一步（壳定型 commit）内做骨架收敛**：先落 `.gate-shell` 祖先限定的全局骨架文件，再做 tab 切割。顺序若反（先拆分后收敛），骨架从 3 份复制变 (壳×3 + 各 tab 引用) **5-8 份**，且分散到多文件后 git 冲突面从 3 文件升到 10+ 文件——量化收益见 §六。判例 58 型"改一处漏一处"在 CSS 侧已经发生（`--surface-1` 悬空、fadeIn 时长漂移），先收敛再拆是唯一不放大熵的顺序。
3. **移动端样式命名空间手术（Tier B-2）等 cly-phone "我的"tab 合回**（与 §五"并行分支处置"红线同由）；合回后 6 文件 → `mm-ui` 公共根类一次改名即可批量收敛 ~440 行重复。
4. `useAdminSign` 孪生合一（§4.1）与样式孪生合一（本报告 §2.4 的 22 个全等选择器）是同一件事的两半，建议同一 PR 序列。

## 六、量化预期

| 项目                                                                                            | 数字                                                                                                                                                                                                                                | 依据                            |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| CSS 总量                                                                                        | 6,324 行（16 块，scoped 5,966 + 全局 358）                                                                                                                                                                                          | blocks.json                     |
| 解析规则                                                                                        | 922 条                                                                                                                                                                                                                              | rules.json                      |
| 跨文件逐字全等冗余（重复上限）                                                                  | **73 组 / 764 行（12.1%）**                                                                                                                                                                                                         | analysis.json exact_cross_files |
| ├─ 移动六组件簇                                                                                 | 41 组 / 冗余 442 行（现实可删 ~420，扣 §四 假重复核验；含 spin 等 keyframes 副本）                                                                                                                                                  | 2.1 表                          |
| ├─ 门户外壳簇（AP/SM/UC）                                                                       | 24 组 / 冗余 261 行（留一副本即净删；各文件全等副本行数：AP 139、UC 170、SM 122）                                                                                                                                                   | 2.1 表                          |
| └─ 其余 8 组 / 61 行（含跨世界 fadeIn、EnvTpl↔SM detail-head、EnvMarket↔Market detail-meta 等） | 61 行                                                                                                                                                                                                                               | analysis.json                   |
| AP↔UC 重复占比                                                                                  | 共享 22 选择器 152 行 = AP 样式 12.9%；UC 按体匹配 167 行 = UC 样式 15.8%                                                                                                                                                           | §2.4                            |
| 骨架三份副本占各自样式区比例                                                                    | AP 12%（139/1182）、UC 16%（170/1059）、SM 34%（122/361）                                                                                                                                                                           | 全等副本行数                    |
| Token 直接收益                                                                                  | 桌面 135 处散色即刻有主；新建 ~25 token 覆盖全库 ~285 处值出现，剩余一次性值 <100                                                                                                                                                   | §2.2                            |
| 分阶段可删                                                                                      | P3 前 ~300 行（骨架 261 + spin/fadeIn 副本与别名 ~25 + UC 冗余 `.loading-spinner` 等）；P3 后移动命名空间再收 ~420 行；**合计 ≈720-780 行 ≈ 上限 764 行的九成九，占样式总量 ~12%**（P3 tab 化本身不新增可删行数，样式是随模板搬运） | 去重上限 §6 行和                |
| 维护性收益（行数外）                                                                            | "改一处"半径：如 tab-dot 色改 1 处 vs 现 3 处；sidebar 骨架改动从 3 文件 152 行同步压力降为 1 文件                                                                                                                                  | §四                             |

## 七、风险与约束核查（任务 4 逐项）

1. **scoped 与全局冲突面**：`grep` 全库 `:deep/::v-deep` 仅 **3 处且内容相同**（`.sidebar-icon :deep(svg)`：AdminPanel.vue:3055、SkillMarket.vue:475、UserCenter.vue:3420）——scoped 泄漏面极小，反而是骨架全等的前置证据。全局类（.card/.btn/.badge/.search-input/.tab-dot）已在移动/桌面模板大量使用（AP 模板 btn-primary×7、card×23、badge×16；UC btn-primary×13、badge×17），**全局面已经公用，缺的是组件间共享层**。
2. **假重复**：见 §四 13 类，合并须逐类点名。
3. **构建**：vite5 + @vitejs/plugin-vue，无任何 CSS 预处理器（package.json dependencies/devDependencies 仅 axios/vue/vue-i18n/vue-router/vite/@vitejs/plugin-vue）、vite.config 无 css 段 → CSS 变量/keyframes 全局化零依赖成本；若要 postcss-custom-media 统一断点需新增 devDep（不建议，见 Tier A-5）。
4. **index.css 变量体系**：入口实为 `assets/style.css`（:root 9 桌面 token，style.css:23-32）+ `styles/mobile-tokens.css`（17 移动 token）——**变量体系已有但只覆盖颜色，且桌面侧采用率仅 135/350≈39%**；两族 token 主色不一致（#6b7bdb 系 vs #6a72e8）系已知产品决策（mobile-tokens.css:7-8 记录），本报告不建议擅自统一。
5. **回归验证手段现状**：docs §五要求 P3 每 commit `npm run build:frontend`+双路径点验；CSS 手术建议同标准（构建 diff 看产物 css 哈希+尺寸，独立 /admin 与内嵌 embedded 两路径目检骨架 8 类：侧栏/页签头/hint/addr-tip/按钮/卡片/红点/浮层）。

—— 以上全部结论可由 `/tmp/cssreview/` 内脚本+JSON 复现（`python3 parse_css.py && python3 analyze_dupes.py`）。
