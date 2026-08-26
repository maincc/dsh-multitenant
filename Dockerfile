# ============================================================================
#  dsh-multitenant 租户镜像（Tenant Image）
# ============================================================================
#  每个租户从本镜像创建一个容器。租户的持久化状态存放在挂载到
#  DSH_HOME (/dsh-home) 的命名卷里；入口服务还会把一个"按租户生成"的
#  cordis patch 挂载进容器，用来把 webserver 钉到 0.0.0.0 并声明
#  该租户可信的浏览器 authority（trustedHosts）。
# ============================================================================

# 基础镜像：Node 22 slim。DSH 只要求 Node >= 22，slim 体积小。
FROM node:22-slim

# ---------------------------------------------------------------------------
# 安装 node-gyp 编译工具链
# ---------------------------------------------------------------------------
# DSH 的依赖 node-pty 需要从源码编译（node-gyp），slim 镜像不带
# python3 / make / g++，必须手动装。
# 另外 deb.debian.org 在国内网络经常不可达，先把 apt 源换成阿里云镜像
# （实测：清华 403、官方超时、阿里云 200）。
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates bash bubblewrap \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# 运行时环境变量
# ---------------------------------------------------------------------------
# DSH_HOME：DSH 把 settings / credentials / sessions / storages 全部放在
# 这个目录下。指向 /dsh-home 后，入口服务只需把一个 Docker 卷挂到这里，
# 就完成了租户的完整持久化。
ENV DSH_HOME=/dsh-home
# 关闭遥测上报；生产模式。
ENV DSH_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# 沙箱模式：如果 bubblewrap 不可用，可改为 danger-full-access（降低安全性）
# ENV DSH_SANDBOX_MODE=danger-full-access

# ---------------------------------------------------------------------------
# 安装 DeepSeek Harness
# ---------------------------------------------------------------------------
# 通过 npm 全局安装（dsh 是普通 npm 包，web profile 已内置，不需要 pnpm）。
RUN npm install -g @deepseek-ai/dsh@latest \
  && npm cache clean --force

# ---------------------------------------------------------------------------
# 注入 crypto.randomUUID polyfill（非安全上下文兼容）
# ---------------------------------------------------------------------------
# DSH 前端在浏览器非安全上下文（局域网 IP + 明文 HTTP）下拿不到
# crypto.randomUUID（W3C Secure Contexts 限制），发消息报
# "crypto.randomUUID is not a function"。这里把 polyfill 注入到 web 前端
# 的 index.html（</head> 前，先于所有 module script 执行）。
# 与 DSH 官方 random-uuid.ts（crypto.getRandomValues 实现）一致；在安全
# 上下文（HTTPS/localhost）下 guard 不成立自动跳过，零副作用。
# 详见 docs/crypto-randomuuid.md
COPY deploy/randomuuid-shim.js /patches/shims/randomuuid-shim.js
COPY deploy/inject-shim.mjs /tmp/inject-shim.mjs
RUN WEB_HTML="$(find "$(npm root -g)" -path '*/dsh-web-frontend/dist/index.html' | head -1)" \
  && test -n "$WEB_HTML" \
  && test -f "$WEB_HTML" \
  && node /tmp/inject-shim.mjs "$WEB_HTML" \
  && rm /tmp/inject-shim.mjs

WORKDIR /srv

# ---------------------------------------------------------------------------
# 内置默认 patch
# ---------------------------------------------------------------------------
# 用途：当入口服务没有挂载按租户生成的 patch 时（例如手动 `docker run`），
# 容器也能正常工作——至少把 webserver 覆盖为监听 0.0.0.0，让 -p 端口映射
# 能打通。trustedHosts 故意不在这里写死（由调用方/入口服务决定）。
# 原理：web-app bundle 里 webserver 行的配置是
#   host: !!js ctx.webStartup.host ?? '127.0.0.1'
# cordis patch 按 id 整行替换 config，因此这里直接给出完整的新 config。
COPY host.patch.yml /patches/host.patch.yml

# ---------------------------------------------------------------------------
# 容器启动命令
# ---------------------------------------------------------------------------
# 坑：`dsh web --patch x.yml` 和 `dsh --patch x.yml web` 都不被接受——
#   - `web` alias 会把未知参数透传给 app（--patch 报 unknown option）
#   - `web` 子命令显式拒绝父级 --patch
# 正确写法是 root 形式：`dsh --profile web --patch x.yml ...`，
# 其中 --patch 是 root 的 repeatable launcher flag。
# 另外 `--host 0.0.0.0` 被 dsh 设计性禁止（防 RCE 暴露），所以必须用 patch
# 覆盖 webserver 配置来实现全接口监听（容器本身就是隔离边界）。
#
# 入口服务挂载的按租户 patch 位于 /patches/tenant.patch.yml；
# 它和 host.patch.yml 有相同的行 id（webserver），后者应用、后者生效
# （last write wins）。shell 包装里先判断该文件是否存在，兼容手动
# `docker run` 不挂载该文件的场景；用 exec 保证 node 进程直接收信号。
CMD ["sh", "-c", "P=/patches/tenant.patch.yml; if [ -f \"$P\" ]; then exec dsh --profile web --patch /patches/host.patch.yml --patch \"$P\" --port 3080; else exec dsh --profile web --patch /patches/host.patch.yml --port 3080; fi"]
