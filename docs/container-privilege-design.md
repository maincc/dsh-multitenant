# 租户容器特权分档（bwrap 依赖链 / 实测矩阵 / strict 收敛决策）

> **状态**：✅ 已实施（第一阶段，commit `3548c42`）｜ **修订**：2026-09-24 ｜ **决策**：⚖️ 不升内核，strict 即收敛点（§7）
> 关联：`docs/security-hardening-plan.md` P1-6、`docs/roadmap-next.md` §1/§2、实现 `src/services/docker.service.js` "安全参数组"块

## 1. 问题背景：三件套不是设计，是依赖链的妥协

租户容器里 DSH 的 bash 工具每条命令都过 **bwrap**（bubblewrap）文件沙箱——第 1 层容器隔离管"租户 vs 租户"，第 2 层 bwrap 管"模型执行的命令 vs 租户自己家里的一切"。bwrap 的魔法建立在内核命名空间上：

```
unshare/clone(CLONE_NEW*)  →  造私有命名空间
mount / bind / tmpfs       →  搭文件系统视图（只读底图 + 工作区可写窗）
pivot_root                 →  换根
```

在 Docker 容器里**再**造这些，要过三道闸，旧方案是三道全拆（`docker.service.js` 原注释）：

| 闸           | 旧参数                               | bwrap 依赖                                           |
| ------------ | ------------------------------------ | ---------------------------------------------------- |
| capabilities | `--cap-add SYS_ADMIN`                | 无特权嵌套 userns 被宿主内核禁时，建命名空间唯一通路 |
| seccomp      | `--security-opt seccomp=unconfined`  | Docker 默认表拦 clone 新命名空间 flag 与 pivot_root  |
| AppArmor     | `--security-opt apparmor=unconfined` | Ubuntu 宿主 docker-default 拦 bwrap 的 mount         |

**真正的风险不是 SYS_ADMIN 本身，而是 SYS_ADMIN × 全部系统调用敞开**：租户代码（含被诱导的模型）想打宿主机内核，历年容器逃逸 CVE 的常客——`io_uring`、`userfaultfd`、`bpf`、`keyctl`、`kexec`、模块加载——全部随手可用。

## 2. 实测矩阵（本机 Docker Desktop 6.10.14-linuxkit + 租户镜像，命令可复现）

探测 argv 与 DSH `packages/sandbox/sandbox-local` 的启动探测**逐字一致**：

```bash
bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
```

| 档     | 参数                                                | 结果                                     | 结论                                                                                |
| ------ | --------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| T1     | 三件套（现状）                                      | ✅                                       | 基线有效                                                                            |
| T2     | `cap-drop ALL` + seccomp/apparmor unconfined        | ❌ `Creating new namespace failed`       | 本机内核禁无特权嵌套 userns——**SYS_ADMIN 摘不得**（内核 sysctl 决定，非本仓库可改） |
| T3     | T2 + 默认 seccomp                                   | ❌                                       | 同因                                                                                |
| T4     | cap-drop ALL + 白名单 seccomp                       | ❌                                       | 瓶颈在内核，白名单救不回 T2                                                         |
| T5     | `landlock_create_ruleset` 直调                      | ❌ ENOSYS                                | linuxkit 内核编了 Landlock 没启用 → 连 DSH 的降级档都没有                           |
| **M1** | 三件套 + `no-new-privileges`                        | ✅                                       | 免费防线，收                                                                        |
| **M2** | SYS_ADMIN + no-new-priv + **白名单替代 unconfined** | ✅                                       | **本方案核心**：关 unconfined 大门，bwrap 照活                                      |
| M4     | SYS_ADMIN + no-new-priv + 默认 seccomp              | ❌ `pivot_root: Operation not permitted` | 默认表必杀 bwrap → 白名单文件是必需品；原注释说法被复核                             |
| E2E    | strict 参数起真容器                                 | ✅                                       | SPA 200 / 激活 303+cookie / RPC 200 / 沙箱内 node、git、tar、管道全活               |

## 3. 定稿 profile：默认表 + 只追加 `pivot_root`

`deploy/seccomp-bwrap-minimal.json` = Docker v28.2.2 默认 profile 原文，尾部追加一条 `SCMP_ACT_ALLOW ["pivot_root"]`（Docker 后匹配覆盖语义）。

推导过程（一次自我纠错）：初版"保守"追加 17 名 → 逐名核对默认表发现 `mount`/`umount`/`umount2`/`chroot` **本就在表里**、`clone`/`unshare` 也是、`keyctl`/`add_key`/新 mount API 五连 bwrap 0.8 **用不到**——真缺口只有 `pivot_root` 一个。**白名单里每一个名字都是欠的债**，定稿只借一行。

效果（vs unconfined）：`io_uring_*`、`userfaultfd`、`kexec_load` 直接 EPERM；`init_module`/`bpf`/`perf_event_open` 等名义在表、实际被容器没有的 cap 与内核 sysctl 把关。

