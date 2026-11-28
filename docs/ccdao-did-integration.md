# CCDAOConnector 插件 DID/VC/CWT 调研与 dsh 对接方案

> **性质**：调研报告 + 对接实施方案（只读分析 `~/workspace/CCDAOConnector`，未改动其一行代码）
> **日期**：2026-10 ｜ **状态**：📌 方案待排期
> **前提资产（已核实存在）**：`src/services/cwt.service.js` 验签已就绪且与 cwt-lib 交叉验证通过；`frontend/src/views/UserCenter.vue` CWT 申请链路已接通 `cwt_sign`；`docs/cwt-verification-design.md` 为同族前文
> **读者**：dsh-multitenant 维护者

## 1. TL;DR

1. CCDAOConnector 是 MetaMask 分叉 + JCC 多链扩展，内嵌一套完整的 **DID 生产体系**：`did:ethr`/`did:swtc` 双方法、自动注册、社交档案、VC 签发、CWT 登录令牌。
2. **它的"去中心化"到格式层为止**：DID 文档注册处是一个中心化 IPFS 网关服务（`wodecards.wh.jccdex.cn:8550`），链上没有任何合约。对接时把它当"格式标准 + 可选数据源"，**永远不当信任根**。
3. dsh 与插件生态的**登录/豁免验签闭环已经跑通**（CWT 一条线）。真正没用的是 DID 侧三件东西：**链上档案数据（昵称/头像）、`did_getBase58PublicKey`、`did_issueCredential`（VC 签发）**。
4. 方案按独立可上线切成 P0/P1/P2 三块：档案展示（低成本高感知）→ 登录统一（可选）→ 豁免凭证 VC 化（架构收益最大）。

## 2. 插件 DID 栈总览

```
┌─ 应用层 ── did_issueCredential(VC签发) / cwt_sign(登录令牌) / 社交档案(昵称·NFT头像)
├─ 协议层 ── createDidMiddleware + createCwtMiddleware + IssueTransactionController(签发审批队列)
├─ 文档层 ── DidLabelController(自动注册/60s轮询) → IPFS RPC 读写 + previousCid 版本链
└─ 身份层 ── @jccdex/did@0.2.11(did.min.js UMD, 全局 jcc_did)：EthrDid/SwtcDid + secp256k1 密钥
```

| 文件（CCDAOConnector 内）                                                | 行数 | 职责                                                                                      |
| ------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------- |
| `src/js/did-detection.js`                                                | 70   | `resolveDID`/`resolveSwtcDID`：EthrDidResolver + IPFS 客户端解析                          |
| `src/app/scripts/controllers/DidLabelController.js`                      | 484  | 自动为 HD 根钱包发布 DID 文档；60s 轮询档案→identity 昵称/头像；`updateNickname` 重发文档 |
| `src/app/scripts/lib/createDidMiddleware.js`                             | 120  | DApp RPC：`did_getBase58PublicKey` / `did_issueCredential` / `did_requestAccountName`     |
| `src/app/scripts/lib/createCwtMiddleware.js`                             | ~140 | DApp RPC：`cwt_sign` → `@jccdex/cwt-lib.sign` 产 token                                    |
| `src/app/scripts/controllers/transactions/IssueTransactionController.ts` | 401  | VC 签发 = 交易态持久审批队列（`issueType:'did_issue'`）                                   |
| `src/app/scripts/lib/chain-externals.js`                                 | 326  | SDK 懒加载（MV3 importScripts / `<script>` 注入 / require 三分支）                        |
| `node_modules/@jccdex/cwt-lib/lib/{webtoken,keypairs}`                   | —    | CWT 字节格式真相（§3.3）                                                                  |
| npm `@jccdex/did@0.2.11` `lib/{resolver,publish,did-document,vc}.js`     | —    | 注册处/文档/签名套件真相（§3.1/3.2/3.4），描述 _"DID for wodecards"_                      |

## 3. 核心机制事实细节

### 3.1 注册处真相：无链，中心文件服务 + 私钥 ACL

`@jccdex/did` 源码（unpkg 实拉）：

