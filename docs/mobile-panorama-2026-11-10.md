# 移动端全景现状报告（cly-phone）

> 状态：📋 现状基线（2026-11-10，四路并行深读后端/桌面端/移动端/文档测试体系后汇总）
> 用途：移动端后续开发的决策底稿。P0 三项修复实施情况见文末「修复记录」。

## 一、项目骨架（对照用）

**定位**：SWTC 钱包身份的多租户容器平台——每用户一个 Docker 容器跑 DSH Web，VC 凭证做判权底座。

| 层   | 实现要点                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 后端 | 原生 node:http 无框架，src ≈21k 行；admin/user/tenant/skill 四路由组；REST + 端口级反代网关（容器只绑回环 internalPort） |
| 前端 | Vue 3 `<script setup>` + vue-router + Vite + vue-i18n（zh 硬编码）；无统一 API 封装层，各视图直调 axios                  |
| 存储 | json 默认（data/ 文件轨）/ mongodb 灰度（10 集合单事务扇出）；CAS 内容寻址随行包（data/env-blobs/）                      |
| 质量 | 58 测试文件 ≈869 用例、pre-commit Prettier+全量 vitest 阻断、fixlog 36 判例只增不删、五条判权不变量                      |

**安全模型**：登录/连接 = 一次性 nonce 挑战 + secp256k1 验签 + 公钥推导地址比对；签名用途绑定
（`purpose|address|nonce|binding`，挑战池按 `用途|地址` 隔离）；管理破坏性操作 20 种全部二次当场签
（`x-admin-nonce/signature/pubkey` 三头，binding 服务端从 operation+payload 推导，防"签 A 执行 B"）。

**改动铁律**（本项目踩过的坑，动代码前必读）：

1. 新路由必须注册 `src/server.js` dispatch 列表——只建 routes/ 文件不生效
2. `server.publicHost` 改后必须重启平台进程（patch 建容器时烘死）
3. 凭证故障 fail-open 绝不上锁；摘卡一律 `isOurIssuedCard`（多平台互踢事故判例）
4. 修一条先 grep 孪生面（半拉子不对称是母题，审查纪实判例 58）

## 二、移动端现状矩阵

**装配方式**：移动端不走路由（仅 `/mobile/container` 可独立直达），其余全靠 `isMobile ≤768px` 在
`UserCenter.vue` 移动壳内条件渲染；底部 TabBar 本地 ref 切换、不改 URL。API 100% 复用 PC 端点，
后端零 `/mobile` 专用形态。Home.vue（`/`）登录态下也独立渲染 MobileHome。

| Tab  | 组件（行数）                                | 完成度 | 要点                                                                                      |
| ---- | ------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| 首页 | MobileHome（471）                           | 🟡     | 渐变头/Docker 横幅/统计卡/管理员 8 宫格；统计硬编码、300s 刷新为假文案、孤儿扫描空壳      |
| 容器 | MobileContainer（936）                      | 🟢     | 信息+技能插件+环境现场三段；进入 DSH/重启/停止/重置/装卸技能可用；环境现场仅占位"请在 PC" |
| 市场 | MobileMarket（876）＋MobileEnvMarket（502） | 🟡     | 技能浏览/预览/签名安装、环境应用/回退/下架可；无技能上传发布入口、无环境定格入口          |
| 审批 | MobileApprovals（793）                      | 🟢     | CWT 申请+环境模板双审批、完整 x-admin 签名链、useAdminBadges 红点联动                     |
| 我的 | ——（占位）                                  | 🔴     | 登录/退出、CWT 凭证申请、凭证列表、配额/用量全部缺失                                      |

**管理员移动覆盖**：admin-tabs 七项中仅 envtpl、cred 两项有移动形态（合并为审批中心）；
overview/users/quota/monitor/dsh 版本无移动形态；用户侧 model 配置也无。

## 三、问题清单（按严重度）

### 🔴 Bug 级

