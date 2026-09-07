# dsh-multitenant 安全加固计划（可落地版）

> 依据：`workflow security-audit-dsh-multitenant` 六面审计结论（认证/注入/越权/前端/数据/基础设施）。
> 原则：**先堵控制面信任根（管理会话），再补资源与纵深，最后做体验类加固**；每项含改动点、测试、验收，可逐项勾销。

## 0. 风险画像（摘要）

- **S1 管理员会话=可伪造 Cookie（零签名）** → 完整管理员接管链（提权/删卷/自批 CWT 豁免）
- **S2 /connect 零门槛 + /leave 无认证** → 资源耗尽、定向 DoS、地址冒领
- **S3 无请求体上限 + 挑战 Map 无界** → 内存 OOM → 单进程 `exit(1)` 全平台停机
- **S4 技能市场正文零审查** → 跨租户供应链命令注入（容器内执行、窃取 DEEPSEEK_KEY）
- 高危：API Key 经 argv 泄露、SSRF、IDOR、卷无配额、容器特权过大

---

## 1. P0 —— 控制面信任根（不改会继续裸奔，工作量 S~M）

> **✅ 阶段 1 已完成（2026-09-05）**：P0-3 全部、P0-2 的 /leave 鉴权+限流、P1-9、P2-2、P2-6 已落地并通过全量测试（192 用例）与实机验证。
> 待办：P0-1（管理员签名登录）、P0-2 的 /connect 所有权口径、P0-4（技能边界）。

### P0-1 管理员登录改「钱包签名挑战」，会话改服务端随机会话（待办）

- **现状**：`POST /api/admin/login {address}` → `isAdmin` 比对即发 `admin_session=<地址>`；`requireAdmin` 只信任 Cookie 原值（admin.routes.js:31-53、auth.middleware.js:10-28）。
- **方案**（复用已存在的 tenant-config nonce 模式，tenant-config.service.js:87-117）：
  1. 后端新增 `POST /api/admin/challenge {address}` → 下发一次性 nonce（`randomBytes(32)`，TTL 5min，用完即焚，存入内存 Map 并定期清理）
  2. `POST /api/admin/login {address, nonce, signature, publicKey}` → `Keypairs.verify` + `deriveAddress(publicKey)===address` + `isAdmin(address)` 三重通过后，签发 **`randomBytes(32)` 随机会话 ID**（存 `data/config/sessions.json`：`{token: {address, expiresAt}}`），Cookie 值=token（非地址）
  3. `requireAdmin` 改查 sessions 表（校验过期、可选轮换）
  4. 新增 `POST /api/admin/logout` 吊销
  5. 前端 AdminPanel：`adminLogin` 先 challenge → 插件 `swtc_signMessage` → 提交验签（与 UserCenter.signChallenge 同模式）
  6. 管理员地址建议迁出仓库（`config.json` 保留开发默认值，生产用环境变量 `DSH_ADMIN_ADDRESSES` 覆盖）
- **测试**：伪造 Cookie 一律 403；签名错误/过期 nonce/非管理员地址拒登；并发登录会话独立；重启后会话失效可重新登录。
- **验收**：无钱包、无签名情况下（curl 直发 Cookie）无法触发任何管理接口；`/api/admin/check` 需登录态。
- **依赖**：前端 + 后端一起改，插件 `swtc_signMessage` 已存在调用先例。

### P0-2 `/leave` 加鉴权 + `/connect` 所有权口径 + 三接口限流

- **现状**：`/connect?address=` 零签名创建/接管；`/leave/:address` 无认证销毁；`/connect-status` 未认证泄露任意地址状态（tenant.routes.js:16-57、60-120、123-143）。
- **方案**：
  - `/leave`：`session===address || isAdmin(session)`（与 /stop 同模型），无会话 403 —— **立即改，无 UX 影响**
  - `/connect`：**需要拍板**（见 §4 决策点）——推荐的折中是：保持免签名可用，但加**按 IP 速率限制**（如 10 次/分钟/IP）+ 已有地址免限；所有权证明（签名）列为 P1
  - `/connect-status`：仅对无会话请求返回脱敏字段（端口/状态保留，用量、timeout 归零或标注"需登录查看"）
  - 速率限制：`src/middleware/rate-limit.middleware.js`（内存滑动窗口，每路由可配）