```js
// lib/resolver.js —— 解析 = 中心化 REST 服务读共享文件
resolve(did) → ipfsClient.readSharedFile({ filePath })
filePath = makeBucketPath(地址, {levels:2, segmentLen:2}) + `/${address}/shared/${did}.json`
// ethr 用 toChecksumAddress 分桶；swtc 用原地址分桶；noLink 判定 = 报错前缀 "no link named"

// lib/publish.js —— 发布 = 同一服务写文件，私钥只是写权限
upload(did, doc, priv) → ipfsClient.writeFile({ name:`${did}.json`, file, key: priv, share: true, chain: ETHEREUM|SWTC })
// 服务侧验签口径（docs/SECURITY-AUDIT.md 确认）："\x19IPFS Signed Message:\n"+len+data → SHA-256 → secp256k1 DER
```

- 服务地址/IPNS 根硬编码 3 处（did-detection、DidLabelController、image-cache），**无多网关兜底**
- `resolver.stat(did)` 返回当前文件 CID——即"链上 CID"实为 RPC 服务元数据
- 结论：**标识符/文档格式是 W3C-DID 兼容的，注册/解析是运营商中心化的**。dsh 依赖它 = 依赖 jccdex 在线率（见 §6 纪律 1）

### 3.2 DID Document 形状与密钥模型（钱包实际发布内容）

```json
{
  "@context": ["<did上下文>", "<CCDAO版本上下文(ethr)/JDID版本上下文(swtc)>"],
  "id": "did:ethr:0x…",
  "version": "1.0.0",
  "created": "…",
  "updated": "…",
  "authentication": ["did:ethr:…#key-1"],
  "assertionMethod": ["did:ethr:…#key-1"],
  "verificationMethod": [
    {
      "id": "…#key-1",
      "controller": "did:ethr:…",
      "type": "EcdsaSecp256k1VerificationKey2019",
      "publicKeyBase58": "<钱包私钥推导>"
    }
  ],
  "service": [
    { "type": "Profile", "serviceEndpoint": { "nickname": "CCDAO DID", "preferredAvatar": "" } },
    {
      "type": "IpfsStorage",
      "serviceEndpoint": { "ipns": "ipns://k2k4r8ntjlp1…", "previousCid": "Qm…" }
    }
  ],
  "credentials": []
}
```

- **一钥双地址**：SWTC 根账户 `keccak(公钥)[12:]` 派生 EVM 地址，DID 只挂 EVM 形态（`did:ethr`）；非根子账户用 `did:swtc:<swtc地址>`
- **单密钥无轮换**：永远 `#key-1`，由 `Secp256k1DidKeypair.fromPrivateKey(钱包priv)` 推导——丢钥匙=身份死，换钥匙=换新 DID
- `credentials[]` 支持把 VC 反向嵌入档案；更新文档 = 整文档重写 + `previousCid` 指旧版（手动版本链）
- `DidDocument` 类实现上继承 dock `VerifiableCredential`（toJSON 删 type/credentialSubject 伪装成文档）——格式兼容但非标准 JSON-LD DID Core 严格形态，互操作时注意

### 3.3 CWT token 字节格式（与 dsh 验签口径对表）

`@jccdex/cwt-lib`（node_modules 实物 1.0.2；项目 package.json 要求 2.0.0）：

```
token = base64url(JSON(header)) + "." + base64url(JSON(payload)) + "." + base64url(DER签名)

header  = { "x5c": ["-----BEGIN PUBLIC KEY-----…(SPKI PEM)"], "type": "CWT",
            "chain": "Ethereum"|"Jingtum", "alg": "Secp256k1"|"Ed25519" }
payload = { "usr": "<标识>"  或  "group": "<企业标识>",  "time": <unix秒，缺省=当下> }
签名    = secp256k1: ECDSA(SHA-256(signingInput), DER, canonical:false)
          ed25519 : EdDSA(signingInput 原始 UTF-8 字节)
```

dsh `cwt.service.js` 头部注释逐条对齐且实测交叉验证通过（`Keypairs.verifyTx` 而非 `verify` 的坑、压缩点前缀、±5min 新鲜窗、`CWT_ENT/group` 不放开）。**本节无需任何改动**——两端口径一致是既有事实。

