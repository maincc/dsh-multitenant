# DSH 多租户管理系统

基于 SWTC 地址的智能容器分配系统：为每个用户分配独立的 Docker 容器运行 DeepSeek
Harness Web，并以可验证凭证（VC）作为准入与豁免的判权底座。

| 我要…              | 看这里                                                                               |
| ------------------ | ------------------------------------------------------------------------------------ |
| 部署/更新服务器    | [DEPLOY.md](DEPLOY.md)（增量指南）+ [deploy/README.md](deploy/README.md)（脚本本体） |
| 装配平台签发身份   | 下方快速开始 §5 + [docs/keys-provisioning.md](docs/keys-provisioning.md)             |
| 凭证/签发/判权细节 | [docs/did-vc-runbook.md](docs/did-vc-runbook.md)                                     |
| 全部文档索引       | [docs/README.md](docs/README.md)                                                     |
| 历史事故与修法     | [docs/fixlog.md](docs/fixlog.md)                                                     |

## 核心判权不变量（改凭证链路前必读）

平台有两个子系统：**容器编排**（用户→容器→端口）与**凭证链路**（档案→台账→签发）。
凭证链路的设计立场固定为五条，评审任何改动都按此对照：

1. **档案是权威**：用户自己的官网档案是第一权威。判权顺序 = **先跑档案，出错才落台账**
   （档案不通≠档案没有——probe-fail 与 absent 严格分家）。
2. **绝不上锁**：任何凭证故障最多降级为"弹窗/限时"，永不把用户挡在门外（fail-open）。
   读不到线上档案时**绝不**据此撤销或覆写——**只减不增**的 revocation 原则。
3. **不同 key = 不同平台**：`Dsh*` 类型名是全局常量，跨平台档案必然同名共存。凡动
   **用户档案**的摘除/展示/stale/回扫，一律用 `isOurIssuedCard`（issuer 或 id 尾部含本
   平台 DID）判定"是不是我签的"；`isDshCard` 类型口径只允许用于本平台自己的登记册文件。
   违反此条 = 多平台互踢卡死循环（2026-10-23 事故复盘见
   [credential.service.js](src/services/credential.service.js) 注释与 fixlog）。
4. **换 key 是身份级事故**：私钥派生 DID（ripemd160(sha256(压缩公钥))），DID 数学上不可
   换；换 key = 已发档案卡全部不再被本平台认领。注册动作必须显式 `--yes`，服务代码永不
   自动注册。
5. **诚实命名**：函数名、字段名、日志文案如实表达语义（`isOurIssuedCard` 之所以叫这个
   名字，见第 3 条）。

## 项目结构

```
dsh-multitenant/
├── src/
│   ├── server.js              # 主入口（路由 dispatch 列表在这里，见开发指南）
│   ├── config/config.js       # 配置加载（config.json + env 覆盖）
│   ├── assets/                # 随代码走的公共资产（签名套件 context）
│   ├── services/              # 业务服务
│   │   ├── docker.service.js  #   Docker CLI 封装（容器生命周期/清理）
│   │   ├── credential.service.js #  凭证核心：签发/级联判权/台账/平台册
│   │   ├── user.service.js    #   用户生命周期
│   │   ├── data.service.js    #   原子写入存储（json 形态）
│   │   └── …                  #   did/dsh-auth/dsh-version/image-inventory 等
│   ├── routes/                # admin / user / tenant / skill 四组路由
│   ├── middleware/            # auth / validate / admin-signature
│   └── utils/                 # 地址、错误、会话工具
├── frontend/                  # Vue 前端（构建产物由平台静态服务）
├── test/                      # vitest 全量套件（869 用例，含真库自包含用例）
├── scripts/                   # 运维脚本（seed-to-pem / mongo-rs / mongo-backup 等）
├── deploy/                    # 服务器部署体系（install/update/rsync-upload/systemd）
├── docs/                      # 设计文档与复盘（索引见 docs/README.md）
├── data/                      # 运行时数据（rsync 只进不出；keys/ 见 §5）
│   ├── keys/                  #   平台签发身份：issuer.key + issuer-profile.json
│   └── …                      #   users/config/stats/logs（json 形态的业务数据）
├── patches/ + host.patch.yml  # 租户注入 patch（构建期资产，Dockerfile COPY）
├── Dockerfile                 # 租户镜像（DSH_VERSION 烘进镜像，tag 供回滚）
├── config.json(.example)      # 现场配置（example 是字段语义权威注释）
└── DEPLOY.md                  # 部署增量指南（形态选型/红线/验收）
```

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 构建前端

```bash
cd frontend && npm install && npm run build && cd ..
```

### 3. 启动服务

```bash
npm start            # 推荐入口
node src/server.js   # 等价直跑
```

服务启动后访问：http://127.0.0.1:8090/ （`/admin` 管理面板，`/user` 用户入口）。

### 4. （可选）MongoDB 存储形态（灰度可用）