| #   | 问题                    | 现象                                                                                 | 根因                                                            |
| --- | ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| B1  | 管理员 8 宫格全部死链   | 移动端点快捷入口跳 `/user?tab=adm:*` 后纹丝不动                                      | `?tab=` 只被桌面侧栏 `activeTab` 消费，移动壳不读 query         |
| B2  | MobileSkills 孤儿+带病  | UserCenter import 了但模板未挂载；其自身用无签名直连 axios，而技能写操作后端要求签名 | 被 MobileMarket 取代后未清引用；旧实现与签名流程分叉            |
| B3  | 审批 tab 对普通用户可见 | 移动底部导航无 role 判断（桌面侧栏是装配层砍掉的）                                   | 违背"管理面对普通用户从装配层移除"的项目基调，仅靠后端 403 兜底 |

### 🟡 体验/技术债

| #   | 问题                                                            | 备注                                                                                                                        |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| T1  | 移动端交互全用原生 alert/confirm                                | 未接项目已有的 GlobalDialog/useDialog 体系                                                                                  |
| T2  | 移动样式 ~300+ 行跨 5-6 文件逐字复制                            | loading/ghead/card/badge/btn 家族；主色 #6a72e8→#9b8cf5 与全局 token 品牌色（#6b7bdb→#6c69c2）不一致，移动组件不用 CSS 变量 |
| T3  | isMobile 检测三处重复实现                                       | App.vue / Home.vue / UserCenter.vue 各一份                                                                                  |
| T4  | connectWithOwnership 手工复制 PC 登录逻辑                       | MobileContainer 内，孪生面漂移风险                                                                                          |
| T5  | 构建单 bundle 无移动分块                                        | 移动端背 UserCenter/AdminPanel 各 140KB 桌面代码                                                                            |
| T6  | MobileHome 统计写死（TODO 11/2/11/0）、"每 300s 自动刷新"仅文案 | 需接 /api/stats 并真起定时器                                                                                                |
| T7  | 地址 chip 文案"退出"但点击行为是复制                            | affordance 语义错位                                                                                                         |
| T8  | MobileContainer 残留大量 console.log                            |                                                                                                                             |

## 四、开发优先级

- **P0（修错误认知，本次实施）**：B1 移动壳消费深链 query.tab → B3 审批 tab role 门禁 → B2 清 MobileSkills 死引用（文件保留，其上传表单是 P2"移动发布链路"的原料；其无签名 API 待 P2 一并收敛）
- **P1（补最大空白）**："我的"tab——钱包登录/退出（顺带治 T7）、CWT 凭证申请与列表、配额/用量查看（桌面 account 页签移动化）
- **P2（补链路，✅ 2026-11-10 已实施，见五-C）**：移动端技能上传/发布（收敛 MobileSkills/MobileMarket 双实现）；环境模板定格向导——用户裁定**保持 PC-only**，容器页占位把话说清
- **P3（还债，✅ 2026-11-10 已实施，见五-D）**：接 GlobalDialog（T1）；抽移动共享样式/token（T2）；isMobile 收敛单例（T3）；connect 内核收敛（T4）；移动 chunk 拆分（T5）；signAdminOperation 三份孪生收敛；console.log 清扫（T8）

## 五、修复记录（2026-11-10 P0）

- **B1**：UserCenter 移动壳新增深链消费——`adm:approval|cred|cwt|envtpl`→审批 tab；`account|me`→我的
  tab；`adm:users/quota/monitor/version/dsh/overview/model`、`system`→如实提示"请在 PC 端使用"；
  非管理员撞管理深链复用桌面同款文案（user.adminEntryLocked）。落定即清 query，重复点击可重放；
  角色未定时先寄存、credential-status 回落后消费（防把"还在查"当"不是管理员"）。
- **B3**：审批 tab 按 `role === 'admin'` 装配；角色跌落即时从审批页弹回首页（与桌面 1414 行
  "撤销即时收面"同闸）。
- **B2**：摘除 UserCenter 对 MobileSkills 的死 import；`views/mobile/MobileSkills.vue` 文件暂留
  （P2 复用其上传表单，届时连同无签名 API 一起收敛）。

## 五-B、P1/P0-b 实施记录（2026-11-10 续）

