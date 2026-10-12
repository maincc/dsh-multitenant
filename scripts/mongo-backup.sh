#!/usr/bin/env bash
# =============================================================================
# DSH MongoDB 备份（storage-design §8 M4 交付物）——mongodump 快照 + 保留策略
#
# 用法：
#   scripts/mongo-backup.sh            备份一次（默认 dsh_prod）
#   scripts/mongo-backup.sh verify     恢复演练：把最新快照 restore 到影子库
#                                      并逐集合对账（不碰生产库），过完删影子库
#   scripts/mongo-backup.sh list       列出快照
#
# 机制：
#   - mongodump 走副本集【快照读】：平台在线时备份，不阻塞写入、不锁库
#   - 每个快照一个时间戳目录（mongodump 原生输出，可直接喂 mongorestore）
#   - 保留最近 ${KEEP:-7} 份，更早的自动删
#   - 恢复目标库用 --nsFrom/--nsTo 改名进影子库 dsh_prod_verify——演练
#     永远不可能误覆盖生产
#
# 环境变量：DSH_MONGO_BACKUP_DIR / DSH_MONGO_URI / KEEP
# =============================================================================
set -euo pipefail

BACKUP_DIR="${DSH_MONGO_BACKUP_DIR:-$HOME/.dshWorkspace/dsh-mongo/backup}"
URI="${DSH_MONGO_URI:-mongodb://127.0.0.1:27018/dsh_prod?replicaSet=dsh-rs}"
SRC_DB="dsh_prod"
SHADOW_DB="dsh_prod_verify"
KEEP="${KEEP:-7}"

latest_snapshot() { ls -1d "$BACKUP_DIR"/2*/ 2>/dev/null | sort | tail -1; }

do_backup() {
  local snap="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$snap"
  # 备份含会话/审计/用户全量——目录收权（文档承诺 0700，这里做实）
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true
  mongodump --uri="$URI" --out="$snap" >/dev/null
  echo "✓ 快照落盘：${snap}（$(du -sh "$snap" | awk '{print $1}')）"
  # 保留策略：按时间序留最近 KEEP 份
  # tail -n +N 可移植（BSD head 负数行号不支持，macOS 实测踩坑）
  ls -1d "$BACKUP_DIR"/2*/ 2>/dev/null | sort | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -rf "$old" && echo "（过期快照已删：${old}）"
  done
}

do_list() {
  ls -1d "$BACKUP_DIR"/2*/ 2>/dev/null | tail -"$KEEP" || echo "（暂无快照）"
}

# 恢复演练：最新快照 → 影子库 → 逐集合计数对账 → 抽一版内容 diff → 删影子库
do_verify() {
  local snap
  snap="$(latest_snapshot)"
  [ -n "$snap" ] || { echo "!! 无快照可演练（先跑一次备份）" >&2; return 1; }
  echo "演练源：$snap"
  # restore 用的 uri 不带库名（库名由 --nsFrom/--nsTo 控制）。注意不能用
  # ${URI%%/*dsh_prod*}——贪婪匹配把 "://host" 一起咬掉只剩 "mongodb/"（实测踩坑）。
  local host_uri
  host_uri="$(echo "$URI" | sed -E 's#^((mongodb(\+srv)?://[^/]+)).*#\1/#')"
  # ⚠️ 必须喂 dump【根目录】而非 $snap/dsh_prod：指向库子目录时 mongorestore
  # 按"指定集合文件"模式处理，--nsFrom/--nsTo 整体失效（实测全量 skipping）。
  mongorestore --uri="$host_uri" --drop --nsFrom="$SRC_DB.*" --nsTo="$SHADOW_DB.*" --quiet --dir="$snap"
  HOME=/tmp mongosh --quiet --port "$(echo "$URI" | sed -E 's#.*://[^:/]+:([0-9]+).*#\1#')" --eval '
    const d = db.getSiblingDB("dsh_prod"), v = db.getSiblingDB("dsh_prod_verify");
    const names = d.getCollectionNames().filter(n => !n.startsWith("system."));
    // 在线对账：快照之后生产库只可能变少（sessions 懒清理、audit 有 TTL）——
    // 这两个集合允许 还原>=生产（还原的是快照旧账）；其余要求精确相等。
    const driftOK = new Set(["sessions", "audit"]);
    let bad = 0;
    for (const n of names) {
      const a = d.getCollection(n).countDocuments({});
      const b = v.getCollection(n).countDocuments({});
      const ok = driftOK.has(n) ? b >= a : a === b;
      if (!ok) bad++;
      print((ok ? "✓ " : "✗ ") + n + ": 生产 " + a + " | 还原 " + b + (ok && b !== a ? "（在线漂移，快照为旧账）" : ""));
    }
    const u1 = d.users.find({}, {_id:1, port:1}).sort({_id:1}).toArray();
    const u2 = v.users.find({}, {_id:1, port:1}).sort({_id:1}).toArray();
    print("users 内容 diff:", JSON.stringify(u1) === JSON.stringify(u2) ? "无 ✓" : "有差异 ✗");
    v.dropDatabase();
    print(bad === 0 ? "=== 恢复演练通过（影子库已清理）===" : "=== 有 " + bad + " 个集合不一致！===");
  ' 2>/dev/null
}

case "${1:-backup}" in
  backup) do_backup ;;
  verify) do_verify ;;
  list) do_list ;;
  *) echo "用法: $0 [backup|verify|list]" >&2; exit 2 ;;
esac
