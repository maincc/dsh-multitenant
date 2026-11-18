#!/usr/bin/env bash
# ============================================================================
#  唯一备份入口（2026-11-14 合并版：原 deploy/backup.sh + scripts/mongo-backup.sh）
#
#  产物是一个【迁移可用】的传输包：bundle-<时间戳>.tgz（0600，目录 0700），
#  解包即七件套——库快照/入口状态/签发根/工作区快照/活容器工作区/卷/镜像清单，
#  附 RESTORE.md 恢复指引。scp 到新机按单逆向执行就是整套迁移。
#
#  用法：
#    ./deploy/backup.sh              全量 bundle（卷默认带上；SKIP_VOLUMES=1 跳过）
#    ./deploy/backup.sh verify       恢复演练：最新 bundle 的库快照 → 影子库逐集合对账
#                                    （mongorestore 只进 dsh_prod_verify，永不动生产）
#    ./deploy/backup.sh list         列出现有 bundle
#
#  环境变量：
#    BACKUP_DIR   产物目录（默认=项目根，bundle 落当前文件夹；cron 长期保留
#                 可指独立盘位。不可写会明确报错而非偷偷 sudo）
#    DSH_MONGO_URI 覆盖库连接（默认读 config.json 的 storage.mongodbUri——唯一真源）
#    KEEP         bundle 保留份数（默认 7）
#    SKIP_VOLUMES=1   跳过租户卷（日常 cron 省磁盘）
#    IMAGE_SAVE=1     把镜像清单里的 tag 逐个 docker save 进包（迁移新机离线导入用）
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

# 默认产物落【项目根】（2026-11-14 用户要求：备份文件在当前文件夹）；
# BACKUP_DIR= 可指到独立盘位（cron 长期保留建议如此，防 rsync 重装误删）。
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR}"
KEEP="${KEEP:-7}"
TS="$(date +%Y%m%d-%H%M%S)"

# 库 URI：config.json 是权威（装完机就不用再同步 env），env 仅应急覆盖
URI="${DSH_MONGO_URI:-}"
if [ -z "$URI" ]; then
  URI="$(node -e "import('./src/config/config.js').then(m=>process.stdout.write(m.CONFIG.storage?.mongodbUri||''))" 2>/dev/null || true)"
fi
[ -n "$URI" ] || URI="mongodb://127.0.0.1:27018/dsh_prod?replicaSet=dsh-rs"

SRC_DB="dsh_prod"
SHADOW_DB="dsh_prod_verify"
HOST_URI="$(echo "$URI" | sed -E 's#^((mongodb(\+srv)?://[^/]+)).*#\1/#')"
MONGO_PORT="$(echo "$URI" | sed -E 's#.*://[^:/]+:([0-9]+).*#\1#')"

MONGO_CLI=""
for c in mongosh mongo; do command -v "$c" >/dev/null 2>&1 && { MONGO_CLI="$c"; break; }; done

latest_bundle() { ls -1t "$BACKUP_DIR"/bundle-*.tgz 2>/dev/null | head -1; }

ensure_dirs() {
  if ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
    echo "!! BACKUP_DIR 不可写：${BACKUP_DIR}（sudo $0 ${1:-backup}，或 BACKUP_DIR=/tmp/... $0 ${1:-backup}）" >&2
    exit 1
  fi
  # 仅独立备份目录才收权 700；默认=项目根时【不动其权限】（chmod 项目根会
  # 破 RUN_USER 部署的服务可读性）——bundle 文件自身 0600 是机密底线。
  if [ "$BACKUP_DIR" != "$ROOT_DIR" ]; then
    chmod 700 "$BACKUP_DIR" 2>/dev/null || true
  fi
}

