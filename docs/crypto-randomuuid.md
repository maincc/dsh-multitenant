# 事件记录：局域网 HTTP 访问 DSH Web UI 报 `crypto.randomUUID is not a function`

> 类型：部署/浏览器兼容问题（非本项目代码 bug，但本项目配套修复了两处）
> 状态：已修复并推送（commit 53a2d95 + 本文件对应的 shim 提交）
> 日期：2026-08-21

## 一、现象

内网部署（`192.168.66.58`）后：

1. 点击"打开 DSH Web UI"按钮，跳转的默认 URL 是 `http://127.0.0.1:<port>/`（客户端本机，打不开）
2. 从局域网其他设备用 `http://192.168.66.58:<port>/` 打开租户 DSH 页面后，报错：
   `crypto.randomUUID is not a function`，页面无法正常使用
3. 在服务器本机用 `http://127.0.0.1:<port>/` 访问时**不报错**——同一套代码，只是访问地址不同

## 二、根因分析

两个独立问题叠加：

### 问题 1：前端把"进入 DSH"的 URL 硬编码为 127.0.0.1（本项目 bug，已修）

`frontend/src/views/UserCenter.vue` 和 `AdminPanel.vue` 的进入链接写死：

```html
:href="`http://127.0.0.1:${userInfo.port}/`"
```

在服务器部署场景下，用户浏览器跳转到的是**用户自己电脑的** 127.0.0.1，必然打不开。
修复：改用 `window.location.hostname` 动态拼接（commit `53a2d95`）。

### 问题 2：浏览器安全上下文限制（DSH 产品侧，本项目以 polyfill 缓解）

- W3C [Secure Contexts](https://www.w3.org/TR/secure-contexts/) 规范规定 `crypto.randomUUID()`
  只在"潜在可信源"（HTTPS，或 `127.0.0.1`/`localhost` 回环地址）下可用
- 局域网 IP + 明文 HTTP（`http://192.168.66.58:<port>`）**不是**可信源
  → 浏览器故意不暴露 `crypto.randomUUID` → 前端调用即报 `is not a function`
- DSH 前端在**发消息**时直接调用 `crypto.randomUUID()` 生成消息/RPC ID
  （`packages/client/connection/lib/client.js` 的 `createMessage` / `mintRpcId`）
- 这不是 Node 版本问题：浏览器里跑的是页面 JS，与容器内 Node 22 无关；
  错误形态 `crypto.randomUUID is not a function`（crypto 存在、方法缺失）也印证了这一点
  （真 Node 版本问题会报 `crypto is not defined`）

## 三、排查关键证据

| 证据                                                                                                     | 结论                                                                                              |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| DSH 源码 `packages/client/connection/src/client/random-uuid.ts` 存在，用 `crypto.getRandomValues()` 实现 | 官方**源码已修复**同类问题，但发布的 npm 包是旧构建（`lib/client.js` 仍调 `crypto.randomUUID()`） |
| `apps/web/dist/index.html` 结构稳定，含唯一 `</head>` 锚点                                               | 可安全注入 polyfill                                                                               |
| DSH web 服务未设置 CSP（`Content-Security-Policy`）                                                      | 内联 `<script>` 注入不会被浏览器拦截                                                              |
| `@deepseek-ai/dsh-web-frontend/dist/index.html` 是实际被服务的文件                                       | 注入目标明确                                                                                      |

## 四、修复方案：镜像内注入 polyfill（方案 A）

**原理**：`crypto.getRandomValues()` 在非安全上下文**也允许**（它是基础 API），用它实现
RFC 4122 v4 UUID 替代被藏起来的 `crypto.randomUUID()`——与 DSH 官方 `random-uuid.ts`
实现完全一致，随机性质量不变。

**实现位置**：

- `deploy/randomuuid-shim.js` —— polyfill 本体（guard 判断，安全上下文下自动跳过）
- `deploy/inject-shim.mjs` —— 注入脚本（把 shim 插到 `</head>` 前，可本地手动执行，幂等）
- `Dockerfile` —— 在 `npm install -g @deepseek-ai/dsh` 之后，把 shim 注入到
  `$(npm root -g)/@deepseek-ai/dsh-web-frontend/dist/index.html` 的 `</head>` 前，
  先于所有 `type="module"` 脚本执行

