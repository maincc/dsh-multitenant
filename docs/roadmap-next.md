# 后续路线图（Next Steps）

> **用途**：随时翻看的待办清单与操作路径。与 `security-hardening-plan.md` 互补：
> 计划文档管"为什么做、方案是什么"，本表管"还剩什么、怎么做、怎么验收"。
> 状态图例：⬜ 待办 ｜ 🔧 进行中 ｜ ✅ 已完结

## 0. 当前基线（2026-09-05）

- ✅ **P0 全部完成**，审计 Top-4 严重问题闭环（管理接管 / connect 冒领 / OOM / 供应链注入）
- ✅ 测试基线 **21 文件 217 用例全绿**；数据文件全 0600
- ✅ 5 笔 commit 未 push：`823ec16`（CWT+限时+阶段1）`f88fc17`（P0-1）`fe513de`（P0-2）`cab5a2e`（P0-4）`96829c3`（docs）
- 服务：8090 运行中（后台 job）；前端 dist 已构建

---

## 1. 待拍板决策（需真机/外部环境）

| 决策                          | 问题                                              | 现状       | 需要                                                        |
| ----------------------------- | ------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| ⬜ 容器特权 SYS_ADMIN（P1-6） | 去掉后 bwrap 沙箱功能是否完整                     | 未验证     | 你真机实测：降权镜像里跑 bwrap --unshare-user               |
| ⬜ HTTPS 反代（P2-1/2-3）     | Cookie Secure / CSP 依赖 TLS                      | 明文 HTTP  | 部署反代后开启 Secure + CSP                                 |
| ⬜ CCDAO 插件适配             | 新用户首次「打开 DSH Web UI」遇 401（需签名创建） | 插件未更新 | 插件处理 401 → signMessage → 带参数重试；或引导先去用户中心 |

---

## 2. P1 纵深（推荐顺序：无需环境的先做）

| 项    | 问题                                       | 改动点                                                            | 验收                       | 依赖        | 状态 |
| ----- | ------------------------------------------ | ----------------------------------------------------------------- | -------------------------- | ----------- | ---- |
| P1-1  | API Key 经 argv 泄露（`ps` 可读）          | merge-credentials.mjs 改 stdin 读值；runScript 错误输出剥离命令行 | docker 失败响应/日志无密钥 | 无          | ⬜   |
| P1-3  | IDOR `/api/user/:address` 无会话读任意用户 | 无会话一律 403（session===address \|\| isAdmin）                  | 无 Cookie 读用户 → 403     | 无          | ⬜   |
| P1-2  | SSRF（probe-models baseURL）               | 拒绝私网/链路本地/环回/metadata 段 + DNS 后校验                   | 169.254.x 被拒             | 无          | ⬜   |
| P1-7  | CWT 申请洪泛 / token 无限                  | token ≤8KB；pending 队列上限（超限 503）                          | 洪泛申请被拒               | 无          | ⬜   |
| P1-8  | CWT 泄露 approvedBy                        | approvedBy 仅管理员可见；usr 非本人脱敏                           | 匿名查不到审批人           | 无          | ⬜   |
| P1-10 | 技能发布零审查                             | 发布正文静态扫描 → 标「未审核」；举报/拉黑                        | 恶意技能被标记拦截         | P0-4 已铺路 | ⬜   |
| P1-4  | Linux 内存预检恒真                         | /proc/meminfo 实测 + 查询失败 fail-closed                         | 耗尽时拒绝供应             | 环境        | ⬜   |
| P1-5  | 卷无配额                                   | --storage-opt size= + I/O 限速；不支持时降级告警                  | 写满卷被拒                 | 环境        | ⬜   |
| P1-6  | 容器特权过大                               | 评估去 SYS_ADMIN；至少 --cap-drop ALL + no-new-privileges         | 容器内无提权操作           | **决策 ↑**  | ⬜   |

### P1-5 补充：磁盘配额存储驱动选型矩阵

> ⚠️ 常见误区：**「Linux 部署」≠ 配额自动生效**。决定配额是否硬执行的是 **Docker 存储驱动**，不是操作系统。
> Linux 默认存储驱动是 **overlay2**（与 Docker Desktop 的 overlayfs 同族），对 `--storage-opt size=` 同样是"接受参数但不强制"。
> Docker 官方仅对 devicemapper / btrfs / zfs / windowsfilter 支持该配额参数。

| 部署环境                                   | Docker 存储驱动            | `--storage-opt size=` 效果                      | 生产选型结论                 |
| ------------------------------------------ | -------------------------- | ----------------------------------------------- | ---------------------------- |
| Docker Desktop (macOS / Windows)           | overlayfs                  | ❌ 记录不强制（审计可见 HostConfig.StorageOpt） | 现状：软配额 + 监控兜底      |
| Linux（默认安装）                          | **overlay2**               | ❌ **同样记录不强制**                           | 不选型 = 维持软配额          |
| Linux（初始化时特意选）                    | btrfs / zfs / devicemapper | ✅ 硬强制，写满被拒                             | **推荐**：代码零改动自动生效 |
| Linux（overlay2 + 底层 xfs + 开启 pquota） | overlay2 + xfs             | ✅ 经文件系统项目配额实现（需专门配置）         | 备选：需环境配置             |

