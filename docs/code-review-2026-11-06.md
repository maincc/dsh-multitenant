# 全代码审查纪实 · 2026-11-06

## 方法

工作流扇出：**12 分区并行审查 → 每条发现独立实物复核**（复核员读现场 ±40 行防幻影）。
审查基准=本仓八铁律 + 当日实案模板（升级/降级半拉子不对称、插件材料静默蒸发、定时器不配平、exact-match 幻影）。

**总账：提出 41 → 实物确认 38 · 待人工裁定 3 · 驳回 0**（复核员纠偏一处行号引用）。
抽验：高严重度 4 条全部我本人二次现场对质属实。

## HIGH（4 条 · 建议即修）

| #   | 位置                                                | 案情                                                                                                                                                                 | 建议                                                                                                                        |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| H1  | `frontend/src/views/AdminPanel.vue:2235`            | `diskScanning` 全文件 6 处引用**零声明**——磁盘扫描钮一点必抛（判例 badgeFor 同族：模板/setup 缺名，构建全绿运行时炸）                                                | `const diskScanning = ref(false)` 一行补声明                                                                                |
| H2  | `frontend/src/components/EnvTemplatesAdmin.vue:467` | 代格**预检 dryRun 裸 POST** `env-commit`，服务端签名闸 (:826) 先于 dryRun 分支 → 现在点预检=403，功能已断                                                            | dryRun 领 `signAdminOperation('env-commit')` 同款票，或闸为 dryRun 单开免签只读口（意图=只读预览不落库）——建议后者+注释记由 |
| H3  | `src/routes/skill.routes.js:250`                    | 技能下架 `hide` 仅 requireAdmin 无当场签名；service 端 `unpublish→rmSync` **物理删正文**（:588 存证式缺失同案）。同站 CSRF 可毁他人共享技能                          | 入签名白名单 + 下架改存证式（对齐 env revoke 判例）                                                                         |
| H4  | `src/middleware/admin-signature.middleware.js:126`  | `env-commit` binding 只签 addr+slug，**include/scrubKeep/plugins 未入绑定**——违反本文件 :82 自订"binding 必须覆盖全部可变语义位"纪律（签"不随行"执行"全随行"偷换面） | binding 并入 include 集合哈希与 scrub 旗标                                                                                  |

## MEDIUM（13 条）