平台支持两种存储形态（完整设计与合同见 `docs/storage-design.md`）：

- **json（默认）**：数据文件在 `data/` 下，零外部依赖，`npm start` 即用。
- **mongodb**：9 个集合入库（users/meta/sessions/cwt×2/audit/usage/skills/skill_installs），
  写路径经多文档事务确认；本机首次启动会自动把磁盘数据**一次性搬家**入库（幂等，
  重启即 `skipped`），此后库为权威、进程启动时六域水合（水合失败拒绝启动）。

启用 mongodb 形态（本机两步；形态声明住在 config.json `storage` 段——字段语义与测试
护盾机制见 `config.json.example`；服务器由 deploy/install.sh 注入）：

```bash
scripts/mongo-rs.sh start    # ① 专用单成员副本集（事务前提；27018 专用，不碰 brew 的 27017）
npm start                    # ② config.json 的 storage 段 provider=mongodb
# 应急回退文件形态：DSH_STORAGE_PROVIDER=json npm start
```

备份与恢复演练：`scripts/mongo-backup.sh backup`（快照+保留 7 份）/ `verify`（还原进
影子库逐集合对账，绝不碰生产库）。回退 json 形态：去掉配置重启即可（文件轨未动过）。
安全边界：mongod 仅监听 127.0.0.1 且未启鉴权——**本地形态专用**，上服务器必须
auth+TLS+独立账号（见 docs/security-hardening-plan.md）。

### 5. 平台签发身份（data/keys/，正式部署前）

凭证链路的签发身份因环境而异，git 与 rsync 都不会携带它（`data/keys/` **只进不出**）。
两条装配路径：

- **形态 A · 接管现有平台**：现场放 `data/keys/issuer.key`（SEC1 PEM，0600；钱包 ss seed
  用 `node scripts/seed-to-pem.mjs` 转换），profile 不用再抄——config 声明
  `credential.platformDid: "did:swtc:<平台DID>"`，服务首启自动从官网读档落成
  `data/keys/issuer-profile.json` 镜像（只读线上；线上档案 id 与声明不符=宁拒不写）。
- **形态 B · 新平台一条命令装配**：
  `node scripts/shelf-open.mjs --seed '<ss-seed>' --nickname 'DSH 测试平台'` 先 dry-run
  预览（零写入），核对派生出的 DID 后加 `--yes` 落钉：落 key（0600）→ 构造 DID 档案 →
  上传官网注册 → 回读确认后落 profile 镜像。链上已有档/读档不稳=**拒写**（注册是永久
  身份钉链，宁可重来不可错钉）。

配对红线：`issuer.key` 派生地址必须等于 profile 的 `id` 尾部——形态 B 由脚本同源派生
天然成立；手工装配（形态 A）配错 = 领取照常"成功"但链上验真永远 invalid 的静默事故。

签名套件 context 在 `src/assets/`（随代码走，loader 兼容回退旧位置）。缺钥不拦启动
（登录等一切照常，首次签发才报错）。完整装配与保护矩阵见
[docs/keys-provisioning.md](docs/keys-provisioning.md)。

## 🧪 运行测试

```bash
npm test               # 全量（869 用例）
npm run test:watch     # 监听模式
npm run test:coverage  # 覆盖率
```

> 真库用例已自包含：vitest globalSetup 自动探测/复用 27018，没人起就临时 spawn 一个
> mongod（独立端口+临时数据目录，跑完回收）；连 mongod 二进制都没有的机器优雅跳过。
> 不需要为测试手动起库。测试护盾（worker 钉 provider=json）见 config.json.example。

## 📝 配置说明

### ⚠️ 改 `server.publicHost` 后必须重启平台进程

`publicHost` 会写进每个租户容器的 patch（`trustedHosts`），而 patch 在**创建容器时
就烘死了**，不会热重载。只重启容器不重启平台 → 旧容器仍只信任老 IP → DSH 的 `/api`
fence 对不认识的 authority 直接 403（页面照常打开，只有目录选择器等宿主管道报错，
非常难自查）。正常流程：**改 config.json → 重启平台进程**。平台启动时会自动比对磁盘
patch 与当前配置的漂移并重写（运行中的容器重启一次使其生效）。

验证某租户是否生效：

```bash
docker exec dsh-swtc-<address> tail -3 /patches/tenant.patch.yml
# trustedHosts 里应包含 "<publicHost>:<对外端口>"
```

### config.json（骨架示例）

