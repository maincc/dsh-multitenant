# 技能市场（Skill Marketplace）设计与任务拆分

> 目标读者：dsh-multitenant 维护者
> 状态：设计评审稿（未动代码）
> 适用范围：本仓库（multitenant 入口服务 + 租户容器），**不改 DSH 本体**

---

## 1. 背景与目标

### 1.1 用户故事

- 作为**租户用户 A**，我在自己容器的 DSH 里写了一个好用的 skill，我希望在 Web 上把它**共享**出去，让其他人也能用。
- 作为**租户用户 B**，我登录 Web 后可以**浏览**共享技能列表、**预览**技能正文，**一键安装**到我的容器里，装完在 DSH 里直接可用（无需重启容器）。
- 作为**租户用户 C**，我在**本地机器**上也装了一台 DSH 并写好了一个技能，我想**直接把技能导入**到服务器上自己的容器里使用，而不用在 Web 上重写一遍。
- 作为**维护者（admin）**，我可以查看谁共享了什么、必要时**下架**可疑技能（prompt 注入防护）。

### 1.2 目标

| 目标                  | 说明                                                                          |
| --------------------- | ----------------------------------------------------------------------------- |
| 最小可用链路          | A 发布 → 宿主共享仓库 → Web 列表/预览 → B 安装 → B 容器内可用                 |
| 纯 multitenant 层实现 | 复用现有 docker/卷/签名/前端机制，零改动 DSH 镜像内逻辑                       |
| 可审计                | 每条共享记录携带分享者地址、时间、内容哈希                                    |
| 安全默认              | 安装/导入技能前可见全文（导入可预览解析结果）；写任意租户卷的接口必须签名鉴权 |
| 本地导入              | 支持"本地 DSH 导出 → 服务器 Web 导入"，与市场安装并列的入库通道               |

### 1.3 非目标（本期不做，留作 P1）

- 全局热更新形态（所有容器挂共享卷 + `customSkillDirs` patch），见 §10.4。
- DSH 原生 HTTP skill provider（中央技能服务）。
- 技能版本化、点赞/评分、评论、搜索词高亮。
- zip 目录包（含 `references/` 等资源）的导入、URL 远程导入（P1/P2，见 §12）。

---

## 2. 现状盘点（对接点，基于现有代码）

| 现状                                                  | 位置                                                                      | 对本功能的意义                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 入口服务手工路由分发                                  | `src/server.js`                                                           | 新加一个 `/api/skills/*` 分发分支即可                           |
| 管理员鉴权（cookie `admin_session`）                  | `src/middleware/auth.middleware.js` + `config.js:isAdmin`                 | 下架/审核走 `requireAdmin`                                      |
| 钱包签名身份认证（nonce + `@swtc/keypairs` 验签）     | `src/services/tenant-config.service.js`（`issueChallenge` / `configure`） | **发布/安装的鉴权底座，直接复用挑战池模式**                     |
| 租户卷挂载点（`dsh-data-swtc-<addr>` → `/dsh-home`）  | `docker.service.js:createContainer`、`utils/address.js:swtcVolumeName`    | 用户技能根 = 卷内 `/dsh-home/skills`                            |
| **卷内脚本执行**（`runVolumeScript`，挂卷跑宿主脚本） | `docker.service.js:runVolumeScript`                                       | **提取/写入技能文件的核心通道**，与 `merge-settings.mjs` 同模式 |
| 宿主数据持久化（原子 JSON）                           | `src/services/data.service.js`（`data/` 目录）                            | 共享技能元数据与安装记录落点                                    |
| 前端 Vue 3 + vue-router + axios                       | `frontend/src/`（views: Home/AdminPanel/UserCenter）                      | 新增 /skills 视图 + "我的技能"区块                              |
| 测试：node 内置 test runner                           | `test/*.test.js`（如 `routes.test.js`）                                   | 新服务配套单测沿用风格                                          |