- **测试**：无会话 `/leave` 403；限流触发 429；状态脱敏生效。
- **验收**：无法通过 `/leave` 击毁非本人容器；洪泛 `/connect` 被限流。

### P0-3 请求体上限 + 挑战 Map 治理 + 队列上限

- **现状**：`parseBody` 无限累加（admin.routes.js:18-24、user.routes.js:17-23）；`challenges` Map 只增不删（tenant-config.service.js:87-102）；`waitQueue` 无界纯内存（user.service.js:39）。
- **方案**：
  - `parseBody` 加 64KB 上限 + Content-Length 预检，超限 413
  - 挑战 Map：TTL 过期清理定时器（复用启动定时器模式）+ 总条目上限（如 10k，超限拒绝新挑战）
  - `waitQueue`：上限（如 500）+ 过期淘汰 + （P1）落盘持久化
- **测试**：>64KB body 413；百万级 fake 挑战后内存稳定；队列超限返回 503。
- **验收**：单请求无法撑爆内存；挑战接口无法无限堆积。

### P0-4 技能市场信任边界（供应链注入）

- **现状**：发布零审查正文入仓，安装原样写入受害者卷，模型可自动调用（skill.service.js、install-skill.mjs）。
- **方案（分两步）**：
  1. 立即：新增配置 `skills.autoInvoke` 默认 `false`（模型不可自动调用未显式装受信技能）；安装前弹确认 + 风险提示（前端）
  2. P1：发布正文静态扫描（命令调用/URL 外发/凭据读写模式标记"未审核"）；按发布者举报/拉黑
- **测试**：恶意技能体安装后不可被模型自动触发；前端确认流生效。
- **验收**：默认配置下恶意技能无自动执行路径。

---

## 2. P1 —— 纵深与资源防线（每个独立可做，S~M）

| 编号  | 问题                                                     | 方案                                                                                                                               | 测试/验收                    |
| ----- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| P1-1  | API Key 经 argv 泄露（tenant-config.service.js:157-161） | `merge-credentials.mjs` 增加 stdin 读值模式；`execFile('docker', args, {stdin})`；`runScript` 错误剥离命令行只留退出码+裁剪 stderr | docker 失败时响应/日志无密钥 |
| P1-2  | SSRF（probe-models.mjs）                                 | 服务端拒绝私网/链路本地/环回/云 metadata 段；DNS 解析后校验目标 IP；并发限流                                                       | baseURL 指向 169.254.x 被拒  |
| P1-3  | IDOR `/api/user/:address`（user.routes.js:194-202）      | 无会话一律 403，仅 `session===address \|\| isAdmin`；用户会话见 P0-1 会话体系扩展                                                  | 无 Cookie 读任意用户 403     |
| P1-4  | 内存预检 Linux 恒真（user.service.js:60-68）             | 改用 Linux 可用内存（`/proc/meminfo` 或 `free`）；查询失败 **fail-closed** 拒绝供应                                                | Linux 下耗尽时拒绝创建       |
| P1-5  | 卷无配额（docker.service.js:120-121）                    | Linux 下 `--storage-opt size=`（ext4/xfs）+ I/O 限速；环境不支持时跳过并降级告警                                                   | 写满卷被拒而非写满宿主       |
| P1-6  | 容器特权过大（docker.service.js:104-109）                | 评估去掉 `SYS_ADMIN`（需容器内验证 bwrap 可用性）；至少 `--cap-drop ALL` + `--security-opt no-new-privileges`                      | 租户容器内无特权/提权操作    |
| P1-7  | CWT 申请队列/token 无限（cwt-admin.service.js:59-73）    | token ≤8KB；pending 队列总条数上限（超限 503）；approved 的 token 改存 SHA-256 摘要（复核时需重新出示）                            | 洪泛申请被拒；磁盘增长受控   |
| P1-8  | CWT 状态泄露 approvedBy（cwt-admin.service.js:100-107）  | approvedBy 仅管理员可见；usr 对非本人脱敏                                                                                          | 匿名查不到审批人             |
| P1-9  | 数据文件 0644（data.service.js 全量）                    | `writeFileSync` 显式 `{mode:0o600}`（state/cwt/日志）                                                                              | 落到磁盘 0600                |
| P1-10 | 技能正文审核（接 P0-4 第 2 步）                          | 发布扫描 + 未审核标记 + 举报                                                                                                       | 恶意技能被标记拦截           |

