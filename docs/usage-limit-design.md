# 每日使用时限设计（usageLimit）

> **状态：✅ 已实施（2026-09）**——120min 每日累计、CWT 授权豁免、用户主动停止保全额度均落地。
> 目标读者：dsh-multitenant 维护者
> 决策已确认：**每日累计限时 · 到时优雅停止容器（数据保留）· CWT 验证用户豁免**
> 关联：`docs/cwt-access-design.md`（已废弃的代理配额方案，本方案取代其限流部分，仅保留其 CWT 验证/记录设计）

## 1. 目标

- 每个 SWTC 地址**每天累计使用 X 分钟**（容器运行时长），X 在 `config.json` 配置。
- 到时**优雅停止**该租户容器（SIGTERM 宽限、数据卷保留；聊天记录/会话/文件全在）。
- 当天额度耗尽后**拒绝再次启动**（提示"明日重置"）；次日自动重置恢复。
- **CWT 验证用户豁免**：完成一次 CWT 验证（cwt_sign 验签）即不限时。
- CWT 验证**可记录、可管理**：记录验证事件，admin 可查、可撤销。

## 2. 计时模型（每日累计，跨重启累加）

```
状态字段（state.json）：
  swtcUsers[address].usageStartedAt   // 本次容器 running 的开始时刻（仅 running 时存在）
  state.usages[address] = { date: 'YYYY-MM-DD', minutes: N }   // 历史累计（当日有效值）

当日已用分钟数 = usages[address].minutes（date=今天 ? 值 : 0）
             + (usageStartedAt ? (now - usageStartedAt) / 60000 : 0)
```

- **开始计时**：容器启动/创建成功（`ensureContainer` 的启动分支 + `finalizeTenant`）→ 设 `usageStartedAt = now`。
- **停止结算**：任何"running → 非 running"的路径都先结算：`minutes += (now - usageStartedAt)` 到当日，再清 `usageStartedAt`。
  覆盖点：cleanup 空闲停止、upgrade 重启、force-stop、destroy/leave、限时超时停止、restoreFromDocker 发现已停容器。
- **跨日重置**：查询/结算时 `date !== 今天` → 归零并更新为今天。
- **豁免**：`swtcUsers[address].cwtVerifiedAt` 存在 → 不检查、不停止、不计数显示"不限时"。

## 3. 超时动作与重连语义

- **检查定时器**：独立于 cleanup（避免互相干扰），默认每 60 秒扫一遍 running 容器；
  若 `当日已用 >= dailyMinutes` 且未豁免 → 优雅停止（复用 `dockerService.stopContainer(name, stopGraceSeconds)`），
  标记 `stoppedAt`、结算计时；与 cleanup 相同的**防重入锁**，避免并发 stop 同一容器。
- **重连语义（自洽版）**：
  - 额度未耗尽的中断（空闲停止/手动升级/异常）→ 重连立即启动，继续扣额度；
  - 额度耗尽（超时停止）→ `/connect` 拒绝启动，返回 `USAGE_LIMIT_REACHED` + "明日 X 时重置"提示；
    次日自动恢复，无需任何操作。
  - 数据始终保留（卷不删），重连即恢复历史会话。
- **用户主动停止（保全额度）**：用户在用户中心点「⏹ 停止容器（保全时长）」
  （`POST /api/user/:address/stop`，仅自己或管理员）→ 立即结算当前运行段，容器优雅停止。
  停止期间不再耗时，把每日额度留给真正使用时；数据保留，随时可重新启动。
- 与现有 cleanup 的关系：限时停止是"主动停"，cleanup 是"空闲停"，互不冲突；
  超时停止的容器同样会进入 cleanup 阶段 2 的销毁流程（数据卷保留）。

## 4. CWT 豁免与记录管理

