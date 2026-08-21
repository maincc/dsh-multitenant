# 部署工具集（deploy/）

把 dsh-multitenant 一键部署到 Linux 服务器（要求：Docker；若在服务器上构建前端还需 Node ≥ 18）。

## 快速开始（3 步）

### 1. 本地：上传代码

```bash
SERVER_HOST=1.2.3.4 ./deploy/rsync-upload.sh
# 可选：SERVER_USER=ubuntu REMOTE_DIR=/opt/dsh 覆盖默认值
```

### 2. 服务器：首次安装

```bash
ssh root@1.2.3.4
cd /srv/dsh-multitenant
ADMIN_ADDRESS=jndwretndumoqbt2uauclmfmx7xbqjykva \
PUBLIC_HOST=1.2.3.4 \
./deploy/install.sh
```

- `ADMIN_ADDRESS`：你的管理员 SWTC 地址（小写，决定谁能进管理面板）
- `PUBLIC_HOST`：用户浏览器可达的公网 IP 或域名（302 跳转目标 + trustedHosts）
- 有 HTTPS 域名时建议同时设置 `PUBLIC_TRUST=你的域名`

### 3. 验证

```bash
curl -s http://127.0.0.1:8090/health
curl -s "http://127.0.0.1:8090/connect-status?address=<你的地址>"
# 浏览器装 CCDAO 插件 → 访问 http://<PUBLIC_HOST>:8090/ → 连接钱包
```

## 文件说明

| 文件                      | 在哪执行 | 作用                                                                          |
| ------------------------- | -------- | ----------------------------------------------------------------------------- |
| `rsync-upload.sh`         | 本地 Mac | rsync 上传代码（排除 node_modules / data / patches / config.json 等）         |
| `install.sh`              | 服务器   | 首次安装：建目录 → 生成 config.json → 构建镜像 → 构建前端 → 安装 systemd 服务 |
| `dsh-multitenant.service` | 模板     | systemd 单元，install.sh 填充占位符后写入 `/etc/systemd/system/`              |
| `update.sh`               | 服务器   | `git pull` + 按需重建前端/镜像 + 重启                                         |
| `backup.sh`               | 服务器   | 备份入口状态（+ 可选租户数据卷）                                              |

## 常用运维

```bash
systemctl status dsh-multitenant          # 服务状态
journalctl -u dsh-multitenant -f          # 实时日志
systemctl restart dsh-multitenant         # 重启
sudo ./deploy/update.sh                   # 更新（git pull + 重建 + 重启）
sudo ./deploy/backup.sh                   # 备份入口状态
sudo VOLUME_BACKUP=1 ./deploy/backup.sh   # 连同所有租户数据卷一起备份
# 定时备份（cron）：
# 0 3 * * * /srv/dsh-multitenant/deploy/backup.sh
```

## 恢复

```bash
# 入口状态：把备份中的 state.json / config.json / data / patches 解包回项目目录
tar xzf /backup/dsh-multitenant/entry-<时间戳>.tgz -C /srv/dsh-multitenant

# 租户数据卷：先停对应容器，再解包回卷
docker stop dsh-swtc-<地址>
docker run --rm -v dsh-data-swtc-<地址>:/dsh-home -v /backup/dsh-multitenant:/backup \
  alpine tar xzf /backup/vol-<地址>-<时间戳>.tgz -C /dsh-home
docker start dsh-swtc-<地址>
```

## 安全提示（务必阅读）

- 每个租户容器运行的是**带远程代码执行能力的 DSH 实例**；`/connect` 无注册门槛，任何人持任意 SWTC 地址即可自助开通。
- 租户端口 31000–65535 若直接对公网开放，风险较高。**生产建议**：内网/VPN 部署，或 nginx + HTTPS + 访问控制（把域名加入 `PUBLIC_TRUST`），至少用防火墙把租户端口段限制到可信来源。
- 本工具集默认以 root 运行入口服务（`RUN_USER=root`）；更稳妥的做法是 `RUN_USER=dsh`（自动建用户并加入 docker 组），或自行收紧权限。
