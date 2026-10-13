# 测试服务器部署手册（mongodb 存储形态）

> 前提决策：测试环境 **暂不上 HTTPS / Mongo 认证**（账记在
> security-hardening-plan.md，给真实用户前必须还）。本手册按此边界写。
> 分支基线：`change_storage_1`（M0–M4 + P1/P2 留痕，2026-10-13）。

## 一、环境要求（实测锚点，不是猜的）

| 组件    | 最低要求                                                     | 本机基准（行为对齐源） | 说明                                                                                                |
| ------- | ------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| Node.js | **≥ 20.19**                                                  | 24.19                  | 硬约束来自 mongodb driver `engines: node>=20.19.0`；推荐 22 LTS                                     |
| MongoDB | **7.0+，且必须是副本集**                                     | 7.0.26                 | 平台多方写走事务；**standalone 单机会直接报错**——单成员副本集即可（我们本地就是 `dsh-rs` 单成员）   |
| Docker  | Engine + CLI 在 PATH                                         | 28.2.2                 | 平台全部容器操作经 `docker` CLI（execFile）；运行平台的服务账号要能访问 docker.sock（加 docker 组） |
| OS      | Linux x86_64/arm64 首选                                      | macOS                  | 代码跨平台；维护任务里的 fstrim 自动只对 Docker Desktop 生效，Linux 上无害跳过                      |
| 时钟    | **NTP 必须开**（chrony/systemd-timesyncd）                   | —                      | sessions 12h TTL / audit 90d TTL 全押在墙上时钟，漂移=大面积掉线或审计错时销毁                      |
| 内存    | mongod ~1G + 平台 ~0.5G + 租户数×tier 配额                   | —                      | 4 租户默认档起步建议 8G                                                                             |
| 磁盘    | 预检 minFree 4GB（线上建议切 enforce）                       | —                      | 镜像每 tag 数 GB + 每租户数据卷 + 备份目录                                                          |
| 端口    | 对外：8090（入口）、31000–31000+租户上限；**27018 不对公网** | —                      | 租户端口=容器映射，防火墙只放行需要公开的                                                           |
| 出网    | npm registry + 镜像仓库                                      | —                      | 装依赖、构建镜像、租户插件拉取                                                                      |

## 二、上传（两条路选一）

### 路 A：git（推荐，前提是仓库有远端且服务器能拉）

```bash
# 本机：由你执行推送（本项目规矩：代理不 push）
git push origin change_storage_1

# 服务器
git clone -b change_storage_1 <远端地址> /opt/dsh/dsh-multitenant
cd /opt/dsh/dsh-multitenant
npm ci                    # 有 package-lock，全量装（含 dev 以便跑测试自检）
npm ci --omit=dev         # 或部署完自检后，生产精简版
```

### 路 B：服务器无外网 git —— 打包直传

mongodb driver 纯 JS，`node_modules` 可整体打包带上（OS 同为 linux 或
darwin→darwin 时最稳；跨 OS 打包后在服务器补跑一次 `npm ci --omit=dev` 兜底）：

```bash
# 本机（排除运行时数据！data/ 含用户卷索引与会话文件，绝不带上服务器）
tar czf /tmp/dsh-deploy.tgz --exclude .git --exclude data \
  --exclude node_modules/.cache dsh-multitenant 所在目录
scp /tmp/dsh-deploy.tgz server:/opt/dsh/ && ssh server 'cd /opt/dsh && tar xzf dsh-deploy.tgz'
```

## 三、服务器落地步骤（按序执行）

### 1. Mongo 副本集（单成员，内网/本机绑定）

`/etc/mongod.conf` 关键项：

```yaml
replication:
  replSetName: dsh-rs
net:
  bindIp: 127.0.0.1 # 测试不认证 → 绝不 0.0.0.0
  port: 27018
```

启动后用 mongosh 初始化一次（等价于本地 scripts/mongo-rs.sh 的首启逻辑）：

