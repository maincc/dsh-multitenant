# 安全审查报告（2026-11-10 · 终版合并）

> 审查构成：父代理亲验判权承重链（签名/会话/静态/SSRF/错误泄漏/网关）+ 三路深审子代理
> （密码学链、容器命令与路径面、访问控制矩阵与前端注入面）。**P0/P1 每条均由父代理
> 重新亲眼复核源码后才立案**（双人独立命中才标"交叉印证"）。只读审计，未改任何代码。
> 纪律：无行号证据不立案；证伪的如实记录，防后人重查。

## 一、总体判断

五条判权不变量的**主干成立**：随机 token 查哈希表会话、破坏性操作当场签名（一次性
nonce 先烧后验 + purpose 分池 + binding 防签A执行B + 公钥推导地址===声称地址 fail-closed）、
全仓 execFile/spawnSync 数组参数（命令注入面封死）、kebab 正则多道闸（路径穿越封死）、
docker socket 不挂租户容器。
**但 2026-10 大加固的三处"灯下黑"属实**：①skills 的免签 GET 视图（守卫补位时漏了
孪生面——判例 58 的守卫版）；②网关签名门的放行凭证是**无秘密的派生哈希且签名前就
印在页面上**（密码学门是客户端装饰）；③"本人免签"分支 × 同站异端口（SameSite 不判端口，
本仓自己的注释反复声明此事）= 租户页可对管理员代发自我毁灭操作。

## 二、发现清单（合并去重后）

### [P0] S1 匿名跨租户卷侦察 + 匿名 docker-run + GET 写他人账（双代理独立命中，父代理复验坐实）

- 证据：`skill.routes.js:121-135` GET `/api/skills/mine?address=` **无会话/无签名/无限流**
  （仅格式正则，注释自认"视图，无需签名"）；`:152-161` GET `/api/skills?address=` 同缺。
  → `skill.service.js:326-338` mineView：读他人 `readInstalls()[address]` 全表 +
  `probeVolumeFull(:286-303)` → `tenant-config.service.js:256-277` **runScript 挂任意地址卷起
  helper 容器**（技能名+sha256+插件实物+pluginsDir 全回读，`list-skills.mjs:108-133`）。
  → `skill.service.js:373-386` 对账循环里 `removeInstallRecord`——**一个匿名 GET 会销他人账**。
- 受害者地址底料：公开市场列表回 `sharer`（`skill.service.js:686-701`）。
- 可跑 payload：`curl HOST/api/skills | jq -r '.skills[].sharer'` → `curl "HOST/api/skills/mine?address=<victim>"`。
- 放大面：两条 GET 无限流、每请求 docker run；`list-skills.mjs:67-86` walkCount 无上限
  （对照同域 `env-inventory.mjs:18 WALK_CAP=2000`）。
- 修复（对齐 `user.routes.js:959-966` tenant-config GET 的 2026-10 修法）：
  ① 归属闸 `session===normalize(addr) || isAdmSync(session)`；② 限流；③ GET 路径去写副作用
  （对账移 POST/显式任务）；④ walk 加帽。**孪生检查：全文检索 `address` 进 runScript/probe
  的其它免守卫调用点，一并收口**（判例 58 纪律）。

### [P1] S2 网关签名门零秘密可白嫖——cookie 独得即可进容器，密码学门形同虚设

- 证据：`tenant-proxy.service.js:425-427` `gwOkToken=sha256("gw-ok|<address>|<port>")[:32]`
  ——**纯公开信息派生，无服务器秘密**；`:437-441`+`:988-992`（父代理亲验）：只要
  `authorize`（会话匹配）通过，**签名发生之前**校验页 HTML 已把 token 明文嵌出；
  `:429-434` hasGwOk 仅字符串比对。`/connect` 同款：`:107-124` 先验后消费。
- 攻击路径（威胁模型自证：`admin-signature.middleware.js:6-11` 与 `tenant-proxy:55-57`
  都写明"cookie 不按端口隔离"）：偷得 user_session → `GET :<租户端口>/ (Accept: text/html)`
  → 从 HTML 抄 gw_ok → 手工 set cookie → 重进即放行。**全程不碰钱包**。H2"串门绕过"
  修的是跨租户维度，没修"cookie 独得"维度——本条即其残余。
- 关联 [P2]：`/__gw__/verify :951-964` `valid` 不含挑战池核验且 `if (valid) consume(...)`
  丢弃返回值 → 历史 GATEWAY 签名永久可重放（同根次生，一并修）。
