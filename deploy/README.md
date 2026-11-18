# 部署工具集（deploy/）

> 本文是 `deploy/` 脚本的常驻运维手册。平台形态选型判据见下文装配段；`data/keys/`
> 签发钥完整红线见 [docs/keys-provisioning.md](../docs/keys-provisioning.md)。

把 dsh-multitenant 一键部署到 Linux 服务器（要求：Docker；若在服务器上构建前端还需 Node ≥ 18）。

## 快速开始（4 步）

### 1. 本地：上传代码

```bash
SERVER_HOST=1.2.3.4 ./deploy/rsync-upload.sh
# 可选：SERVER_USER=ubuntu REMOTE_DIR=/opt/dsh 覆盖默认值
```

排除清单（node_modules / data / patches / config.json / state.json / 日志等）**同时
作用于 `--delete`**——服务器现场的文件与数据不会被这次上传抹掉。

### 2. 服务器：首次安装

```bash
ssh root@1.2.3.4
cd /srv/dsh-multitenant
ADMIN_ADDRESS=jndwretndumoqbt2uauclmfmx7xbqjykva \
PUBLIC_HOST=1.2.3.4 \
./deploy/install.sh
```

- `ADMIN_ADDRESS`：管理员 SWTC 地址（小写，决定谁能进管理面板）
- `PUBLIC_HOST`：用户浏览器可达的公网 IP 或域名（302 跳转目标 + trustedHosts）；
  有 HTTPS 域名时建议同时设 `PUBLIC_TRUST=你的域名`
- **存储形态**：解析顺序 = 显式参数 > **现场 config.json 的 `storage` 段** > 默认
  `STORAGE=mongodb` + `mongodb://127.0.0.1:27018/dsh_prod?replicaSet=dsh-rs`（库名以
  URI path 为准）。现场 config 已有 storage 段时 install 全程尊重它（预检/迁移预览/
  systemd env 三处同一个值）；改库只需改 config.json 后重跑 install 或 update。
  **前置**：mongod 7.0+ 且为副本集（单成员即可；配方见 `docs/deploy-test-server.md`
  三.1）——install.sh 有预检，连不上/非副本集直接失败。应急回退 `STORAGE=json`；
  mongod 在远端加 `SKIP_MONGO_CHECK=1`；mongod 跑在容器里加 `MONGO_CONTAINER=dsh-mongo`
  （预检借道容器，连接 URI 不动；配方 三.1b 已实弹验证）。
- 老 json 服务器升级进库：**普通上传即可，别加 UPLOAD_DATA**——M1 迁移原料是服务器
  自己的 `data/`（rsync exclude 保护让它一直在场），install 后首启自动搬家（日志
  `[startup] storage 迁移：{...}`）。`UPLOAD_DATA=1` 只用于"往空服务器注入本地测试
  种子"，且本地文件会覆盖服务器同名文件，日常上传绝不可带。

install 不检查签发身份，缺钥也不拦启动（登录等一切照常，只是不签发）——身份在下一
步装配；而装配脚本要用 `@swtc/keypairs`，恰好依赖已由 install 的 `npm ci` 就位。

### 3. 服务器：装配平台签发身份（key）

`data/keys/` 下**只有两个文件**，是整个平台的"身份"，git 与 rsync 永不携带（只进不出）：

| 文件                  | 是什么                                                                            | 谁在用                                                                  |
| --------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `issuer.key`          | 平台签发**私钥**（SEC1 PEM，0600）。派生出 profile 里的 `verificationMethod` 公钥 | 每次给档案卡签发、每次给平台登记册文件签名                              |
| `issuer-profile.json` | 平台 **DID 公共档案**（标准 DID Document）的线上镜像，`id` 尾部地址 = 平台 DID    | 判权口径（档案卡 `issuer === 本平台 DID` 才算"我签的"）、登记册货架基址 |

**seed（身份的源头）从哪来**——① 测试平台新造一条（形态 B 用）：

```bash
node -e "const {Keypairs}=require('@swtc/keypairs'); console.log(Keypairs.generateSeed())"
```

② 或已有平台/钱包导出的 `ss` 开头 seed（形态 A 用）。**seed 就是备份本体**：一条
`ss` 串可数学还原私钥，抄进密码管理器即可——`.key` 文件丢了用 seed 重转就是。

