# dsh 平台身份认证现状盘点（DID 讨论的事实基线）

> **性质**：只读现状调研（代码证据逐条标注路径行号），不改任何行为
> **日期**：2026-10 ｜ **状态**：📋 现状基线，供 DID 认证方案（`ccdao-did-integration.md` P3 候选）对照用
> **触发**：讨论"用 DID 做身份认证"前，先钉死现在到底怎么认证

## 1. 身份模型一句话

**地址 = 私钥 = 身份，三位一体。** 系统里不存在独立于地址的"人"：租户主键、额度、豁免、卷名、容器、会话全部以 SWTC 地址（51 位 base32，`normalizeAddress` 统一小写）为键；"你是谁"的验证 = "你能签对为这个地址发放的挑战"。无档案、无注册门槛——**任何有效私钥都是合法租户**（"登录零门槛"是明文产品决策，见 `cwt-access-design.md` 前置节）。

## 2. 公共底座：用途绑定的 challenge 机制

六条签名信道共用一台机器（`src/services/tenant-config.service.js` L80-206）：

```
SIGN_PURPOSE = { LOGIN | CONNECT | TENANT_CONFIG | SKILLS | GATEWAY | ADMIN_OP }

发放 issueChallenge(address, purpose)
  → nonce = 32字节hex；message = hex("dsh-multitenant|<purpose>|<地址>|<nonce>")
  → 存挑战池，key = "<purpose>|<地址>"（按用途分池——A 用途的 nonce 拿到 B 用不了）
  → TTL 5min，全池 MAX_CHALLENGES 上限，过载发不出就 503

验签 verifySignature(address, message, signature, publicKey)      (L219-227)
  → Keypairs.verify(message, signature, publicKey)               // 注意：challenge 信道用 verify（含 sha512 变换），
  → deriveAddress(publicKey) === normalizeAddress(address)       //   CWT 信道用 verifyTx（裸 sha256+DER）——两套口径各在各的链路，别混

消费 consumeChallenge → 一次性删除，重放必死
```

这是现状里最值钱的资产：防凭证混淆（用途绑定）+ 防重放（一次性）+ 防堆积（池上限）都已实装且有测试。

## 3. 七条认证信道逐条（现状全图）

| #   | 信道                | 触发方                      | 协议形状                                                                                                                                                                                        | 会话/产物                                                                                                                                                                   | 代码位置                                                                           |
| --- | ------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A   | **用户 API 签名**   | 用户中心/技能市场 10 处操作 | signChallenge 四步（领挑战→插件 `swtc_signMessage` **静默签**→`getPublicKey`→带 `{address,nonce,signature,publicKey}` 提交）                                                                    | 无会话，逐请求验证                                                                                                                                                          | `UserCenter.vue` L902、`tenant-config` 各 consume 点(L591/615/654)、`skill.routes` |
| B   | **用户会话 cookie** | 进入容器 / CWT 入场后       | `user_session` token（服务端随机），存储只留 sha256→{address,expiresAt}，持久化 0600 文件 + mongo 镜像                                                                                          | 按入口不同 TTL：**30min**（CWT 短钥匙，user.routes L157）/ **2h**（connect，tenant.routes L110/429）/ **1h**（代理激活，tenant-proxy L418）/ 默认 **12h**（middleware L19） | `user-auth.middleware.js`                                                          |
| C   | **CWT 出示入场**    | CWT 豁免用户                | 前端 `cwt_sign({address, usr:'dsh-usr'})`（插件**有确认弹窗**）→ token 交后端 → `cwt.service` 验签（x5c→公钥→地址推导、time 单向窗、chain/type/alg 策略）→ `registry[addr].status==='approved'` | 换发 30min 会话 + 一次性 `gateway_ticket`                                                                                                                                   | `UserCenter.vue` L764、`user.routes` L120-165、`cwt.service.js`                    |
| D   | **容器所有权连接**  | 平台→容器建连               | **401 驱动握手**：未带签名材料→401+下发 CONNECT 挑战→钱包签→带参重试→验+consume→创建/进入容器                                                                                                   | 2h 会话                                                                                                                                                                     | `tenant.routes` L40-90                                                             |
| E   | **网关流量校验**    | 容器内 DSH→平台 RPC         | GATEWAY purpose 的同款 challenge 往返                                                                                                                                                           | 无会话                                                                                                                                                                      | `tenant-proxy.service` L757-798                                                    |
| F   | **管理员登录**      | AdminPanel                  | LOGIN purpose 四步验签 + `isAdmin()` 名单 → `admin_session` cookie（httponly/samesite=strict/12h）                                                                                              | cookie 会话                                                                                                                                                                 | `admin.routes` L148-215                                                            |
| G   | **容器内 DSH UI**   | 用户浏览器→租户容器         | 平台经 docker logs 读 **launch token** → 代激活 → 容器签 cookie；复制 URL 直访则 ticket 失效后回落到签名校验页                                                                                  | 容器自己的 cookie                                                                                                                                                           | `dsh-auth.service.js` 头部设计注释                                                 |

