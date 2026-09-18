# DSH 多租户管理系统

基于 SWTC 地址的智能容器分配系统，为每个用户分配独立的 Docker 容器运行 DeepSeek Harness Web。

## 项目结构

```
dsh-multitenant/
├── src/                          # 源代码（模块化架构）
│   ├── server.js                 # 主服务器入口
│   ├── config/                   # 配置管理
│   │   └── config.js
│   ├── services/                 # 业务服务
│   │   ├── docker.service.js     # Docker 操作封装
│   │   ├── user.service.js       # 用户管理
│   │   └── data.service.js       # 数据存储（原子写入）
│   ├── routes/                   # 路由处理
│   │   ├── admin.routes.js       # 管理路由
│   │   ├── user.routes.js        # 用户路由
│   │   └── tenant.routes.js      # 租户路由
│   ├── middleware/               # 中间件
│   │   ├── auth.middleware.js    # 权限验证
│   │   └── validate.middleware.js # 输入验证
│   └── utils/                    # 工具函数
│       ├── address.js            # SWTC 地址工具
│       └── errors.js             # 错误处理
├── test/                         # 测试文件
│   ├── address.test.js
│   ├── config.test.js
│   ├── data.test.js
│   └── errors.test.js
├── frontend/                     # Vue 前端
├── data/                         # 运行时数据目录
│   ├── users/                    # 用户数据（按地址分文件）
│   ├── config/                   # 配置数据
│   ├── stats/                    # 统计数据
│   └── logs/                     # 日志数据
├── patches/                      # 租户 cordis patch
├── config.json                   # 系统配置
├── state.json                    # 状态文件（兼容旧格式）
├── package.json                  # 依赖配置
├── vitest.config.js              # 测试配置
├── entry-server.mjs              # 兼容旧入口
└── README.md                     # 本文档
```

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 构建前端

```bash
cd frontend
npm install
npm run build
cd ..
```

### 3. 启动服务

```bash
# 方式 1：使用新入口（推荐）
npm start

# 方式 2：直接运行
node src/server.js

# 方式 3：兼容旧入口
node entry-server.mjs
```

服务启动后访问：http://127.0.0.1:8090/

## 🧪 运行测试

```bash
# 运行所有测试
npm test

# 监听模式
npm run test:watch

# 覆盖率报告
npm run test:coverage
```

## 📊 系统架构

### 模块化设计

```
┌─────────────────────────────────────────┐
│              HTTP Server                │
└─────────────┬───────────────────────────┘
              │
    ┌─────────┼─────────┐
    │         │         │
┌───▼───┐ ┌──▼──┐ ┌────▼────┐
│ Admin │ │User │ │ Tenant  │
│Routes │ │Routes│ │ Routes  │
└──────┘ └──┬──┘ └────┬────
    │        │         │
    └────────┼─────────┘
             │
    ┌────────▼────────┐
    │   Middleware    │
    │  (Auth/Validate)│
    └────────┬────────┘
             │
    ┌────────▼────────┐
    │    Services     │
    │  (Docker/User)  │
    ────────┬────────┘
             │
    ┌────────▼────────┐
    │   Data Layer    │
    │  (Atomic Write) │
    └─────────────────┘
```

### 核心模块

| 模块                   | 职责                 | 文件                                    |
| ---------------------- | -------------------- | --------------------------------------- |
| **ConfigService**      | 配置管理、管理员验证 | `src/config/config.js`                  |
| **DockerService**      | Docker CLI 封装      | `src/services/docker.service.js`        |
| **UserService**        | 用户生命周期管理     | `src/services/user.service.js`          |
| **DataService**        | 原子写入数据存储     | `src/services/data.service.js`          |
| **AuthMiddleware**     | 管理员权限守卫       | `src/middleware/auth.middleware.js`     |
| **ValidateMiddleware** | 输入验证             | `src/middleware/validate.middleware.js` |

## 📝 配置说明

### ⚠️ 改 `server.publicHost` 后必须重启平台进程