## 4. 分档设计：`docker.privilegeProfile` 三态

```
auto（默认）首次供应容器前：用 strict 参数实跑一次 §2 探测
  ├─ 过  → 全租户 strict 档（本仓库 + 新内核宿主）
  └─ 不过 → compat 档（= 2026-09-22 前行为）+ 控制台告警
strict 强制新档；探测/降级都不做，坏了好过静默回退
compat 强制旧档；应急回退开关（配置改一个词，无需回滚代码）
```

- **缓存**：探测结果进程级缓存，并发供应合并为一次；`clearCapabilityCache()`（镜像重建/版本切换）一并失效；平台重启重测
- **二级降级**：daemon 读不到 profile 文件（部署缺件/权限）→ 本次 `docker run` 失败文本精确匹配 → 降 compat 重试一次（与 `--storage-opt` 配额降级同构，教训同源：线上曾因"拒绝整个 run"全员进不去）
- **配置兜底**：`config.json` 浅合并会整块顶掉 DEFAULTS——代码里对 `privilegeProfile`/`seccompProfilePath` 双兜底（缺省 auto、路径缺省仓库文件），老配置不改也能跑
- **排障**：`DSH_PRIVILEGE_PROFILE` 环境变量临时覆盖

## 5. 安全增益与残余表面

|                      | 三件套（旧） | strict（现在）                                          |
| -------------------- | ------------ | ------------------------------------------------------- |
| syscall 面           | **全部敞开** | 默认白名单 + 1 项追加                                   |
| setuid/提权          | 未约束       | `no-new-privileges` 焊死                                |
| SYS_ADMIN × mount 族 | 敞开         | **保留**（bwrap 功能定义域，见 §7 决策）                |
| AppArmor             | unconfined   | 不变（Ubuntu 宿主 bwrap 必需；linuxkit 等宿主此条空转） |

## 6. 验收标准修订（P1-6）

原验收"容器内无提权操作"**过严**（与 bwrap 依赖矛盾，除非宿主内核配合）。修订为：

> ① syscall 面收至白名单（✅）② setuid 升格封死（✅）③ 特权面收缩至"bwrap 功能必需的 mount 族"（✅）④ 无特权 userns 友好的宿主机**自动**升至免 SYS_ADMIN 档（探测架构已就位，触发条件是宿主内核，不是代码）

## 7. 决策记录：⚖️ 不升级内核，strict 即收敛点（2026-09-24）

**理由**——第二阶段（摘 SYS_ADMIN）防的是"租户利用内核 0-day 逃逸"，攻击链要两条件同时成立：

```
① 存在可用的内核本地提权漏洞   ← 取决于补丁时效（与 SYS_ADMIN 无关）
② 够到它的入口 + 权限          ← §3/§5 已收至 mount 族窄条
```

摘 SYS_ADMIN 的边际收益 ≈ 把②的窄条再掐掉，而代价是把产品可用性押在宿主内核配置赌博上。**真正的风险转移到了①，因此配套运维清单是**：

| 必做                                                            | 说明                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 宿主内核走发行版安全更新（如 unattended-upgrades）              | 残余风险的唯一防线已从权限结构转移到补丁时效                                                            |
| P1-1（API Key 经 argv 泄露）/ P1-2（probe-models SSRF）优先做掉 | 与内核无关、当下真实存在的洞，优先级高于 SYS_ADMIN 理论最坏态                                           |
| 宿主机 Docker 大版本升级后重跑探测                              | 内置默认表换血可能让白名单失效——auto 探测已兜底，升级日看一眼日志 `安全参数组 auto 探测完成 → ...` 即可 |

**"什么都不用决定"是本设计的一部分**：新服务器到货若内核支持无特权 userns，探测自动过、无需改动；哪天白名单被 Docker 升级弄坏，自动回落 compat——两端之间不存在"静默失去沙箱"的中间态。

## 8. 代码与测试映射

| 实现                            | 位置                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| 两档参数组 / 探测 / 缓存 / 降级 | `src/services/docker.service.js`（"安全参数组"注释块 + `_resolveSecurityArgs`）             |
| 探测 argv（契约锁定）           | `BWRAP_PROBE_ARGS` 导出常量，测试逐字断言                                                   |
| 配置键 + 注释                   | `src/config/config.js` DEFAULTS.docker（浅合并坑见 §4）                                     |
| 白名单 profile                  | `deploy/seccomp-bwrap-minimal.json`（随 rsync 上服务器，无 exclude 命中）                   |
| 行为测试                        | `test/docker-security-profile.test.js`（12 用例：形状/单次探测/并发合并/降级矩阵/错误精判） |
| 复现矩阵脚本                    | §2 命令 + `--entrypoint bwrap` 姿势可直接手工重跑；自动化看护由上述测试承担                 |