**二选一装配**（判据：把服务器 `issuer-profile.json` 的 DID 与官网正式平台
`did:swtc:jh7Gc6hGpu7kj9sytaUPFHoV6dwEYU3P9y` 对比——一致=形态 A 接管，不一致=形态 B 平行测试）：

- **形态 A · 接管现有平台**：把私钥放进 `data/keys/issuer.key`（ss seed 转 PEM：
  `node scripts/seed-to-pem.mjs '<ss-seed>' > data/keys/issuer.key && chmod 600 data/keys/issuer.key`
  ——stderr 打出的派生地址必须等于既有 profile `id` 尾部），config 声明
  `credential.platformDid: "did:swtc:<平台DID>"`，服务首启自动从官网读档落
  `issuer-profile.json` 镜像（只读线上；线上档案 id 与声明不符=宁拒不写）。
- **形态 B · 新平台一条命令**（profile 不用手拷，脚本生成并注册）：
  `node scripts/shelf-open.mjs --seed '<ss-seed>' --nickname 'DSH 测试平台'` 先 dry-run
  **零写入**预览，人工核对派生出的 DID 后加 `--yes` 落钉：落 key（0600）→ 组 DID
  档案 → 上传官网注册 → 回读确认后落 profile 镜像。链上已有档/读档不稳=**拒写**
  （注册是永久身份钉链，宁可重来不可错钉；脚本绝不覆盖现场 keyFile）。

**红线**（为什么这步值得独立编号）：

- DID 由公钥数学推导（ripemd160(sha256(压缩公钥))），**换 key = 换平台**：旧 DID
  签进用户档案的卡全部不再被本平台认领。注册不可撤，必须显式 `--yes`，服务代码
  永不自动注册。
- **seed/私钥丢失 = 平台身份永久丢失**，无找回渠道；形态 B 装完立刻把 `ss` seed 存档。
- **配对红线**（唯一会静默的雷）：`issuer.key` 派生地址必须等于 profile `id` 尾部。
  形态 B 同源派生天然成立；形态 A 手工配错 = 领取照常"成功"但链上验真永远 invalid。
- 装配后核对 + 重启（平台身份是**进程级单例缓存**，装配/更换后必须 restart）：

  ```bash
  head -3 data/keys/issuer-profile.json   # id = 预期 DID（形态 B 应 ≠ 既有平台 DID）
  ls -l data/keys/                        # issuer.key 权限 0600
  systemctl restart dsh-multitenant
  ```

完整装配、缺钥降级语义与保护矩阵见
[docs/keys-provisioning.md](../docs/keys-provisioning.md)。

### 4. 验证

```bash
curl -s http://127.0.0.1:8090/health
curl -s "http://127.0.0.1:8090/connect-status?address=<你的地址>"
systemctl status dsh-multitenant
# 浏览器装 CCDAO 插件 → http://<PUBLIC_HOST>:8090/ → 连接钱包 → 应自动发卡（冷启动级联）
```

追加验收点（冒烟之上，浏览器实走）：

- **跨平台共存**：官网档案页"测试平台"卡与"DSH 平台"卡**并存、互不摘除**——
  `isOurIssuedCard` 窄闸修复的实弹验证（credential.test.js 4 条回归用例钉死），
  形态 B 可放心与正式平台共用官网 relay
- **容器 tab**：未跑则后台自动拉起 + tab 右侧转圈 → 完毕弹窗【确定】跳容器管理；
  期间「启动容器」按钮置灰
- **F9 会话**：切换插件账户自动重签一次即闭环，不再循环报"会话主人不一致"
- **冷启动级联**：空台账直接跑**不需预造凭证**——无档案无卡 → 自动签发 assigned →
  登录弹窗领取 → 落档；即便迁库丢档，用户首登也经"档案优先发现"自动恢复 claimed

**镜像预热前置**：新版进入用户中心即自动拉起容器，上线瞬间会并发建容器——首次务必
确认 `docker images` 里有 `dsh-multitenant:latest` 且 `data/dsh-image.json` 在场，
否则第一波创建全卡在构建/拉取。

## 文件说明

