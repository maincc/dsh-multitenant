# 存储改造设计（MongoDB 集中存储）

> **状态：📋 方案待确认（2026-09-14，分支 change_storage）**
> 目标读者：dsh-multitenant 维护者
> 已确认前提：
>
> - **部署形态**：单前端入口（控制面）+ 租户容器分布于多台宿主机（数据面）+ 业务数据集中存储
> - **后续可能分布式部署**：存储层需天然支持多实例共享与水平演进
> - 因此存储介质选择 **MongoDB**（文档型、网络访问、副本集/分片演进路径清晰）
>   关联：`docs/usage-limit-design.md`、`docs/cwt-access-design.md`、`docs/security-hardening-plan.md`

## 1. 目标与非目标

### 目标

1. **业务元数据集中存储**：用户表/会话/CWT/技能索引/用量等从本地 JSON 文件迁入 MongoDB，多入口实例可共享同一份数据。
2. **真事务**：CWT 审批、容器状态流转等多文档写操作原子化（消除现有"跨文件无事务"风险）。
3. **消除写放大**：不再整表重写 `state.json`，按文档粒度更新。
4. **schema 版本化**：引入 `schema_version` + 启动迁移器，后续字段演进有标准流程。
5. **为分布式预留演进路径**：单节点起步 → 副本集（高可用）→ 分片（扩容），代码侧无感。

### 非目标（本次不做，单列后续议题）

- **容器分布式管理**：docker.service.js 目前操作本机 Docker CLI；容器跨宿主机调度/远程管理（agent / swarm / ssh 远程）是独立的大改造，不在本次存储范围内。
- **租户卷数据迁移**：`dsh-data-swtc-*` 卷仍留在各宿主机本地（数据面）。是否集中到共享卷/对象存储，待容器分布式议题一并决策。
- **前端改动**：无。所有变化收敛在后端存储层，API 契约不变。

## 2. 现状与问题（摘要）

| 现状                                                        | 问题                             |
| ----------------------------------------------------------- | -------------------------------- |
| `state.json` 每次状态变化**整表全量重写**                   | 写放大，数据量大后性能劣化       |
| CWT 审批 = registry + applications + records + state 多次写 | 无事务，中断可能不一致           |
| 数据文件存宿主机本地磁盘，路径硬编码                        | 多入口实例无法共享；部署不可配置 |
| 无 schema 版本/迁移框架                                     | 字段演进无标准流程               |
| 备份靠外部 tar 脚本                                         | 运行中打包可能拿到中间态         |

## 3. 目标架构

```
[浏览器] ──> 入口 Node 实例 A ──┐
[浏览器] ──> 入口 Node 实例 B ──┼──> MongoDB（集中存储，单节点→副本集→分片）
                              │         collections:
[浏览器] ──> 入口 Node 实例 N ──┘           users / sessions / cwt_* / skills / usage ...
        │
        ▼  (docker CLI，本地)
  宿主机 A/B/C：租户容器（dsh-data-swtc-* 卷留本机）
```

- **元数据**（用户表、会话、CWT、技能索引、用量、审计）→ MongoDB 集中。
- **容器与租户卷** → 宿主机本地（本期不变）。

## 4. 数据模型映射（JSON 文件 → MongoDB collection）

