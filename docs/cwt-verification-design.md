# dsh-multitenant CWT 验证设计（申请-批准-出示）

> **状态：✅ 已实施（M0 后端 + M1 前端，2026-09）**——接口/前端/豁免联动均已落地
> **实施后修订**：①注册表/申请/审计存储从 `state.json` 迁至 `data/cwt/`
> （registry.json / applications.json / records.log，启动自动迁移）；②出示 token
> 时效由双向 `±ttl` 改**单向**（`0 ≤ now−issued*1000 ≤ ttl`，拒绝未来签发，P2-6）。
> 依据：cwt-lib 网关认证模式（`plugin/cwt.lua` 的 APISIX consumer 注册表 + 出示验签）与
> cwt-lib JS 验签口径（signingInput=raw_h.raw_p、secp256k1=sha256+DER、ed25519=原始字节、jingtum=base58 派生）
> 复用：`src/services/cwt.service.js`（验签+策略+地址推导，已就绪）
> 前置决策：登录零门槛；**CWT 授权地址豁免每日限时**；需要记录并管理 CWT

## 1. 借鉴 cwt-lib 的两种验证哲学

| cwt-lib 机制                                                                            | 本设计对应                                                                                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **APISIX consumer 注册表**（预注册 `usr→wallet` 绑定，token 的 usr 必须命中，否则 401） | **审批注册表** `cwtRegistry`：管理员批准后入库 `{usr, wallet, exp, status}`；出示 token 时查库                            |
| **验签后从 x5c 推导地址**并按 wallet 比对（CWT 类型）                                   | 复用 `cwt.service.js`：x5c 公钥 → SWTC 地址 → 与注册表 `wallet` 比对                                                      |
| **consumer 级 `exp` 双向时效窗口**                                                      | ~~注册表 `expSeconds` 时效~~ **本期不做**：CWT 只确定"该地址是已验证用户"，批准即豁免、撤销即受限，无注册时效（用户定稿） |
| **CWT_ENT 远程 verify_url（组认证）**                                                   | 本期不做（只有 CWT 单用户形态；CWT_ENT 留扩展位）                                                                         |
| **认证通过后给请求绑定身份**                                                            | 通过后该地址标记"已授权"，豁免限时（接入现有限时开关）                                                                    |

JS 端教训：JS `verify()` 只验签、**无注册表/时效/地址归属层**——所以本设计把"认证策略层"全部放服务端（与 Lua 插件同构），不依赖 cwt-lib 的裸 verify。

## 2. 四步业务流程

```
① 申请         用户 cwt_sign 签 token（usr=申请身份，如昵称/工号）
               → POST /api/user/cwt/apply（系统自动解析：地址/usr/time/验签/链）
② 管理员验证   管理面板"待审批"：显示解析结果 + 验签结果，人工点批准/拒绝
    存入      批准 → 验签复核过 → 写入 cwtRegistry（usr/wallet/exp/approvedAt）
               → 追加审计记录 cwtRecords（含 token 原文，可追溯）
③ 启动出示     用户连接/启动容器时携带 token（cwt_sign 新签）
④ 系统验证    ① 结构/策略（chain=jingtum、type=CWT、alg、TTL）
               ② 验签（x5c 公钥，secp256k1/ed25519 双路径）
               ③ 推导 SWTC 地址
               ④ 查注册表：该地址 status=approved 且未撤销 → 通过
               → 授权标记 → 启动容器（豁免每日限时）
               任一失败 → 受限/拒绝（提示去申请）
```

> 语义与 APISIX consumer 完全同构：**注册表存"身份规则"，出示 token 只是证明"当前持钥且未过期"**。
> 因此：①每次出示的都是**新签** token（time 防重放）；②批准状态在注册表以地址为键，不是把某个特定 token 当通行证。

## 3. 数据模型（data/cwt/，由 state.json 迁移而来）

```jsonc
{
  // ① 审批注册表：管理员批准后的身份规则（键 = SWTC 地址，无注册时效）
  "cwtRegistry": {
    "jndwretndumoqbt2uauclmfmx7xbqjykva": {
      "usr": "alice",
      "wallet": "jndwretndumoqbt2uauclmfmx7xbqjykva", // = 键，冗余便于展示
      "approvedAt": 1788500000000,
      "approvedBy": "admin",
      "status": "approved", // approved | revoked
    },
  },
  // ② 申请队列（待审批）
  "cwtApplications": [
    {
      "id": "a1b2...",
      "token": "eyJ4NWMi...", // 申请时出示的 token 原文
      "parsed": {
        "usr": "alice",
        "time": 1720681289,
        "address": "j...",
        "alg": "secp256k1",
        "chain": "jingtum",
      },
      "sigOk": true, // 服务端预验签结果
      "submittedAt": 1788500001000,
      "status": "pending", // pending | approved | rejected
    },
  ],
  // ③ 审计记录（每次审批动作/验证申请，token 原文存档）
  "cwtRecords": [
    {
      "address": "j...",
      "usr": "alice",
      "token": "eyJ4NWMi...",
      "alg": "secp256k1",
      "action": "approve",
      "at": 1788500002000,
      "by": "admin",
    },
  ],
  // ④ 授权状态（运行时，用于限时豁免与展示）
  "swtcUsers": {
    "jndwretndumoqbt2uauclmfmx7xbqjykva": { "...": "...", "cwtAuthorizedAt": 1788500002000 },
  },
}
```

