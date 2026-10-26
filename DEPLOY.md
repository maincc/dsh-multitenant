# 部署手册（当前架构：档案优先级联 + 跨平台共存，2026-10-23 定稿）

## 0. 两种部署形态，先选对

| 形态                              | issuer.key                          | relay            | 说明                                                                                                                                             |
| --------------------------------- | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. 正式接管**                   | 复制现有平台 key                    | 官网 relay       | 用户档案里的卡被服务器台账"档案优先发现"自动恢复（含 CWT 豁免/admin 任命）。上线后**退役旧实例**，保持单写者                                     |
| **B. 平行测试**（当前服务器属此） | **新生成一套**（不同 key=不同平台） | 可共用官网 relay | 2026-10-23 `isOurIssuedCard` 修复后，两平台卡在同一用户档案**互不摘除、互不误报**，放心共存。测试台账空库冷启动，用户照常走"自动签发→领取"全流程 |

## 1. 前置条件

- Node **22.x**（与开发一致），docker（租户容器运行时），**mongod 副本集**（会话镜像/台账事务前提）
- 网络：入站服务端口（8090 或反代 443）；出站可达 `https://ipfsserver.ccda.ooo`（档案 relay）与 `jdid.cn`（DID 解析）
- 服务器本地备好租户镜像：按 `data/dsh-image.json` 定义先 build/pull——**新版有"进入用户中心自动拉起容器"，上线瞬间会并发建容器，镜像没备好会一波全失败**

## 2. 代码

```bash
git clone <repo> -b cly && cd <repo>
npm ci
cd frontend && npm ci && npm run build && cd ..   # dist 是构建产物，不在 git
npm test                                          # 可选自检：862 用例
```

## 3. `data/` 装配（gitignore 区，程序零生成，手动放置）

```
data/keys/issuer.key              # 0600，secp256k1 SEC1 PEM（形态 B：新平台身份）
data/keys/issuer-profile.json     # 该 key 的平台 DID 档案（relay 写挂架要用它验文件签，
                                  #   须经官网 app.ccda.ooo 注册流程生成，不能手编）
data/keys/secp256k1-2019-v1.json  # 公共 context，直接从开发机复制
data/dsh-image.json               # 租户镜像定义（复制）
data/legacy-cwt.json              # CWT 集合（形态 B 可放空 {} 或测试子集）
data/config/admin.json            # 管理员名册（形态 B 放测试地址）
data/installs.json data/skills/   # 技能市场数据（要测技能才复制）
```

> **key 红线**：issuer.key 一旦启用不可更换——换 key = 该平台已写入用户档案的所有卡
> 验真失效（invalid → 剥豁免摘卡）。形态 A 用旧 key 则无所谓（本来就是同一身份）。

## 4. 环境变量

```bash
DSH_STORAGE_PROVIDER=mongodb
MONGODB_URI='mongodb://…/…?replicaSet=…'   # 副本集 URI
```

## 5. 台账库选择（形态 B：空库即可）

- 空库直接跑：`credentialService.init()` 自建集合与索引。
- **不需要预先"造凭证"**：级联第③步（无档无台账→按 CWT 集合/新用户自动签发 assigned）
  就是冷启动入口；用户登录→弹窗→领取→档案落卡，全链路自动长出来。
- 形态 A 才涉及 mongodump/restore 迁移（credentials/users/sessions 三集合），
  且有档案优先发现在兜底：丢了 dump，用户首登也会自动恢复 claimed。

## 6. 启动与冒烟

```bash
pm2 start src/server.js --name dsh --env production   # 或 systemd / nohup
```

冒烟清单（全部应为 ✅）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<server>/              # 200，且为新 bundle 哈希
curl -s -o /dev/null -w '%{http_code}\n' http://<server>/user          # 200
curl -s 'http://<server>/connect-challenge?address=<测试地址>'           # 200 + {ok,nonce,message}
curl -s -o /dev/null -w '%{http_code}\n' http://<server>/api/user/credential-status  # 401（无 cookie）
pm2 logs dsh --lines 50                                                # 无 error/unhandled
```

浏览器验收：插件登录 → 自动重签（如需）→ 凭证区出现**本平台新签的 assigned 卡**+领取弹窗
→ 点领取落档 → 官网档案页出现"DSH 平台（测试）"卡，且**原有平台的卡仍在档案里未被动**
（跨平台共存回归点）→ 容器 tab 自动拉起 → 弹窗【确定】跳容器管理。

## 7. 回滚

`git checkout <旧提交> && npm run build && pm2 restart dsh`。
key 不动 = 任何旧版本对新档案验签永远兼容；台账新字段（archive-revive 等）旧版本读不坏。

## 8. 已知无害现象

- 双平台并行时各自平台册（挂架）只登记自家分发，官网"平台档案"展示互不包含——正常
- relay 完全不可达 = probe-fail：已领取**不会被剥**（只减不增铁律），但新领取会失败提示重试
- 队列位次不落盘：重启时排队中的用户重排