| 位置                                                       | 案情一句话                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/middleware/user-auth.middleware.js:111`               | 会话 cookie 正则未锚定，名字以 `user_session` 结尾的杂 cookie 可抢占解析（48 处 requireAdmin/getUserSession 共用面）；:116/:128/:232 同正则登出错删                                                   |
| `src/routes/user.routes.js:869`                            | 该重端点无限流（对照 :45 max20、tenant max10）；且挑战池全局单 Map，10k 满=跨用途连带 503                                                                                                             |
| `src/routes/user.routes.js:601`                            | 快照覆写窗：revert 路径有新鲜读判例、此 patch 走 $set 全量——并发写互相吞                                                                                                                              |
| `src/routes/admin.routes.js:105`                           | 领挑战入口无 rateLimit 无会话前置（全局单池被灌）                                                                                                                                                     |
| `src/routes/skill.routes.js:152`                           | 匿名市场 GET 逐条起 `docker run` 探针（180s 超时×无配额）——公开 sharer 地址可放大打宿主                                                                                                               |
| `src/services/skill.service.js:332/588`                    | mongo 轨 `readInstalls()` 返活数组引用，`recordInstall` 原地 push → gone 误含新记录；unpublish 路径 rmSync 无存证、`status:'removed'` 全仓无写家（"含 removed"注释系幻影）                            |
| `src/services/list-skills.mjs:43/59`                       | skills 目录 catch 即弃仍 `ok:true` 出空名单 → 上层判"实物没有"→ **整户销账**（违"查不了≠没了"）；symlink 目录不列                                                                                     |
| `src/services/install-skill.mjs:40/42`                     | tmp 名用 `process.pid`（容器内恒 1，并发互踩）；按名 rm flat 文件无存证（判例 55 同族漏网）；宿主侧 :209 已修 randomBytes，卷侧漏改——又一半拉子                                                       |
| `src/services/env-install.mjs:85/92`                       | tar 支 expect 只比名集合不比 sha256（头纪律承诺落空）；校验写同循环见 error 即 throw 无回滚=半拉子装；`user.routes:777` 正则拒单文件插件形态 → 老包无对账直 rm                                        |
| `src/services/env-commit.service.js:305`                   | `out['__proto__']` 赋值触发 setter 不落键 → 幻影名入账本（判例 57-H2 同族：probe/probe-plugins 已修，此处漏网；`normEnvNames:46` 放行）                                                               |
| `src/services/env-inventory.mjs:76`                        | statSync 无 per-entry catch：断链 ENOENT 炸整面（头纪律自书"lstat 直出"，:88 插件段已用 lstatSync——口径自相矛盾）                                                                                     |
| `frontend/src/views/AdminPanel.vue:1766/2893`              | 成功分支漏 `startPolling`（数据自动刷新死锁在 dataRefreshInterval 初值）；embedded 初始 externalTab 无 immediate watch → cwtTotal 首屏不赋值，红点搭车断源                                            |
| `deploy/rsync-upload.sh:42` + `deploy/install.sh:232/156`  | UPLOAD_DATA=1 时 `--delete` 无 data/ 排除线=服务器多余文件物理删（告警只写"覆盖同名"，轻描）；build 上下文无 .dockerignore（data/keys 188M 进上下文）；admin 地址无 env 通道，重跑 install 静默失效面 |
| `scripts/mongo-rs.sh:79` + `scripts/mongo-backup.sh:51/71` | rs.sh 裸调 mongosh 无预检——无 mongosh 机器上误杀刚拉起的健康 mongod（**今日 04:00 实发**）；backup :51 空快照 pipefail 退 2 死码杀脚本；:71 "只可能变少"注释方向反、精确等必假红                      |

## LOW（9 条，摘要）

`skill.service.js:434` mine() 二次探针无去重（性能）；`middleware/rate-limit:2` 头注"滑动"实为固定窗口（账实漂移）；`admin-signature:40` ADMIN_SIGNED_OPERATIONS 死数组零引用且清单与实签面漂移（env-commit 等六项不在、'user-downgrade' 无签发方）；`admin-signature:147` dsh 镜像 binding toLowerCase 与 select 原样铁律相左（实害窄）；`EnvTplAdmin:357` 签名材料校验缺位（对照 AdminPanel:1885 已修版——第三次半拉子）；`UserCenter:1629` 裸传材料（闸在 AdminPanel 侧，svc 先 consume 后 verify）；`AdminPanel:363/369/375` 猜数残存 3 处（??兜底=账实一致反例）；`AdminPanel:2065` toast+throw 叠报双弹；`setup-hooks.js:34` 文件名空格展开噪声（方向安全）。

## 待人工裁定（3 条）

1. `skill.routes.js:121` GET `/api/skills/mine` 公开视图含实物名单/插件——**注释与测试表明有意免签**；要不要按"读面最小化"收紧，产品裁。
2. `tenant.routes.js:331` 本人销毁容器免签——:328 明书"历史契约"有意裁定（保卷仅毁容器）；维持 or 补签弹窗，裁。
3. `admin.routes.js:831` 代格 commit 不采 provenance（作者自述恒 null）——代格面该不该转述作者声明，产品意图裁。

## 结构性判语

38 条确认里**「半拉子不对称」占七个案发现场**（升降级、宿主/卷 tmp、probe 三兄弟 **proto**、lstat 口径、材料校验三处两套……）——补丁时只修了病灶半边是最大母题。**修任何一条时，先 grep 它的孪生面**。

复核纪律自证：0 幻影入库（一处行号被复核员纠偏）；HIGH 4 条另经主会话本人对质。

—— 判例 58 入册。