- 修复：token 改 `randomBytes` **会话侧服务器签发**——只在 `/__gw__/verify` 验签成功
  （consume 返回 true）时 `Set-Cookie: gw_ok=<随机值>`；verify 的 valid 并入 consume 结果。

### [P1] S3 同站 CSRF：只凭 cookie 免签的自我毁灭端点，租户页可代发（前提父代理亲验）

- 关键前提（本仓自认）：SameSite=Strict **不判端口**（`tenant-proxy:55-57`、
  `admin-signature.middleware:6-11`）→ 租户页（:310xx）对平台（:8090）的表单/img 请求
  **带 cookie 且属"同站"**；下列端点不读体=简单请求免预检：
  | 端点                                 | 免签证据                                               | 后果                     |
  | ------------------------------------ | ------------------------------------------------------ | ------------------------ |
  | `GET /leave/<自己地址>`              | `tenant.routes.js:331`（仅 session!==address 要签）    | `<img>` 即销毁管理员容器 |
  | `POST /api/user/<self>/reset`        | `:510-521` **亲验**：本人分支免签，注释自陈 reset 删卷 | 抹掉会话主人全部数据     |
  | `POST /api/user/<self>/stop·restart` | 同型                                                   | 断服/断会话              |
  | `POST /api/{user,admin}/logout`      | 仅读 cookie                                            | 踢登出（低危）           |
- 受害者地址枚举：`admin.routes.js:253-274` isAdmin oracle + 市场 `sharer`。
- 修复：给"仅 cookie 状态变更"统一加 **Origin/Referer 同源校验**（本仓无 CORS 头，
  需 JSON 体的端点因预检失败已侥幸安全——不扩到简单请求面即可）；`GET /leave` 改 POST；
  "本人免签"是否升级为当场签名 = 产品决策（治理对称性注释 `admin-signature:55-58` 已
  暗示方向），先以 Origin 闸止血。

### [P1] S4 挑战池全局洪泛：三个匿名发放端点无限流，共享池满=全站登录瘫痪

- 证据：无 rateLimit——`skill.routes.js:54`（skills/challenge）、`user.routes.js:869`
  （config-challenge）、`admin.routes.js:105,151-158`（admin/challenge 的 LOGIN 分支）、
  `admin.routes.js:170`（admin/login，验签 CPU 放大）。对照 `/connect-challenge` 有 max10
  （`tenant.routes.js:28-43`）。**池全 purpose 共享一张 Map**（`tenant-config.service.js:127`，
  键含 purpose 但 `MAX_CHALLENGES=10000` 数全局，`:53,193`）→ 从无限流的门灌满共享池，
  限了流的 connect-challenge 照样 503。攻击成本 ~2k req/min。
- 修复：三发放端点 + admin/login 补同款限流；`issueChallenge` 加"每地址/分钟"二级闸；
  （可选）purpose 分池配额，隔离伤害半径。

### [P1] S5 错误响应回吐内部串（docker stderr/宿主绝对路径/卷名）

- 证据：`errors.js:84-85` 原样回 `err.message`；载荷源 `tenant-config.service.js:282-285`
  （卷名+stderr）、`admin.routes.js:1621-1625`（**宿主绝对部署路径**）、
  `tenant.routes.js:214-215`（text/plain stderr 直出，验签租户可读）+各路由自造 5xx 模板十余处；
  `admin.routes.js:1582/1791/1884/1926` 任务对象含 err.message/backupPath。
- 修复：≥500 对外固定文案+错误号，原文只进日志（`errors.js:69` 已有 console.error 分支）。

### [P2] 汇总（各带证据，修复从简）

- **P2-a DELETE /api/skills/:name 管理员分支免签**（父代理亲验 `skill.routes.js:185-197`）——
  与已签名的 POST `:name/hide`（`:249-257`，H3 加固）**同语义双入口一严一松**；cookie 独得者
  可直接毁他人技能正文。修：并入同一 requireAdminSignature('skill-hide',{name})。
- **P2-b env-commit 勾选集规范化非单射=签A执行B成立**（`admin-signature.middleware.js:131-135`
  `join(',')`+`|` 拼接不查元素字符集；执行侧 `env-commit.service.js:43-48` 允许逗号竖线）：
  诱签 `folders:["a,b"]` 执行 `["a","b"]` binding 相等。修：元素含 `,|:` 拒收或长度前缀编码。
- **P2-c dsh/apply image 绑定小写化 vs 执行大小写敏感**（`:161` vs `:187-191` dsh/select
  反例自证）+ **dryRun 不入 binding**（`:1802` 注释称有意——预览签即真重建钥匙）。