- 注册表键 = 地址（身份级）；`usr` 是申请身份标识（展示/检索），**不参与验签判定**（判定只看地址 + 验签），与 cwt-lib 一致语义。
- 撤销 = `status: revoked`（历史保留）；撤销后该地址回到受限（限时生效）。

## 4. 接口一览（新增）

| 路径                                      | 方法 | 鉴权               | 说明                                                            |
| ----------------------------------------- | ---- | ------------------ | --------------------------------------------------------------- |
| `/api/user/cwt/apply`                     | POST | 无（token 即凭证） | 提交申请：解析+预验签 → 进 `cwtApplications`                    |
| `/api/user/cwt/status`                    | GET  | 钱包签名挑战       | 我的注册状态 / 申请进度 / 剩余限时                              |
| `/api/admin/cwt/applications`             | GET  | admin              | 待审批列表（含解析与预验签结果）                                |
| `/api/admin/cwt/applications/:id/approve` | POST | admin              | 复核验签 → 入库 `cwtRegistry` + 记录                            |
| `/api/admin/cwt/applications/:id/reject`  | POST | admin              | 拒绝（记录）                                                    |
| `/api/admin/cwt/registry`                 | GET  | admin              | 已批准注册表（含状态）                                          |
| `/api/admin/cwt/registry/:address/revoke` | POST | admin              | 撤销授权（受限）                                                |
| `/api/admin/cwt/records`                  | GET  | admin              | 审计记录列表（token 原文可查可重验）                            |
| connect/ensure 出示                       | POST | —                  | `/connect` 与 `/api/llm-proxy`（可选）带 token 或由授权标记判定 |

## 5. 服务端验证链（出示时）

```
verifyCwtForAccess(address, token):
  1. cwtService.verify(token)          // 现有：结构/策略/验签/地址推导（secp256k1+ed25519 双路径、TTL 双向）
  2. if !ok → 拒绝（受限/提示申请）
  3. registry = cwtStore.getRegistry()[addr]   // data/cwt/registry.json
  4. if !registry or registry.status !== 'approved' → 拒绝（未授权：提示走申请）
  5. 通过 → 豁免限时（isUsageExempt：approved 即豁免，无注册时效）
```

- 无注册时效（用户定稿）：CWT 只确定"该地址是已验证用户"——批准即豁免、撤销（revoked/不存在）即受限；`expSeconds` 概念已移除，不写入注册表。
- 申请时**预验签**（`sigOk`）：完整校验（结构/策略/签名/时效），通过才入待审批队列。
- **批准时复核签名，但不校验时效**（`verify(token, { checkFreshness: false })`）：
  - 校验签名 = 防 `applications.json` 被篡改（纵深防御），签名无效则拒绝批准；
  - **不校验 time 新鲜度**：审批是人工异步流程，5 分钟窗口会让管理员每次审批都失败
    （用户被迫反复重新提交），且与"无注册时效（批准即永久豁免）"自相矛盾；
  - 申请时刻已校验过新鲜度，token 只能申请一次（重复申请被拒），重放防线由
    **注册表 + 唯一申请**承担，与审批时 token 是否"新鲜"无关；
  - 是否批准一个较旧的申请交由管理员判断——管理端 CWT 列表已展示申请提交时间。

## 6. 配置（config.json 新增）

```jsonc
{
  "cwt": {
    "enabled": true,
    "ttlMs": 300000, // 出示 token 全局时效（已改单向：0 ≤ now−issued*1000 ≤ ttl，拒绝未来签发）
    "allowCwtEnt": false, // CWT_ENT 组形态预留，本期关闭
  },
}
```

## 7. 安全与边界（诚实声明）

1. **出示性质**：出示 token 证明"当前持钥"，注册表决定"身份是否授权"。**授权状态与限时豁免绑定**，但机密性等同 APISIX consumer 设计。
2. **不防对抗**：用户在容器内有 shell，限时/授权不影响其自行使用；CWT 授权是平台侧凭证体系，不是沙箱加固。
3. **token 原文存审计**：`cwtRecords` 存明文字符串（可随时重验），管理员可见；如需脱敏可改进（本期明文，文档注明）。
4. **单实例**：注册表在 `data/cwt/registry.json`，单实例生效；多实例需共享存储（与现状一致）。
5. **CWT 是"签名证明"而非实名**：任何持该地址私钥者都能完成出示；实名/审核由"管理员批准"这道人工关承担（注册表可随时撤销）。

## 8. 落地阶段

| 阶段        | 内容                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **M0 后端** | `cwtRegistry`/`cwtApplications`/`cwtRecords` 数据结构 + `apply`/审批/注册表/撤销接口 + 出示验证链接入 connect（授权→豁免限时）+ 单测 |
| **M1 前端** | UserCenter：申请表单（借 cwt_sign）+ 状态展示；AdminPanel：待审批列表（解析/验签展示+批准/拒绝）、注册表管理、审计记录               |
| **M2 可选** | CWT_ENT 组形态（verify_url 模式）、注册表导出/明文 token 脱敏、颁发邮件/通知                                                         |

## 9. 与现有代码的衔接

- `cwt.service.js`：新增一个薄封装 `verifyForAccess(token, {registry})`，内部复用现有 verify + 注册表判定；不破坏现有 API。
- `user.service.js ensureContainer` / connect 流程：启动前检查注册状态（未授权 → 受限行为由 `usageLimit` 决策；已授权 → 免检限时并标记）。
- admin 路由：`src/routes/admin.routes.js` 增 5 个接口；user 路由增 2 个。
