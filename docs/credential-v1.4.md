# Dsh 凭证体系 v1.4 · 定稿说明与运维手册

> **状态：已上线（2026-10-19，mongodb provider + prod relay `ipfsserver.ccda.ooo`，用户 E2E 全链实测通过：领取落档 / CWT 申请→钱包签名审批→换发 / 到期登录续发 / 链上验真 / stale 同步归一）。** 测试 739/739。本文档取代 `did-vc-runbook.md`（v1.2 口径）中的凭证模型部分；runbook 中的预验证记录、wodecards 生态结论、私钥红线仍有效。

---

## 1. 模型一页图

```
用户点「打开 DSH Web UI」→ 钱包签名登录（身份层）
        │
        ▼
   enter(address)  ← GET /api/user/credential-status 触发
        │
   ┌────┴──────────────────────────────────────────────┐
   │ Mongo 台账 credentials（真源工单，_id=小写地址）    │
   │  一人一行 = DID 普通凭证与解限凭证互斥的物理保证      │
   │  { kind: did|cwt, state: assigned|claimed,          │
   │    source: auto|legacy|approval,                    │
   │    vcId, expiresAt, profileDid(原始大小写),          │
   │    issuedAt/claimedAt/renewedAt, onChain:{…} }       │
   └────┬──────────────────────────────────────────────┘
        │ 无记录 → 自动分配 did/assigned（legacy CWT 名单命中 → 直接 cwt）
        │ expiresAt 已过 → 【登录即续发】当场重铸新卡（见 §4）
        │ claimed → 【异步链上验真】onChainVerify（见 §5）
        ▼
   权限判定：豁免 = 台账 kind===cwt（与 state 无关）
   usage 热路径查内存 _cwtSet 快照（5min 刷新 + 批准/续发即时补集）
```

**三层数据，各司其职：**

| 层             | 位置                                               | 角色                                                    | 权威级                     |
| -------------- | -------------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| 台账           | Mongo `credentials` / json `data/credentials.json` | 权限判定、互斥、工作流（申请/审批）、续发资格           | **平台内部唯一真源**       |
| 平台档案登记册 | `did:swtc:<平台DID>` 的 `credentials[]`（IPFS）    | 链上分发记录/公开登记，第三方（wodecards 查询页）可验证 | 展示权威（对外的"官网"）   |
| 用户个人档案   | `did:swtc:<用户地址>` 的 `credentials[]`（IPFS）   | 用户手中的凭证副本，需本人钱包签名写入                  | 出示副本（可能滞后=stale） |

术语：**解限凭证**（CWT，DshCwtCredential）/ **普通用户凭证**（DID，DshMemberCredential）。互斥：任何时刻一个地址在台账只有一种 kind；在两层档案里只挂一张 Dsh 卡（同 subject 换卡式替换）。

---

## 2. 领取链路（把凭证写进用户自己的档案）

```
POST /api/user/credential-scaffold {canonicalAddress}
  前置：台账有记录；canonicalAddr 小写化必须等于会话地址（防签A传B）
  L1 探测：l1ProfileHit(canonical, {bust:true})  ← 用户主动动作，不吃负缓存
    无档案 → {noProfile, didGenUrl:'https://app.ccda.ooo/#/', expectedAddress}
             前端出"先生成 DID 并核对地址"指引（不硬拦截）
    连不上 → {probeFailed, hint}（≠没档案，只劝重试）
  有档案 → mintVC 平台真签一张新卡 → 目标文档 = 档案现有内容
           滤掉旧 Dsh 卡 + 追加新卡 → {document, fileName, vcId, reissue}

前端：sha256Hex(JSON bytes) → 插件 ipfs_personalSign(utf8(hashHex)) →
      ipfs_getPublicKey → POST /api/user/credential-upload {document,fileName,publicKey,signature}

服务端 claimUpload：
  文件名/id/会话地址三方一致校验 → verifyFileSignature（noble + deriveAddress 回推）
  → relayWrite（校验 HTTP 状态 **且 body.code===0**）→ 台账 patch
    {state:claimed, claimedAt, profileDid, vcId, expiresAt, onChain:null}
  → shelfCredential(新卡)：登记进平台档案（同 subject 互斥换卡）
```

`claimed` 后再走 scaffold = **同步**（reissue:true）：重铸新卡覆盖档案，用于个人副本 stale 时归一。