do_backup() {
  command -v mongodump >/dev/null 2>&1 || { echo "!! 缺 mongodump（装 mongodb-database-tools 或 docker run mongo:7 mongodump）" >&2; exit 1; }
  ensure_dirs
  local work bundle
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  bundle="$work/bundle-$TS"
  mkdir -p "$bundle"/{mongo,entry,keys,snapshots,workspace-live,volumes,images}

  echo ">> [1/7] 库快照（副本集快照读，平台在线可跑）..."
  mongodump --uri="$URI" --out="$bundle/mongo" >/dev/null 2>&1 || {
    echo "!! mongodump 失败（库不可达？uri=${URI}）" >&2; exit 1; }
  echo "   $(du -sh "$bundle/mongo" | awk '{print $1}')"

  echo ">> [2/7] 入口状态（config/state/patches/data 轻件；keys 与大件单列）..."
  tar --ignore-failed-read -czf "$bundle/entry/entry.tgz" \
    --exclude='data/keys' --exclude='data/backups' --exclude='data/npm-cache' \
    --exclude='data/workspace-snapshots' \
    config.json state.json patches data 2>/dev/null || true
  # 逐层校验必备件（config.json 缺=打包姿势错了，宁醒不眠）
  [ -f config.json ] || echo "   ⚠ config.json 不在项目根？entry 包可能空壳" >&2

  echo ">> [3/7] 签发根（独立 600 tar，与 entry 分袋——keys 只进不出，别混进日常件）..."
  tar --ignore-failed-read -czf "$bundle/keys/keys.tgz" data/keys data/legacy-cwt.json 2>/dev/null || true
  chmod 600 "$bundle/keys/keys.tgz" 2>/dev/null || true

  echo ">> [4/7] 工作区归档槽（data/workspace-snapshots，平台重建容器时自动合回）..."
  tar --ignore-failed-read -czf "$bundle/snapshots/ws-snapshots.tgz" data/workspace-snapshots 2>/dev/null || true

  echo ">> [5/7] 活容器 /root/workspace 现值（快照槽只在销毁时产生，这里抓差值）..."
  local n addr done_ct=0
  while read -r n; do
    [ -n "$n" ] || continue
    addr="${n#dsh-swtc-}"
    if docker cp "$n:/root/workspace" - >"$bundle/workspace-live/ws-$addr.tar" 2>/dev/null; then
      done_ct=$((done_ct + 1))
    else
      rm -f "$bundle/workspace-live/ws-$addr.tar"
      echo "   （${addr}：无 /root/workspace 或容器不可读，跳过）"
    fi
  done < <(docker ps -a --format '{{.Names}}' 2>/dev/null | grep '^dsh-swtc-' || true)
  echo "   导出 $done_ct 个工作区"

  if [ "${SKIP_VOLUMES:-0}" = "1" ]; then
    echo ">> [6/7] 租户卷：SKIP_VOLUMES=1 已跳过"
    rmdir "$bundle/volumes" 2>/dev/null || true
  else
    echo ">> [6/7] 租户卷（/dsh-home 持久层；单卷失败不拦整体）..."
    for v in $(docker volume ls -q --filter name=dsh-data-swtc- 2>/dev/null); do
      echo "   $v"
      docker run --rm -v "$v:/dsh-home" -v "$bundle/volumes:/backup" \
        alpine tar czf "/backup/vol-${v#dsh-data-swtc-}.tgz" -C /dsh-home . \
        || echo "   ⚠ 卷 $v 导出失败（继续，其余照包）" >&2
    done
  fi

  echo ">> [7/7] 镜像清单（pinnedImage 钉过的 tag 若新机没有，重建会失败）..."
  {
    echo "# docker ps -a 引用的镜像 tag"
    docker ps -a --format '{{.Image}}' 2>/dev/null | sort -u
    if [ -n "$MONGO_CLI" ]; then
      echo "# 库内 pinnedImage（钉版本租户）"
      "$MONGO_CLI" --quiet "$URI" --eval \
        'db.users.find({pinnedImage:{$ne:null}},{_id:1,pinnedImage:1}).toArray().forEach(u=>print(u._id+" -> "+u.pinnedImage))' 2>/dev/null \
        || echo "（查询失败）"
    else
      echo "（无 mongosh/mongo CLI，pinnedImage 未盘）"
    fi
  } >"$bundle/images/manifest.txt"
  if [ "${IMAGE_SAVE:-0}" = "1" ]; then
    grep -v '^#' "$bundle/images/manifest.txt" | grep '^dsh-multitenant' | sort -u | while read -r tag; do
      echo "   docker save $tag"
      docker save -o "$bundle/images/$(echo "$tag" | tr ':/' '__').tar" "$tag" || echo "   ⚠ save 失败：$tag" >&2
    done
  else
    echo "   （只出清单；离线新机加 IMAGE_SAVE=1 重跑）"
  fi

  cat >"$bundle/RESTORE.md" <<EOF
# 恢复指引（bundle-${TS}）

前置：新机已放代码/镜像与 node；docker daemon、mongo（单成员副本集 dsh-rs，
事务硬要求）就绪。以下在新机【项目根】执行。

\`\`\`bash
tar xzf bundle-$TS.tgz && cd bundle-$TS

# 1. 库（--drop 覆盖同名库；影子演练见 deploy/backup.sh verify）
mongorestore --uri="$HOST_URI" --drop --dir mongo

# 2. 入口状态 + 签发根（keys 属主给运行用户、600；属主错=签发拒启）
tar xzf entry/entry.tgz
tar xzf keys/keys.tgz && chown -R "\$(id -un)" data/keys && chmod 600 data/keys/issuer.key

# 3. 工作区归档槽（平台重建容器后自动合回 /root/workspace）
tar xzf snapshots/ws-snapshots.tgz

# 4. 卷（逐卷建同名 volume 灌回；名字取自文件名 vol-<地址>.tgz）
for f in volumes/vol-*.tgz; do
  [ -e "\$f" ] || continue
  v="dsh-data-swtc-\$(basename "\$f" .tgz | sed 's/^vol-//')"
  docker volume create "\$v"
  docker run --rm -v "\$v:/dsh-home" -v "\$PWD:/bk" alpine tar xzf "/bk/\$f" -C /dsh-home
done

# 5. 活容器工作区现值：新平台首启会自动建容器并合第 3 步的归档槽；
#    workspace-live/ 里的 tar 仅当【容器从未被平台归档过】时人工救急用——
#    正常迁移以 snapshots 槽为准，两者同名以 ws-<addr>.tar 覆盖进
#    data/workspace-snapshots/ 即可（active 槽文件名规则 ws-<address>.tar）。

# 6. 镜像：对照 images/manifest.txt，tag 缺失则 docker load -i images/*.tar
#    或按版本号重新 build。

# 7. 改 config.json 的部署面：server.publicHost（新机地址/域名）、docker 端口段
#    （新机混段：basePort/maxPort=对外段，internalBasePort/internalMaxPort=配对
#    回环段，跨度相等）。其余库/密钥件不动。

# 8. 起服务 → 验证：
systemctl start dsh-multitenant
curl -s localhost:8090/health
curl -s localhost:8090/api/admin/gateway-ports | head -c 300
# 用户点"连接"：旧端口段越界自动弃号换段（无需洗账），容器降级重建、卷与
# 工作区合回——登录态（sessions）随库迁移直接续用。
EOF

  local out="$BACKUP_DIR/bundle-$TS.tgz"
  tar czf "$out" -C "$work" "bundle-$TS"
  chmod 600 "$out"
  echo "✓ bundle：${out}（$(du -sh "$out" | awk '{print $1}')）"

  ls -1t "$BACKUP_DIR"/bundle-*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" && echo "（过期 bundle 已删：${old}）"
  done
}

do_verify() {
  command -v mongorestore >/dev/null 2>&1 || { echo "!! 缺 mongorestore" >&2; exit 1; }
  [ -n "$MONGO_CLI" ] || { echo "!! 缺 mongosh/mongo CLI，无法对账" >&2; exit 1; }
  local snap; snap="$(latest_bundle)"
  [ -n "$snap" ] || { echo "!! 无 bundle 可演练（先跑一次备份）" >&2; return 1; }
  echo "演练源：$snap"
  ensure_dirs
  local work; work="$(mktemp -d)"; trap 'rm -rf "$work"' RETURN
  tar xzf "$snap" -C "$work"
  local bundle; bundle="$(ls -d "$work"/bundle-*)"
  # ⚠ 必须喂 dump【根目录】而非 $bundle/mongo/dsh_prod：指库子目录时
  # --nsFrom/--nsTo 整体失效（实测全量 skipping，mongo-backup.sh 判例原样保留）
  mongorestore --uri="$HOST_URI" --drop --nsFrom="$SRC_DB.*" --nsTo="$SHADOW_DB.*" --quiet --dir="$bundle/mongo"
  "$MONGO_CLI" --quiet --port "$MONGO_PORT" --eval '
    const d = db.getSiblingDB("dsh_prod"), v = db.getSiblingDB("dsh_prod_verify");
    const names = d.getCollectionNames().filter(n => !n.startsWith("system."));
    // 在线对账：快照之后生产库只可能变少（sessions 懒清理、audit 有 TTL）——
    // 这两个集合允许 还原>=生产；其余要求精确相等。
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

do_list() {
  ls -1t "$BACKUP_DIR"/bundle-*.tgz 2>/dev/null | head -"$KEEP" || echo "（暂无 bundle）"
}

case "${1:-backup}" in
  backup) do_backup ;;
  verify) do_verify ;;
  list)   do_list ;;
  *) echo "用法: $0 [backup|verify|list]（选项见文件头）" >&2; exit 2 ;;
esac