### 2.1 两个关键事实（决定方案形态）

1. **用户技能根目录固定**：容器内 `DSH_HOME=/dsh-home`（Dockerfile `ENV`），而 skill-filesystem provider 的用户根是 `$DSH_HOME/skills`，即 `/dsh-home/skills/<name>/SKILL.md`（或 `<name>.md`）。**只要把文件写进该卷的这个路径，容器内 watcher 会自动发现，无需重启。**
2. **跨卷文件操作已有成熟通道**：`runVolumeScript(volume, script, ...)` 用一次性辅助容器挂载租户卷执行脚本——提取（读）与安装（写）都走它，不经 `docker exec`，不依赖运行中的容器。

---

## 3. 总体架构与数据流

```
┌─────────────┐  ① 用户在 Web 点"共享"+钱包签名   ┌──────────────────────┐
│ 租户 A 容器  │ ───────────────────────────────▶ │   入口服务(src/)      │
│ 卷:/dsh-home │                                │  SkillService         │
│ skills/xxx  │◀─ extract-skill.mjs(读卷)────────│  共享仓库 data/skills │
└─────────────┘                                └──────────┬───────────┘
                                                          │ ② 列表/预览
                                               ┌──────────▼───────────┐
┌─────────────┐  ③ Web 浏览/预览 + 签名鉴权    │   前端 /skills 页     │
│ 租户 B 容器  │ ◀── install-skill.mjs(写卷)────│  (Vue3, 新路由)       │
│ 卷:/dsh-home │     ④ 一键安装到 /dsh-home/    └──────────────────────┘
│ skills/xxx  │        skills/<name>/SKILL.md
└─────────────┘
```

**导入支线（本地 DSH → 服务器容器，新增场景）**：

```
本地 DSH (/dsh-home/skills/<name>/SKILL.md)
   │ ① 导出（复制出文件；服务器侧 download 接口同等能力）
   ▼
Web「我的技能 → 导入」上传/粘贴
   │ ② 入口服务校验 frontmatter/命名/体积（复用 src/utils/skill.js）
   ▼
③ 写自己卷 /dsh-home/skills/<name>/SKILL.md（install-skill.mjs）→ DSH watcher 自动发现
   │ ④ 可选
   └──▶「共享到市场」进入发布流程（本地 → 导入 → 共享 → 他人安装，闭环）
```

**组件**：

| 组件           | 形态                                                                           | 职责                                                      |
| -------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 共享仓库       | 宿主目录 `data/skills/<name>/`（技能文件）+ `data/skills/index.json`（元数据） | 单一事实来源                                              |
| `SkillService` | 新 `src/services/skill.service.js`                                             | 发布/列表/详情/安装/卸载/下架/安装记录                    |
| 卷脚本         | `src/services/extract-skill.mjs`、`install-skill.mjs`                          | 在辅助容器内读/写租户卷（与 `merge-settings.mjs` 同模式） |
| API 层         | 新 `src/routes/skill.routes.js`，挂进 `server.js`                              | `/api/skills/*`                                           |
| 前端           | 新 `frontend/src/views/SkillMarket.vue` + UserCenter 增区块                    | 市场页 + 我的技能                                         |

---

## 4. 数据模型

### 4.1 共享仓库布局

```
data/
├── skills/
│   ├── index.json                 # 全量元数据（原子写入）
│   └── <skillName>/               # kebab-case，= 技能唯一键
│       └── SKILL.md               # 或 flat <skillName>.md；正文原文
└── installs.json                  # 安装记录表
```

### 4.2 元数据条目（index.json 数组项）

| 字段                     | 类型    | 必填 | 说明                                                                       |
| ------------------------ | ------- | ---- | -------------------------------------------------------------------------- |
| `name`                   | string  | 是   | kebab-case，`/^[a-z0-9]+(-[a-z0-9]+)*$/`，= 目录名 = frontmatter.name      |
| `description`            | string  | 是   | 取自 frontmatter，市场卡片展示                                             |
| `whenToUse`              | string  | 否   | 取自 frontmatter                                                           |
| `hasResources`           | boolean | 是   | 是否存在 `references/` `scripts/` `assets/` 等扩展（决定卡片"含资源"标记） |
| `sharer`                 | string  | 是   | 发布者 SWTC 地址（小写）                                                   |
| `sharedAt`               | string  | 是   | ISO 时间                                                                   |
| `contentHash`            | string  | 是   | 正文 SHA-256，用于溯源与更新比对                                           |
| `bodyBytes`              | number  | 是   | 正文字节数（配额/风控用）                                                  |
| `status`                 | enum    | 是   | `active` / `removed`（下架）                                               |
| `disableModelInvocation` | boolean | 否   | 透传 frontmatter，用于风险提示                                             |

### 4.3 安装记录（installs.json）

```jsonc
// { <address>: [ { name, source, installedAt, contentHash, size } ] }
// source: 'market'（市场安装）| 'import'（本地导入）
{
  "jabcdef...": [
    {
      "name": "example-skill",
      "source": "market",
      "installedAt": "2026-08-27T…",
      "contentHash": "sha256:…",
      "size": 1024,
    },
    {
      "name": "local-tool",
      "source": "import",
      "installedAt": "2026-08-27T…",
      "contentHash": "sha256:…",
      "size": 2048,
    },
  ],
}
```

用途：我的技能列表、更新提示（比对 hash）、卸载。

---

## 5. API 设计

统一前缀 `/api/skills`，挂到 `server.js`（在用户路由段旁新增分支）。响应沿用 `{ok:true,…}` / `{error, code}` 风格。

| #   | 方法/路径                           | 鉴权                             | 说明                                                                                                                                                                                                          |
| --- | ----------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/skills`                   | 无                               | 市场列表：`[{name,description,whenToUse,hasResources,sharer,sharedAt,contentHash,installed}]`；`installed` 需要 query `?address=` 返回该用户是否已装                                                          |
| 2   | `GET /api/skills/:name`             | 无                               | 详情 + **全文预览**（安装前必看）                                                                                                                                                                             |
| 3   | `POST /api/skills/publish`          | 钱包签名                         | 发布：body `{address, skillName, nonce, signature, publicKey}`；服务端先从该地址卷提取技能，再验签通过后入仓                                                                                                  |
| 3a  | `POST /api/skills/import`           | 签名（地址=目标）                | **本地导入**：body `{address, skillName, fileName, content, nonce, signature, publicKey}`；校验 frontmatter（name 与 skillName 一致/kebab-case/description 非空/≤64KB）后写入该地址卷，记账 `source:'import'` |
| 3b  | `GET /api/skills/:name/download`    | active 技能：无；已装/我的：签名 | **导出**：返回单个 Markdown 文件（备份、本地 DSH 搬运）；zip 打包（含资源）P1                                                                                                                                 |
| 4   | `DELETE /api/skills/:name`          | 签名或 admin                     | 作者取消共享（`sharer==address`，或 admin）→ status=removed，**不删已装用户的副本**                                                                                                                           |
| 5   | `POST /api/skills/:name/install`    | 钱包签名                         | 安装到**自己的**卷：body `{address, nonce, signature, publicKey}`，要求签名地址 == 目标地址（或 admin 代装带 `?to=`）                                                                                         |
| 6   | `POST /api/skills/:name/uninstall`  | 签名                             | 从自己卷删除该技能                                                                                                                                                                                            |
| 7   | `GET /api/skills/mine?address=`     | 签名                             | 我的发布 + 我的安装（含"有更新"标记）                                                                                                                                                                         |
| 8   | `POST /api/admin/skills/:name/hide` | admin                            | 下架（审核/处置），复用 `requireAdmin`                                                                                                                                                                        |
| 9   | `GET /api/admin/skills`             | admin                            | 全量管理视图（含 removed、分享者、安装数）                                                                                                                                                                    |

### 5.1 签名鉴权（复用挑战模式）

与 `tenant-config.service.js` 完全同构：新增 challenge 用途（`publish` / `install`），复用同一 nonce 池与验签函数（`issueChallenge(address, scope)` 增加 scope 参数即可）。**签名覆盖 `address` + `skillName` + `nonce`，防止重放与串改目标。**

> 为什么发布/安装必须签名（而非只读卷验证）：
> ① 发布——卷里存在某技能 ≠ 作者同意共享，需要签名证明"主动分享"；
> ② 安装/导入——这两个接口**都能向任意地址卷写入文件**，无鉴权 = 任何人可污染任何用户卷，是最高危面。签名地址必须等于目标地址。

---

## 6. 关键技术实现

### 6.1 提取技能（读 A 卷）—— `extract-skill.mjs`

```bash
# 内部实现（对应 runVolumeScript 的调用形态）
docker run --rm \
  -v dsh-data-swtc-<addr>:/dsh-home \
  -v $PWD/src/services/extract-skill.mjs:/extract-skill.mjs:ro \
  dsh-multitenant:latest node /extract-skill.mjs <skillName>
```

脚本职责：定位 `/dsh-home/skills/<name>/`（SKILL.md 或 flat .md，无则报"技能不存在"）；输出 JSON `{ name, description, whenToUse, disableModelInvocation, hasResources, bodyBase64, sha256, bytes }`（**内容走 stdout 单次输出，脚本内拼 JSON**，宿主解析 stdout 即可，与 `merge-credentials.mjs` 输出风格一致）。

### 6.2 frontmatter 解析与校验（宿主侧）

- MVP 用**最小自研解析**（`---` 分界 + 键值/布尔），只认 `name/description/whenToUse/metadata/disable-model-invocation/user-invocable`；
- 硬校验：`name` 合法 kebab-case 且**等于请求的目录名**；`description` 非空；非法 frontmatter → 拒绝入仓并返回原因（与 DSH 行为一致：损坏技能不进目录）。

### 6.3 安装（写 B 卷）—— `install-skill.mjs`

- 入参：技能名 + 正文 base64（宿主从共享仓读取传入）；`args` 传递避免额外挂载；
- 写入 `/dsh-home/skills/<name>/SKILL.md`：先写 `.tmp` 再 `rename`（原子）；
- 同目录含 `references/` 等资源时，仅复制正文（资源本轮不复制，卡片标注"资源缺失"）；
- 返回写入后复读的 sha256 供宿主校验。

### 6.4 安全编码（命名/路径/体积）

- 技能名白名单正则（§4.2），**禁止一切路径穿越**（`name` 只允许 `[a-z0-9-]`，绝不拼接用户输入进路径）；
- 体积上限：正文 ≤ 64 KB、技能数 ≤ 200 / 共享者、安装接口按地址限流（如 10 次/小时，复用 `data/stats` 或内存计数）；
- 发布配额：每地址 ≤ 20 个 active 技能。

### 6.5 并发

同卷写操作（安装/卸载）用进程内 per-volume 简单互斥（`Map<volume, Promise>` 链），避免两个安装同时写坏 SKILL.md。

### 6.6 导入（本地 DSH → 服务器容器）

1. **导出（本地侧）**：本地 DSH 的技能即 `/dsh-home/skills/<name>/` 目录，复制出 `SKILL.md`（单文件 MVP）；服务器侧由 `download` 接口提供同等能力，供备份/双向搬运
2. **上传（Web 侧）**：`UserCenter → 我的技能 → 导入`：选择 `.md` 文件或直接粘贴正文
3. **校验**：复用 `src/utils/skill.js` 同一套 frontmatter/命名/体积规则（名必须 kebab-case，且 frontmatter.name 与表单 skillName 一致）
4. **写入**：与市场安装同通道 `install-skill.mjs`，落地 `/dsh-home/skills/<name>/SKILL.md`，`installs.json` 记 `source:'import'`
5. **闭环**：导入成功后同屏出现「共享到市场」入口，衔接发布流程（本地 → 导入 → 共享 → 他人安装）

---

## 7. 安全设计（prompt 注入面）

技能正文会被注入**别人的模型上下文**，本质是受控的 prompt 注入通道。默认防线：

| 防线     | 措施                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| 知情     | 安装前必须预览全文；卡片展示分享者、时间、内容哈希（可复制核对）                            |
| 溯源     | 每条记录含 sharer/sharedAt/contentHash，admin 可审计                                        |
| 处置     | admin 下架接口；`status=removed` 的技能不可再安装、详情页提示"已下架"                       |
| 入口收紧 | 只能从 `dsh-swtc-` 容器卷提取；非法 frontmatter 拒绝入仓                                    |
| 滥用控制 | 发布/安装配额 + 限流（§6.4）                                                                |
| 扩展预留 | `disableModelInvocation` 透传展示；P2 可加"共享技能禁用资源引用"（剥离 references/scripts） |

---

## 8. 前端设计（Vue 3）

### 8.1 路由与视图

- 新路由 `/skills` → `SkillMarket.vue`（市场页）
- `UserCenter.vue` 增加 **"我的技能"** 区块：我的发布（可取消共享）、我的安装（可卸载 / 显示"有更新"）、**「导入技能」**（三步入库：选文件/粘贴 → 校验结果预览 → 钱包签名确认写入，成功后提供「共享到市场」入口）

### 8.2 页面结构（SkillMarket.vue）

```
┌ Header: 搜索框（name/description 过滤）+ 刷新 ───────────┐
│ 技能卡片列表（虚拟滚动预留）                              │
│  每卡: name · description · sharer 缩写 · 已装/未装标记   │
│        [预览] [安装/已安装]                              │
├ 详情抽屉（Dialog）:                                      │
│  元数据 + 风险提示栏（分享者/时间/哈希/含资源标记）        │
│  正文全文预览（只读, max-height 滚动）                    │
│  [签名并安装]（调 CCDAO 插件签名 → install API）          │
└──────────────────────────────────────────────────────────┘
```

### 8.3 依赖

沿用 axios 封装（项目已有）；钱包签名调用方式复用 `UserCenter.vue` 里现成的 CCDAO 插件交互（挑战 → `swtc_signMessage` → `swtc_getPublicKey`）。抽取 `src/api/skills.js` 与 `src/api/wallet.js`（如 wallet 逻辑尚内联，则先随市场页抽出）。

---

## 9. 边界与错误处理

| 场景                                       | 行为                                                                |
| ------------------------------------------ | ------------------------------------------------------------------- |
| A 卷里没有该技能 / 目录损坏                | 发布失败，返回"容器内未找到技能 xxx 或 frontmatter 非法"            |
| A 卷技能 frontmatter.name ≠ 路径名         | 拒绝发布（防伪造身份）                                              |
| 重复发布同名技能                           | 覆盖旧条目（记录新 hash/time），已装用户列表显示"有更新"            |
| B 已装同名技能（自建）                     | 安装前确认：覆盖并备份为 `SKILL.md.bak-<ts>`（提示）                |
| 容器不存在（B 从未创建）                   | 走现有 wait queue 语义：提示"请先连接钱包激活容器"                  |
| 技能被作者下架                             | 列表隐藏；已装用户不受影响                                          |
| 正文含 `disable-model-invocation`          | 卡片展示"仅用户侧可用"标记                                          |
| 安装写入失败                               | 返回错误，installs.json 不记录（写入成功才记账）                    |
| 导入文件 frontmatter 缺失/非法/name 不匹配 | 拒绝写入并**回显具体字段错误**（与 DSH 行为一致：损坏技能不进目录） |
| 导入名称与卷内已有技能冲突                 | 覆盖前确认，备份为 `SKILL.md.bak-<ts>`                              |
| 上传 zip / 填 URL                          | 提示"本期仅支持单个 Markdown 文件"（zip/URL 见 P1/P2）              |

---

## 10. 任务拆分（里程碑）

### M0 — 后端骨架（SkillService + 仓库 + API）

- [ ] `skill.service.js`：共享仓读写（index.json / installs.json 原子写，复用 `DataService` 风格）
- [ ] frontmatter 最小解析器 + kebab-case 校验（`src/utils/skill.js`，纯函数，配套单测）
- [ ] `extract-skill.mjs`（读卷脚本）+ `install-skill.mjs`（写卷脚本）+ `remove-skill.mjs`（卸载脚本）
- [ ] `skill.routes.js`：列表 / 详情 / publish / install / uninstall / mine / 下架 / **import** / download
- [ ] `server.js` 挂载 `/api/skills/*` 分发
- [ ] 测试：`test/skill.test.js`（frontmatter 解析、命名校验、仓库读写、路由分发——参照 `routes.test.js` 风格，卷操作用 mock）

**验收**：curl 可完成 publish → list → detail → install 全程（install 目标用临时测试卷），`data/skills` 与 `data/installs.json` 形态正确。

### M1 — 前端最小可用

- [ ] `/skills` 路由 + `SkillMarket.vue`（列表 / 预览 / 安装，签名复用现成钱包交互）
- [ ] `UserCenter.vue` 加"我的技能"（发布/安装/卸载/更新标记）+ **「导入技能」对话框**（选文件/粘贴 → 预览 → 签名 → 写卷 → 转共享）
- [ ] `frontend/src/api/skills.js`

**验收**：真机走通"A 共享 → B 预览 → B 签名安装 → B 容器 DSH 会话出现该技能（无需重启）"。

### M2 — 安全加固与审计

- [ ] admin 下架/管理列表接口 + AdminPanel 入口
- [ ] 发布/安装配额与限流
- [ ] 风险提示文案与 `disableModelInvocation` 标记

**验收**：无鉴权调用 install/发布被拒；下架技能不可安装；配额生效。

### M3 — 体验完善

- [ ] "有更新"提示 + 一键更新（重装）
- [ ] 卡片搜索过滤、分享者展示
- [ ] admin 审计视图（分享记录、安装统计）

### P1（远期，另行设计）

- 全局共享根：所有租户容器挂同一共享卷 + 按租户 patch 配 `customSkillDirs: ['/shared-skills']`，实现"A 共享即全平台热更新"；需在 `createContainer` 增加挂载参数并重启既有容器。

---

## 11. 总验收标准

1. 用户 A 在 DSH 容器写好技能 → Web 上签名发布 → 市场可见。
2. 用户 B 无需管理员介入，预览正文后签名安装 → 自己容器会话中直接可用。
3. 全程不下线、不重启容器；技能文件落地 `/dsh-home/skills/<name>/SKILL.md`。
4. 每笔发布/安装可溯源（地址/时间/哈希）；admin 可下架任意技能。
5. 所有写卷操作（安装/导入）必须经过签名鉴权；技能名无路径穿越；非法 frontmatter 不入仓。
6. 本地导入链路：本地 DSH 导出 → 服务器上传/粘贴 → 校验 → 签名 → 写入卷 → 会话可见；且可一键转共享。
7. 现有功能回归通过（`npm test` 全绿，前端 build 通过）。

---

## 12. 开放问题（决策点）

| #   | 问题                                                                         | 倾向                                                       |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | 发布是否必须本人在 Web 操作（签名）？还是允许进阶版"从卷自动提取+作者确认"？ | MVP：签名发布（语义正确，成本低）                          |
| 2   | 安装接口的目标地址是否必须 == 签名地址？                                     | 是；admin 代装为例外                                       |
| 3   | 资源目录（references/scripts/assets）本期是否随装？                          | 只装正文，资源标注缺失，P1 再补                            |
| 4   | 是否引入"审核制"（发布需 admin approve 才可见）？                            | 默认"先发后审"（下架兜底），审核开关做成配置项             |
| 5   | frontmatter 解析用最小自研还是引入 `yaml` 依赖？                             | MVP 自研最小解析（仅白名单字段），避免宿主新增依赖         |
| 6   | 导入形态：单文件（.md/粘贴）起步，zip（含资源）何时支持？                    | MVP 单文件（已并入 M0/M1）；zip P1（需解压脚本与资源写入） |
| 7   | URL 远程导入是否做？                                                         | P2 前不做（SSRF + 内容不可控，收益低风险高）               |

---

## 13. 实现落地记录（M0/M1 已完成，与设计的实测差异）

> 状态：M0 后端 + M1 前端已实现，`npm test` 134 通过（新增 24 服务测试 + 7 路由冒烟），前端 `vite build` 通过。以下为落地时的调整。

### 13.1 新增/调整的文件

| 文件                                                                        | 说明                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/utils/skill.js`                                                        | frontmatter 最小解析 + 命名/体积/布尔/legacy 键校验（纯函数） |
| `src/services/skill.service.js`                                             | SkillService（共享仓、安装记录、鉴权、配额、限流）            |
| `src/services/extract-skill.mjs` / `install-skill.mjs` / `remove-skill.mjs` | 卷内读/写/删脚本（辅助容器 + 挂载 `/dsh-home`）               |
| `src/routes/skill.routes.js` + `server.js` 挂载                             | `/api/skills/*` 分发                                          |
| `test/skill.test.js` / `test/skill-routes.test.js`                          | 服务层 + 路由冒烟测试                                         |
| `frontend/src/api/wallet.js` / `api/skills.js`                              | CCDAO 签名挑战 + 技能 API 封装                                |
| `frontend/src/views/SkillMarket.vue` + 路由 `/skills` + 导航                | 市场页（列表/搜索/预览/安装/下载）                            |
| `frontend/src/views/UserCenter.vue`                                         | "我的技能"区块 + 导入对话框（文件/粘贴→签名→写卷）            |

### 13.2 API 实测形态（相对 §5 的差异）

| 差异     | 实现                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| 领取挑战 | 新增 `POST /api/skills/challenge`（与 config-challenge 同模式，nonce 同池）       |
| `mine`   | 实现为 `POST /api/skills/mine`（带签名 body），非 GET                             |
| 管理列表 | `GET /api/skills/admin`（管理员 cookie），非 `/api/admin/skills`                  |
| 下架     | `POST /api/skills/:name/hide`（管理员 cookie），非 `/api/admin/skills/:name/hide` |
| download | 仅 active 技能可下载（"已装/我的签名可下"未细分，P1）                             |

### 13.3 行为决策（相对 §5.1/§6 的调整）

- **签名范围**：实现为签 nonce（地址绑定靠公钥推导），skillName **不参与签名**——因为它天然受约束：发布时名称必须精确对应卷内文件；安装/导入只写签名地址自己的卷。等价于"覆盖 address + nonce + 目标卷"，安全性不减。
- **发布同名规则**：改为**同发布者重发 = 覆盖更新；他人占用同名 = `ConflictError`（拒绝）**，替代原"覆盖旧条目"。理由：防止改名劫持他人技能。
- **服务单测存储隔离**：SkillService 构造函数支持注入 `storeDir / installsFile`（测试用 tmp 目录），生产默认 `<data>/skills` 与 `<data>/installs.json`。

### 13.4 遗留（下期）

- zip（含 resources）导入/导出打包；download 的已装用户签名下载细分。
- admin 技能管理页 UI（后端 `GET /api/skills/admin` 与 `POST .../hide` 已就绪，AdminPanel 未接入）。
