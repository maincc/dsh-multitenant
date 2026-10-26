# 部署增量指南（本轮架构变更 → 接现有 `deploy/` 脚本）

> **执行入口一律是 `deploy/` 既有脚本，本文不重复造流程。**
> 完整上传/安装/更新/回滚步骤见 **`deploy/README.md`**（`rsync-upload.sh` → `install.sh` / `update.sh` → systemd）。
> 本文只补三件既有 README 没覆盖的事：**平台形态选型、签发钥红线、本轮新架构的验收回归点**。

## 一键部署（复用现有脚本，回顾）

```bash
# 服务器能连 GitHub：
git push                                        # 本地推 cly 分支
ssh root@<IP> "cd /srv/dsh-multitenant && sudo ./deploy/update.sh"   # pull+按需构建+重启
# 服务器连不上 GitHub：本地 rsync 上传后 update.sh 自动跳过 pull 并全量重建
SERVER_HOST=<IP> ./deploy/rsync-upload.sh
```

## 1. 平台形态选型（决定 `data/keys/issuer.key` 放哪把）

| 形态                    | issuer.key                          | relay                      | 台账库             |
| ----------------------- | ----------------------------------- | -------------------------- | ------------------ |
| **A. 正式接管**         | 复制现有平台 key                    | 官网 `ipfsserver.ccda.ooo` | 旧实例退役，单写者 |
| **B. 平行测试**（当前） | **新生成一套**（不同 key=不同平台） | 可共用官网 relay           | 独立空库冷启动     |

判据：把服务器 `issuer-profile.json` 里的 DID 打出来对比 `did:swtc:jh7Gc6hGpu7kj9sytaUPFHoV6dwEYU3P9y`——一致=形态 A，不一致=形态 B。

**形态 B 的核心保障**：2026-10-23 `isOurIssuedCard` 窄闸修复后，两平台在同一用户档案**互不摘除、互不误报 stale**（`credential.test.js` 有 4 条回归用例钉死），可放心共用 relay。

## 2. 签发钥红线（`data/keys/` 区，`deploy/` 脚本不碰）

- `rsync-upload.sh` 对 `data/keys/` **无条件排除**：只进不出，现场钥永不被本地覆盖（毁灭级保护，见脚本注释）。
- 程序**零生成**：key 由部署者放置，权限 `0600`。形态 B 的新 DID 须经官网 `app.ccda.ooo` 注册流程生成（relay 写挂架验文件签要它在链），手编裸 PEM 过不了。
- **一旦启用不可换**：换 key = 该平台已写入用户档案的所有卡验真失效（invalid → 剥豁免摘卡）。
- 装配清单（rsync 不带、须手动放服务器）：**只剩两件**——`issuer.key` + `issuer-profile.json`。context（`secp256k1-2019-v1.json`）2026-10-23 已迁进仓 `src/assets/` 随代码走（loader 兼容回退旧位置，存量服务器不炸）。ss seed 字符串转 PEM 用 `scripts/seed-to-pem.mjs`（stderr 打派生地址，核对 profile.id——配错对是静默事故：领取照常成功、链上验真永远 invalid）。详见 [docs/keys-provisioning.md](docs/keys-provisioning.md)。

## 3. 台账：空库直接跑，**不需预造凭证**

`data/` 不在 git、rsync 默认也不带——服务器 mongo 可空库起步。本轮档案优先级联就是冷启动入口：

> 无档案无台账 → 按 CWT 集合/新用户**自动签发** assigned → 登录弹窗 → 用户领取落卡 → 档案长出凭证。

`credentialService.init()` 首启自建集合与索引。形态 A 才涉及 `mongodump/restore`；且即便迁移丢库，用户首登也经"档案优先发现"自动恢复 claimed。

## 4. 镜像预热（本轮新行为的前置）

新版**进入用户中心即自动拉起容器**——上线瞬间会并发建容器。租户镜像 `dsh-multitenant:latest` 须**预先存在**（`install.sh`/`update.sh` 会按需构建，但首次务必确认 `docker images` 有它，否则一波创建全卡在构建/拉取）。`data/dsh-image.json`（镜像定义）须在场。

## 5. 本轮新架构验收回归点（在 `deploy/README.md` §3 冒烟之上追加）

浏览器走一遍：登录 →（如需）自动重签 → 凭证区出现**本平台新签** assigned 卡 + 领取弹窗 → 点领取落档 →

- **跨平台共存**：官网档案页里"测试平台"卡与"DSH 平台"卡**并存、互不摘除**（`isOurIssuedCard` 修复的实弹验证）
- **容器 tab**：未跑则后台自动拉起 + tab 右侧转圈 → 完毕弹窗【确定】跳容器管理；期间「启动容器」按钮置灰
- **F9 会话**：切换插件账户自动重签一次即闭环，不再循环报"会话主人不一致"（`getRequestAddress` 已翻正为 user 优先）

## 6. 回滚

沿用现有能力：`update.sh` 失败可 `git checkout` 旧提交再跑；镜像回滚靠 `update.sh` 打的版本 tag `${IMAGE%%:*}:$DSH_VERSION`。key 不动 = 任何旧版本对新档案验签永远兼容；台账新字段（`archive-revive` 等）旧版本读不坏。