`publicHost` 不只是拼 URL 用的：它会写进每个租户容器的 patch（`trustedHosts`），
而 patch 在**创建容器时就烘死了**（宿主文件 bind-mount 进容器
`/patches/tenant.patch.yml`，DSH 启动时读取，**不会热重载**）。

改了 `publicHost` 后如果只重启容器而不重启平台，旧容器仍只信任老 IP。DSH 的
`/api` fence 对"非回环且不在 `trustedHosts`"的 authority 直接返回 403
`forbidden`，前端表现为：

```
client api: directoryPicker/list failed: transport failure for /api/directoryPicker/list: HTTP 403
```

**页面本身照常打开**，只有用到宿主机管道（目录选择器等）时才报错，非常难自查。

平台启动时（`server.listen` 回调）会自动同步：比对磁盘 patch 与"按当前配置应生成的
patch"，有漂移就重写，并把**正在运行**的容器重启一次使其生效（已停的只重写文件，
下次启动自然生效）。所以正常流程是：**改 `config.json` → 重启平台进程 → 完成**。

验证某个租户是否生效：

```bash
docker exec dsh-swtc-<address> cat /patches/tenant.patch.yml | tail -3
# trustedHosts 里应包含 "<publicHost>:<对外端口>"
```

### config.json

```json
{
  "server": {
    "port": 8090,
    "publicHost": "127.0.0.1"
  },
  "admin": {
    "addresses": ["jndwretndumoqbt2uauclmfmx7xbqjykva"]
  },
  "cleanup": {
    "stopTimeoutMs": 900000,
    "destroyTimeoutMs": 3600000,
    "checkIntervalMs": 300000,
    "activityWindowMs": 180000,
    "processBaseline": 2,
    "stopGraceSeconds": 60
  },
  "tiers": {
    "1": { "label": "基础", "memory": "512m", "cpus": "1.0" },
    "2": { "label": "增强", "memory": "1g", "cpus": "2.0" },
    "3": { "label": "高性能", "memory": "2g", "cpus": "4.0" }
  }
}
```

### 环境变量

| 变量               | 说明                   | 默认值                 |
| ------------------ | ---------------------- | ---------------------- |
| `PORT`             | 服务端口               | 8090                   |
| `PUBLIC_HOST`      | 对外主机名             | 127.0.0.1              |
| `DSH_TENANT_IMAGE` | 租户镜像               | dsh-multitenant:latest |
| `BASE_PORT`        | 起始端口               | 31000                  |
| `PUBLIC_TRUST`     | 信任的浏览器 authority | -                      |
| `INJECT_ENV`       | 注入容器的环境变量     | -                      |

## 🔌 API 文档

### 健康检查

```
GET /health
Response: { "ok": true }
```

### 管理员登录

```
POST /api/admin/login
Body: { "address": "j..." }
Response: { "ok": true, "address": "...", "isAdmin": true }
```

### 检查管理员权限

```
GET /api/admin/check
Response: { "isAdmin": true, "address": "..." }
```

### 获取用户列表（管理员）

```
GET /api/users
Response: { "users": [...], "tiers": {...} }
```

### 获取系统统计（管理员）

```
GET /api/stats
Response: { "totalUsers": 6, "runningUsers": 2, ... }
```

### 升级用户配额（管理员）

```
POST /api/upgrade/:address
Body: { "tier": 2 }
Response: { "ok": true, "tier": 2, "limits": {...} }
```

### 提权管理员（管理员）

```
POST /api/admin/promote/:address
Response: { "ok": true, "address": "...", "promoted": true }
```

### 连接钱包

```
GET /connect?address=j...
Response: 302 Redirect to user port
```

### 检查连接状态

```
GET /connect-status?address=j...
Response: { "exists": true, "port": 31000, "status": "running" }
```

### 销毁容器

```
GET /leave/:address
Response: { "ok": true, "status": "destroyed" }
```

### 配置租户模型密钥与自定义模型（钱包签名验证身份）

解决 DSH 配置平面 loopback-only 限制：用户可在前端自助配置自己容器的 API Key、
自定义模型端点（baseURL）与模型列表，身份由 CCDAO 插件钱包签名验证
（详见 [docs/crypto-randomuuid.md](docs/crypto-randomuuid.md)）。