## 3. P2 —— 部署与体验类（依赖外部环境，S）

| 编号  | 问题                                              | 方案                                                                      |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| P2-1  | 明文 HTTP + Cookie 无 Secure                      | 前置反代 HTTPS（外部依赖）；Cookie 加 `Secure`（直接改，无依赖）          |
| P2-2  | `target=_blank` 无 noopener                       | 全局补 `rel="noopener noreferrer"`（前端，立即做）                        |
| P2-3  | 无 CSP / SRI                                      | index.html 加保守 CSP（`default-src 'self'`）；构建产物 SRI（可选）       |
| P2-4  | writeWithLock 无真锁/fsync/损坏兜底               | 进程内互斥串行化 CWT 写；写前读回校验；损坏保留 `.bak`+告警（不静默置空） |
| P2-5  | restoreFromDocker 无白名单（user.service.js:893） | 容器名提取地址复用 `isValidSwtcAddress` 断言                              |
| P2-6  | token 未来时间窗口（cwt.service.js:98-101）       | 改单向 `0 ≤ now-issued ≤ ttl`                                             |
| P2-7  | 超时/maxConnections                               | `server.requestTimeout`、`headersTimeout`、`maxConnections` 显式配置      |
| P2-8  | 配置浅合并 + 死配置                               | 深合并；清理 `allowCwtEnt` 死配置；admin 名单单一数据源                   |
| P2-9  | 错误消息回显内部信息（/connect 502 等）           | 统一脱敏：只透传稳定错误码，详情进日志                                    |
| P2-10 | 等待队列丢失（重启即空）                          | 队列落盘（data/queue.json）                                               |

---

## 4. 需要你拍板的决策点

1. **/connect 所有权口径**：A) 保持免签名 + IP 限流（最快，UX 不变） B) 钱包签名才可创建/接管（根治冒领，UX 多一步签名） C) 免签名但**限制只能操作已存在于平台的地址**（首次创建需签名）
2. **管理员地址存放**：从 `config.json` 迁到环境变量（生产）？还是保留文件（改 0600）？
3. **CWT approved token 储存**：保留原文（当前，可重验回放逻辑） vs 改存 SHA-256 摘要（防泄露，复核需重出示）
4. **容器特权**：去掉 `SYS_ADMIN` 需要你确认 bwrap 在无 SYS_ADMIN 下功能完整（影响用户沙箱能力）
5. **int'l 范围**：HTTPS 反代、userns remap 属部署层，是否纳入本次？

## 5. 建议执行顺序（每阶段独立验收）

1. **阶段 1（1 个工作日）**：P0-3 全部 + P0-2 的 /leave、/connect-status、限流 + P1-9 + P2-2/P2-6 —— 零 UX 影响，先止血
2. **阶段 2（1~2 个工作日）**：P0-1 管理员签名登录 + 会话体系（前后端联动，需真机验证插件签名）→ 顺便 P1-3、P1-8
3. **阶段 3（拍板后）**：P0-2 /connect 口径、P0-4 + P1-10 技能边界、P1-1/2/7 密钥与队列
4. **阶段 4（环境验证）**：P1-4/5/6 资源与 Docker 类、P2 部署类

> 每阶段完成后跑全量测试（当前 192 用例）+ 手工 curl 回归（伪造会话/Cookie 全拒）。