- **T6（首页三硬伤）**：MobileHome 统计真取 `/api/stats`（字段口径 `getStats()`：
  totalUsers/runningUsers/tierCounts；数据源是管理端点，统计卡改仅 admin 装配，普通用户
  不再看零值假数据）；"每 Xs 自动刷新"改真定时器（默认 15s，管理员读 `uiConfig.refreshIntervalMs`
  后端真值重建节拍，切后台停表/回前台刷续表——红点节拍器同纪律）；孤儿清理接真链路
  （`GET /api/admin/orphan-volumes` 出列表 → askConfirm 明细 → `cleanup-orphan-volumes` 当场
  签名 → 删除/失败/跳过三笔报账，与桌面 AdminPanel 双闸语义逐字对齐）。
- **签名链收敛**：新建 `frontend/src/api/adminSign.js`（含 2026-11-02 材料校验加固的权威语义），
  MobileHome 与 MobileApprovals 换用——MobileApprovals 本地拷贝缺该加固（插件未解锁时签名
  材料半路蒸发→裸 POST 撞闸），就此补上装甲。AdminPanel/EnvTemplatesAdmin 两份桌面拷贝未动
  （改动面大，P3 收敛）。
- **P1"我的"tab（MobileMe.vue）**：四态屏（未连钱包指引/切号停读数/未登录引导/已登录主体）；
  已登录含 今日配额（connect-status.usage，CWT 豁免=不限时紫标+进度条）、v1.4 凭证单卡互斥
  （kind/state/到期 30 天黄标/onChain 四态；领取与同步=claimCredential 全链含文件签口径与
  probeFailed/noProfile 分家、CWT 申请/重申请含驳回理由展示、凭证本体 JSON 展开含 holder
  防线）、退出登录（askConfirm→POST logout→清本地地址）。登录链与桌面 walletLogin 逐字对齐
  （canonical 拼法同 localStorage 键）。T7 顺带治标：MobileHome 地址 chip"退出"改如实"复制"，
  真退出落点在本 tab。

## 五-C、P2 实施记录（2026-11-10 续）

- **移动发布链路（落在 MobileContainer 技能子 tab，非市场页——与桌面 fe46075 裁定同位次）**：
  技能插件 tab 顶部加动作行 `📥 导入技能`（主色）/ `⬆ 共享到市场`（次色）：
  - **导入**：`signChallenge → skillsApi.importSkill(kebab-name, content)`，写自己卷不入市场；
    选 .md 文件自动回填名字+正文（`onImportFile` 与桌面逐字同款，kebab 正则才回填）。
  - **共享**：`signChallenge → skillsApi.mine` 取 inContainer 列表→选源→`skillsApi.publish`；
    **409 撞名就地转重命名**（shareConflict 弹输入框，源名不变，桌面同款语义）。
  - 全程走 wallet.js 权威签名（后端按 hex(dsh-multitenant|purpose|address|nonce|binding) 用途绑定
    消息验签），非孤儿文件的无签名裸 API。
- **双实现收敛**：删除 `views/mobile/MobileSkills.vue`（P0-b 摘 import→P2 在 MobileContainer 另建
  真签名上传后，旧孤儿无引用，`git rm`）。MobileMarket"我的"tab 加去向指引"去容器 tab 导入/共享"。
- **环境模板定格（用户裁定：保持 PC-only）**：MobileContainer 环境现场占位从"环境变量管理功能较复杂"
  改为分点说清——**模板定格/上传流程重（清洗勾选/随行包确认/落库签名）留 PC**；
  **移动端可直接用 市场→环境 查看/应用/回退/下架**（能力不减，只是把"去哪干什么"讲透）。
- **样式**：MobileContainer 新增弹窗族（modal-mask/panel/head/body、pick-item、ms-input/textarea/file），
  配方与 MobileMarket 同系；按钮类 btn-p/g/r/sm 与基类 btn 已存在，复用无真空。

## 五-D、P3 实施记录（2026-11-10 续）

- **T3 isMobile 单例**：新建 `composables/useIsMobile.js`（模块级单 ref + 首用绑定全局
  resize 监听）；App/Home/UserCenter 三份复制（ref+updateMobile+监听+清理）全摘。断点
  常量唯一点 `MOBILE_BREAKPOINT_PX=768`。