已知弱面（cwt-lib 特性，非 dsh bug）：

- `canonical:false` → 签名可延展：**不得拿签名字节当防重放唯一键**（dsh 现用 time+address 策略，安全）
- `time` 可被 DApp 传未来值，插件弹窗是唯一闸门——dsh 前端固定 `usr:'dsh-usr'` 不传 time（服务端当下生成），已规避

### 3.4 VC 签发链路（`did_issueCredential`）

```
DApp 请求 → createDidMiddleware（origin 授权地址校验，EVM+SWTC 双族）
 → IssueTransactionController.addIssueTransaction
    meta{status:'unapproved', issueType:'did_issue', persist:true, txHistoryLimit 裁剪}
 → ApprovalController 弹窗（did-identity-confirm.vue）
 → 批准 → derivePrivateKey(issuer地址) → Secp256k1DidKeypair(priv).keypair()
    → getKeyDoc(issuerDid, kp, _, keyDoc.id)
    → issueCredential(finalKeyDoc, credential, compactProof=true 默认, …)
       suite = EcdsaSecp256k1Signature2019（JSON-LD Data Integrity；compactProof 时 proof 转紧凑形态）
    → meta.status='submitted'，result 回填 DApp promise；拒绝→rejected（JSON-LD 上下文包内含
       BBS+/BBDT16/StatusList2021 全套——插件路径没启用，生态留白）
```

**UI 缺口（插件侧）**：确认弹窗是纯壳（`confirm()` 只 emit，credential 的 issuer/subject/claims 一个字段都不渲染）——其 `docs/SECURITY-AUDIT.md` §266 明确要求"展示签发内容+不可逆提示"，实现未跟上。dsh 若消费此 RPC，须在自家 UI 补展示层，不能指望插件弹窗。

### 3.5 插件侧缺陷清单（只读备案，供评估生态可靠性）

| #   | 事实                                          | 影响                                                   |
| --- | --------------------------------------------- | ------------------------------------------------------ |
| 1   | `did-detection.detected` 模块级单例           | 会话内只检首个账户，切账户残留旧值                     |
| 2   | IPFS 网关/IPNS 硬编码无兜底                   | 服务下线 → 全生态 DID 档案不可读（CWT 不受累，自包含） |
| 3   | 签发确认弹窗空壳                              | 用户盲签 VC（审计文档已识别未修复）                    |
| 4   | 审计 M3 族：DID 发布路径曾 debug 打印私钥长度 | 私钥内存卫生敏感区，插件仍在治理中                     |

## 4. dsh 现状对表

| 能力                             | 插件提供                                                       | dsh 现状                                            | 差距                                                    |
| -------------------------------- | -------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| CWT 登录令牌验签                 | `cwt_sign`                                                     | ✅ 前端已调 + 后端 cwt.service 已通（豁免申请链路） | 登录仍是 signChallenge 自定义 nonce（两套身份信道并存） |
| DID 档案（昵称/头像）            | `did_requestAccountName`（仅本地已知名）/ resolve 全量文档     | ❌ 未用                                             | **P0 空白**：管理面板/用户中心无"链上身份名"展示        |
| DID 公钥导出                     | `did_getBase58PublicKey`                                       | ❌ 未用                                             | 低需求（CWT x5c 已含公钥）                              |
| VC 签发（用户背书豁免凭证）      | `did_issueCredential`                                          | ❌ CWT 豁免=平台 registry 记录制                    | **P2 空白**：豁免凭证非标准、不可离线第三方验证         |
| DID 解析（服务器直连，不经插件） | `@jccdex/did` + `@jccdex/ipfs-rpc-client`（纯 npm，Node 可跑） | ❌                                                  | P0 的实现方式（服务器直接 resolve，无需用户在线）       |

## 5. 对接方案（每块独立可上线）

### P0 · DID 档案接入（低成本高感知，建议先做）

**目标**：用户中心与管理面板显示用户的链上身份名/头像（CCDAO 生态真实社交身份），无档案则降级显示地址缩写。