| 现有文件                                                                       | Collection                                                                               | 说明                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `state.json`（swtcUsers / nextPort / cleanupPolicy / availablePorts / usages） | `users`（每条 swtcUser 一文档）、`meta`（nextPort/availablePorts/cleanupPolicy：单文档） | 按用户文档粒度读写                                              |
| `data/config/sessions.json`                                                    | `sessions`（TTL 索引自动过期）                                                           | `{ _id: sha256(token), address, expiresAt }`                    |
| `data/config/user-sessions.json`                                               | `user_sessions`（同上）                                                                  | 同上                                                            |
| `data/config/admin.json`                                                       | `admin`                                                                                  | `{ _id: 'config', addresses, history, updatedAt }`              |
| `data/cwt/registry.json`                                                       | `cwt_registry`                                                                           | `{ _id: address, usr, wallet, approvedAt, approvedBy, status }` |
| `data/cwt/applications.json`                                                   | `cwt_applications`                                                                       | `{ _id: id, token, status, ... }`                               |
| `data/cwt/records.log`                                                         | `cwt_records`（append-only 文档）                                                        | 审计记录                                                        |
| `data/logs/operations.log`                                                     | `ops_log`                                                                                | 操作日志                                                        |
| `data/skills/index.json` + 技能文件                                            | `skills`（元数据）+ `skill_files`（GridFS 或直接 BSON 存正文）                           | 技能正文可选 GridFS                                             |
| `data/installs.json`                                                           | `skill_installs`                                                                         | `{ _id: address, skills: [...] }`                               |
| `data/users/<address>.json`                                                    | 并入 `users` collection（`user.profile` 字段）                                           | 用户明细                                                        |

## 5. 存储层设计：MongoStore 抽象

### 5.1 接口兼容策略

现有 `DataService` 是同步 API（`readFileSync`/`writeFileSync`），全部服务层同步调用。MongoDB 是异步 API。改造方案：

- 新增 `src/services/mongo.store.js`：`MongoStore` 类，封装连接管理（单例）+ 各集合读写方法（**异步**）。
- 服务层调用点改为 `await`：
  - `user.service.js`：`loadState()` → `await mongoStore.loadUsers()` + `loadMeta()`；`saveState()` → 拆分为按文档更新 `updateUser(address, patch)` / `updateMeta(patch)`。
  - `cwt.store.js`：`saveCwtRegistry` → `await replaceRegistry()` 等。
  - `auth.middleware.js` / `user-auth.middleware.js`：sessions 落库异步化。
- **兜底模式（可选）**：`MongoStore` 实现同签名同步读缓存 + 写入队列；先把 I/O 收敛到 store 内部，逐文件迁移。**推荐直接走异步改造**（触点已统计：约 36 处写调用，集中在 5 个文件），一次到位避免双轨。

### 5.2 事务边界

- **CWT 审批**（approve/revoke）：`cwt_registry` + `cwt_applications` + `cwt_records` + `users.cwtVerifiedAt` 放入同一 session 事务。
- **容器创建/销毁**：`users` 状态 + `meta.nextPort/availablePorts` 放入同一事务（消除可用端口分配与用户落库之间的竞态）。
- 事务失败整体回滚，重试幂等（操作 handler 已有幂等设计基础）。

### 5.3 一致性/缓存策略

- 高频读路径（豁免判定：`users.cwtVerifiedAt`、registry）维持**内存缓存 + 写直达**（与现状一致），但写入经由 Mongo 事务。
- 多实例场景：缓存失效采用"短 TTL + 写后主动失效广播"（v1 不做广播，容忍 ≤1s 陈旧；在设计中标注为已知边界）。

### 5.4 权限与备份

- **连接安全**：`MONGODB_URI` 支持带认证 URI；建议专用库/用户，最小权限。
- **备份**：`mongodump` 或 Atlas 快照替代 tar；单点写入时事务保证快照一致。
- **0600 权限**：数据不再落本地明文文件，密钥/凭据只存在于 MongoDB 与内存；保留 `config.json` 0600（含连接串场景下改由 env 注入）。

## 6. 迁移策略（JSON → MongoDB）

```
启动检查（幂等，damage-free）：
1. 连接 MongoDB，读 mongo 侧 meta.schema_version
2. 若为 0（空库）且本地存在旧 JSON 数据：
   a. 全量读取 state.json / data/** 各 JSON 文件
   b. 按 §4 映射写入 collections（单次事务或批量）
   c. 写 schema_version = 1
3. 若本地 JSON 仍在，搬迁完成后标记（保留 data/ 原文件不删，进入"归档"状态，
   退出确认后再清理；或由 CONFIG.storage.archiveAfterMigration 控制）
4. 若 mongo 侧已有新数据且本地也有 → 以 mongo 为准（已迁移标志位防止重复导入）
```