**为什么不直接改 DSH 的 JS bundle**：minified bundle 有多个调用点、文件名带哈希、
DSH 升级即被覆盖——注入式 polyfill 只有一行注入点、锚点稳定、天然幂等。

## 五、安全权衡

- ✅ **不降级随机性**：`getRandomValues` 是加密级随机源，非安全上下文允许
- ✅ **不绕过任何认证/权限**：trustedHosts 篱笆、管理员鉴权、Cookie 安全照常生效
- ✅ **自动失效**：DSH 发新版修复后，`typeof crypto.randomUUID !== 'function'` 不成立，
  polyfill 自动跳过，零副作用
- ⚠️ **shim 只解决"UI 能用"，不解决"传输安全"**：明文 HTTP 下 API 密钥、对话内容
  在局域网裸奔，同一网段设备可嗅探。内网测试可接受；**正式使用必须 HTTPS**
  （域名 + nginx 反代 + 证书，并把域名加入 `PUBLIC_TRUST`）

## 六、部署与验证

```bash
# 1. 拉取含修复的代码
cd ~/dsh-multitenant
git pull

# 2. 重建镜像（含 shim 注入）
docker build -t dsh-multitenant:latest .

# 3. 重建租户容器（数据卷保留，无损）
docker ps -a --filter name=dsh-swtc- -q | xargs -r docker rm -f

# 4. 验证：镜像内 HTML 已注入
docker run --rm dsh-multitenant:latest \
  sh -c 'grep -c randomUUID "$(npm root -g)/@deepseek-ai/dsh-web-frontend/dist/index.html"'

# 5. 触发租户重建后，从局域网设备访问 http://192.168.66.58:<port>/ 不再报错
```

浏览器端自证（F12 → Console）：

```js
window.isSecureContext // 127.0.0.1 为 true，192.168.66.58(HTTP) 为 false
typeof crypto.randomUUID // 安全上下文为 "function"，否则 polyfill 注入后也是 "function"
```

## 七、替代方案（未采用，记录备查）

| 方案                                                     | 说明                        | 未采用原因                               |
| -------------------------------------------------------- | --------------------------- | ---------------------------------------- |
| nginx `sub_filter` 注入                                  | 反代时往 `</head>` 前插脚本 | 需 nginx 前置每个动态租户端口，配置繁琐  |
| Chrome flag `--unsafely-treat-insecure-origin-as-secure` | 手动把 origin 当安全上下文  | 只能逐台设备、逐端口配置，不适合多人使用 |
| SSH 隧道 / 服务器本机 127.0.0.1                          | 走回环地址                  | 只适合临时验证                           |
| 直接改 DSH bundle                                        | sed 替换调用点              | 脆弱、升级即失效                         |

## 八、时间线

1. 首次内网部署（`install.sh` 成功，镜像/前端/systemd 均正常，`/health` 200）
2. 发现"进入 DSH"跳 127.0.0.1 → 定位为前端硬编码 → 修复并推送（`53a2d95`）
3. 发现 `crypto.randomUUID is not a function` → 排查区分 Node 版本 vs 浏览器
   安全上下文 → 确认后者
4. 讨论替换方案（A 镜像注入 / B nginx 注入 / C 不替换）→ 确认方案 A
5. 实现 `deploy/randomuuid-shim.js` + Dockerfile 注入 → 本地构建验证 → 推送
6. 局域网直连发现"模型/设置页"打不开 → 定位为配置平面 loopback-only 设计限制
   （见第九节，DSH 产品侧限制，非本项目可修）

## 九、后续发现：配置平面（模型/API Key 设置页）loopback-only 限制

**现象**：局域网直连 `http://192.168.66.58:<port>/` 后，打开"模型"设置页报
`Loading the provider directory failed: settings are unavailable in this browser`。

**根因**（DSH 设计性限制，非 bug）：

