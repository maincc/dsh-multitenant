# dsh-multitenant 文档索引

> 维护：随实现滚动更新。每份文档顶部带状态块，标注"设计 / 已实施 / 历史"与最新修订。

## 平台签发身份装配

- [keys-provisioning.md](./keys-provisioning.md)——`data/keys/` 两件装配、配对红线、缺钥降级、保护矩阵（2026-10-23 context 迁仓后版）

## 一图览

| 文档                                                             | 内容                                                                                                  | 状态                  | 备注                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------- |
| [product.md](./product.md)                                       | 产品文档（简介 / 用户指南 / 管理员指南 / 安全 / 部署）                                                | ✅ 随代码滚动         | 面向使用者与运维                       |
| [roadmap-next.md](./roadmap-next.md)                             | 后续路线图（P1/P2 待办 + 待拍板决策 + 操作备忘）                                                      | 🔧 滚动更新           | 完成一项勾一项                         |
| [security-hardening-plan.md](./security-hardening-plan.md)       | 六面审计结论 + 加固计划（P0/P1/P2）+ 决策点                                                           | ✅ 已实施（P0 全绿）  | 每阶段完成即勾销；P1/P2 待办           |
| [cwt-verification-design.md](./cwt-verification-design.md)       | CWT 申请-批准-出示（验证哲学 / 数据结构 / 接口 / 豁免）                                               | ✅ 已实施（M0+M1）    | 存储已迁 `data/cwt/`；token 单向时效   |
| [cwt-access-design.md](./cwt-access-design.md)                   | CWT 分层提问权限（登录随意 · 验证解锁完整额度）                                                       | 📌 历史设计参考       | 部分落点表述过时（见文档内标注）       |
| [usage-limit-design.md](./usage-limit-design.md)                 | 每日使用时限（120min / CWT 豁免 / 停止保全）                                                          | ✅ 已实施             | 与 CWT 豁免联动                        |
| [ccdao-did-integration.md](./ccdao-did-integration.md)           | CCDAO 插件 DID/VC/CWT 调研 + dsh 对接方案（P0档案/P2凭证化）                                          | 📌 方案待排期         | 只读调研，注册处中心化风险见 §6        |
| [identity-auth-current.md](./identity-auth-current.md)           | 身份认证现状盘点（七条信道/挑战机器/强弱面/DID 分级映射）                                             | 📋 现状基线           | DID 方案讨论的事实对照                 |
| [credential-v1.4.md](./credential-v1.4.md)                       | **凭证体系 v1.4 定稿**：互斥单台账 did/解限双凭证、领取落档、登录续发、链上验真、大小写规则、运维手册 | ✅ 已上线（2026-10）  | 凭证模型的现行权威文档                 |
| [did-vc-runbook.md](./did-vc-runbook.md)                         | DID/VC 实施方案手册 v1.2（预验证记录/wodecards 生态结论/私钥红线）                                    | 🗄️ 模型已被 v1.4 取代 | 仍有效：§3.4 红线、§5 预验证、生态考证 |
| [container-privilege-design.md](./container-privilege-design.md) | 租户容器特权分档（bwrap 依赖链 / 实测矩阵 / 不升内核决策）                                            | ✅ 已实施（一阶段）   | P1-6 收敛记录；§7 决策日志             |
| [skill-market-design.md](./skill-market-design.md)               | 技能市场（共享仓 / 安装 / 鉴权 / 配额）                                                               | ✅ 已实施             | P0-4 供应链边界见 §10                  |
| plugin-market-design.md                                          | 统一市场（技能 + 插件）扩展设计                                                                       | 📌 用户既有物         | 未按本索引修订                         |
| [crypto-randomuuid.md](./crypto-randomuuid.md)                   | 局域网 HTTPS 兼容事件记录（crypto.randomUUID shim）                                                   | 🗄️ 历史归档           | 已修复，备查                           |

## 状态图例

- ✅ **已实施**：文档描述的行为已落地且与当前代码一致
- 📌 **设计参考**：早期/备选方案，用于追溯决策；部分细节可能过时
- 🗄️ **历史归档**：事件/问题记录，不再演进

## 文档与代码映射（维护提示）

| 文档章节                          | 实现位置                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| 加固计划 P0 各项                  | `src/middleware/`、`src/routes/*.routes.js`、`src/utils/`、`src/services/*.service.js`  |
| CWT registry/applications/records | `src/services/cwt.store.js`、`src/services/cwt-admin.service.js`、`data/cwt/`           |
| CWT 出示验签 + 单向时间窗         | `src/services/cwt.service.js`                                                           |
| 每日限时 + 豁免                   | `src/services/user.service.js`（`usages` / `checkUsageLimitAndStop`）                   |
| 技能市场                          | `src/services/skill.service.js`、`src/utils/skill.js`、`data/skills/`                   |
| 管理员签名会话                    | `src/middleware/auth.middleware.js`、`data/config/sessions.json`                        |
| /connect 所有权签名               | `src/routes/tenant.routes.js`（复用 `tenant-config.service.js` 挑战池）                 |
| 容器安全参数分档 + bwrap 探测     | `src/services/docker.service.js`（"安全参数组"块）、`deploy/seccomp-bwrap-minimal.json` |