**改动清单**：

1. 后端新增 `src/services/did.service.js`：依赖 `@jccdex/did` + `@jccdex/ipfs-rpc-client`（版本锁插件同款：did@0.2.11 / ipfs-rpc-client@0.1.4）；对 SWTC 地址复用 `cwt.service` 现成的公钥推导路径拿 EVM 形态地址 → `EthrDidResolver.resolve`；解析结果**进程内缓存 15min** + 失败静默降级（插件的 DidLabelController 同款容错语义）
2. `GET /api/user/did-profile`（用户自查）与 `GET /api/admin/users/:addr/did-profile`（管理端）——返回 `{did, nickname, avatar, updated}`，超时 3s 硬顶（外部服务依赖，绝不拖垮主接口）
3. 前端：用户中心"我的 CWT"卡片与 AdminPanel 用户列表加昵称位（有则显示，无则留白）
4. 配置化：网关 URL 进 `config.json`（`did.ipfsBase`，默认 wodecards），现场可换镜像源——**不做硬编码**（吸取插件 3.5-2 教训）

**验收**：用装有 CCDAO 插件且有 DID 档案的账户（根钱包自动注册，默认昵称 "CCDAO DID"）→ 面板显示昵称；拔网/网关挂 → 降级显示地址，主功能无感；测试：mock IpfsClient 三态（正常/noLink/超时）。

### P1 · 登录信道统一（可选，建议观察后再动）

**现状**：登录用 signChallenge（nonce 双向回源防重放），豁免用 cwt_sign——两条身份信道并存但各安其位，**没有故障压力**。

**方案 A（推荐：不动）**：双轨并存。CWT 已承担"强身份展示"角色，登录保持 nonce 制（防重放强于 time 窗口）。
**方案 B（若追求接口收敛）**：登录改 `cwt_sign({usr:'login-<sessionid>'})`，服务端把 sessionid 绑进 usr 字段做一次性（等效 nonce），前端少一套 challenge 往返。代价：防重放语义从服务端保证降级为 usr 编码约定——除非登录链路成为维护负担，否则不值得。

**结论：写进 roadmap 观察项，不排期。**

### P2 · CWT 豁免凭证 VC 化（架构收益最大）

**目标**：把"平台 registry 记录制豁免"升级为**标准 VC 凭证**——凭证自包含、可离线验证、多部署联邦/第三方网关免回源。

**两种签发形态**：

| 形态                      | 签名者                                                             | 语义                                                             | 适用                                                    |
| ------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------- |
| **V1 平台签**（推荐起步） | dsh 服务端密钥（Ed25519/secp 平台 keypair，即 admin 签名体系那把） | "平台为该用户背书"——与现行 registry 语义等价                     | 替换 registry 判定源，验证方（网关/未来多节点）离线可验 |
| V2 用户背书               | 插件 `did_issueCredential`（用户 DID 为 issuer）                   | "用户自我声明持有豁免"——语义错配（豁免是平台授予的），**不采用** | —                                                       |

**V1 落地拆解**：

1. 凭证 Schema（对齐 W3C VC DM + 插件生态 suite）：

```json
{ "@context": ["https://www.w3.org/2018/credentials/v1", "<dsh豁免上下文>"],
  "type": ["VerifiableCredential", "DshExemptionCredential"],
  "issuer": "did:web:<dsh平台host>",
  "issuanceDate": "…", "expirationDate": "<豁免到期>",
  "credentialSubject": { "id": "did:swtc:<用户地址>", "dailyMinutes": null, "tier": 2 },
  "credentialStatus": { "id": "https://<平台>/api/cwt/status/1#<idx>", "type": "StatusList2021Entry" },
  "proof": { "type": "EcdsaSecp256k1Signature2019" 或 Ed25519Signature2018, "compactProof": true } }
```