**信任根分两类**：A-F 的锚是"私钥持有证明"（deriveAddress 一致即本人，无注册表）；G 的锚是平台代激活（容器网络内信任）。Admin 的操作签名（`signAdminOperation`）用平台 keyfile 私钥，与用户钱包**不同信任域**，不在 DID 讨论范围。

## 4. 身份键贯通面（动"身份"会碰哪里）

```
地址为键的资产（现状清单，供后续评估改动半径，非改动计划）：
  Mongo: 租户文档 _id=addr │ sessions 集合 │ cwt_registry._id=addr │ cwt_applications
  物理:  卷名 dsh-data-swtc-<addr>（字符串烧死） │ 容器名 dsh-<addr> │ 端口表
  配额:  usage-limit 按地址累计 │ data/cwt/registry.json │ user-sessions.json
  展示:  localStorage swtc_address │ identities（插件侧昵称）
```

## 5. 前端调用面统计

- `signChallenge(...)`：**10 处**（UserCenter 9：配置/端点/官方 key/重置/重启/停止/技能上撤下卸… + SkillMarket 1：安装）
- `cwt_sign`：**1 处**（UserCenter CWT 申请，usr 固定 `dsh-usr`，不传 time 走服务端当下）
- 插件三 RPC：`requestAccounts` / `swtc_signMessage` / `getPublicKey`（A 信道每次 3 调用 + 1 次 HTTP 领挑战）

## 6. 强面与弱面（只陈述，不设计）

**强面**

1. 用途绑定 + 分池 + 一次性：跨端点凭证混淆链已被明确堵死（admin.routes L177 注释即当时的加固记录）
2. CWT 验签与插件生态字节级对齐（x5c/verifyTx/时效窗），交叉验证在册
3. 会话短化策略有意为之：CWT 入场 30min 防"切钱包后旧 URL 仍可进"（user.routes 注释）

**弱面（DID 认证方案要面对的差距）**

1. **零门槛的另一面**：任何脚本生成的 secp256k1 私钥都是合法身份——系统无法区分"生态里真实的人"与"新生成的地址"；额度/豁免按地址发放，批量生成地址薅额度无阻力（CWT 申请本身要求先持有 `dsh-usr` token，但 token 也是任意钱包可签）
2. **静默盲签**：A 信道的 `swtc_signMessage` 无弹窗（插件源码确认无授权流），用户对"自己刚为哪个操作背了书"无感知
3. **公钥自证结构**：`{publicKey}` 随请求体上传、以"能推导出声称地址"为唯一审查——正确但**无"这把键是否在生态登记过"的概念**（did:swtc 文档里 `authentication[]` 的存在性未被利用）
4. **身份三层压扁**：人/钥匙/设备无区分——一把私钥就是全部；丢钥匙 = 数据在卷里但永久不可达（无恢复路径，见 DID 讨论 §硬事实）
5. `usr:'dsh-usr'` 固定值：CWT 出示不绑用途一次性（任意历史合法 token 可复用出示，与 A 信道的一次性标准不对齐）

## 7. 与 DID 分级认证的映射（预置坐标系）

| 现状             | DID L0/L1/L2 定位                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| 第 3 节 A-F 全部 | **已是 L0**（密钥持有证明，签名信道标准化 = P1 讨论的底座①）                                           |
| 未做             | **L1**：解析 `did:swtc/did:ethr` 文档 → 签名公钥须在该 DID `authentication[]` 登记（"有生态档案的人"） |
| 未做             | **L2**：config 开关，敏感操作（豁免申请/重置/删除）强制 L1                                             |
| 弱面 1/5         | L1 的准入语义天然收敛（无档案地址止步 L0，只能看不能申请豁免）                                         |
| 弱面 2           | `cwt_sign` 信道自带弹窗，A→C 统一即"知情签名"（P1 遗留结论：值得，但独立于 DID）                       |

**基线小结**：现状认证骨架是健康的（purpose 绑定机器可复用为 DID 认证的挑战层），缺口不在"签名对不对"而在"**签名的这把键是不是一个登记过的身份**"——L0 已有，L1 空白，L2 空白。所有 DID 方案讨论应以此为对照，不重复发明已有零件。
