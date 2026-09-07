# CWT 分层提问权限设计（登录随意 · 验证解锁完整额度）

> 目标读者：dsh-multitenant 维护者
> 状态：设计评审稿（未动业务代码）
> 适用范围：本仓库（multitenant 入口服务 + 租户容器），**不改 DSH 本体**
> 前置资产：`src/services/cwt.service.js`（CWT 验签服务，已就绪，本设计直接复用）

---

## 1. 目标与用户故事

- 作为**新用户**，我连接钱包就能进自己的容器开始用（登录随意，现状不变）。
- 作为**未验证用户**，我可以提问，但**每天有次数上限**（默认 10 次，可配置）；超限后界面明确提示，并引导我去完成 CWT 验证。
- 作为**已验证用户**（完成一次 CWT 验证），我不再受次数限制，体验完整。
- 作为**维护者**，我可以看到**谁、什么时候、用什么 CWT 验证过**（记录可审计），可以把某个地址的验证**撤销**（回退为受限），可以看各地址的配额使用情况。

| 目标                  | 说明                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| 登录零门槛            | 连接钱包即创容器，不拦在门外                                            |
| 提问有限额            | 未验证：每日 N 次（默认 10，`config.json` 可调）；已验证：不限次        |
| CWT 记录可管理        | 记录验证事件（地址/usr/token/时间），admin 可查可撤销                   |
| 纯 multitenant 层实现 | 复用 cwt.service.js + llm-pi-ai provider + dataService，零改动 DSH 镜像 |

## 2. 现状盘点与关键事实

| 现状                                                    | 位置                                                | 与本设计的关系                                                   |
| ------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| 租户容器启动不注入任何模型 key/provider                 | `user.service.js:tenantPatch`                       | "默认不可问"已经是现状；本设计要加的是**受限通道 + 配额**        |
| 用户自助配 key（钱包签名 → 写卷）                       | `tenant-config.service.js`、`merge-credentials.mjs` | 配 key 后 DSH **直连官方端点**，入口无法计数 → 这是必须改造的点  |
| `llm-pi-ai` 多 provider（自定义 baseURL/models/apiKey） | `tenant-config.service.js` 的 providers 注入        | **模型出站调用可指向任意端点** —— 唯一能被入口"截获并计数"的路径 |
| `cwt.service.js`：CWT 验签 + 地址推导 + 策略检查        | `src/services/cwt.service.js`（保留中）             | 验证与记录的直接底座                                             |
| `state.json` 单进程原子写                               | `data.service.js`                                   | 配额计数 + CWT 记录落点                                          |
| admin cookie 鉴权                                       | `auth.middleware.js`                                | CWT 记录管理接口复用                                             |

**四个决定方案形态的事实：**

1. **提问发生在租户容器内的 DSH**，入口服务听不到"对话"本身；能听到的唯一位置是**模型出站调用**（HTTP 到 provider 端点）。
2. **用户在自己的容器里有 shell + 卷写权限**（现有自助配 key 就是写卷），所以"容器内配置文件被用户改掉"是能力边界的一部分——方案对"善意配合流程"的用户精确执行，对"故意绕过"是软约束（见 §9）。
3. **无平台 key**（本次决策）：平台不持有公共买单 key。用户提问用的 key 属于用户自己。
4. DSH 的 `trustedHosts` 是 **host 级**（且局域网 IP 自动可信），不能做用户级门禁，因此**限制只能做在"出站模型调用"这一层**，不能做在"界面能否打开"层。

## 3. 总体架构：模型出站代理网关（LLM Gateway）

```
租户容器 DSH（未验证/已验证）
   │  模型调用（llm-gateway provider 注入，baseURL 指向入口）
   ▼
入口服务  POST /api/llm-proxy/<address>/chat/completions
   │  ① 按 URL 路径识别租户地址
   │  ② 配额/验证检查（见 §4）
   │  ③ 限流放行 → 转发到该用户配置的真实模型端点（带用户自己的 key）
   ▼
DeepSeek 官方 / 用户自定义端点
```

要点：

- **所有租户创建即注入一个受限 provider** `llm-gateway`（写到卷 `settings.yaml` 的 `llm-pi-ai.providers.gateway` 段）：
  ```yaml
  llm-pi-ai:
    providers:
      gateway:
        api: gateway
        baseURL: 'http://<入口host>:8090/api/llm-proxy/<address>'
        models: [deepseek-chat, deepseek-reasoner] # 或按租户配置
  ```