**官方 DeepSeek 与自定义端点并存**：自定义端点通过 DSH 的 `llm-pi-ai` 多 provider
适配器注册（官方设计：settings 段非空时路由实时注册、清空即消失），保存后进入
DSH 的模型选择器，**官方 DeepSeek 与自定义端点并列可选**，可随时切换。

**工作原理**：

- API Key 写入租户卷 `$DSH_HOME/.credentials.yaml`（官方 `DEEPSEEK_API_KEY`；
  每个自定义端点各自的 `<ROUTE>_API_KEY`）
- 官方端点覆盖（可选）写入 `settings.yaml` 的 `llm-deepseek` 段
- 自定义端点写入 `settings.yaml` 的 `llm-pi-ai.providers.<route>` 段
  （`api: openai-completions` + displayName + baseURL + models + apiKeyEnv）
- 两个文件都被 DSH 用 chokidar 热监听（约 100ms），provider 配置为请求级
  动态解析（官方 dynamic-config 测试验证：改配置后下一请求即生效，无需重启）

```
# 1. 领取一次性签名挑战（5 分钟有效）
POST /api/user/config-challenge
Body: { "address": "j..." }
Response: { "ok": true, "nonce": "<hex>" }

# 2. 前端让 CCDAO 插件对 nonce 签名 + 取公钥（插件弹签名确认）
window.ccdao.request({ method: 'swtc_signMessage',  params: [address, nonce] })
window.ccdao.request({ method: 'swtc_getPublicKey', params: [address] })

# 3. 提交（服务端验签 + 公钥推导地址比对后写入该租户卷）
#    apiKey 非空才更新；providers 为全量列表（被移除的端点自动删除并清 key）
POST /api/user/tenant-config
Body: { "address": "j...", "nonce": "...", "signature": "...", "publicKey": "...",
        "apiKey": "sk-xxx",                       # 可选：官方 DeepSeek key
        "providers": [                            # 可选：自定义端点（全量）
          { "route": "custom-123...",             # 更新现有时回传；新建省略
            "displayName": "我的中转站",
            "baseURL": "https://gw.example.com/v1",
            "apiKey": "sk-gw",                    # 可选，留空保留已存
            "models": [ { "id": "m1", "name": "M1", "contextWindow": 128000, "maxTokens": 8192 } ] }
        ] }
Response: { "ok": true, "configured": true }

# 4. 查询配置状态（永不回显 key）
GET /api/user/tenant-config?address=j...
Response: { "ok": true, "configured": true, "apiKeyConfigured": true,
            "baseURL": ..., "models": ...,
            "providers": [ { "route": "custom-...", "displayName": "我的中转站",
                             "baseURL": "https://...", "models": [...], "apiKeyEnv": "..." } ] }

# 5. 探测端点的模型列表（自动用该端点已存 key 鉴权，key 不离开容器）
POST /api/user/tenant-config/discover
Body: { "address": "j...", "nonce": "...", "signature": "...", "publicKey": "...",
        "baseURL": "https://gw.example.com/v1", "credentialRef": "CUSTOM_..._API_KEY" }
Response: { "ok": true, "models": [ { "id": "model-a", "name": "Model A" } ] }

# 6. 恢复默认（清除官方 key + 端点覆盖 + 所有自定义端点，同样需要签名）
DELETE /api/user/tenant-config
Body: { "address": "j...", "nonce": "...", "signature": "...", "publicKey": "..." }
Response: { "ok": true, "configured": false }
```

> 安全边界：探测请求在租户镜像的辅助容器内执行（SSRF 面与租户容器一致），
> 只接受 http/https 地址；baseURL 支持任意 OpenAI 兼容服务（中转站/自建网关）。
> 验证工具：`docker run --rm -v <租户卷>:/dsh-home \
  -v "$PWD/deploy/verify-llm-providers.mjs:/verify.mjs:ro" \
  dsh-multitenant:latest node /verify.mjs` 可列出容器内实际注册的 provider。

## 🔒 安全特性