- **验证**：`POST /api/user/cwt-verify`，body `{ token }`（插件 cwt_sign 输出）。
  复用 `src/services/cwt.service.js`（验签 + 策略检查 + 地址推导，含防重放）。通过 →
  `swtcUsers[address].cwtVerifiedAt = now` + 追加记录。
- **记录**（可审计，token 原文存档，可随时重验）：
  ```json
  state.cwtRecords = [ { address, usr, token, alg, verifiedAt, revokedAt? } ]
  ```
- **管理接口**（requireAdmin）：`GET /api/admin/cwt`（列表）、`GET /api/admin/cwt/:address`（详情含 token）、
  `POST /api/admin/cwt/:address/revoke`（撤销 → 恢复受限）、`GET /api/admin/usage`（各地址用量+剩余+豁免状态）。

## 5. 配置（config.json 新增）

```jsonc
{
  "usageLimit": {
    "enabled": true,
    "dailyMinutes": 120, // 每个地址每天累计使用上限（分钟）
    "checkIntervalMs": 60000, // 超时检查间隔
  },
}
```

## 6. 接口与前端改动

| 项                                    | 说明                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /connect-status?address=`        | 响应增加 `usage: { enabled, dailyMinutes, usedMinutes, remainingMinutes, verified, cwtVerifiedAt }` |
| `/connect`                            | 额度耗尽返回 `USAGE_LIMIT_REACHED`（202 JSON，可操作提示），不再执行启动                            |
| `POST /api/user/cwt-verify`           | 验证 + 记录 + 豁免标记                                                                              |
| `/api/admin/cwt*`、`/api/admin/usage` | 管理（上述）                                                                                        |
| UserCenter                            | 显示"今日剩余 X 分钟 / 已豁免不限时"；「🔑 CWT 验证解锁」按钮（调插件 cwt_sign 后提交）             |
| AdminPanel                            | "CWT 记录"区块（列表/撤销）+ 用量概览                                                               |

## 7. 实现触点（文件/函数）

- `src/config/config.js`：DEFAULTS 增 `usageLimit`。
- `src/services/user.service.js`：
  - 新增 `settleUsage(address)`（结算）、`getUsedMinutes(address)`（含豁免判断）、`checkUsageLimitAndStop()`（定时检查）、`recordCwtVerification(address, result)`；
  - 改：`ensureContainer`（启动前额度检查 + 启动后记 `usageStartedAt`）、`finalizeTenant`（记 `usageStartedAt`）、`cleanupIdleContainers`/`forceStopContainer`/`upgradeContainer`/`destroyContainer`（停止前 settle）、`restoreFromDocker`（对齐 usageStartedAt）。
- `src/routes/tenant.routes.js`：`/connect`、`/connect-status` 增 usage 字段。
- `src/routes/user.routes.js`：新增 `POST /api/user/cwt-verify`。
- `src/routes/admin.routes.js`：新增 4 个管理接口。
- `src/server.js`：启动限时检查定时器。
- `frontend/src/views/UserCenter.vue`、`AdminPanel.vue`：见 §6。
- `test/`：新增 `usage-limit.test.js`（计时/跨日/豁免/停止）、`cwt-verify` 路由测试（复用 `test/cwt.test.js` 的 token 构造 helper）。

## 8. 诚实边界

1. **计时粒度**：按容器运行时长计（非"活跃对话时长"）；分钟级，进程重启期间的运行时间按
   `usageStartedAt` 残留连续计算，误差可忽略。
2. **本地时钟**：跨日重置按服务器本地日期。
3. **不防对抗**：用户在容器内有 shell，刻意操作不影响限时本身（限时由入口服务强制，容器内改配置绕不过出口停止）。
4. 单实例部署即可精确；多实例需把 usages 移到共享存储（本期不做，与现状一致）。

## 9. 落地顺序

M0 后端（config + 计时/停止 + cwt-verify + admin 接口 + connect 提示 + 单测）→
M1 前端（UserCenter 剩余时间/验证解锁、AdminPanel 记录区块）→ 构建 + 重启验证。