- **P2-d API key 明文进 docker exec argv**（`tenant-config.service.js:295-299`+`:266-277`
  `…merge-credentials.mjs set <REF> <明文>`）——宿主 `ps`/daemon 审计日志可见。修：stdin 传值。
- **P2-e 存储形态与"0600"声明错位**：现网 provider=mongodb（实测 `config.json`），
  **mongod 无鉴权、监听 127.0.0.1:27018（lsof 实测）**——本机任意进程可 insertOne 铸管理员
  会话票（`session.store.js:74-82` 查表即真）；json 时代 0600 叙事对现形态不适用。
  且 `data/credentials.json`、`data/backups/*.tgz`（**全租户数据卷副本**）实测 **0644**，
  不在 `hardenDataPermissions` 名单（`data.service.js:51-58`）。修：Mongo 开 SCRAM+确认 bind；
  权限收敛名单扩容；备份落盘 chmod。
- **P2-f 供应降级静默化**：`compat`=seccomp/apparmor unconfined+两档均 `--cap-add SYS_ADMIN`
  （`docker.service.js:349-374`）；seccomp 文件被 daemon 拒一次→**进程级永久静默降级**（`:640-660`）；
  租户隔离网络建网失败→退回 default bridge 互通（`:138-146`，测试日志实测触发过此态）；
  逃逸 payload 构造不出（内核相关），属隔离强度弱点非直接洞。修：降级显式化+熔断旗标+补
  no-new-privileges。
- **P2-g discover SSRF**：helper 容器无 `--network none`（`tenant-config.service.js:266-277`
  对照 `docker.service.js:1826-1828` 选项存在未用），`probe-models.mjs` 仅 `^https?://` 前缀闸，
  `HTTP <code>` 错误回显=盲打内网 oracle。修：helper 默认断网/egress 白名单。
- **P2-h 工作区快照宿主解包无尺寸闸**（`docker.service.js:1051-1054` 仅 120s timeout；
  `--storage-opt` 不支持时静默跳过 `:633-656`）→磁盘 DoS。修：解包前 stat 帽。
- **P2-i 布尔枚举 oracle**：isAdmin（`admin.routes.js:253-274`，已限流 20/min）、
  /connect-status exists、wallet-login NO_ACCOUNT 存在性（`user.routes.js:55-61`）。S3 的前置侦察料。

### [INFO] 纵深增强与如实记录

- 全端点无 CSP/XFO/Referrer-Policy/HSTS；cookie 无 `Secure`（LAN-HTTP 形态自洽，上 HTTPS
  反代必须同步补，且反代后限流键 `req.socket.remoteAddress` 会退化为单代理 IP——两形态都要实测确认）。
- `gateway_ticket` 走 URL（1min 一次性）可经 Referer/历史外泄。
- 静态服务安全依赖 WHATWG 解析器兜底，join 无自带 containment（现状无可利用）。
- 前端：3 处 v-html 全绑硬编码 SVG（亲验无用户内容）；innerHTML 等 sink 全仓 0；技能全文
  `<pre>{{ body }}</pre>` 插值转义 → **XSS 面判定不成立**；localStorage 仅公开地址，无 token/
  签名材料；无 postMessage 监听器。仅 `MobileContainer.vue:583` window.open 缺 noopener。
- verify→consume 次序三种流派并存（admin 先烧/connect 后烧）——均不可利用（nonce 256bit），
  记一致性债。
- high-s 签名可延展（elliptic 6.6.1 不查 low-s）——一次性消费下无利用面，记档。
- 双 handler 认领靠排除表隐式契约（`server.js:273-290`+`user.routes.js:988-993`）、
  若干 `return;`（undefined）依赖"已发响应不复写"（`user.routes.js:996/1045/1048`）——脆弱耦合，改路由时须小心。

### [证伪记录]（本轮查过、确认不成立——防重复排查）

SSRF-网关激活 token 外流（目标硬编码 127.0.0.1+内表端口）｜命令注入（execFile 数组参数全覆盖，
容器内 3 处 sh -c 的插值全常量/严格字符集/shq 规范转义）｜路径穿越（kebab 四道闸+bsdtar 实测
拒 `..` 成员）｜验签 fail-open（catch→false）｜外层签名消息分符注入（validateSwtcAddress 前置于
全部兑现点，j+base58 无 `|`）｜malleability/重放（一次性消费封死）｜算法自选（推导地址===声称
地址仍强制）｜会话大小写遮蔽｜双票抢占（历史，已废止）｜平台 cookie 漏进租户容器（H1 请求向已剥离）｜
计时侧信道（无秘密值 === ）｜孤儿卷清理清单进 shell（execFile 数组，不成立）｜docker socket 暴露
租户（挂载面核查无）｜技能正文 zip bomb（publish 64KB/名 64 字符/包 50-200MB/200 项多道帽）。