- DSH 把 `settings.*` / `credentials.*` / `llm.discoverModels` 等**配置平面方法**
  钉死在 loopback（`packages/client/connection/src/index.ts` 的 `PRIVILEGED_METHODS`，
  服务端按请求 Host 是否回环强制拒绝）
- 官方注释原文：_"trustedHosts is a DNS-rebinding fence, explicitly not
  authentication, so the whole configuration plane stays loopback-same-origin
  until a real authentication layer exists."_
- 因此 **`PUBLIC_TRUST` 和 HTTPS 都无法解除该限制**（看的是 Host，不是加密）
- 模型目录 `llm.providers` / `llm.models` 故意不钉死 → **局域网聊天正常**，
  只有设置/密钥页需要 loopback

**影响与对策**：

- 聊天：局域网直连可用（配合本文件 shim 修复 randomUUID）
- 配置模型/API Key：只能 loopback 访问——服务器本机 `http://127.0.0.1:<port>/`，
  或远程 SSH 隧道 `ssh -L <port>:127.0.0.1:<port> user@server` 后浏览器开 127.0.0.1
  （隧道访问同时满足 loopback + 安全上下文，randomUUID 也无问题）
- 多租户产品约束：每个租户的模型配置由租户经 loopback 自行完成，或运维以
  环境变量注入（读 README 的 `INJECT_ENV`；注意模块化版 `src/` 当前未实现该变量，
  需要时需补回）

## 十、解决方案：用户自助配置（钱包签名验证身份）

在 loopback 限制下，让**每个用户在自己的前端**配置自己的租户密钥，同时保留
真实认证（而不是放开 loopback 变成"网段信任"）：

```
用户浏览器（UserCenter.vue）
  ① POST /api/user/config-challenge { address }        → 领取一次性 nonce（5 分钟）
  ② window.ccdao.request({ method: 'swtc_signMessage',
                           params: [address, nonce] })  → 插件弹签名确认，返回 signature
     window.ccdao.request({ method: 'swtc_getPublicKey',
                           params: [address] })         → 返回 publicKey
  ③ POST /api/user/tenant-config { address, nonce, signature, publicKey, apiKey }
  服务端：nonce 一次性校验 + @swtc/keypairs 验签 + 公钥推导地址 === 声称地址
          → 写入该租户卷 $DSH_HOME/.credentials.yaml（DEEPSEEK_API_KEY）
  → DSH credentials-local 热加载（chokidar，约 100ms），无需重启容器
```

**为什么安全**：

- 身份 = **钱包签名**（能签出该地址的有效签名 = 持有该地址私钥），不是"网段信任"
- 插件侧双保险：`swtc_signMessage` 会拒绝不属于当前钱包的地址（unauthorized）
- key 只写入租户卷（容器内 0600），服务端/日志绝不落盘或回显；
  GET 状态只回 configured/absent
- 与 CCDAO 插件同库同流程（插件内部就是 `Keypairs.sign(messageHex, privateKey)`，
  服务端 `Keypairs.verify` 对称验证），ed25519 / secp256k1 都支持

**涉及文件**：

- `src/services/tenant-config.service.js` —— 挑战存储/验签/写卷
- `src/services/merge-credentials.mjs` —— 卷内 `.credentials.yaml` 原子合并
  （在租户镜像的辅助容器内运行，借助数据卷挂载）
- `src/routes/user.routes.js` —— 4 个端点（challenge / POST / GET / DELETE）
- `frontend/src/views/UserCenter.vue` —— "🔑 我的模型密钥"卡片
- `package.json` —— 新增运行时依赖 `@swtc/keypairs`

**部署注意**：入口服务新增了运行时依赖，服务器上需先 `npm install` 再重启：

```bash
cd ~/dsh-multitenant
git pull
npm install                # 安装 @swtc/keypairs（新增）
cd frontend && npm run build && cd ..
systemctl restart dsh-multitenant
```

## 十一、时间线（补充）

7. 定位 CCDAO 插件签名 API（`swtc_signMessage` / `swtc_getPublicKey`，源码确认
   JCCDex/CCDAOConnector）
8. 实现用户自助配置 + 钱包签名验证 → 单元测试（33 通过）+ 端到端冒烟验证通过