1. **地址验证**：所有 API 端点验证 SWTC 地址格式
2. **权限守卫**：管理路由需要管理员 session
3. **HttpOnly Cookie**：admin_session 使用 HttpOnly + SameSite
4. **原子写入**：数据更新使用临时文件 + 重命名，防止损坏
5. **输入清理**：地址统一转小写，防止大小写绕过
6. **破坏性操作当场签名**：见下方"管理端破坏性操作签名"

### 管理端破坏性操作签名

**威胁模型**：`admin_session` 是一个 12 小时有效的 bearer token，
`requireAdmin` 只做 `sha256(token)` 查表 + 过期判断（不验签）。而租户网关会把
浏览器带来的 cookie **原样转发进租户容器** —— `path=/` 的 cookie 不按端口
隔离（RFC 6265），`SameSite=Strict` 也不判端口。于是一个能读到请求头的人
（恶意 skill / 提示注入 / 容器内命令执行）就能拿到这串 token 并**重放**它
冒充管理员；实测仅凭 cookie 即可成功 `promote` / `force-stop`。

**加固**：会改变平台状态的操作，除会话外还要求**当场钱包签名**，做法与钱包侧
（`tenant-config.configure`、skill 安装、`/connect`）同款 —— 一次性 nonce、
5 分钟过期、用完即毁。

覆盖的操作（`src/middleware/admin-signature.middleware.js` 白名单）：

| 操作            | 端点                                     | 为什么破坏性           |
| --------------- | ---------------------------------------- | ---------------------- |
| `promote`       | `POST /api/admin/promote/:address`       | 持久化提权             |
| `force-stop`    | `POST /api/admin/force-stop/:address`    | 打断在用租户           |
| `delete-volume` | `POST /api/admin/delete-volume/:address` | 删数据卷，不可逆       |
| `remove`        | `POST /api/user/:address/remove`         | 删租户记录（默认连卷） |
| `dsh/apply`     | `POST /api/admin/dsh/apply`              | 重建容器（可能停机）   |

纯读取接口（`/api/users`、`/api/stats`、`/api/admin/dsh/status` 等）**不要求
签名**，日常查看管理面板不会被钱包弹窗打断。

**签名内容由服务端推导**，客户端无法影响：

```js
// 挑战：服务端从 (operation, payload) 推导 binding
binding = `promote:address=<目标地址>`
message = `${nonce}|${binding}` // 钱包里签的就是这个串

// 执行：服务端重新推导，与发放时记录的一致才验签
```

因此"签了 A 却执行 B"不可能成功 —— 绑定串含操作名与目标（`remove` 还含
`keepVolume` 语义，`dsh/apply` 区分单租户与 `all=1`）。nonce 在验签**之前**
就作废，失败也不给第二次机会。

签名材料走请求头（`x-admin-nonce` / `x-admin-signature` / `x-admin-pubkey`），
因为 `force-stop` / `remove` 根本不读请求体，用 body 会与业务解析互相干扰。

**给管理员**：`admin_session` 的设计（避免每点一下都弹钱包）保持不变，但
**请不要在登录管理面板的同一个浏览器里访问租户容器** —— 网关目前仍会把平台
cookie 转发进容器，纵深防御尚未收口。

## ✅ 已知问题修复

### 已修复