```json
{
  "server": { "port": 8090, "publicHost": "127.0.0.1" },
  "admin": { "addresses": ["jndwretndumoqbt2uauclmfmx7xbqjykva"] },
  "credential": {
    "platformDid": "",
    "keyFile": "data/keys/issuer.key",
    "profileFile": "data/keys/issuer-profile.json"
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

完整字段语义以 `config.json.example` 的内嵌注释为准。

### 环境变量

| 变量                   | 说明                                                 | 默认值                 |
| ---------------------- | ---------------------------------------------------- | ---------------------- |
| `PORT`                 | 服务端口                                             | 8090                   |
| `PUBLIC_HOST`          | 对外主机名                                           | 127.0.0.1              |
| `DSH_TENANT_IMAGE`     | 租户镜像                                             | dsh-multitenant:latest |
| `BASE_PORT`            | 起始端口                                             | 31000                  |
| `PUBLIC_TRUST`         | 信任的浏览器 authority                               | -                      |
| `INJECT_ENV`           | 注入容器的环境变量                                   | -                      |
| `DSH_STORAGE_PROVIDER` | 存储形态：`json` / `mongodb`（压过 config）          | json                   |
| `MONGODB_URI`          | mongodb 形态库 URI（常规配置在 config `storage` 段） | 见 config              |

## 🔌 API 一览

完整请求/响应示例（含租户模型自助配置的签名流程）见 [docs/api.md](docs/api.md)。
速查：

| 组       | 端点                                                                                   | 鉴权                                      |
| -------- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| 会话     | `POST /connect-challenge` → `POST /api/user/login`；`GET /connect?address=` 302 进容器 | 钱包签名                                  |
| 管理     | `/api/admin/*`（用户列表/统计/提权/审批）                                              | admin session；**破坏性操作另需当场签名** |
| 租户自助 | `/api/user/tenant-config*`（模型 key/端点/发现/重置）                                  | 钱包签名（用途绑定）                      |
| 技能市场 | `/api/skills/*`                                                                        | 钱包签名                                  |
| 健康     | `GET /health`                                                                          | 无                                        |

## 🔒 安全特性

1. **地址验证**：所有 API 端点验证 SWTC 地址格式；地址统一小写，防大小写绕过。
2. **会话模型**：`user_session`（钱包签名换发，12h）与 `admin_session` 分轨；判权
   取用户会话**优先**（`getRequestAddress` = user ?? admin，防管理 cookie 劫持用户身份，
   fixlog 第 35 条同族）。
3. **签名用途绑定 + 挑战分池**：所有钱包签名签的都是服务端构造的
   `hex(dsh-multitenant|<purpose>|<address>|<nonce>[|<binding>])`，挑战池按
   `用途|地址` 隔离——为 A 用途取得的签名在 B 用途一律无效（覆盖 login / connect /
   tenant-config / skills / gateway-verify / admin-op 全部签名入口）。
4. **平台 cookie 不出境**：网关转发进租户容器前剥离 `admin_session` / `user_session` /
   `gw_ok`——租户容器完全可控也拿不到平台会话令牌。
5. **管理端破坏性操作当场签名**：`promote` / `force-stop` / `delete-volume` / `remove` /
   `dsh/apply` 除会话外还要求一次性钱包签名（5 分钟 nonce、用完即毁、目标写进签名
   绑定串，"签 A 执行 B"不可能）。纯读取不签名，日常面板不被弹窗打断。
   威胁模型全貌见 fixlog 第 35 条与 docs/security-hardening-plan.md。
6. **原子写入**：数据更新临时文件 + rename；上传体积/队列上限 + 按 IP 限流
   （cwt 申请通道防洪泛，fixlog 第 36 条）。

## 🧹 空闲清理机制（不会误停正在干活的容器）

空闲超时（`stopTimeoutMs`，15 分钟）后**不直接停**，先做四层活动检测（宿主侧完成，
任一命中即视为活跃）：

1. **DSH 内部活动**：卷内 `sessions/` 会话 jsonl 近 3 分钟有写入 = 在干活。
2. **外部程序**：`docker top` 进程数超基线（2）= 有命令/代码在跑。
3. **活跃连接**：容器 netns 非回环 ESTABLISHED > 0 = 浏览器页面或 LLM 请求在用。
4. **运行中任务**：容器 RPC `session.list` 有 running 会话 = agent 正在处理
   （含静默等 LLM 响应、会话文件暂无写入的场景）。

四层全静默才停止（SIGTERM 宽限 60s 让 DSH 保存状态），停止后再闲置 1 小时才销毁
容器——**数据卷始终保留**，重连即恢复。`cleanupPolicy` 实际读自 `state.json`，
config.json 仅在其缺字段时兜底。

## 🛠 开发指南

- **Git Hooks**：`pre-commit` 自动 Prettier + 全量 Vitest，失败阻断提交
  （`npm run hooks:install` / `hooks:uninstall`）。
- **新路由必须注册 dispatch**：`src/server.js` 有显式的路由前缀分发列表，只在
  `src/routes/` 建文件**不会**生效——这是踩过的坑，dispatch 漏注册=路由 404。
- **测试**：新增判权逻辑先照"核心判权不变量"五条写回归（跨平台共存类缺陷全部有
  实名用例钉着，见 test/credential.test.js）。
- 更多开发/贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT
