#!/usr/bin/env bash
# ============================================================================
# 检查 Docker 存储驱动与磁盘配额能力（决定 --storage-opt size= 是否硬生效）
#
# 用法：
#   ./deploy/check-storage.sh          # 只检测并给出结论
#   ./deploy/check-storage.sh --test   # 附加实测：起临时容器写超配额，验证是否真被拦
#
# 背景：磁盘配额（tiers.*.disk → --storage-opt size=）仅对部分存储驱动硬生效；
#       overlay2/overlayfs 下仅记录不强制。详见 docs/roadmap-next.md §P1-5。
# ============================================================================
set -uo pipefail

echo "=========================================="
echo " Docker 存储驱动与磁盘配额能力检查"
echo "=========================================="
echo ""

# ---- 1. 存储驱动 ----
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ 未找到 docker 命令（本机不是 Docker 宿主机？）"
  exit 1
fi

DRIVER="$(docker info --format '{{.Driver}}' 2>/dev/null || echo unknown)"
echo "① 存储驱动：${DRIVER}"

# ---- 2. 底层文件系统（overlay2 判定配额能力需要） ----
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
BACKING="$(docker info 2>/dev/null | awk -F': ' '/Backing Filesystem/{print $2}' | head -1)"
echo "② Docker 根目录：${DOCKER_ROOT}"
[ -n "${BACKING}" ] && echo "   底层文件系统：${BACKING}"

# overlay2 场景：查挂载选项是否含 pquota/prjquota（xfs 项目配额）
MOUNT_OPTS=""
if [ "${DRIVER}" = "overlay2" ]; then
  MOUNT_OPTS="$(findmnt -no OPTIONS --target "${DOCKER_ROOT}" 2>/dev/null || \
                awk -v m="${DOCKER_ROOT}" '$2==m {print $4}' /proc/mounts 2>/dev/null)"
  [ -n "${MOUNT_OPTS}" ] && echo "   挂载选项：${MOUNT_OPTS}"
fi

# ---- 3. daemon.json 是否显式指定驱动 ----
echo "③ daemon.json："
if [ -f /etc/docker/daemon.json ]; then
  grep -q 'storage-driver' /etc/docker/daemon.json 2>/dev/null \
    && grep 'storage-driver' /etc/docker/daemon.json \
    || echo "   （未显式指定 storage-driver，使用 Docker 自动选择的 ${DRIVER}）"
else
  echo "   （无 /etc/docker/daemon.json，使用默认驱动 ${DRIVER}）"
fi

# ---- 3.5 Docker 版本 + 镜像/快照存储后端 ----
DOCKER_VER="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
echo "④ Docker 版本：${DOCKER_VER}"
# containerd image store（Docker 29+ 新装默认）：镜像走 containerd snapshotter，
# 不再经由 graph driver，--storage-opt size 可能静默失效（不报错也不生效）。
# 判定：docker info 出现 driver-type → 确认启用；否则仅当版本 ≥29 时提示需自查。
DOCKER_MAJOR="${DOCKER_VER%%.*}"
CONTAINERD_STORE="no"
if docker info 2>/dev/null | grep -qiE 'driver-type'; then
  CONTAINERD_STORE="yes"
elif [ "${DOCKER_MAJOR:-0}" -ge 29 ] 2>/dev/null; then
  CONTAINERD_STORE="likely"
fi
case "${CONTAINERD_STORE}" in
  yes)
    echo "   ⚠️ 已启用 containerd image store —— --storage-opt size 可能【静默失效】"
    echo "      （既不报错也不生效，与存储驱动是否支持配额无关）。"
    echo "      如需回退经典存储：daemon.json 设 \"features\": {\"containerd-snapshotter\": false}，"
    echo "      然后重启 Docker 并重建镜像（旧镜像不可复用）。"
    ;;
  likely)
    echo "   ⚠️ Docker ${DOCKER_VER}（≥29）新装默认启用 containerd image store，"
    echo "      该模式下 --storage-opt size 可能【静默失效】。"
    echo "      自查：docker info | grep -i driver-type（有输出=已启用）。"
    ;;
esac
echo ""

# ---- 4. 判定 ----
echo "=========================================="
QUOTA="soft"
case "${DRIVER}" in
  btrfs | zfs | devicemapper)
    QUOTA="hard"
    echo "✅ 结论：磁盘配额【硬生效】"
    echo "   ${DRIVER} 原生支持 --storage-opt size=，写超配额会被内核拒绝。"
    ;;
  overlay2)
    if echo "${MOUNT_OPTS}" | grep -qE 'pquota|prjquota'; then
      QUOTA="hard"
      echo "✅ 结论：磁盘配额【硬生效】（overlay2 + xfs 项目配额）"
      echo "   底层 xfs 已启用 pquota/prjquota，容器可写层受 size 限制。"
    else
      echo "⚠️  结论：磁盘配额【软配额】——记录但不强制"
      echo "   overlay2 不支持 --storage-opt size= 强制（参数被接受并记录在"
      echo "   HostConfig.StorageOpt，但写超不会被拦）。"
      echo "   注意：Linux 默认安装即为此情形，与 Docker Desktop 一致。"
      echo "   要硬生效：初始化时选 btrfs/zfs，或把 ${DOCKER_ROOT} 所在分区"
      echo "   格式化为 xfs 并挂载 pquota 后重建 Docker 数据目录。"
    fi
    ;;
  overlay | overlayfs)
    echo "⚠️  结论：磁盘配额【软配额】——记录但不强制"
    echo "   ${DRIVER} 不支持 size 强制（Docker Desktop 常见）。"
    ;;
  vfs)
    echo "⚠️  结论：磁盘配额【不支持】"
    echo "   vfs 驱动无配额能力，且性能差，不建议生产使用。"
    ;;
  *)
    echo "❓ 结论：未知驱动 ${DRIVER}，请查阅 Docker 文档确认其配额支持。"
    ;;
esac
echo "   租户磁盘使用情况可在管理端「资源监控」查看（引擎口径 + du 实测）。"
echo "=========================================="
echo ""

# ---- 5. 可选实测 ----
if [ "${1:-}" = "--test" ]; then
  echo "=== 实测：--storage-opt size=10m 容器尝试写 50MB ==="
  echo "（期望：硬配额环境下写入被拒；软配额环境下能写满）"
  echo ""
  OUT="$(docker run --rm --storage-opt size=10m alpine \
    sh -c 'dd if=/dev/zero of=/tmp/fill bs=1M count=50 2>&1 | tail -2' 2>&1)"
  echo "${OUT}"
  echo ""
  if echo "${OUT}" | grep -qiE 'no space|quota exceeded|exceeded'; then
    echo "✅ 实测结果：写入被拒 → 配额【已生效】"
  else
    echo "⚠️  实测结果：写满 50MB 成功 → 配额【未强制】（软配额）"
  fi
  echo ""
  echo "注：本测试针对【容器可写层】。租户数据在命名卷（dsh-data-swtc-*，"
  echo "    挂载为 /dsh-home），命名卷不在 --storage-opt 的作用范围内——"
  echo "    卷级配额需 btrfs qgroup / 卷驱动 size 选项，属独立课题。"
fi
