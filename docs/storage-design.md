# 存储改造设计（MongoDB 集中存储）

> **状态：✅ 方案已拍板（2026-09-14 定稿 → 10-10 对照修订 → 10-10 维护者拍板"全按推荐"，开工）**
> 本期范围：**本地测试先行**——服务器暂不部署 Mongo；改造期间平台照常跑文件，Mongo 灰度验证（P3）通过后切换。
> 已确认前提：单前端入口（控制面）+ 租户容器分布多宿主机（数据面）+ 业务数据集中存储；后续可能分布式部署。
> 关联：`docs/usage-limit-design.md`、`docs/cwt-access-design.md`、`docs/security-hardening-plan.md`

## 0. 拍板记录（2026-10-10，全部按推荐）

| #   | 决策                           | 结论                                                                                                                                                                            |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 异步化范围                     | 服务层直接 `await` 一次到位，不走同步双轨                                                                                                                                       |
| D2  | Mongo 形态                     | 本地**专用单成员副本集**（27018），不动既有 brew 服务（其上有 `skywell_hash` 等业务库）；服务器本期不部署                                                                       |
| D3  | 归档                           | 迁移后 `data/` + `state.json` 保留为归档，不自动删；校验通过才写 `schema_version`                                                                                               |
| D4  | 测试连接                       | vitest `globalSetup` 托管起停本机原生 mongod 专用实例（不依赖 docker 镜像拉取，无 memory-server 数百 MB 下载）                                                                  |
| D5  | 切换方式                       | json/mongo **双 provider 灰度**，M3 全绿后删除 json 写路径                                                                                                                      |
| D6  | **不引入 Web 框架**（Nest 等） | 维持零框架纯 JS；以"框架化纪律"替代：Store 接口化 + deps 组装点 + admin 路由表驱动（M0 落地）。重新评估触发条件：路由文件 >2000 行×3 / 并发开发者 >3 / 需 express 生态中间件 ≥3 |
| P4  | `audit` 保留策略               | 90 天 TTL（`at` 索引 `expireAfterSeconds: 7776000`）                                                                                                                            |
| P5  | `usage._id`                    | 复合对象 `{address, date}`（天然防同日重复）                                                                                                                                    |
| P6  | `audit` ops 记录               | `details.address` 拉平为顶层 `actor`                                                                                                                                            |
| P7  | `settleUsage`                  | 改造时顺带修"先清表针再累加"的重复计量隐患，纳入 M2-user 块                                                                                                                     |

## 1. 目标与非目标

### 目标

1. **业务元数据集中存储**：用户/会话/CWT/技能/用量/审计/台账从本地 JSON 迁入 MongoDB，多入口实例可共享同一份数据。
2. **真事务**：CWT 审批、端口分配+落库、用量结算原子化。
3. **消除写放大**：按文档粒度更新，不再整表重写 `state.json`。
4. **schema 版本化**：`meta.schema` + 启动迁移器，字段演进有标准流程。
5. **分布式演进路径**：单成员副本集 → 三节点副本集 → 分片，代码侧无感。

### 非目标

- **容器跨宿主机管理**：docker.service 仍操作本机 Docker CLI（独立议题）。
- **租户卷/补丁文件集中**：`dsh-data-swtc-*` 卷与 `patches/*.yml` 留宿主机（§4.2 物理约束）。
- **前端改动**：无。API 契约不变。
- **性能优化**：当前数据量（百级用户）性能收益≈0。买到的是**多实例共享、跨文件原子性、日粒度历史留存**三件事。
- **服务器部署**：本期只做本地；服务器 mongod 与切换属下一期。

## 2. 现状要点（实测复核）

- `state.json` 在**仓库根**（非 data/），每次状态变化整表重写；`saveState` 触点实测 **31 处**（user.service.js），全项目写触点 ~60+。
- `usages` 在文件结构下**跨日互相覆盖**（`rec.date!==today` 视为 0 后整条覆写）——昨日用量实际丢失。独立集合后天然逐日留存。**usage 的写入是事件驱动结算（生命周期 10 个 settle 点），不是高频分钟写**——独立动因是历史留存，不是写频。
- CWT 审批 = registry + applications + records + state 多次独立写，无原子性。
- 会话清理靠手写过期循环；ops/cwt 两个 append 日志永不清理。
- 测试基线：**47 文件 / 729 用例**。
- 迁移预览已实测通过：`scripts/migrate-to-mongo.mjs` 124 条 9 集合全对，源文件全程只读。

## 3. 架构

```
[浏览器] ──> 入口 Node 实例 ×N ──> MongoDB 单成员副本集(27018) → 三节点 → 分片
                                        collections: users / meta / sessions /
                                        cwt_registry / cwt_applications / audit /
                                        usage / skills / skill_installs
        │
        ▼ (docker CLI 本机；patches/*.yml 仍从宿主文件挂载)
  宿主机：租户容器 + dsh-data-swtc-* 卷（不变）
```

