#!/usr/bin/env bash
# ============================================================================
#  备份脚本（在服务器上执行）
#  备份入口状态（state.json / config.json / data / patches）+ 可选租户数据卷
#  用法：
#    ./deploy/backup.sh                  # 只备份入口状态
#    VOLUME_BACKUP=1 ./deploy/backup.sh  # 同时备份所有租户数据卷
#  建议 cron：0 3 * * * /srv/dsh-multitenant/deploy/backup.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  exec sudo env VOLUME_BACKUP="${VOLUME_BACKUP:-0}" BACKUP_DIR="${BACKUP_DIR:-}" "$0" "$@"
fi

BACKUP_DIR="${BACKUP_DIR:-/backup/dsh-multitenant}"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# 1. 入口状态（state.json 首次运行前可能不存在，容错）
tar --ignore-failed-read -czf "$BACKUP_DIR/entry-$TS.tgz" state.json config.json data patches 2>/dev/null || true

# 2. 租户数据卷（可选，逐卷导出）
if [ "${VOLUME_BACKUP:-0}" = "1" ]; then
  for v in $(docker volume ls -q --filter name=dsh-data-swtc-); do
    name="${v#dsh-data-swtc-}"
    echo ">> 备份卷 $v ..."
    docker run --rm -v "$v:/dsh-home" -v "$BACKUP_DIR:/backup" \
      alpine tar czf "/backup/vol-$name-$TS.tgz" -C /dsh-home .
  done
fi

# 3. 保留最近 7 份入口备份，更早的删除（卷备份全部保留，注意磁盘规划）
ls -1t "$BACKUP_DIR"/entry-*.tgz 2>/dev/null | tail -n +8 | xargs -r rm -f

echo ">> 备份完成: $BACKUP_DIR"
ls -1 "$BACKUP_DIR" | tail -5