- 迁移在入口启动流程 `startup` 阶段执行，失败则拒绝启动（避免半迁状态服务）。
- 单测覆盖：空库+有JSON、有库+有JSON、空库+空盘 三态。

## 7. 配置（config.json 新增）

```jsonc
{
  "storage": {
    "provider": "mongodb", // 预留 "json"（回退单机模式）
    "mongodbUri": "mongodb://127.0.0.1:27017/dsh", // 或环境变量 MONGODB_URI 覆盖
    "dbName": "dsh",
    "archiveAfterMigration": true, // 迁移后 data/ 是否保留为归档
    "cacheTtlMs": 1000, // 豁免判定等高频读的内存缓存 TTL
  },
}
```

- `MONGODB_URI` env 优先于 config.json（部署侧注入凭据，不入仓库）。
- **依赖**：新增 npm 依赖 `mongodb`（官方驱动，纯 JS，无原生编译负担）。

## 8. 分布式演进路径

| 阶段       | 形态                            | 改动                                                                                         |
| ---------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| M0（本次） | 单 MongoDB 节点 + 单/多入口实例 | 存储层 MongoDB 化 + 迁移 + 事务                                                              |
| M1         | 副本集（≥3 节点）               | 仅部署层：`mongodbUri` 指向 replica set + `writeConcern: majority`；应用代码加 `retryWrites` |
| M2         | 分片集群                        | 按 `users` 地址哈希分片；应用代码无感                                                        |
| 后续       | 容器跨宿主机                    | 独立议题：docker 远程管理 + 租户卷集中                                                       |

## 9. 实现触点（文件/函数/测试）

### 后端（核心）

- **新增** `src/services/mongo.store.js`：连接管理 + collections 读写 + `withTransaction(fn)`（session 事务封装）+ 迁移器入口。
- `src/services/data.service.js`：保留（供归档读/回退/迁移源），写路径逐步切到 mongo。
- `src/services/user.service.js`：`loadState/saveState` 重构为文档级异步读写（约 14 处 saveState 调用点改造）。
- `src/services/cwt.store.js`、`src/services/cwt-admin.service.js`：写路径异步化 + 事务。
- `src/middleware/auth.middleware.js`、`src/middleware/user-auth.middleware.js`：sessions 落库异步化。
- `src/services/skill.service.js`：index/installs 落库异步化。
- `src/config/config.js`：`storage` 配置段。
- `src/routes/*.routes.js`：仅当 handler 依赖同步状态的地方核对（多数无需改签名，触点为服务层）。

### 测试

- **新增** `test/mongo-store.test.js`：连接（可用 mock/memory server）、迁移三态、事务回滚。
- **改造**：现有 `data.test.js`、`cwt-store.test.js` 等存储相关单测适配异步 I/O；其余 255 用例套件保持全绿目标。
- 测试数据库隔离：`dsh_test` 库 + 每用例清空。

## 10. 诚实边界

1. **异步化面**：服务层约 36 处数据写调用点需改 `await`，是本改造主要工作量与回归风险点。
2. **内存缓存多实例陈旧**：v1 不做跨实例缓存失效广播，豁免/会话判定在多数派写后最多陈旧 ≤1s（写直达 + TTL）。
3. **本地归档保留**：迁移后 `data/` 仍留在各宿主机（归档），不会自动删除，避免误删风险。
4. **MongoDB 运维引入**：需要部署/监控一个 MongoDB（或托管 Atlas）；这是本次改造新增的外部依赖，部署文档与备份流程需配套更新。
5. **容器分布仍是后续议题**：本期完成后"入口共享数据"达成，但容器仍绑定各自宿主机；真正多机容器调度不在本方案内。

## 11. 落地顺序