## 三、修复优先级建议（待裁定）

1. **S1**（P0，一小时内可修）：skills 两 GET 补归属闸+限流、去写副作用、walk 帽——最高危且改动小。
2. **S2+S4**（P1）：gw_ok 服务器随机签发+verify 并 consume；三发放端点+admin/login 限流。
3. **S3**（P1）：Origin 同源校验小闸（一个 util 函数）+ GET /leave 改 POST（前后端两处）。
4. **S5**（P1）：5xx 文案收口。
5. **P2 批次**：a/b/c/d 各一行级；e/f/g/h 需部署配合（Mongo 凭据/降级显式化/网络帽）。
6. S3 的"本人操作也当场签名"与 P2-c 的 dryRun 入绑——**治理扩展，需产品裁定**，不擅动。

## 四、修复落地（2026-11-12 批次 · S1+S2+cookie secure，用户裁定"修一下"）

**S1 已修**（`src/routes/skill.routes.js`）：

- `GET /api/skills/mine?address=` 加归属闸：`getRequestAddress(req) === normalizeAddress(address)`
  或管理员（`isAdmSync`）才可读，否则 403——匿名侦察他人安装账、借 `mineView→probeVolumeFull`
  挂受害者卷、以及 GET 路径 `removeInstallRecord` 写侧销账三条面一并关闭。判例：tenant-config GET 会话门。
- `GET /api/skills?address=` 列表保持公开，但非本人/管理员的 address **静默忽略**——市场页照常
  公开可逛，只是不再替匿名访客探卷打"已安装"标记。
- 回归：`test/skill-routes.test.js` 3 例（本人 200/匿名 403/他人会话 403）；生产冒烟匿名 mine → 403。

**S2 已修**（`src/services/tenant-proxy.service.js`，三道闸缺一不可）：

1. `gwOkToken` 从裸 `sha256('gw-ok|addr|port')[:32]`（无秘密、可离线铸造）改为
   **HMAC-SHA256 + 进程级随机密钥**（`GW_OK_SECRET = randomBytes(32)`，重启废旧票=重签一次，
   刻意不持久化）+ **5 分钟滚动窗口**（`GW_OK_WINDOW_MS=300_000`，校验宽容上一窗一格）。
2. **票只发给通过者**：校验页不再预埋 `__GWOK_TOKEN__`；`/__gw__/verify` 验签+消费成功后由
   服务端 `Set-Cookie`（httponly+samesite=lax）现签发放——未签名者翻遍页面也拿不到放行凭证。
3. **重放判决**：verify 旧代码只调 `consumeChallenge` 不判返回值（同份签名可无限兑换 true），
   现 `valid = valid && consume(...)`。

- (address,port) 绑定语义保留（2026-10 串门判例不破）。导出签名 `gwOkToken(addr,port[,win])` 向后兼容。
- 回归：`test/tenant-gateway-verify.test.js` 4 例（旧 sha256 配方被拒/校验页零泄漏/重放二连必挂/
  窗口滚动 w,w-1 通 w-2 拒）。

**cookie secure 条件化已修**（新 `src/utils/cookie-flags.js::secureFlag(req)`）：

- 判形：`req.socket.encrypted || x-forwarded-proto 首跳==https` → `; secure`，否则空串。
  纯 http 形态（本机 8090）带上它浏览器直接丢 cookie——两形态共存是硬约束。
- 覆盖全部 9 处会话 cookie 签发/清除点：user.routes×2、tenant.routes×3、admin.routes×2、
  tenant-proxy×2（tryTicket 会话 + gw_ok 签发），logout 清除同规。
- 回归：`test/cookie-flags.test.js` 6 例钉死判形矩阵。

**未动（留后续批次）**：S1 尾巴两项——`mineView` 读路径上的 ghost-reconcile 写副作用（归属闸后
只剩"本人刷新自己的页会销自己的账"，攻击面已除，语义待 S4 批次一并理顺）与 skills 端点限流
（归入 S4）。S3（同站 CSRF Origin 闸+GET /leave 改 POST）、S4（三发放端点限流）、
S5（5xx 文案收口）、P2 批次。测试基线 990 → **1002/1002**（+12），prettier 全绿。

**踩坑记录**：skill-routes 测试补会话 mock 时 `{...mod.dataService}` 展开丢类原型方法
（readJson 现场炸）——部分 mock 服务单例必须 `Object.create(getPrototypeOf)+assign` 保原型链。
