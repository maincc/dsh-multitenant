#!/usr/bin/env bash
# =============================================================================
# DSH 专用 MongoDB 副本集启停管理（storage-design §8 M4 交付物）
#
# 为什么是"专用副本集"：写路径依赖多文档事务（§5.2 审批四方写等），
# 而 withTransaction 要求副本集拓扑——单实例 mongod 不算。这里用【单成员
# 副本集】满足事务前提，与 brew 的 27017（别人在用）完全隔离。
#
# 用法：
#   scripts/mongo-rs.sh start     起（幂等：已运行则报告不动它；空数据目录
#                                 首起自动 rs.initiate 并等上 PRIMARY）
#   scripts/mongo-rs.sh stop      优雅停（SIGTERM，WiredTiger 干净收尾）
#   scripts/mongo-rs.sh status    监听态 + 副本集角色 + 库清单
#   scripts/mongo-rs.sh restart   stop + start
#
# 环境变量覆盖：
#   DSH_MONGO_RS_DIR  数据/日志根目录（默认 $HOME/.dshWorkspace/dsh-mongo）
#   DSH_MONGO_PORT    端口（默认 27018）
#   MONGOD_BIN        mongod 路径（默认 /usr/local/bin/mongod）
#
# ⚠️ 已知边界：本机重启后 mongod 不会自启（本地形态，无 systemd/launchd）。
#    恢复方式就一条：scripts/mongo-rs.sh start（dbpath 保留拓扑，无需重新
#    initiate）；平台侧有"迁移失败拒绝启动"兜底，不会带着脏状态开跑。
# =============================================================================
set -euo pipefail

RS_DIR="${DSH_MONGO_RS_DIR:-$HOME/.dshWorkspace/dsh-mongo}"
DATA_DIR="$RS_DIR/data"
LOG_FILE="$RS_DIR/mongod.log"
PID_FILE="$RS_DIR/mongod.pid"
PORT="${DSH_MONGO_PORT:-27018}"
RS_NAME="dsh-rs"
MONGOD="${MONGOD_BIN:-/usr/local/bin/mongod}"

running() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

rs_state() {
  # ⚠️ eval 串用 shell 单引号定界——JS 内部字符串一律双引号，否则引号冲突
  # 把传给 mongosh 的代码截成碎句（stderr 被 2>/dev/null 吞后表现为空输出）
  mongosh --quiet --port "$PORT" --eval '
    try { const s = rs.status(); print(s.myState === 1 ? "PRIMARY" : s.myState); }
    catch (e) { print(e.codeName === "NotYetInitialized" || /not yet initialized/.test(String(e.message)) ? "NEED_INIT" : "NO_RS:" + e.codeName); }
  ' 2>/dev/null | tail -1
}

wait_primary() {
  for _ in $(seq 1 40); do
    st="$(rs_state || true)"
    [ "$st" = "PRIMARY" ] && return 0
    sleep 0.5
  done
  echo "!! 20s 内未等到 PRIMARY（最后状态：${st:-?}）" >&2
  return 1
}

cmd_start() {
  if running; then
    echo "✓ mongod 已在 $PORT 运行（脚本不重复起、不扰动）"
    return 0
  fi
  [ -x "$MONGOD" ] || { echo "!! 找不到 mongod：${MONGOD}（用 MONGOD_BIN= 指定）" >&2; exit 1; }
  mkdir -p "$DATA_DIR" "$RS_DIR"
  "$MONGOD" --replSet "$RS_NAME" --port "$PORT" --dbpath "$DATA_DIR" \
    --logpath "$LOG_FILE" --pidfilepath "$PID_FILE" --bind_ip 127.0.0.1 --fork >/dev/null
  # 等端口真就绪再探状态（--fork 返回≠立刻可连接；过早探测得空值会误判异常）
  for _ in $(seq 1 30); do running && break; sleep 0.5; done
  echo "mongod 已拉起（port=$PORT rs=$RS_NAME dbpath=${DATA_DIR}）"
  st="$(rs_state || true)"
  [ -z "$st" ] && { sleep 1; st="$(rs_state || true)"; } # 空值再重试一次
  case "$st" in
    PRIMARY) echo "✓ 拓扑保留（dbpath 复用），直接 PRIMARY" ;;
    NEED_INIT)
      echo "空实例首起 → rs.initiate（单成员）…"
      mongosh --quiet --port "$PORT" --eval \
        "rs.initiate({_id:'$RS_NAME',members:[{_id:0,host:'127.0.0.1:$PORT'}]})" >/dev/null
      wait_primary && echo "✓ PRIMARY 就绪"
      ;;
    *)
      echo "!! 异常状态：${st:-无法探测}（查 ${LOG_FILE}）；回收本次拉起的进程不留残留" >&2
      cmd_stop || true
      return 1
      ;;
  esac
}

cmd_stop() {
  if ! running; then echo "（$PORT 本就没在跑，无事可做）"; return 0; fi
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")"
  else
    kill "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | tail -1 | awk '{print $2}')"
  fi
  for _ in $(seq 1 20); do running || break; sleep 0.5; done
  running && { echo "!! SIGTERM 10s 未退出，请查日志" >&2; return 1; } || true
  rm -f "$PID_FILE"
  echo "✓ 已优雅停止"
}

cmd_status() {
  if ! running; then echo "✗ $PORT 无监听（未运行）"; return 1; fi
  echo "✓ 监听中：$PORT"
  mongosh --quiet --port "$PORT" --eval '
    const s = rs.status();
    print("副本集角色: " + (s.myState === 1 ? "PRIMARY" : "state " + s.myState) + " | 成员: " + s.members.length);
    const dbs = db.adminCommand({listDatabases:1}).databases.filter(d => !["admin","config","local"].includes(d.name));
    print("业务库: " + (dbs.length ? dbs.map(d => d.name).join(", ") : "（空）"));
  ' 2>/dev/null
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  restart) cmd_stop || true; sleep 1; cmd_start ;;
  *) echo "用法: $0 start|stop|status|restart" >&2; exit 2 ;;
esac