```bash
mongosh --port 27018 --eval 'rs.initiate({_id:"dsh-rs",members:[{_id:0,host:"127.0.0.1:27018"}]})'
```

### 2. 租户镜像

服务器 build（仓库内有 Dockerfile），**tag 要与钉版兼容**（本地已用
`dsh-multitenant:0.2.0-rc.2`；若全新起步无钉版租户，latest 即可）：

```bash
docker build -t dsh-multitenant:latest -t dsh-multitenant:0.2.0-rc.2 .
```

### 3. systemd 托管（两个 unit，可直接抄）

`/etc/systemd/system/dsh-mongod.service`：

```ini
[Unit]
Description=DSH MongoDB replica set member
After=network.target

[Service]
ExecStart=/usr/bin/mongod -f /etc/mongod.conf
User=mongod
LimitNOFILE=64000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/dsh-platform.service`：

```ini
[Unit]
Description=DSH multitenant platform
After=dsh-mongod.service network-online.target
Requires=dsh-mongod.service

[Service]
WorkingDirectory=/opt/dsh/dsh-multitenant
Environment=DSH_STORAGE_PROVIDER=mongodb
Environment=MONGODB_URI=mongodb://127.0.0.1:27018/dsh_prod?replicaSet=dsh-rs
Environment=PUBLIC_HOST=<服务器对外IP或域名>
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server.js
User=dsh
Group=docker
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now dsh-mongod dsh-platform
```

启动语义已在本地实测：库连不上 **fail-closed 拒起**（不会拿陈旧文件当权威）；
`systemctl stop` 触发 SIGTERM → 会话镜像 drain 后退出。

### 4. 数据：默认全新起步（推荐）

空库首启平台自建 schema 戳。要搬本机数据（一般测试没必要）：

```bash
# 本机出快照
scripts/mongo-backup.sh backup
# 传服务器后还原。坑位备忘（已在脚本修复）：mongorestore --dir 必须喂【快照根目录】
# （里面才是 dsh_prod/ 子目录），喂到 dsh_prod 子目录会静默全跳过。
mongorestore --uri='mongodb://127.0.0.1:27018/dsh_prod?replicaSet=dsh-rs' \
  --drop --dir=/opt/dsh/backup/<快照目录>
```

### 5. 定时备份

```cron
30 3 * * * cd /opt/dsh/dsh-multitenant && scripts/mongo-backup.sh backup >> /var/log/dsh-backup.log 2>&1
```

备份目录含用户数据，保持 0700；上线前做一次"备份→影子库还原→verify 对账"演练。

## 四、部署后验收清单（10 分钟）

- [ ] `systemctl status dsh-mongod dsh-platform` 双 active
- [ ] 浏览器开 `http://<服务器>:8090/` → 钱包登录成功
- [ ] Compass/mongosh 看 `dsh_prod`：`sessions` 新增本次登录行（`expiresAt` BSON Date）
- [ ] `audit` 出现 `kind:'ops' action:'admin_login'`（P1 后的新录像，本地已实弹验证）
- [ ] 启动/停止一个租户容器 → `users` 行状态翻转 + `usage` 当日行累计
- [ ] 退出登录 → `audit` 出现 `admin_logout` 且 actor=你的地址（**actor 非空是平台进程内会话的判据**，进程外插的假会话才会 null）
- [ ] `systemctl restart dsh-platform` 后六链水合日志齐全，登录态仍在（sessions 未丢）
- [ ] NTP：`timedatectl` 显示 System clock synchronized: yes

## 五、上线前待还的账（提醒，不做进本手册）

1. HTTPS 反代 + cookie `Secure`（现在只 HttpOnly+SameSite=Strict，http 下发安全）
2. Mongo 认证（最小权限账号：仅 dsh_prod readWrite）+ 跨机时 TLS
3. D5：灰度稳定后删 json 写路径，终结双轨
4. README 环境变量表中 MONGODB_URI 默认值为历史 27017，与现默认 27018 不符——文档纠一行