## 3. 解限（CWT）链路

```
用户端 applyCwt（需 did/claimed——领取动作确认地址主人活跃）
  → 申请单 cwt_applications {address(小写), addressDisplay(原始大小写), status}
管理端（钱包当场签名，payload 绑定单号+地址）：
  POST /api/admin/cwt-applications/:id/approve   header 签名
    → grantCwt：台账整行替换为 cwt（did 不复存在——互斥强制）
    → 豁免即时（_markExempt + 快照）；批准即生效，不等领取
  POST .../reject → 留痕可重申（rejected 保留 100 条裁剪）
用户随后领取 CWT 卡落自己档案（不影响豁免，纯出示）。
```

## 4. 到期自动续发（登录触发，无后台铸卡定时器）

VC 有效期 **365 天**（`mintVC` 硬编码 `365*864e5`；如要可调，挪 config）。

> 设计公理：豁免只在用户使用容器时需要，使用必先登录——**enter 就是唯一需要有效凭证的时刻**。

```
enter: cred.vcId && cred.expiresAt < now
  → 本地重铸新卡（毫秒级）→ 台账 {vcId, expiresAt, renewedAt}
  → 平台册异步换卡（fire-and-forget，失败下次登录重试）
  → cwt 用户 _markExempt 即时保持 → 响应 renewed:true（前端 toast）
```

- 幂等防风暴：判据是 `expiresAt`，续完自然不触发
- **个人档案不会被平台代签**（relay 认档案 owner 公钥）→ 续发后档案滞后 = `stale` 态（§5）

## 5. 链上验真（onChainVerify）

身份在门上验（钱包签）→ 资格从台账续（§4）→ **真伪从链上查**（这里）。

```
前置 claimed+vcId+profileDid；节流：ok 结论保鲜 5min、其它 1min
relayRead(档案) →
  probe-fail → 保留上次结论（网络抖动绝不误判失效——L1 误判事故换来的铁律）
  按台账 vcId 精确找卡：
    命中   → 官方 SDK verifyCredential（resolver 取签发公钥，proof/有效期/结构全判）
             verified → ok ／ 否则 invalid+原因
    没命中但有别的 Dsh 卡 → stale（reason 带旧卡尾号："点领取同步新卡"）
    彻底没有       → missing（可能被删除）
结果落台账 onChain:{status, at, reason}；领取/同步时清 null 重验。
```

前端凭证卡徽章四态：`ok` 绿「链上验真通过 ✓」/ `stale` 黄「档案未同步新卡」/ `missing|invalid` 黄「链上副本失效，重新领取可找回」/ 灰「待完成」。
**「同步凭证到档案」按钮**在 stale/missing/invalid 时出现，一点即归一（=§2 的 reissue 通路）。

## 6. 大小写规则（踩过坑，锁死）

| 用途                                          | 形态                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 台账键 / 会话 / 匹配 / 签名 payload / binding | **一律小写**（normalizeAddress）                                                                       |
| DID 档案文件名与路径（链上）                  | **钱包原始大小写**（小写形态 relay 报 `no link named "3f"` 实证）                                      |
| 界面展示 / 申请单 addressDisplay / 核对提示   | 原始大小写（`pluginCaseAddr` 从 requestAccounts 捕获 + localStorage 持久；台账取 profileDid 前缀剥离） |

## 7. API 面

| 端点                                                    | 鉴权                   | 说明                                                                 |
| ------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| GET `/api/user/credential-status`                       | 钱包会话               | enter 钩子：分配/续发/异步验真；返回 credential+popup+renewed+legacy |
| POST `/api/user/credential-scaffold`                    | 同上                   | §2 第一步                                                            |
| POST `/api/user/credential-upload`                      | 同上                   | §2 第二步（文件签校验+relay 写）                                     |
| POST `/api/user/cwt-apply`                              | 同上                   | 申请解限（需 did/claimed，一人一 pending）                           |
| GET `/api/user/cwt-application`                         | 同上                   | 本人申请单查询                                                       |
| GET `/api/user/credential-vc`                           | 同上                   | 凭证本体读回 `{credential, consistent}`（60s 缓存）                  |
| GET `/api/admin/credentials`                            | admin                  | 台账浏览 kind/q/分页                                                 |
| GET `/api/admin/cwt-applications`                       | admin                  | 申请单 status/分页                                                   |
| POST `/api/admin/cwt-applications/:id/{approve,reject}` | admin+**钱包当场签名** | payload 绑定 id+address                                              |