| 文件                                     | 在哪执行   | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rsync-upload.sh`                        | 本地       | rsync 上传代码（排除项同时保护服务器现场不被 `--delete` 抹掉）                                                                                                                                                                                                                                                                                                                                                                          |
| `install.sh`                             | 服务器     | 首次安装：建目录 → 生成 config.json → 构建镜像 → 构建前端 → 装 systemd 服务。**不同步代码、不检查 keys**（代码靠 rsync/git，keys 靠上文第 3 步；`BUNDLE=` 除外——自动导入）。`BUNDLE=<bundle.tgz>` 即【迁移部署】：库 --drop 还原+keys/入口件/工作区/卷/镜像自动导入，随后走常规安装（现场 config 为王，包内 config/state 不覆盖）。`PORT_BASE/PORT_MAX/PORT_INT_BASE/PORT_INT_MAX` 直传租户端口段（含双段配对），免装完手改 config.json |
| `update.sh`                              | 服务器     | 更新：`git pull --ff-only`（远端不可达自动跳过 → 离线全量重建）+ 按需重建前端（`frontend/` 或 `package*` 有 diff 才建）/镜像（Dockerfile 变更或镜像内 DSH_VERSION ≠ 目标才建）+ 重启。版本 tag `IMAGE:DSH_VERSION` 留回滚锚点                                                                                                                                                                                                           |
| `backup.sh`                              | 服务器     | **唯一备份入口**：一键 bundle = 库快照+入口状态+签发根+工作区归档槽+活容器工作区现值+租户卷+镜像清单，**解包即迁移**（内附 RESTORE.md）；子命令 `verify` 恢复演练（影子库对账，永不碰生产）/ `list`；`BACKUP_DIR` `SKIP_VOLUMES=1` `IMAGE_SAVE=1` `KEEP=7` 可选                                                                                                                                                                         |
| `dsh-multitenant.service`                | 模板       | systemd 单元，install.sh 填充 `ADMIN_ADDRESS`/`PUBLIC_HOST` 占位符后写入 `/etc/systemd/system/`                                                                                                                                                                                                                                                                                                                                         |
| `check-storage.sh`                       | 服务器     | 磁盘配额环境自查（驱动/底层 FS/容器态判定；`--test` 附加写超配额实测）                                                                                                                                                                                                                                                                                                                                                                  |
| `verify-llm-providers.mjs`               | 服务器     | 挂租户卷进镜像跑一把，列出容器内实际注册的 LLM provider（排查模型配置用）                                                                                                                                                                                                                                                                                                                                                               |
| `inject-shim.mjs` / `randomuuid-shim.js` | 构建期资产 | 局域网 HTTP 下 `crypto.randomUUID` shim（见 docs/crypto-randomuuid.md），Dockerfile 引用                                                                                                                                                                                                                                                                                                                                                |
| `seccomp-bwrap-minimal.json`             | 运行时资产 | 租户容器 bwrap 所需最小 seccomp 白名单（docker.service 引用）                                                                                                                                                                                                                                                                                                                                                                           |

## 单域名隧道形态（https://域名:外口 → 服务器 8090）

平台是**多端口架构**：入口 8090 一个 + 每个租户一个网关端口（31000 起）。隧道只
映射入口一个口时，平台首页可用，但"进入容器"跳 `域名:31xxx` 必被拒
（ERR_CONNECTION_REFUSED）——**租户端口过隧道是物理前提，代码不能替它凭空开门**。

完整可用的隧道形态 = 映射入口 + 租户端口段，再向平台声明对外协议/端口：

**端口段三处必须一致**（平台发号段 = frpc 映射段 = 安全组开通段），平台段在
config.json 的 `docker.basePort / docker.maxPort` 收口（默认 `31000..65535`
形同虚设，走端口段映射部署**务必收段**，如只开 20 个就设 `maxPort: 31019`）。
发号纪律由代码守死（test/port-range.test.js 六例钉桩）：回收池越界旧号就地
丢弃、存量租户段外旧号重连时自动重发、段满明确报错——**绝不静默发出隧道
没开通的端口**，"进入容器"链接必然落在已开通段内。
**段内外部占用自动避让**（与既有业务混段共存，如复用 40xxx 转发池）：发号前
bind 探针实勘占用，撞外部监听自动改派段内下一空号；网关 bind 失败一律弃号，
下次连接探号重建（容器与卷数据不动）。排查面：`ss -tlnp | grep :<口>`。

**双端口段配对模式**（config.json `docker` 节四键；对外段唯一真源是
`basePort..maxPort`——原 `publicBasePort/publicMaxPort` 与它同义、已删除）：

```json
"basePort": 40010, "maxPort": 40060,                 // 给用户看的对外段（DNAT/安全组面）
"internalBasePort": 47010, "internalMaxPort": 47060  // 容器宿主回环映射段（>0 即启用配对；勿碰 k3s NodePort 段）
```

- 运行期一一对应：`internal = internalBase + (public - publicBase)`，容器映射不再随机，排障可推算。
- 发号**整对探测**：对外端 bind 0.0.0.0 探 + 回环端 bind 127.0.0.1 探，任一端被外部占用 → 整对跳过试下一对。
- **非本服务产生的占用**记入账本 `state.externalOccupations`（port/scope/首末见/命中数），
  经 `GET /api/admin/gateway-ports` 的 `occupied` + `ranges` 字段透出——混段里谁占了哪号，看接口不用 ss。
- internal 两值缺一半或全 0/不写 = 内部口随机（旧行为，启动日志会警告半配置）（test/port-pairs.test.js 双模式均有桩）。

```bash
# install.sh 追加两参（或写进 config.json 的 server 段 publicScheme/publicPort）：
PUBLIC_SCHEME=https PUBLIC_PORT=8550 ./deploy/install.sh
```

```ini
# frpc 侧参考（证书不含端口，同域一张证书全段复用）：
[name-platform] type = https
custom_domain = dsh.wh.jccdex.cn
[name-gw31016] type = https          # 租户端口逐个（或 range）映射
custom_domain = dsh.wh.jccdex.cn
```

**免人肉补口**：租户端口是动态分配的，新增租户不用手改 frpc——平台提供同步面
`GET /api/admin/gateway-ports`（返回全部已分配端口 + 对外形态；同机回环免口令，
异机带 `Bearer TUNNEL_SYNC_TOKEN`），配 `deploy/tunnel-sync.example.sh` 进 cron，
新端口自动经 frpc admin API 补映射。

⚠️ **一致性红线**：`PUBLIC_SCHEME=https` = 承诺"入口与**全部**已映射租户端口都是
https 终结"。cookie 按 host 共享不分端口——Secure 票发得出去收不回（明文口收不到），
混形态会断网关会话（403 循环）。全 raw tcp 映射（http 直连租户口）则两参都不设，
走自动判形。口径单点 `src/utils/public-endpoint.js`（env > config > 请求判形）。

## 常用运维

```bash
systemctl status dsh-multitenant          # 服务状态
journalctl -u dsh-multitenant -f         # 实时日志
systemctl restart dsh-multitenant         # 重启（session 在 data/ 下，重启不掉线）
sudo ./deploy/update.sh                   # 更新（git pull + 按需重建 + 重启）
sudo ./deploy/backup.sh                   # 全量 bundle（含租户卷；产物 0600）
sudo SKIP_VOLUMES=1 ./deploy/backup.sh    # 库+入口轻件（日常 cron 省磁盘）
sudo ./deploy/backup.sh verify            # 恢复演练：最新 bundle→影子库逐集合对账
# 产物 bundle-<TS>.tgz 默认落【项目根】（BACKUP_DIR= 可指独立盘位；git 与
# rsync-upload 均已排除 bundle-*.tgz，不会误提交/误删，但装完机的旧包记得清）
# 定时备份+每周演练（cron）：
# 0 3 * * * /srv/dsh-multitenant/deploy/backup.sh
# 30 4 * * 0 /srv/dsh-multitenant/deploy/backup.sh verify
```

**服务器连不上 GitHub 的更新路径**：本地 `SERVER_HOST=<IP> ./deploy/rsync-upload.sh`
→ 服务器 `sudo ./deploy/update.sh`（自动跳过 pull、全量重建前端+镜像；也可显式
`SKIP_GIT_PULL=1`）。上传会同步删除多余文件，但 `data/ patches/ config.json state.json`
已排除不会丢；改了 `Dockerfile` 镜像必重建，**租户数据卷不受影响**。建议上传前先
`backup.sh`。

**`npm ci` 报 "Missing: … from lock file"（lock 与 package.json 脱节）**：这是保护不是
故障——lock 是唯一依赖真相。修法在本地：`npm install --package-lock-only` 重新生成
`package-lock.json`，连同代码一起上传，再重跑 install/update（2026-10-26 实弹：
VC SDK 传递依赖 @cedar-policy/cedar-wasm、mscrypto 因改 package.json 未刷 lock 而漏记）。

## 磁盘配额（tiers.\*.disk）：三个实情 + 一条历史

**实情**（设计前必读，别再按 `--storage-opt` 的字面语义理解）：

1. `disk` 仅在 **btrfs/zfs/devicemapper** 存储驱动下硬生效；overlay2/overlayfs（含
   Linux 默认安装）下"记录不强制"（软配额）。选型矩阵：`docs/roadmap-next.md` §P1-5。
2. 即使硬生效，`--storage-opt size=` 限的也只是**容器可写层**——租户数据全在命名卷
   `dsh-data-swtc-*`（挂载 `/dsh-home`），**配额管不到它**。现阶段真正的磁盘护栏是
   管理端「资源监控」（引擎口径 + `du` 实测）；配额字段是"声明 + 为将来预留"。
3. **Docker 29+** 新装默认启用 containerd image store，`--storage-opt size` 可能
   **静默失效**（与驱动是否支持无关）。`check-storage.sh` 会检测提示；要回退经典
   存储：`daemon.json` 设 `"features": {"containerd-snapshotter": false}` 重启并重建镜像。

```bash
bash deploy/check-storage.sh          # 一条命令给当前环境判定
bash deploy/check-storage.sh --test   # 附加实测：临时容器写超配额是否真被拦
```

另外注意：个别 Docker 版本在不支持的宿主上会**直接拒绝整个 `docker run`**（exit 125）
而非静默跳过——平台已做"仅对这一种明确原因去参重试"的降级（docs/fixlog.md 第 23 条）。

**历史**（从 memorySwap 时代（≤2026-09）升级的老服务器才需要动）：字段已改名
`tiers.*.memorySwap` → `tiers.*.disk`。旧 config 缺 `disk` 时容器仍能启动（跳过参数
并告警），但配额不生效。症状 `journalctl -u dsh-multitenant | grep 'disk quota'`；修复：

```bash
cp config.json config.json.bak
sed -i 's/"memorySwap":/"disk":/' config.json   # 值不变仅改名
systemctl restart dsh-multitenant
```

（`FORCE=1 ./deploy/install.sh` 重生成 config 也行，但会丢自定义项，仅无自定义时用。
同代新增可选项 `resource.*`/`usageLimit`/`cwt` 缺失有默认兜底，参考 `config.json.example`。）

## 恢复 / 迁移

`backup.sh` 产出的 `bundle-<时间戳>.tgz` 解包后**内附 RESTORE.md**——库/keys/入口/
卷/工作区/镜像八步恢复指引（同机灾备按它手工走）。**换机迁移一条命令**：

```bash
# 新机（代码已 rsync/clone 到位后）：
scp 源机:/srv/dsh-multitenant/bundle-<TS>.tgz /tmp/   # 默认产物=源机项目根
ADMIN_ADDRESS=<同旧机> PUBLIC_HOST=<新机地址或域名> \
PORT_BASE=40000 PORT_MAX=40099 PORT_INT_BASE=47010 PORT_INT_MAX=47109 \
BUNDLE=/tmp/bundle-<TS>.tgz ./deploy/install.sh
```

`PORT_*` 四个参数只写进【新装的】config.json（现场已有 config 时不生效，改段请直接
编辑 config.json）；新机段规划见上文【双段配对】节——对外段对齐隧道放行范围，
内部段避开 k3s NodePort 等本机监听面。

install 会先整包导入（库 --drop、keys 收权入位、卷建同名灌回、工作区入槽、
镜像 load），再照常走构建与服务注册——首启即带全部历史数据，登录态/凭证不断。
迁移 bundle 建议源机用 `IMAGE_SAVE=1` 全量打一次（镜像也进包，缺 tag 的
钉版本租户会起不来；install 屏幕会列清单提示）。旧形态 `entry-*.tgz`/`vol-*.tgz`
袋件都在 bundle 内，恢复一律以包为准。

## 安全提示（务必阅读）

- 每个租户容器运行的是**带远程代码执行能力的 DSH 实例**；`/connect` 无注册门槛，任何人持任意 SWTC 地址即可自助开通。
- 租户端口 31000–65535 若直接对公网开放，风险较高。**生产建议**：内网/VPN 部署，或 nginx + HTTPS + 访问控制（把域名加入 `PUBLIC_TRUST`），至少用防火墙把租户端口段限制到可信来源。
- 本工具集默认以 root 运行入口服务（`RUN_USER=root`）；更稳妥的做法是 `RUN_USER=dsh`（自动建用户并加入 docker 组），或自行收紧权限。
