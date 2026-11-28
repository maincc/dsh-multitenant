# API 参考

> 从根 README 迁出（2026-10-26 整理）。签名类端点的**被签消息构造与分池规则**见
> `docs/security-hardening-plan.md` 与 fixlog 第 35 条；管理端破坏性操作见 README 安全节。

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
Response: { "ok": true, "nonce": "<hex>", "message": "<hex>" }
#    ⚠ 要签的是 message，不是 nonce。message 是服务端构造的**用途绑定**内容：
#    hex( `dsh-multitenant|tenant-config|<address>|<nonce>` )
#    用途前缀把"这次签名是授权什么"钉进被签字节，因此为其它用途
#    （登录 / 连容器 / 网关校验 / 技能市场）取得的签名在这里一律验不过。

# 2. 前端让 CCDAO 插件对 message 签名 + 取公钥（插件弹签名确认）
window.ccdao.request({ method: 'swtc_signMessage',  params: [address, message] })
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
