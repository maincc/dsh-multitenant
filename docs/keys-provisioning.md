# 平台签发身份装配（data/keys/）

> 2026-10-23 定位调整：公开的签名套件 context（`secp256k1-2019-v1.json`）**已迁进仓库** `src/assets/`，
> 随 git/rsync 自动到位，不再手动复制；loader 兼容回退旧位置 `data/keys/`，存量服务器不炸。
> `data/keys/` 从此只剩两件**因环境而异且敏感**的文件。

## 现场必须放置的两件

### 1. `issuer.key` — 平台签发私钥（0600，永不出、永不换）

程序不自动生成、永不轮换这把钥（`shelf-open.mjs --seed` 的落盘是**人工显式触发的一次性装配**，不是自动路径）。两种来源任选：

```bash
# 途径 A：服务器现场新造（测试平台形态 B）
openssl ecparam -name secp256k1 -genkey -noout -out data/keys/issuer.key

# 途径 B：钱包/插件导出的 ss seed（或 s secret）字符串转换（SEC1 PEM 封闭格式）
node scripts/seed-to-pem.mjs '<ss-seed>' > data/keys/issuer.key   # stderr 打印派生地址
chmod 600 data/keys/issuer.key
```

`platform()` 硬编码 `createPrivateKey({format:'pem'})`——**只认 SEC1 PEM**；hex/base58 字符串都要先过 `seed-to-pem.mjs`。

### 2. `issuer-profile.json` — 平台 DID 公共档案（标准 DID Document）

它不是私钥的附属品：`id` 是卡的 issuer/id 嵌段/验真闸的唯一来源，`verificationMethod[0]`
是平台文件签口径，文档本体是官网平台册（挂架档案）的本地镜像源。三种到位方式：

- **自取（形态 A 推荐）**：config 声明 `credential.platformDid`，服务首启从官网 relay 读档落
  镜像（`provisionPlatformProfile`；纯只读线上，id 严格核对不符=宁拒不写）
- **注册（形态 B 推荐）**：`scripts/shelf-open.mjs --seed … --yes` 构造生态模板档案上传官网并落镜像
- **手工**：从官网/开发机复制该 DID 的档案 JSON（= 老办法）

官网链上没有这个 DID 的档案时，签发/领取核心链路可跑（用户档案写的是用户文件签），但平台挂架
会被 relay 拒（只 warn）——官网侧"该平台是谁、发了哪些卡"不可见。

## ★配对红线（唯一会静默的雷）

**key 的派生地址必须等于 profile 的 `id` 尾部**（`did:swtc:<地址>`）。配错对的后果是静默事故：
服务照常起、台账照常写、用户"领取成功"，**但链上验真永远 invalid**（豁免被对账剥离、卡被摘）。

装配后立刻核对：

```bash
# 途径 B 装配的：seed-to-pem.mjs 的 stderr 已打派生地址，肉眼比对 profile.id
node -e "console.log(JSON.parse(require('fs').readFileSync('data/keys/issuer-profile.json','utf8')).id)"
# 途径 A 装配的：从 PEM 推公钥后按 jdid 地址算法核对（或直接走一次领取冒烟，看官网验真结果）
```

## 缺钥行为（有意的降级，非缺陷）

`platform()` 在首个**签发类**动作（领取/配发/挂架）时才被调用并读文件——缺文件 = 该请求 500；
服务启动**不拦**（`syncAdminProvisioning` 失败被 catch，`isAdmSync` 落名册兜底，管理面照常）。
"缺钥=发卡功能未启用，登录等一切照常"（口径源自 did-vc-runbook 决策表 #4）。

## 保护矩阵（为什么它不会不小心离开服务器/进入版本库）

| 层         | 机制                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| git        | `data/` 整体 `.gitignore`（含 keys）                                                                                 |
| rsync 上传 | `deploy/rsync-upload.sh` 对 `data/keys/` **无条件排除**：`UPLOAD_DATA=1` 不上传它、`--delete` 不删除它（"只进不出"） |
| 文件权限   | 0600 + root 属主                                                                                                     |
| 日志       | 代码路径零打印 key 内容；`seed-to-pem.mjs` 输出只走 stdout                                                           |
| 轮换       | **不存在轮换机制，也永远不要新增**——换 key = 该平台已写入全部用户档案的卡验真失效                                    |

> 换 key 的等价事故演练见 did-vc-runbook §3.4。
