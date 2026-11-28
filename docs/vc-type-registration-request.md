# VC 业务类型注册申请：DshMemberCredential / DshCwtCredential

**申请方**：DSH 多租户平台（签发者 DID：`did:swtc:jh7Gc6hGpu7kj9sytaUPFHoV6dwEYU3P9y`，档案昵称「DSH 平台」）
**申请目标**：将两个业务类型注册进 jdid 品牌词表（`https://jdid.cn/vc/v1`）与数字档案（app.ccda.ooo）卡片渲染模板库。
**品牌**：`jdid`（SWTC 链），词汇结构完全遵循现有 phone-verification / file-access profile 惯例。

## 1. 类型一：DshMemberCredential（平台成员凭证）

| 字段         | 值/形态                                                                                                                                 | 说明                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| type URI     | `https://jdid.cn/vc/v1#DshMemberCredential`                                                                                             | 与 PhoneVerificationCredential 同级注册                                             |
| 中文显示名   | **平台成员凭证**                                                                                                                        | 建议模板标题                                                                        |
| 语义         | 签发方已验证持有人钱包对该平台身份的归属（钱包签名验证，非手机号）                                                                      |                                                                                     |
| issuer       | 平台 DID 纯字符串                                                                                                                       | 已符合 VC v1 @protected 约束                                                        |
| subject 必填 | `id`（持有人 DID）、`status`（`verified`）、`verificationMethod`（`dsh-siwe`）、`verificationProcess{verifiedAt, updateAt, verifierId}` | **与 PhoneVerificationCredential 模板字段完全同构**，仅 verificationMethod 取值不同 |
| subject 选填 | `tier`（number）、`dailyMinutes`（number）、`verifiedVia`（string）                                                                     | 平台业务属性，渲染可忽略                                                            |
| id 惯例      | `{持有人DID}#dsh-member-{ISO时间}-{签发者DID}-{随机4}`                                                                                  | 与 `#phone-…` 同模板                                                                |
| proof        | EcdsaSecp256k1Signature2019 / assertionMethod / detached ES256K jws                                                                     | 与生态现卡一致                                                                      |
| 有效期       | issuanceDate + 365 天（expirationDate）                                                                                                 |                                                                                     |

## 2. 类型二：DshCwtCredential（容器使用豁免凭证）

| 字段         | 值/形态                                                                             | 说明         |
| ------------ | ----------------------------------------------------------------------------------- | ------------ |
| type URI     | `https://jdid.cn/vc/v1#DshCwtCredential`                                            |              |
| 中文显示名   | **容器豁免授权凭证**                                                                | 建议模板标题 |
| 语义         | 平台管理员批准持有人免除容器使用时长限制（限时授权类凭证，验证过程同成员卡）        |              |
| subject 必填 | 同类型一，`verificationMethod`=`dsh-cwt-grant`                                      |              |
| subject 选填 | `cwtGrant`（`approved`）、`roles`（string[]）、`tier`                               |              |
| id 惯例      | `{持有人DID}#dsh-cwt-（管理员角色用 #dsh-admin- 段，角色在 id 自辨）-{ISO时间}-...` |              |

## 3. @context 内联术语（签发卡中实际写入，逐字仿官方 profile 构造）

```json
{
  "DshMemberCredential": "https://jdid.cn/vc/v1#DshMemberCredential",
  "DshCwtCredential": "https://jdid.cn/vc/v1#DshCwtCredential",
  "version": "https://jdid.cn/did/v1",
  "standard": "https://jdid.cn/did/v1#standard",
  "status": "https://jdid.cn/did/v1#status",
  "verificationMethod": "https://jdid.cn/did/v1#verificationMethod",
  "verificationProcess": {
    "@id": "https://jdid.cn/did/v1#verificationProcess",
    "@context": {
      "verifiedAt": "https://jdid.cn/did/v1#verifiedAt",
      "updateAt": "https://jdid.cn/did/v1#updateAt",
      "verifierId": "https://jdid.cn/did/v1#verifierId"
    }
  },
  "tier": "https://jdid.cn/did/v1#tier",
  "dailyMinutes": "https://jdid.cn/did/v1#dailyMinutes",
  "verifiedVia": "https://jdid.cn/did/v1#verifiedVia",
  "cwtGrant": "https://jdid.cn/did/v1#cwtGrant",
  "roles": "https://jdid.cn/did/v1#roles"
}
```

## 4. 渲染需求（最小集）

1. 模板匹配 `type` 数组**包含**上述类型 URI/名 → 使用对应中文标题；
2. "签发方" = `issuer` DID → 解析其档案 `service[Profile].serviceEndpoint.nickname`（现行为已对生态卡这么做，无新增逻辑）；
3. 状态徽标 = `credentialSubject.status`；验证过程 = `verificationProcess`（复用 phone 模板组件即可——**两个新类型与 phone 模板字段同构，接入成本≈0**）。

## 5. 实物样例（已在链上，可直接拉取验证兼容性）

- 平台登记册（签发者档案）：`did:swtc:jh7Gc6hGpu7kj9sytaUPFHoV6dwEYU3P9y` 的 `credentials[]`，含两张真实新形态卡（id 形如 `did:swtc:jNDwRet…#dsh-cwt-2026-10-23T08:17:44.215Z-did:swtc:jh7Gc6…-xxxx`）；
- 持有人档案样例：`did:swtc:jNDwRetndumoqBT2UAuCLmFMx7XBQjYKvA`。

## 6. 过渡现状与诉求

注册完成前，我方以类型栈 `["VerifiableCredential","PhoneVerificationCredential","DshCwtCredential"]` 借用 phone 模板渲染——**卡内全部字段如实**（verificationMethod=`dsh-cwt-grant` 等），但模板标题显示为"电话验证"，与业务语义不符，对档案浏览者有误导。注册后我方将去掉借用类型，仅保留本类型。**这是本申请的核心动机。**

---

签发管线：@jccdex/did issueCredential（jsonld/EcdsaSecp256k1Signature2019），词汇表遵循 @jccdex/vc-vocabularies profile 惯例（brands/jdid.js）。
联系人/渠道：（提交时补充）