1. **state.json 数据不一致** - running 状态清理 stoppedAt 字段
2. **Cookie 安全配置** - 添加 SameSite=strict 标志
3. **管理员提权持久化** - 写入 data/config/admin.json
4. **全局错误处理** - 添加 unhandledRejection 和 uncaughtException 处理
5. **局域网 HTTP 访问 DSH Web UI** - 前端"进入 DSH"链接硬编码 127.0.0.1 已改为动态 host；`crypto.randomUUID is not a function` 已通过镜像内 polyfill 注入解决（详见 [docs/crypto-randomuuid.md](docs/crypto-randomuuid.md)）
6. **管理端破坏性操作可被 cookie 重放** - 网关转发 `admin_session` 导致提权链；已加"当场钱包签名"（见上方安全特性 6）。仅凭 cookie 现在返回 `SIGNATURE_REQUIRED`
7. **启动时 tenant patch 漂移** - 改 `server.publicHost` 后旧 `trustedHosts` 残留致 `/api/directoryPicker/list` 403；已加启动自愈 + 重启必刷新 patch
8. **网关把浏览器的失效 `dsh-auth-*` cookie 转发给容器** - 浏览器残留旧 cookie 时平台跳过注入，DSH 回 `dsh web authentication required`；已改为「平台现换的那份永远权威，旧 cookie 一律剔除」（HTTP 与 WebSocket 升级两处）
9. **「版本更新」因备份目录默认值必然失败** - 内置默认 `backupDir` 是 `/backup/dsh-multitenant`，普通用户直接跑平台时无权创建 → 备份 EPERM → 更新中止（容器已停过一次白停）。默认已改为平台自有 `data/backups`；配置的目录不可写会**自动降级并告警**，且「预览」会提前报出快照目录可写性
10. **版本列表取不到（npm EPERM）** - 宿主 `~/.npm` 不可写时 `npm view` 直接失败；已为 `npm view` 显式指定可写缓存目录（`dsh.npmCacheDir`，默认 `data/npm-cache`），不再依赖运行用户的 `~/.npm`
11. **版本历史看不出镜像是否还在本地** - 同一版本可被构建多次（每次新镜像 ID，tag 只有一个 → 后来覆盖先前），历史却全部保留，容易误以为多条同版本记录都能回滚。已标出「在本地/不在本地」+ 体积 + 保留原因，并支持多选清理悬空构建（破坏性操作，需管理端签名）
12. **悬空镜像清理筛不出任何东西** - 镜像 untag 后 `docker images` 的 Repository 变成 `<none>`，按仓库名过滤会一个都筛不出来（功能失效）。已改为用平台构建历史认领归属，既能清理自己的悬空构建，也绝不会误碰别的项目的镜像
13. **清理入口在"没得清"时整个消失** - 清理区只在有可清理项时渲染，而镜像通常都带 tag → 用户看不到这个功能。已改为**始终显示**镜像清单与清理区（含"为什么不可删"与谁在用），并允许清理带 tag 的旧版本（旧 tag 一样占 1.2GB）
14. **"容器在用"判定会漏判（有误删风险）** - `docker ps --format '{{.Image}}'` 对带 tag 的容器返回**名字**、对悬空镜像返回短 ID，用名字永远匹配不上 sha256 → 该容器被漏判。已改为逐个 `inspect` 取完整镜像 ID，并让"拿不到信息"直接失败而不是猜着删
15. **镜像归属漏认自家悬空构建** - 只靠平台历史认领会漏掉"构建中途失败 / 手工 `docker build`"留下的镜像（它们从未进历史），那部分空间永远清不掉（实测有一个 843MB 的）。已补 Dockerfile 签名兜底（`DSH_HOME`/`DSH_TELEMETRY_DISABLED`/`DSH_VERSION`），只对无 tag 镜像逐个 `inspect`，认不到就不认领
16. **"当前镜像"标记永远不亮** - 平台存完整 `sha256:...`、docker 给短 ID，用 `===` 比较恒为 false。已统一用双向前缀匹配
17. **DSH 版本管理层次不清** - 版本列表 / 构建镜像 / 总体镜像 / 租户镜像混在两三个卡片里，看不出递进关系，且"本地手上已有哪些版本"无处可查（`stable` 还恒为空，因为该包目前只有预发布）。已重排为 4 步：①本地版本列表（含已验证已构建标记）②构建版本镜像 ③总体镜像（全部租户共用）④个别租户镜像，版本下拉合并并按版本号排序
18. **租户镜像不能选（只能升到最新）** - 平台只能把租户升到 `latest`，既不能回滚到旧版本，也不能让不同租户跑不同版本。已在「个别租户镜像」加**目标镜像选择**：默认跟随最新，也可钉到任一已构建版本（`state.pinnedImage` 持久化，重建与重连都沿用；销毁中的租户也会记住选择）。安全上：镜像必须属于本平台仓库、必须能读出 DSH 版本号，且目标镜像会**签进管理签名绑定**（防"签 latest、实装别的版本"）
19. **沙箱逃生开关变量名写错（写了也不生效）** - Dockerfile 注释让运维在 bubblewrap 不可用时改用 `ENV DSH_SANDBOX_MODE=danger-full-access`，但 DSH 只认 `DSH_PERMISSION_MODE`（`DSH_SANDBOX_MODE` 在整个 DSH 包里出现 0 次）。照注释改会以为已放开沙箱，实际仍以 `workspace-write` 启动后失败。已改为正确变量名并注明副作用（`danger-full-access` 会同时把审批策略变成 `never`）
20. **租户容器缺 agent 常用工具** - 容器内实测没有 `curl`/`jq`/`ripgrep`：抓网页只能 `node -e "fetch(...)"`、解析 JSON 要写一行式、搜索只能用 `grep -r`，每次绕路都消耗 token。已在 apt 层补上这三个包（镜像仅增 ~10MB）
21. **租户列表看不到 DSH 版本** - 后端未下发版本、且「版本」列实际渲染的是状态徽章；已加 `containerDshVersion()`（问容器 `dsh --version`，按镜像 ID 缓存）并在两个列表里正确展示