## 8. 配置键（CONFIG.credential）

```js
relayBaseURL / apiBase('/v0/api/ipfs') / chain('swtc')
issuerDid?（从 profileFile 读） / keyFile('data/keys/issuer.key') / profileFile('data/keys/issuer-profile.json')
contextFile('data/keys/secp256k1-2019-v1.json') / vcNamespace
profileProbeTimeoutMs: 8000   // resolve 冷启动实测 2.7~2.8s，3s 会误判"没档案"
```

私钥红线（继承 runbook）：`data/keys/` 整目录 gitignore + rsync 无条件排除（`--exclude='data/keys/'`，毁灭级操作 --delete 也不碰服务器 keys）。

## 9. 运维手册

**legacy CWT 名单导入**（老平台解除用户迁移，等待 registry 导出投喂）：

```bash
# 1) 官网导出名单放入 data/legacy-cwt.json  ({"<小写地址>": {approvedAt}, ...})
node scripts/import-legacy-cwt.mjs --dry   # 核对条数/形态
node scripts/import-legacy-cwt.mjs         # 正式（写台账 kind=cwt/source=legacy）
```

命中名单者 enter 时直接分配 cwt（即使尚未导入，enter 也会查 legacyHit 兜底）。

**补登/修复工具**（node REPL）：

```js
import { credentialService } from './src/services/credential.service.js'
await credentialService.init()
await credentialService.resyncShelf() // 存量已领取卡补登平台册（幂等，顺带回填 vcId）
await credentialService.onChainVerify(addr, { force: true }) // 单用户强制重验
await credentialService.stats() // {did:cwt 计数分布}
```

**台账速查**（mongosh 本机被日志权限挡，用 driver）：

```bash
node -e "…MongoClient.connect(CONFIG.storage.mongodbUri)…"   # dsh_prod@127.0.0.1:27018?replicaSet=dsh-rs
```

**重启即全量重建豁免快照**：服务启动 init → refreshExemptSet；改代码需重启（8090，`DSH_STORAGE_PROVIDER=mongodb`），换前端 bundle 不用。

## 10. 事故与教训登记（别再犯）

| 事故                           | 根因                                                              | 对策（已进代码）                                                                               |
| ------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 有档案判"没有"（用户报严重）   | L1 探测 3s 预算撞上 resolve 2.7s 冷启动 + 60s 负缓存固化          | 8s + 自动重试一次 + bust 实探 + `[l1-probe]` warn；relay 读三态化，probe-fail 绝不输出"没档案" |
| `signFileBytes is not defined` | 编辑报"文件已变"后漏重放，运行期 undefined 测不到                 | import 符号审计脚本；每次编辑失败必须重放验证                                                  |
| 平台册写入假成功               | relay **HTTP 200 + body code:500**（只看状态）                    | relayWrite 强制 `body.code===0`                                                                |
| 逗号串非 hex 签名              | `toDERRawBytes().toString('hex')`（Uint8Array.toString 忽略参数） | 显式 `toDERHex()` 出口链                                                                       |
| 公钥被 relay 拒                | swtc 族文件签要**压缩 hex 无 0x**（未压缩被拒）                   | platformSignKey 从私钥现推 `getPublicKey(priv,true)`                                           |
| replace_all 吞换行             | old_string 带尾部 `\n` 拼接粘连                                   | 改无换行尾锚点 + prettier/构建双闸                                                             |
| 悬停无反应                     | tooltip ::after 被同元素 overflow:hidden 裁剪                     | `.addr-tip[data-full]{overflow:visible}` 全站规则                                              |

## 11. 已知边界（有意为之）

- 豁免判定用台账而非每次查链（热路径 2.7s 不可接受）；链上登记册保持一致靠续发/领取/审批时同步维护，第三方验证走 §5 的 onChain 面
- 个人档案是用户数据区：他可删可改（VC 平台签名不可伪造，副本失效只影响出示，不影响权限）；stale 态可见可修复
- 续发落点在平台册（平台自己的钥匙可写）；个人副本必须本人签名，故有"同步"按钮而不是静默代写
- AdminPanel users tab 显示小写地址（容器维度视图，与凭证展示域分离，暂不混）

```

```