- **T5 chunk 拆分**：UserCenter 五个移动组件 `defineAsyncComponent`；router 的
  UserCenter/SkillMarket/MobileContainer 改路由级懒加载（Home 留同步防首屏多一跳）。
  实测桌面主 chunk **499KB→262KB**（gzip 174→107KB），UserCenter 独立 168KB 按需，
  adminSign/wallet/skills 自动成共享小包。
- **T1 原生弹层清零**：移动四组件 48 处 `alert/confirm/prompt` 全部退役（Market 5、
  EnvMarket 9、Approvals 13、Container 21）——alert→toast（autoKind 启发式分色），
  confirm→`await askConfirm`，危险动作（停止/重置/卸载/取消发布/应用/回退/下架）加
  `danger:true` 红钮 + 动词 confirmLabel。Approvals 两处 `prompt` 收原因：GlobalDialog
  无输入态、不扩共享件，组件内自建拒绝/驳回薄 sheet（cwt 原因可选、env 必填——原口径）；
  GlobalDialog 本身早在 App 根挂载，此轮补的是"组件真的用它"。
- **T1 顺带治活 bug**：MobileContainer 卸载/取消发布技能原走 `POST /api/skills/uninstall|unpublish`
  **裸 JSON 且无签名——后端无此路由，一直 404**（MobileSkills 病根同款残留）。改
  `signChallenge→skillsApi.uninstall/unpublish`（/:name/uninstall 与 DELETE /:name 正门），
  与桌面孪生同口径。
- **signAdminOperation 三孪生归一**：`api/adminSign.js` 升为全端唯一权威支——challenge→
  sign→**2026-11-02 材料校验**→三头。桌面差异装进 opts：`sessionAddress`（钱包≠会话预检，
  AdminPanel 注入）与 `t`（i18n 话术）。AdminPanel 本地全装拷贝退役为薄包装（hasCCDAO 前置闸
  +friendlyPluginError 包装留本地）；**EnvTemplatesAdmin.signOp 系缺材料校验的裸孪生**
  （判例 58 活体：插件未解锁时材料蒸发→裸 POST 撞闸），收敛后补上装甲。
- **T4 connect 内核收敛**：新建 `api/connect.js`（`signConnectPlugin` =
  requestAccounts→/connect-challenge→signMessage→getPublicKey 一支；`buildConnectUrl` 统一
  /connect 参数拼装）。桌面 connectWithOwnership 保单飞锁+阶段化 loading（onPhase 回调注入，
  时序与改造前逐点一致），移动拷贝改走内核并**补齐 swtc_plugin_case 拼法落库**——旧移动拷贝
  漏记该线索（"档案优先发现"的 canonical 依赖），即判例 58 在签名链的漂移投影。
- **T2 移动 token 单一真源**：新建 `styles/mobile-tokens.css`（19 个 `--m-*`，:root），
  main.js 全局引一次；六组件 `<style>` 与模板内联样式中 30+ 处高频色等值替换
  （`var(--m-primary)`≡#6a72e8，**零视觉变化**）。如实保留未合并项：移动主色 vs 桌面
  `--brand-start:#6b7bdb`（哪个赢是产品决策，改 token 一行+桌面一处即可）；危险红两支
  （#ff4757/#d64545）与琥珀两支（#e8930c/#d97706）各守其位；rgba() 透明主色暂留字面量。
  **结构性去重刻意未做**（scoped @import 每组件重复打包不省字节；全局注 .card/.btn
  泄漏桌面作用域——先决条件是 .mm-* 命名空间改造，横跨六份模板，属视觉回归大手术，
  留待专项评审）。
- **T8**：MobileContainer 10 处 debug console.log 随 T1 重写清零（console.error 保留）。

## 五-E、挂机跌落修复（2026-11-10 用户报障）

**报障**：手机端长时间不管后 ①底部 tab 栏整个消失 ②容器显示未启动且找不到启动按钮。

**根因链（逐条源码坐实）**：