## 4. 数据模型（9 集合合同）

### 4.1 迁移域

| 集合               | `_id`            | 来源                                           | 文档形态与索引                                                                                                                                                                                                                                                      |
| ------------------ | ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`            | 地址(34)         | `state.swtcUsers` + `data/users/<addr>.json`   | port/internalPort/tier/时间戳/containerStatus/baseImageVersion/imageId/requiresToken/lastDshVersion/versionChangedAt/pinnedImage；**冗余 `cwtVerifiedAt`**（审批事务同步维护，豁免判定免跨集合查）；`profile` 并入；`usageStartedAt` 表针。索引 `{containerStatus}` |
| `meta`             | 固定名           | `state` 剩余 + `admin.json` + `dsh-image.json` | 5 个单例文档：`ports{nextPort,availablePorts}` / `cleanup{6旋钮}` / `admin{addresses,history,updatedAt}` / `dsh_image{current,history≤50}` / `schema{version,migratedAt,sourceStats}`                                                                               |
| `sessions`         | sha256(token)    | admin+user 两会话文件**合并**                  | `{scope:'admin'\|'user', address, expiresAt}`；**TTL `expiresAt@0`**；索引 `{scope,address}`                                                                                                                                                                        |
| `cwt_registry`     | 地址             | registry.json                                  | usr/wallet/approvedAt/approvedBy/status/revokedAt                                                                                                                                                                                                                   |
| `cwt_applications` | 申请 id          | applications.json                              | token/parsed/sigOk/submittedAt/status；索引 `status`、`parsed.address`                                                                                                                                                                                              |
| `audit`            | ObjectId         | operations.log + records.log **合并**          | `{kind:'ops'\|'cwt', at(时间统一), actor(ops 的 details.address 拉平), …原字段}`；索引 `{at:-1}`、`{kind,address,at:-1}`；**90 天 TTL**（P4）                                                                                                                       |
| `usage`            | `{address,date}` | `state.usages`                                 | `{minutes}`；P5 复合主键防同日重复                                                                                                                                                                                                                                  |
| `skills`           | 技能名           | skills/index.json entries                      | 市场目录（当前空）                                                                                                                                                                                                                                                  |
| `skill_installs`   | 地址             | installs.json                                  | `{skills:[{name,source,installedAt,contentHash,size}]}`                                                                                                                                                                                                             |

**`meta` 准入纪律（四条全满足才准进，违者开新集合）**：
① 全局单例；② 只按 `_id` 点查、无需二级索引；③ 体积小且**增长有界**（`dsh_image.history` 有 slice(-50) 封顶）；④ 不是任何查询主体。新状态入库评审逐条对照。

**已否决的进一步合并**：`cwt_registry`+`cwt_applications`（复合 _id 字符串区分命名空间，主键语义烂掉）；`skill_installs` 并入 `users`（技能服务写操作与租户状态同文档争用）。9 集合是清晰度底线。

### 4.2 不迁移清单（物理/安全约束）

| 数据                     | 位置                      | 原因                                                                      |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------- |
| 租户补丁                 | `patches/swtc-<addr>.yml` | **物理约束**：`docker create -v` 挂载宿主路径进容器，容器要文件不要数据库 |
| 卷备份                   | `data/backups/*.tgz`      | 二进制归档，走 mongodump 之外的链路                                       |
| 平台配置                 | `config.json`             | 0600 + 启动前需可读（鸡生蛋）；`MONGODB_URI` 走 env 注入凭据              |
| 挑战池/签名 pending      | 进程内存                  | 5 分钟 TTL 临时态                                                         |
| npm-cache/技能正文文件区 | 本地目录                  | 缓存与工件，非业务元数据                                                  |

## 5. 存储层设计

### 5.1 接口与组装（D6 纪律落点）

- 新增 `src/services/mongo.store.js`：连接单例 + 9 集合读写（异步）+ `withTransaction(fn)` + 迁移器入口。
- **Store 接口化 + deps 组装点**：服务层经 `server.js` 启动时组装的依赖拿 store，不再散落 `import` 单例（穷人版 DI，兼容 provider 灰度 P3）。
- 服务层调用点全部 `await`（D1）：`user.service`（31 触点）、`cwt.store`/`cwt-admin`、auth 中间件 sessions、`skill.service`、dsh-image 台账读写。
- admin 路由顺手表驱动化拆分（M0 框架化纪律之一）。

### 5.2 事务边界（依赖副本集，P1 已备）

```
① CWT 审批 = cwt_registry + cwt_applications + audit + users.cwtVerifiedAt
② 容器创建/销毁 = users + meta#ports（消灭端口竞态）
③ 用量结算 settleUsage = 先清表针再累加（P7 修重复计量），usage + users 单事务
```

**【R1 硬约束】多文档事务只在 replica set 可用**。本地专用实例：

```bash
mongod --replSet dsh-rs --port 27018 --dbpath <专用目录> --logpath <日志> --bind_ip 127.0.0.1 --fork
mongosh --port 27018 --eval 'rs.initiate({_id:"dsh-rs",members:[{_id:0,host:"127.0.0.1:27018"}]})'
```

### 5.3 缓存与多实例边界

高频读（豁免判定、registry）维持内存缓存 + 写直达；多实例缓存失效 v1 容忍 ≤1s 陈旧（写后主动失效不做广播）。

## 6. 迁移策略（三态幂等）

```
启动时读 meta.schema：
  无 + 本地有 JSON  → 全量导入 → 逐域行数校验 → 写 schema（失败则拒绝启动）
  有 schema         → 跳过（幂等）
  有 schema + 本地又有新数据 → 以 Mongo 为准，告警
归档（D3）：data/ 与 state.json 保留原样不删。
```

预览脚本 `scripts/migrate-to-mongo.mjs` 已验证此路径（124 条全对）；M1 正式迁移器以它为底，加启动钩子与校验门禁。

## 7. 配置

```jsonc
{
  "storage": {
    "provider": "json", // D5 灰度：默认 json，验证后切 "mongodb"
    "mongodbUri": "mongodb://127.0.0.1:27018/dsh?replicaSet=dsh-rs", // MONGODB_URI env 优先
    "dbName": "dsh", // 测试库 dsh_test
    "archiveAfterMigration": true,
  },
}
```

- 依赖仅 `mongodb` 官方驱动（纯 JS 无编译，与零框架传统不冲突；不引 mongoose/ODM/TS/Nest）。
- Node 兼容垫（crypto polyfill）经验证保留在脚本层。

## 8. 落地步骤（每块独立提交，测试全绿才进下一块）

```
M0 地基：mongodb 依赖 + config.storage + mongo.store.js + deps 组装点 + 专用副本集实例(27018)   ~1 天
M1 迁移器：三态幂等 + 逐域校验 + 启动钩子失败拒启（含 dsh_image/audit 归一逻辑）                ~1 天
M2 服务层五块（每块一提交）：user(31 触点+P7) → cwt+事务 → sessions+TTL → skills → dsh_image    ~3 天
M3 测试：mongo-store 新测（globalSetup 原生 mongod，库隔离 dsh_test）+ 729 基线保绿             ~1-2 天
M4 本地配套：mongod 启停脚本 + mongodump 备份演练 + README/security-hardening 文档更新          ~0.5 天
```

> 约定：不擅自 commit/push（提交节奏维护者逐批指示）；每块完成报验收。

> **执行状态（2026-10-12）：M0–M4 全部完成** ✅
> M0 `27d68a2` · M1 `07dd2e9` · M2 五块 `73ac7a2/488c513/fc12d85/96add86/2e290de` ·
> M3 `9c9f408/f5afafd/1ca1ecb`（基线 54 文件 / 781 用例全绿，35 个真库用例经
> globalSetup 自包含执行）· M4 `e4c2a3b/253924b` + 本文档更新。
> 本机已在 mongodb 形态灰度实跑（库 `dsh_prod`，首迁对账 7/7、恢复演练 8/8、
> SIGTERM 排空与重启 skipped 实测过）。**json 写路径暂留**——按 D5 约定待灰度
> 观察期稳定后再删，删除前它仍是全量回归的安全网。

## 9. 诚实边界

1. 服务层 ~60+ 写触点异步化是主要工作量与回归风险（M2 分五块消化）。
2. 多实例缓存陈旧 ≤1s（v1 已知边界）。
3. 本地 mongod 是新增运维件（启停脚本+备份脚本配套，M4）。
4. 容器与 patches 仍绑宿主机；真多机调度是后续议题（届时需要 patches 渲染器）。
5. json provider 灰度期双轨维护成本——M3 全绿后删 json 写路径终结双轨。

## 10. 分布式演进

| 阶段       | 形态                        | 改动                                                  |
| ---------- | --------------------------- | ----------------------------------------------------- |
| M0（本次） | 单成员副本集 + 多实例可共享 | 存储层 MongoDB 化                                     |
| M1         | 三节点副本集                | 仅部署层：uri 指多节点 + `writeConcern:majority`      |
| M2         | 分片                        | 按 `users._id` 哈希分片，代码无感                     |
| 后续       | 容器跨宿主机                | 独立议题（docker 远程管理 + 卷集中 + patches 渲染器） |
