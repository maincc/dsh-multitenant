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
    "checkIntervalMs": 300000
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

### 配置租户模型密钥（钱包签名验证身份）

解决 DSH 配置平面 loopback-only 限制：用户可在前端自助配置自己容器的 API Key，
身份由 CCDAO 插件钱包签名验证（详见 [docs/crypto-randomuuid.md](docs/crypto-randomuuid.md)）。

```
# 1. 领取一次性签名挑战（5 分钟有效）
POST /api/user/config-challenge
Body: { "address": "j..." }
Response: { "ok": true, "nonce": "<hex>" }

# 2. 前端让 CCDAO 插件对 nonce 签名 + 取公钥（插件弹签名确认）
window.ccdao.request({ method: 'swtc_signMessage',  params: [address, nonce] })
window.ccdao.request({ method: 'swtc_getPublicKey', params: [address] })

# 3. 提交（服务端验签 + 公钥推导地址比对后写入该租户卷 .credentials.yaml）
POST /api/user/tenant-config
Body: { "address": "j...", "nonce": "...", "signature": "...", "publicKey": "...", "apiKey": "sk-xxx" }
Response: { "ok": true, "configured": true }

# 4. 查询配置状态（永不回显 key）
GET /api/user/tenant-config?address=j...
Response: { "ok": true, "address": "j...", "configured": true }

# 5. 清除（同样需要签名）
DELETE /api/user/tenant-config
Body: { "address": "j...", "nonce": "...", "signature": "...", "publicKey": "..." }
Response: { "ok": true, "configured": false }
```

## 🔒 安全特性

1. **地址验证**：所有 API 端点验证 SWTC 地址格式
2. **权限守卫**：管理路由需要管理员 session
3. **HttpOnly Cookie**：admin_session 使用 HttpOnly + SameSite
4. **原子写入**：数据更新使用临时文件 + 重命名，防止损坏
5. **输入清理**：地址统一转小写，防止大小写绕过

## ✅ 已知问题修复

### 已修复

1. **state.json 数据不一致** - running 状态清理 stoppedAt 字段
2. **Cookie 安全配置** - 添加 SameSite=strict 标志
3. **管理员提权持久化** - 写入 data/config/admin.json
4. **全局错误处理** - 添加 unhandledRejection 和 uncaughtException 处理
5. **局域网 HTTP 访问 DSH Web UI** - 前端"进入 DSH"链接硬编码 127.0.0.1 已改为动态 host；`crypto.randomUUID is not a function` 已通过镜像内 polyfill 注入解决（详见 [docs/crypto-randomuuid.md](docs/crypto-randomuuid.md)）

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