## 🧹 空闲清理机制（不会误停正在干活的容器）

清理定时器每 `checkIntervalMs`（5 分钟）检查一次运行中的容器。空闲超时
（`stopTimeoutMs`，15 分钟）后**不会直接停止**，而是先做四层活动检测
（全部从宿主侧完成，无需进容器，**任一命中即视为活跃**）：

1. **DSH 内部活动**：卷内 `sessions/` 会话文件最近 `activityWindowMs`（3 分钟）
   内有写入 → 对话流/工具调用/agent 任务正在发生 → 视为活跃，刷新 lastSeenAt，
   跳过清理。原理：DSH 把每个会话的事件流 append 到卷里 `sessions/` 的
   jsonl 文件，文件在动 = 在干活。
2. **外部程序**：`docker top` 进程数超过 `processBaseline`（2）→ 有 shell 命令、
   代码执行等额外进程在跑 → 视为活跃，跳过清理。
3. **活跃连接**：共享租户容器的网络命名空间统计非回环 ESTABLISHED 连接 > 0 →
   浏览器开着 DSH 页面（WebSocket 长连接）或 LLM 出站请求进行中 → 视为活跃。
4. **DSH 运行中任务**：容器内 RPC `session.list` 存在 running 会话 → agent 正在
   处理（含静默等待 LLM/外部 API 响应的场景，此时会话文件可能暂无写入）→
   视为活跃。

四层全部安静且空闲超时才停止容器，且停止使用 `stopGraceSeconds`（60 秒）的
SIGTERM 宽限，让 DSH 有机会保存状态。停止后再闲置 `destroyTimeoutMs`
（1 小时）才销毁容器（**数据卷始终保留**：聊天记录、会话历史、文件全在，
重连即恢复）。

> 注意：`cleanupPolicy` 实际读自 `state.json`（兼容旧格式）；`config.json`
> 的值仅在 state.json 缺省字段时作为兜底。

## 📈 性能优化

1. **按需加载**：用户数据按地址分文件，避免加载全部
2. **原子写入**：临时文件 + 重命名，减少锁竞争
3. **连接复用**：Docker CLI 调用使用 execFile
4. **SPA 缓存**：静态资源浏览器缓存

## 🛠 开发指南

### 添加新路由

1. 在 `src/routes/` 创建路由文件
2. 在 `src/server.js` 注册路由
3. 添加测试到 `test/`

### 添加新服务

1. 在 `src/services/` 创建服务文件
2. 导出单例实例
3. 在路由中注入使用

### 添加中间件

1. 在 `src/middleware/` 创建中间件文件
2. 导出中间件函数
3. 在路由中调用

### Git Hooks

本项目配置了 `pre-commit` hook，在提交时自动：

- 格式化暂存区的代码文件（Prettier）
- 运行测试套件（Vitest）

如果测试失败，提交将被阻止。

手动安装/卸载 hooks：

```bash
npm run hooks:install    # 安装 hooks
npm run hooks:uninstall  # 卸载 hooks
```

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