1. **cookie 寿命与服务端滑动续期错位**——`user_session` 签发点全部硬编码
   `max-age=43200`（固定 12h，共 6 处：user/tenant/admin 路由 + 网关 ticket 换取）。
   服务端 `resolve()` 过半滑动续期续的是**表**，浏览器到点照扔**cookie**：页面开着、
   轮询勤快也没用。12h 后请求集体 401 → Home.vue 的 `isLoggedIn` 翻假 → `/` 跌回
   登录引导页（tab 栏在 /user 壳里，引导页没有）＝"tab 不见了"。
2. **移动端唯一的恢复通道被守卫挡死**——`MobileContainer.enterDsh` 先按 `!userInfo.port`
   短路 toast"容器未启动"。而带签名的 `/connect` 本就是**启动+重登+进入**三合一通道
   （`ensureContainer:1411` 对 stopped 走 `docker start`；会话过期由该调用重新签发
   cookie）。守卫把手机上唯一能自救的按钮变成了谎话＝"没有启动按钮"。

**修复**：

- **A（服务端，6 签发点）**：`user_session` 改发**会话 cookie**（无 max-age，活到浏览器
  关闭），会话生死唯一裁决权收归服务端 12h 滑动；退出清理仍 `max-age=0` 不变。
  `user.routes.js` 签发点载判例注释；`test/user-session-sliding.test.js` 头注补二轮修正
  口径（其 12h TTL 断言与 max-age=0 断言均不受影响，实测全绿）。
- **C（移动端）**：`enterDsh` 摘除 port 守卫——容器停止/会话过期一律直接走签名 connect
  （顺带启动、顺带重登）；按钮文案感知状态：running+port → "打开 DSH Web UI"，否则
  "⚡ 启动并进入 DSH"；4xx/5xx 解析响应体透传服务端原因（凭证闸/会话类错误说人话），
  结束回调 `loadUserInfo()` 刷新口径。卡片副文案同步改实。
- 残留设计事实（非 bug）：闲置真的满 12h（手机杀掉后台 JS、轮询停摆）仍会掉线——这是
  服务端生死簿的本意；恢复路径 = 引导页 → /user "我的" 钱包登录，或容器 tab 新按钮
  直接签名重登，两条都通。

**补刀（用户复测"还是没有下方的tab"后找到的真根因）**：tab 消失主因不在 cookie 层，
在 **UserCenter 模板的 v-if 互斥链**——`loading → !connected(连接钱包全屏卡) →
waiting(排队卡) → isMobile壳(唯一有 tab 的分支) → 桌面`。会话 401 后
`handleAddressChange` 走 `connected=false`（`:2507` 判例分支明确回未连接态），模板即
切到"连接钱包"卡：**整个移动壳连 tab 栏一起被顶掉**，且该卡让手机"装 Chrome 扩展"
（`:27`），移动端根本无从点击恢复。修复（同报障同轮）：

- 连接卡与排队卡均改 `&& !isMobile`——**移动端 tab 壳常驻**为铁律；
- 失联瞬间（watch connected）与首帧开机（onMounted 尾部检查）都自动回落「我的」tab
  ——MobileMe 登录面板（P1 落地的"唯一重登录门"）成为移动失联恢复正门；
- 桌面行为一字不变。市场 tab 匿名可用（公开列表），首页/容器 tab 失联期显示降级态。
- `loading` 全屏卡保留覆盖移动端（瞬态操作进度，非稳态，不构成"挂机跌落"）。

**裁定（2026-11-11）**：移动端进入 DSH Web 一律**同页跳转**（`location.assign`），
不再新开标签——手机标签是孤儿页制造机；系统返回手势回平台壳，SPA 重载会话仍在。
落点 `MobileContainer`：enterDsh 200/302 两支 + reset 回 URL 支（reset 无 URL 时
保留壳内 3s 回读）。桌面端新标签行为不变。副作用红利：`:601` 漏 noopener 的审计
INFO 随 window.open 清零。按钮文案「打开」→「🚀 进入」。