- 入口只认 URL 里的 `<address>`（来源天然隔离，不需要额外身份头）。
- 容器到宿主的地址：Docker 容器访问宿主用 `host.docker.internal`（`createContainer` 加 `--add-host host.docker.internal:host-gateway`）或 `PUBLIC_HOST`（内网可达时）。
- **用户 key 的位置（关键决策，与"无平台 key"不冲突）**：用户"配 key"改到**入口侧**——新增接口
  `POST /api/user/gateway-credential`（CWT/钱包签名鉴权），把 `{ baseURL, apiKey }` 存到
  `data/config/gateway.json`（按地址分文件，0600，服务端仅用于转发该用户请求，不共用、不公开）。
  转发时解密使用。**平台持有的是"用户私有 key"，不是平台公共买单 key**。
- 现有 `tenant-config`（把 key 写进卷 → DSH 直连官方）将**按验证状态分流**：
  - 未验证：配 key 走 gateway-credential（入口侧），容器内**不落直连凭据**，模型调用必经网关 → 可计数；
  - 已验证：保留直连配置能力（现状），或继续走网关但不限流，二选一由配置 `quotas.gatewayForVerified` 决定（默认：已验证走网关但不计次，体验一致且路径统一，便于以后加审计）。

## 4. 配额计数

- 计数数据结构（`state.json`）：
  ```json
  "quotas": {
    "<address>": { "date": "2026-09-04", "count": 3 }
  }
  ```
  按**自然日**重置（date != 今天 → count 归零）。
- 检查逻辑（代理入口，同步内存计数 + 原子持久化兜底）：

  ```
  verify(address) 已通过 ? → 放行（不计次）
  count(date) >= dailyLimit ? → 429 QUOTA_EXCEEDED（附剩余/重置信息）
  否则 → count+1，放行转发
  ```

- 配置（`config.json`）：`quotas.dailyLimit`（默认 10）、`quotas.enabled`（默认 true）。
- 单进程内计数即准；入口为单实例部署（现状）。**多实例横向扩展会破坏内存计数**——需移动到 Redis，见 §9 残差声明。
- 转发失败（上游 4xx/5xx/超时）**不计次**——只有成功进入上游的请求消耗配额。

## 5. CWT 验证与记录管理

### 5.1 验证流程

```
用户点"验证解锁" → 插件 cwt_sign({address, usr}) → token
   → POST /api/user/cwt-verify { token }
   → cwtService.verify(token)  （cwt.service.js：策略检查 + 验签 + 地址推导）
   → 通过 → 记录 + 该地址标记已验证 → 返回 { verified: true, address }
```

- `usr` 由用户自填（身份标识，不校验内容）；身份以 **x5c 公钥推导的地址**为准。
- 验证**只有通过/不通过**，不引入邀请码（如需审核可在管理端按地址撤销）。

### 5.2 记录结构（`state.json`，追加式，可审计）

```json
"cwtRecords": [
  {
    "address": "j...",
    "usr": "alice",
    "token": "header.payload.Signature",   // 原文存档，可随时重验
    "alg": "secp256k1",
    "verifiedAt": 1788500000000,
    "revokedAt": null                        // 撤销时填写
  }
]
```

- 每个地址保留**最近一次**生效记录；撤销 = 置 `revokedAt` + 清除该地址的验证标记（历史保留）。
- 验证标记：`swtcUsers[address].cwtVerifiedAt`（与容器状态同表，便于联动展示）。

### 5.3 管理接口（requireAdmin）

| 接口                               | 方法 | 说明                                   |
| ---------------------------------- | ---- | -------------------------------------- |
| `/api/admin/cwt`                   | GET  | 验证记录列表（地址/usr/时间/是否撤销） |
| `/api/admin/cwt/:address`          | GET  | 单地址详情（含 token 原文）            |
| `/api/admin/cwt/:address/reverify` | POST | 用记录的 token 重新验签（审计）        |
| `/api/admin/cwt/:address/revoke`   | POST | 撤销验证（回退受限）                   |
| `/api/admin/quotas`                | GET  | 各地址今日配额使用情况 + dailyLimit    |

## 6. 前端体验

- **UserCenter**：新增"CWT 验证解锁"区块——
  - 未验证：显示"今日剩余 X 次提问"，按钮「🔑 CWT 验证解锁」→ 调插件 cwt_sign → 提交 → 解锁后显示"已解锁 · 不限次"；
  - 已验证：显示"已通过 CWT 验证 · 不限次"+ 验证时间。