**落地动作**（部署时）：

1. 生产 Docker 初始化时选 btrfs/zfs（或 overlay2+xfs+pquota），`/etc/docker/daemon.json` 设 `"storage-driver"`。
2. 换驱动通常需格式化 Docker 数据目录（`/var/lib/docker`），属**新环境初始化选型**，非线上热切换。
3. 当前代码已传 `--storage-opt size=<tier.disk>`：btrfs/zfs 下自动硬生效；overlay2 下触发降级告警（软配额）。
4. 管理端「配额配置」已内嵌 ⚠️ 提示：磁盘大小配额在 overlayfs/overlay2 下为尽力而为。
5. **自查工具**：`bash deploy/check-storage.sh [--test]` 一键判定（驱动 / 底层 FS / Docker 版本 / containerd store）。

**已知实测**：线上 Linux 测试机（192.168.66.58）= overlay2 + ext4 → 软配额；本地 Docker Desktop = overlayfs → 软配额。

**另一处坑（Docker 29+）**：Engine 29 起新装默认启用 containerd image store，镜像不经 graph driver，
`--storage-opt size` 可能**静默失效**（不报错也不生效，与驱动是否支持配额无关）。回退方式：
`daemon.json` 设 `"features": {"containerd-snapshotter": false}` 后重启并重建镜像。

### P1-5b（独立课题）：卷级配额 —— 真正的租户磁盘限制

> ⚠️ 语义边界：`--storage-opt size=` 只限制**容器可写层**，**不作用于命名卷**。
> 租户数据全部在命名卷 `dsh-data-swtc-*`（挂载为 `/dsh-home`），所以即便换 btrfs/zfs，
> P1-5 的配额也**管不到租户数据主体**。要真正限制租户磁盘，需卷级方案：

| 方案                     | 依赖               | 说明                                                                               |
| ------------------------ | ------------------ | ---------------------------------------------------------------------------------- |
| btrfs qgroup / subvolume | btrfs 存储         | 对卷 subvolume 单独限额，最贴合                                                    |
| 卷驱动 `size` 选项       | btrfs / 特定卷驱动 | `docker volume create -o size=`（当前卷由 `docker run -v` 隐式创建，需改显式创建） |
| 巡检 + 超限告警/停服     | 无（纯代码）       | 用现有 `du` 精确扫描数据，超阈值告警或限流——**不依赖存储层，可立即落地**           |

**现状**：护栏是磁盘监控（引擎口径 + du 实测 + 精确扫描）；`tiers.*.disk` 为声明 + 预留。

## 3. P2 部署/体验类

| 项    | 内容                                                      | 依赖       |
| ----- | --------------------------------------------------------- | ---------- |
| P2-1  | Cookie Secure（登录/会话）                                | HTTPS 反代 |
| P2-3  | index.html 保守 CSP + 可选 SRI                            | HTTPS 反代 |
| P2-4  | CWT 写锁互斥 + 写前读回校验 + 损坏 .bak 告警              | 无         |
| P2-7  | requestTimeout / headersTimeout / maxConnections 显式配置 | 无         |
| P2-8  | 配置深合并；清理 allowCwtEnt 死配置；admin 名单单一数据源 | 无         |
| P2-9  | /connect 502 等错误脱敏（详情进日志）                     | 无         |
| P2-10 | 等待队列落盘（重启不丢）                                  | 无         |

## 4. 产品/体验（非安全）

- ⬜ AdminPanel 技能管理页 UI（后端 `GET /api/skills/admin` / `POST :name/hide` 已就绪）
- ⬜ 技能 zip（含 resources）导入/导出；已装用户签名下载细分（skill-market-design §13.4）
- ⬜ 插件市场（plugin-market-design.md 扩展设计，未开工）
- ⬜ CWT 审计记录脱敏选项（records.log 明文 token → 摘要，决策 3 曾驳回，可复议）

---

## 5. 长期维护备忘

```bash
# 恢复上下文
open docs/README.md docs/roadmap-next.md docs/security-hardening-plan.md

# 基线测试
cd /Users/cly/.dshWorkspace/dsh-multitenant
npx vitest run        # 期望 217 全绿

# 后端改动生效：kill 8090 后台 job → node src/server.js（新后台 job）
# 前端改动生效：frontend && npm run build（dist 由 8090 托管，无需重启后端）
# 提交规范：git commit（不 push）
```

- **行为已变**（测试时注意）：管理员登录要钱包签名；新用户建容器要签名；市场技能模型不会自动调用；旧"地址即会话"Cookie 全 403。
- **敏感数据提醒**：state.json / config.json / data/ 均 gitignore；管理员地址与真实用户数据永不入库。