**裁定（2026-11-11 续）：模型配置上移动端**——容器 tab 新增第四子页「模型配置」
（顺序 info/skills/**model**/env）。契约与桌面模型页逐字对齐：GET 只回脱敏态（Key 只写
不读、留空=不改动）；保存为 providers **全量替换**（带 route=更新、新建由服务端分配）；
官方 item 仅可换 Key，旧覆盖残留保存时显式清回官方；恢复默认=DELETE 全清（危险双确认）；
探测=discover 回填模型列表（独立签名不代保存，v-show 保活防丢编辑态，toast 提示点保存
生效）。写/清/探测每次独立领 TENANT_CONFIG 池 nonce——一次操作一次钱包确认。通道改造：
`api/wallet.js` 的 `signChallenge` 泛化用途 URL（默认技能池不动，模型传
`/api/user/config-challenge`）。env-template 定格/上传维持 PC-only 裁定不变。

**幻影键正链（同轮核查发现）**：首页管理八宫格「🤖 模型配置」旧 push `?tab=adm:model`
——管理注册表 admin-tabs.js **从无 model 键**（overview/users/quota/monitor/dsh/envtpl/
cred），模型配置历来是**用户域**页签（桌面 sidebarTabs key:'model'）。旧链移动端落兜底
toast"该管理功能移动端暂未提供"（谎话：既非管理功能、移动也已提供），桌面消费则 activeTab
指向不存在页签。修正：八宫格 push `?tab=model` → applyMobileTabLink 新增 model 分支=
落容器 tab 并经 **initial-sub 一次性接力**穿透子页签（MobileContainer 挂载即消费+
emit 清空，防下次手点误跳；未知值回落 info）。普通用户移动入口=容器 tab 第四子页
（八宫格本就管理员可见，未扩权）。

**移动侧代码审查（2026-11-11）判例**：`cfgRefFor` 曾自加 `MODEL_` 前缀——**判例：凡
服务端存在规范派生体（credentialRefFor 等），客户端复刻必须三方核对（服务端定义、
服务端消费点、桌面复刻件），不得自创**。前缀错则探测读容器里不存在的 `MODEL_*_API_KEY`，
已存 Key 端点永远探空。同时修正移除端点确认文案（旧承诺"key 保留"与 setProviders
全量替换真删 key 的行为相悖，对齐桌面 `user.confirmRemoveEndpoint` 诚实口径）。
GET 回包形状、configure/clear/discoverWithAuth 字段、purpose 池签名互斥、20 端点上限、
深链 fresh-mount 消费时序逐项核验通过。

**移动↔PC 模型配置对比（2026-11-11）四处修正**：①**数据丢失级**——PC 模型行带
contextWindow/maxTokens 数值字段（服务端逐字存储、providers 保存是全量替换），移动
modelsText 只表达 id+名，旧实现保存会抹掉 PC 配的窗口/上限；修正为按 id 从原
item.models 继承两字段（discover 回填清空与 PC 同款）。②校验时机——PC 签名前
validateAll 拦截（名必填/≤64/查重、https、模型 id 重复），移动旧版让服务端报错白烧
一次钱包签名与 nonce；补 `validateCfg` 签名前置。③功能缺项——PC 有"只清官方
Key"（DELETE scope='official-key'，不动端点），移动补按钮+函数。④reset 确认文案补
自定义端点数（对齐 PC confirmResetCustomLine）。核验等价项：save payload 结构、
officialOverride 清空、discover 分流、credentialRef 规范体（前一轮已正）、20 上限、
purpose 池互斥；`syncWalletAccount`（PC 存签名字地址+重取）↔移动保存后
`loadModelConfig` 重取（移动更贴服务端真态）。显示规范化差异（无害）：name==id 时
PC 保留发送、移动省略，服务端均回落显示 id。

## 六、来源说明

本报告由四路子代理深读汇总：后端 src（模块/API 表/生命周期/签名/CAS/定时器）、桌面端前端
（UserCenter+AdminPanel 页签全表）、移动端六组件全量精读、docs+test+deploy+scripts+git log。
详细 API 清单见 [api.md](./api.md)，判权不变量全文见根 README，桌面管理页签语义见
admin-tabs.js 与 EnvTemplatesAdmin/User 组件。