- **DSH 超限提示**：网关返回 429（错误体 `QUOTA_EXCEEDED`）→ DSH 界面发消息报错。为让用户看到引导，需在租户 patch 注入的 provider 名/提示里带上下文（provider 名 `llm-gateway` 便于排查），并可在 UserCenter 常驻提示。
- **AdminPanel**：新增"CWT 记录"区块（列表/撤销/配额查看）。

## 7. API 一览（新增/改造汇总）

| 路径                           | 方法            | 鉴权                                       | 说明                           |
| ------------------------------ | --------------- | ------------------------------------------ | ------------------------------ |
| `/api/llm-proxy/:address/*`    | POST            | 无（URL 即身份；转发仅限该租户自己的凭据） | LLM 网关：配额检查 + 转发      |
| `/api/user/cwt-verify`         | POST            | 钱包签名（token 内）+ 验签                 | 验证并记录                     |
| `/api/user/gateway-credential` | GET/POST/DELETE | 钱包签名挑战-响应（复用现有模式）          | 用户自己的端点/key 代管        |
| `/api/user/quotas`             | GET             | 钱包签名                                   | 查看今日剩余次数               |
| `/api/admin/cwt*`              | GET/POST        | admin cookie                               | 记录/撤销/重验                 |
| `/api/admin/quotas`            | GET             | admin cookie                               | 配额总览                       |
| `tenant-config` 改造           | —               | 钱包签名                                   | 按验证状态分流直连 vs 网关凭据 |

## 8. 配置新增（config.json / env）

```jsonc
{
  "quotas": {
    "enabled": true,
    "dailyLimit": 10,
    "gatewayForVerified": true, // 已验证是否仍走网关（true=统一路径，不计次）
    "upstreamTimeoutMs": 60000,
  },
}
```

## 9. 诚实残差声明（局限，必须知情）

1. **软约束边界**：用户在容器内有 shell、能写自己的卷。刻意绕过的用户可以直接把
   `settings.yaml` 的 baseURL 改回官方直连、或自行放 key —— **限额拦不住对抗性用户**。
   精确防绕过需要"凭据平台托管 + 容器永不落 key"架构（Docker 层锁出站 + 入口统一凭据），
   与"无平台 key/用户自主"的方向冲突，**不在本期**。
2. **多实例计数失效**：计数在入口进程内存 + state.json；入口多副本部署时计数不共享，
   需引入 Redis（本期不做）。
3. **CWT 是"一次性签名凭证"，不是实名**：任何人持对应地址钱包即可完成验证；
   记录可审计、可撤销，但不具备真实身份背书（如需实名再叠加邀请码/审核，见 §5.1 备注）。
4. **gateway-credential 的 key 存入口侧**：平台"碰到"用户 key（加密存储、不落日志）。
   若用户不能接受平台代管 key，则精确限额无法实现（模型调用绕不开入口时必须有 key 可用）。

## 10. 落地阶段

| 阶段        | 内容                                                                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 后端** | ① `/api/llm-proxy/:address/*` 转发 + 配额计数（含 429、失败不计次、日重置）② `cwt-verify` 验证+记录 ③ `gateway-credential`、`quotas` 接口 ④ admin CWT/quotas 接口 ⑤ 租户创建时注入 `llm-gateway` provider + `--add-host` ⑥ `tenant-config` 按验证状态分流 ⑦ 单测 |
| **M1 前端** | UserCenter 验证解锁与剩余次数、DSH 超限引导文案、AdminPanel CWT 记录/配额区块                                                                                                                                                                                    |
| **M2 可选** | 记录重验审计、撤销定时、限额模型白名单（gateway 只放开指定模型）、统计图表                                                                                                                                                                                       |

## 11. 待确认问题（实现前拍板）

1. 「已验证用户」的模型路径：**继续走网关（不计次）** 还是 **允许直连官方**？（默认推荐前者，路径统一）——影响 §3 的 `gatewayForVerified`。
2. `gateway-credential` 是否允许未验证用户配置？（推荐**允许**：配额期内用自己的 key，超过 10 次仍被拦；平台依旧不买单）——不然未验证用户"可问"但没有 key 可用，体验断裂。
3. 每日 10 次的口径：**按地址**（推荐，与容器一一对应）；如需按"浏览器/设备"则要另设计。