```
M0 存储层：mongo.store.js（连接/读写/事务）+ config.storage + 依赖安装
M1 迁移器：JSON→Mongo 三态迁移 + 启动钩子
M2 服务层切换：user / cwt / auth / skill 四大块异步化（每块可独立提交）
M3 测试适配：mongo-store 单测 + 存量用例回归（目标 255+ 全绿）
M4 部署：MongoDB 部署脚本 + 备份（mongodump）+ README/security-hardening 更新
```

> 每步独立可提交、可回滚；M0–M2 完成后即可切 provider 上线，M4 为运维配套。

## 12. 阶段任务清单（⏳ 待处理，2026-09-14 归档）

> 状态：**已定方案，未执行**。以下为按序展开的可执行任务，每步独立可提交、可回滚；
> 全部完成后由维护者确认后再动工，禁止未确认先行改代码。

### 🔧 M0 —— 存储层地基（依赖 + 连接层）

- [ ] **M0-1 安装依赖**：`npm install mongodb`（官方驱动，纯 JS，无原生编译负担）
- [ ] **M0-2 配置段**：`config.json` 增 `storage` 段（`provider` / `mongodbUri` / `dbName` / `archiveAfterMigration` / `cacheTtlMs`），`MONGODB_URI` 环境变量优先（凭据不入仓库）
- [ ] **M0-3 新增 `src/services/mongo.store.js`**：连接管理（单例）+ 各 collection 读写方法（异步）+ `withTransaction(fn)`（session 事务封装）

### 🔄 M1 —— 迁移器（JSON → MongoDB）

- [ ] **M1-1 三态幂等迁移**：空库+有JSON → 全量导入；已迁（schema_version=1）→ 跳过；双有 → 以 Mongo 为准（防重复导入）
- [ ] **M1-2 启动钩子**：迁移在 `server.js` 启动阶段执行，失败拒绝启动（避免半迁状态服务）
- [ ] **M1-3 迁移单测**：覆盖空库+有JSON / 有库+有JSON / 空库+空盘 三态

### ⚙️ M2 —— 服务层切换（四大块，每块独立提交）

- [ ] **M2-1 user.service.js 异步化**：`loadState/saveState` → 用户文档级读写（约 14 处 `saveState` 调用点改造）
- [ ] **M2-2 cwt.store.js + cwt-admin.service.js 异步化**：registry / applications / records 落库 + 审批/撤销事务（`withTransaction`）
- [ ] **M2-3 auth / user-auth middleware 异步化**：sessions 落 MongoDB（TTL 索引自动过期），替换本地 `data/config/sessions.json`
- [ ] **M2-4 skill.service.js 异步化**：skills 索引 + installs 落库

### ✅ M3 —— 测试适配

- [ ] **M3-1 新增 `test/mongo-store.test.js`**：连接（内存 server / mock）、迁移三态、事务回滚、集合读写
- [ ] **M3-2 存量回归**：现有 24 测试文件 / 255 用例全绿（存储相关测试适配异步 I/O，测试库隔离 `dsh_test`）

### 🚀 M4 —— 部署配套

- [ ] **M4-1 本机 mongod 启动脚本**（`deploy/`，含数据目录/日志配置说明）
- [ ] **M4-2 备份脚本**：mongodump 替代 tar（`deploy/backup.sh` 更新）
- [ ] **M4-3 文档更新**：README / `security-hardening-plan.md` 存储章节（0600→连接安全、备份方式、多实例共享说明）

### 待确认决策点（执行前需拍板）

- [x] **D1 异步化范围**：直接异步化服务层（一次到位，语义清晰，推荐）
- [ ] **D2 MongoDB 形态**：本机 mongod 单节点起步（推荐） vs 托管 Atlas（数据出境需评估合规）
- [ ] **D3 归档处理**：`archiveAfterMigration: true` 保留原 data/ 归档（推荐）+ 迁移校验通过才标 schema_version；后续手动清理

> 约定：M0 起即为代码改动，**不擅自 commit/push**，待维护者明确指示。