——suite 选插件包内含的（`EcdsaSecp256k1Signature2019`），**别自创 proof 格式**，否则 CCDAO 生态 DApp 验不了 2. `did:web:<平台host>`：dsh 服务端挂 `/.well-known/did.json`（verificationMethod=平台公钥，controller=自身 DID）；依赖 HTTPS——与 `security-hardening-plan.md` 的 TLS 债务**捆绑排期**，上不了 HTTPS 就内部先以"约定格式"跑，对外不称标准兼容3. 签发/撤销：`cwt-admin.approve` 时 mint VC（私钥签）存 `data/cwt/`；`revoke` 时置 StatusList2021 bit（平台状态位图挂 `/api/cwt/status/:page`，网关缓存 5min，撤销延迟可接受）4. 迁移：registry 记录一次性铸成存量 VC（stamp 机制防重铸，对齐存储改造的 `schema` stamp 思路）；旧 registry 读路径保留一个版本周期灰度 5. 消费方：容器网关校验会话时可选"回源 registry"∥"离线验 VC + status bit"——先只给多部署场景开

**验收**：交叉测试——用 `@jccdex/did` 的 credential-sdk verify 在 Node 侧独立验签通过；撤销延迟 ≤ status 缓存窗口；离线场景（平台 DB 断）存量豁免仍可被验。

**工作量预估**：P0 ≈ 1~~1.5 天；P2 ≈ 3~~4 天（含迁移与交叉测试）。

> ⚠️ **P2 定稿已迁出**：闭环范围收缩（发放与验证均在 dsh 平台内）后的可实施版本、双投影格式决策、P2.5 档案挂载，均见 `did-vc-runbook.md`。本节保留为历史草案；其中"多部署联邦/离线验 VC + status bit"部分被 runbook 挪入"闭环外清单"（留插头不施工）。

## 6. 风险纪律（红线，写码前默读）

1. **wodecards IPFS 服务永远不当信任根**：dsh 的登录/豁免/撤销判定不得依赖它在线；P0 只做"档案富化显示"，查不到即降级。P2 的信任根是 dsh 自己的 `did:web` 公钥，与它无关。
2. **私钥边界**：用户私钥永不出浏览器/插件（dsh 只收签名产物）；平台签发密钥复用 admin 签名体系但**独立一把**（身份分离：平台凭证密钥 ≠ 管理员操作密钥），存储走现有 keyfile 权限模式。
3. **防重放不拿签名字节当唯一键**（cwt-lib `canonical:false` 可延展）；沿用 time+nonce/sessionid 编码策略。
4. **不放开 group/CWT_ENT**（企业态）：cwt.service 现行策略注释已立此规矩，对接方案维持。
5. **插件确认弹窗空壳问题**（§3.4）：任何用到 `did_issueCredential` 的流程，展示责任必须落在 dsh 自家 UI。定稿方案（runbook v1.0）已**彻底绕开**：凭证 proof 全部由平台服务端签发（与 wodecards 自家 Manufacturer 蓝图同构——机构凭证生在组织签名环境，不经用户钱包）；「领取进档案」用户只签自己文档的上传（`ipfs_personalSign`），弹窗语义是"同意写入档案"而非盲签凭证。
6. 版本锁定：`@jccdex/did@0.2.11`、`@jccdex/ipfs-rpc-client@0.1.4`、cwt-lib **2.0.0**（CCDAO 仓库 node_modules 里 1.0.2 是旧残留，以 lockfile 为准）；升级窗口做双版本交叉验签再切。

## 7. 附录 · RPC 参数形状（dsh→插件调用参考）

```js
// 登录令牌（dsh 已在用）
await provider.request({ method: 'cwt_sign', params: [{ address, usr: 'dsh-usr' }] }) // → "h.p.s" token

// DID 公钥导出（P2 备用：让用户出示 DID 公钥与 x5c 交叉核对）
await provider.request({ method: 'did_getBase58PublicKey', params: [address] }) // → { publicKeyBase58, type }

// 生态账户名查询（本地缓存语义，仅返回插件已知名——服务器直连 resolve 更全，见 P0）
await provider.request({ method: 'did_requestAccountName', params: [address] }) // → "昵称"|""

// VC 签发（本次方案不采用，接口备案）
await provider.request({
  method: 'did_issueCredential',
  params: [{ credential, keyDoc: { address, did }, compactProof: true }],
}) // → 签名 VC（用户弹窗盲签，慎用）
```

