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
# 安装 node-gyp 编译工具链 + agent 常用命令行工具
# ---------------------------------------------------------------------------
# DSH 的依赖 node-pty 需要从源码编译（node-gyp），slim 镜像不带
# python3 / make / g++，必须手动装。
# 另外 deb.debian.org 在国内网络经常不可达，先把 apt 源换成阿里云镜像
# （实测：清华 403、官方超时、阿里云 200）。
#
# 一并装 agent 真正用得到的三个工具（容器内实测原本都没有）：
#   curl  —— 抓取网页/接口。没有它 agent 只能靠 `node -e "fetch(...)"` 兜底
#   jq    —— 解析 JSON。没有它要写 node/python 一行式
#   ripgrep —— 代码检索。没有它只能用 grep -r，慢且默认忽略规则不同
# 放着不装的话，agent 每次都要绕路，而且这些绕路是逐次消耗 token 的。
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates bash bubblewrap \
    curl jq ripgrep \
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
# 沙箱模式：默认 workspace-write（DSH 的 sandbox-policy 默认值，边界 = 进程
# cwd = /srv）。bubblewrap 不可用时才需要改成 danger-full-access（降低安全性）。
#
# ⚠ 变量名必须是 DSH_PERMISSION_MODE，不能写 DSH_SANDBOX_MODE：
#   后者在 DSH 包里出现 0 次（实测 grep 整个 node_modules），写了也不生效 ——
#   会让人以为"已经放开沙箱"，实际仍以 workspace-write 启动后失败。
#   副作用：danger-full-access 会同时把 approval 策略变成 never（见 dsh-base 的
#   cordis.patch.yml），即不再弹审批 —— 这正是它"降低安全性"的地方。
# ENV DSH_PERMISSION_MODE=danger-full-access

# ---------------------------------------------------------------------------
# 安装 DeepSeek Harness
# ---------------------------------------------------------------------------
# 通过 npm 全局安装（dsh 是普通 npm 包，web profile 已内置，不需要 pnpm）。
#
# DSH_VERSION 是构建参数：
#   - 不传 → 装 DSH_TOKEN_AUTH_SINCE 之前的最后一个版本（见下方说明）
#   - 传确切版本（如 0.1.5-rc.2）→ 装到指定版本，且**构建期核对**
#     （装错立刻失败，而不是产出一个"看起来成功"的错版镜像）
#
# 默认值为什么钉在 0.1.1-rc.2 而不是 latest：
#   自 0.1.2-alpha.2 起，DSH 给 `/` 和 `/api` 加了一层"绑定 authority 的签名
#   cookie"认证，必须先用**进程级 launch token** 激活才能访问。而用户浏览器
#   永远拿不到那个 token —— 激活 URL 指向容器内的 127.0.0.1:3080 / 容器内网 IP，
#   浏览器够不着。不处理的话从那个版本起用户会撞上：
#       dsh web authentication required; reopen the URL printed by dsh web.
#
#   ✅ 现在平台已经**代做激活**（src/services/dsh-auth.service.js + 租户网关）：
#     从容器日志读出 launch token → 用浏览器请求里的 Host 请求
#     /?token=... 换到签名 cookie → 注入后续转发。所以 ≥0.1.2-alpha.2 的版本
#     现在都能正常进入，`latest` 与管理员升级到最新版都是可以的。
#   同一层认证也覆盖 `/api`，平台的 check-rpc.mjs 已同步带上
#   authority + cookie（否则空闲检测会 401，把"正在跑任务的会话"误判为空闲
#   并停掉——比界面进不去更危险）。
#
#   默认仍钉在 0.1.1-rc.2 只是"保守默认值"，不是能力限制：
#     · 想跟上游最新版 → 显式传 --build-arg DSH_VERSION=<版本> 或用管理端升级
#     · 平台保留能力判定（dsh-version.service.js 的 requiresToken），
#       代激活失败时会明确报错并说明原因，而不是静默坏掉
#
#   0.1.1-rc.2 是**最后一个不需要该认证**的版本（逐版本下载 tarball 实证：
#   0.0.1-rc.1 … 0.1.1-rc.2 共 10 个版本里 token 字样出现 0 次）。
#
# 装完把【解析后的真实版本】写进 /usr/local/share/dsh-version：
#   - LABEL 记的是"构建参数"（可能是 latest，无信息量）
#   - 这个文件记的是"实际装上的版本"，是权威值，供：
#     · 平台判断镜像里到底是什么版本（docker run --entrypoint cat）
#     · deploy/update.sh 比对"上次构建版本 vs 目标版本"，决定是否重建
#   （label 与文件都要：label 便于 docker inspect 快速看，文件用于精确比对）
#
# 运行期读取还有第二级回退：读不到该文件时回退读包内 package.json，
# 以兼容本次改动之前构建的旧镜像（见 docker.service.js 的 VERSION_PROBE_CMD）。
ARG DSH_VERSION=0.1.1-rc.2
RUN EXPECTED="${DSH_VERSION}" \
  && echo ">> 安装 @deepseek-ai/dsh@${EXPECTED}" \
  && npm install -g "@deepseek-ai/dsh@${EXPECTED}" \
  && npm cache clean --force \
  && PKG="$(npm root -g)/@deepseek-ai/dsh/package.json" \
  && test -f "$PKG" \
  && ACTUAL="$(node -p "(require('${PKG}').version)||''")" \
  && test -n "$ACTUAL" \
  && if [ "$EXPECTED" != "latest" ] && [ "$ACTUAL" != "$EXPECTED" ]; then \
       echo "!! DSH 版本不符：期望 $EXPECTED，实际 $ACTUAL" >&2; exit 1; \
     fi \
  && echo "$ACTUAL" > /usr/local/share/dsh-version \
  && echo ">> DSH 实际版本：$ACTUAL"

LABEL org.opencontainers.image.title="dsh-multitenant tenant image"
LABEL dsh.version="${DSH_VERSION}"

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