**参考源**：`@jccdex/did@0.2.11`（npm/unpkg，描述 "DID for wodecards"，deps：@docknetwork/credential-sdk 0.54.19）；`CCDAOConnector` 仓库路径见 §2 表；同族文档 `docs/cwt-verification-design.md`（验签设计）、`docs/cwt-access-design.md`（权限分层沿革）。

## 8. 勘误 · wodecards 源码复核（2026-08）

> 背景：此前对 wodecards 生态的判断基于**远程黑盒 + @jccdex/did 库源码**。现取得 wodecards 完整仓库（`http://192.168.66.246/chtian/wodecards`，本地分析副本 `~/.dshWorkspace/wodecards/`），四个判断被源码推翻或修正。**本文档正文保留原文**（记录调研过程），以下勘误为准。

| #   | 原判断                                    | 源码事实                                                                                                                                                                                                      | 证据（文件:行）                |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | "钱包生态没有第三方 VC 的 holder 保管位"  | **wodecards DApp 本身即保管箱**：`bindVcToDid` 把任意 VC 写入用户 DID 文档 `credentials[]` 并发布；删除有 `deleteCredentialFromDID`                                                                           | didManage/index.ts L343 / L675 |
| 2   | "需等插件补 addCredential RPC 才能挂档案" | **无需新 RPC**：文档更新=整文档覆盖上传，插件 `ipfs_personalSign`+`ipfs_writeFile` 今天就在（此前只 grep 了 `did_*` RPC 族，漏了 `ipfs_*` 族）                                                                | didManage/index.ts L133-141    |
| 3   | "IPFS 不可变，挂上去的凭证撤不掉"         | **覆盖制**：同路径反复写，`deleteDIDDocument` 实现=上传空文档；生态自管理：已领取/过期凭证下次授权时自动清理                                                                                                  | index.ts L623 / L881-905       |
| 4   | "共享文件公开可读=隐私墙"                 | 生态模型**把凭证当公开对象设计**：FileAccessAuthorization VC 公开挂档案，机密性靠 `credentialSubject.grantee` 服务端匹配 + 资源路径内容寻址。隐私降级为"claim 语义自选"（挂"免限 VIP"仍会公开，故仍默认不挂） | ipfs.service.ts L628-660       |

**维持且更实的两条**：

- "当前无区块链"：链上 VDR 锚定**确实设计过**（`docs/DID/00.Prefix.md`：ethr 合约 + SWTC 转账备注承载 VDR 创建、服务重建=重扫链上交易），但 **VDR 在代码中零引用，从未实施**——"设计过、没做"。
- "注册处=wodecards 中心化服务"：进一步实锤为**三合一**——IPFS 文件服务、DID 文档库、VC 验证器同机（服务端 `resolveDid`=`readSharedFile` 读自家文件，VC 验证不依赖外部资源）。

**连带发现（超出原调研，生态真面目升级）**：wodecards 的 VC 模型是"**凭证即钥匙**"——`listFilesByVc`/`readFilesByVc` 端点用 VC 授权文件目录访问（type=`VC_TYPES.FILE_ACCESS_AUTHORIZATION` + `accessRestrictions{expiresAt, ipWhitelist}` 双层防线，服务端 `verifyVC` 消费）；凭证生命周期走"签发者挂货架→grantee 按 id 领取→自动清理"中转模式；词汇表包 `@jccdex/vc-vocabularies`（descriptor/issueVC/verifyVC）。这套完整运转证明"dsh 当 issuer、生态认 JSON-LD VC"在技术上是通的——支撑 runbook ADR-8（双投影）与 §9（P2.5 档案挂载）。

**对方案的影响（定稿）**：主链升级为**平台货架 + 分层发卡**（基础卡人人自动 / 升级卡凭 CWT+判定件换代重铸，ADR-7/11 翻案记录在 runbook）；凭证格式统一 JSON-LD（JWT 投影砍掉，ADR-8）；`@context` 内联化（ADR-15，源于 `ccda.ooo/vc/v1` 404 的生态实证）；全部实施见 `did-vc-runbook.md` v1.0。
