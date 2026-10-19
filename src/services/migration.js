/**
 * JSON → 9 集合迁移纯逻辑（M1，docs/storage-design.md §6）
 *
 * 本模块【不起连接、不写库】——只负责三件事：
 *   1. readSources：读源文件快照（state.json 在仓库根！data/** 只读）
 *   2. buildCollections：源 → 9 集合文档数组（形状合同）
 *   3. expectedCounts：逐域应有行数（供写侧事务内校验）
 * 事务、校验执行、meta.schema 落库在 mongo.store.js runMigration()。
 *
 * ⚠️ 形状合同：迁移写侧与 M2 服务层读侧【共用本文件】——迁进去什么形状、
 * 读出来就是什么形状，杜绝"两边各写一份 transform 漂移"。改形状先改这里
 * 并跑 test/migration.test.js A 组。
 *
 * 形状沿革：移植自 scripts/migrate-to-mongo.mjs（本机 124 条实测全对），
 * 升级点：audit 的 ops 记录拉平 actor（P6）；userData 注入不再读文件时顺手读。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)))

function readJsonAt(root, rel) {
  const p = join(root, rel)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (err) {
    throw new Error(`迁移源文件解析失败 ${rel}: ${err.message}`)
  }
}

function readNdjsonAt(root, rel) {
  const p = join(root, rel)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** 空态源快照（缺文件按空处理——迁移器对"新机器空盘"要无事可做） */
export function emptySources() {
  return {
    state: {},
    sessions: {},
    userSessions: {},
    admin: { addresses: [], history: [] },
    opsLog: [],
    skillsIndex: { entries: [] },
    installs: {},
    dshImage: { current: null, history: [] },
    userData: {},
  }
}

/**
 * 读全部迁移源（只读，绝不写回）。userData 按 swtcUsers 的地址清单逐个探测
 * data/users/<addr>.json（大多数机器该目录为空——缺失=null，不报错）。
 */
export function readSources(root = DEFAULT_ROOT) {
  const s = emptySources()
  s.state = readJsonAt(root, 'state.json') ?? {}
  s.sessions = readJsonAt(root, 'data/config/sessions.json') ?? {}
  s.userSessions = readJsonAt(root, 'data/config/user-sessions.json') ?? {}
  s.admin = readJsonAt(root, 'data/config/admin.json') ?? s.admin
  s.opsLog = readNdjsonAt(root, 'data/logs/operations.log')
  s.skillsIndex = readJsonAt(root, 'data/skills/index.json') ?? { entries: [] }
  s.installs = readJsonAt(root, 'data/installs.json') ?? {}
  s.dshImage = readJsonAt(root, 'data/dsh-image.json') ?? { current: null, history: [] }
  for (const addr of Object.keys(s.state.swtcUsers ?? {})) {
    s.userData[addr] = readJsonAt(root, `data/users/${addr}.json`)
  }
  return s
}

/**
 * 源快照 → 9 集合文档数组。key 顺序即合同清单（mongo.store 遍历插入与校验）。
 * 不含 meta.schema——迁移状态文档由 runMigration 在校验通过后同事务写入。
 */
export function buildCollections(s) {
  const users = Object.entries(s.state.swtcUsers ?? {}).map(([addr, u]) => {
    return {
      _id: addr,
      port: u.port ?? null,
      internalPort: u.internalPort ?? null,
      tier: u.tier ?? null,
      createdAt: u.createdAt ?? null,
      lastSeenAt: u.lastSeenAt ?? null,
      containerStatus: u.containerStatus ?? 'destroyed',
      baseImageVersion: u.baseImageVersion ?? null,
      imageId: u.imageId ?? null,
      requiresToken: u.requiresToken ?? null,
      lastDshVersion: u.lastDshVersion ?? null,
      versionChangedAt: u.versionChangedAt ?? null,
      usageStartedAt: u.usageStartedAt ?? null,
      pinnedImage: u.pinnedImage ?? null,
      profile: s.userData[addr] ?? null,
    }
  })

  const meta = [
    {
      _id: 'ports',
      nextPort: s.state.nextPort ?? null,
      availablePorts: s.state.availablePorts ?? [],
    },
    { _id: 'cleanup', ...(s.state.cleanupPolicy ?? {}) },
    {
      _id: 'admin',
      addresses: s.admin.addresses ?? [],
      history: s.admin.history ?? [],
      updatedAt: s.admin.updatedAt ?? null,
    },
    { _id: 'dsh_image', current: s.dshImage.current ?? null, history: s.dshImage.history ?? [] },
  ]

  // 双会话文件合并（scope 区分；_id 为现成 sha256(token) hex，不迁明文凭据）
  // ⚠️ expiresAt 转 BSON Date：TTL 监控器【只认 Date】（毫秒 number 会被静默
  // 无视、过期行永久堆积——本机 70s 探针实证），水合侧统一 Number() 归一。
  const toDate = (ms) => new Date(Number(ms) || 0)
  const sessions = [
    ...Object.entries(s.sessions).map(([hash, v]) => ({
      ...v,
      _id: hash,
      scope: 'admin',
      expiresAt: toDate(v.expiresAt),
    })),
    ...Object.entries(s.userSessions).map(([hash, v]) => ({
      ...v,
      _id: hash,
      scope: 'user',
      expiresAt: toDate(v.expiresAt),
    })),
  ]

  // 双日志合并：时间统一 at（同为 TTL 字段——ttl_90d 索引只认 Date，P4 的
  // "90 天自动清"要求它必须是 Date）；ops 的 details.address 拉平为 actor（P6）
  const audit = [
    ...(s.opsLog ?? []).map((r) => ({
      ...r,
      kind: 'ops',
      at: toDate(r.timestamp),
      action: r.operation ?? null,
      actor: r.details?.address ?? null,
    })),
  ]

  // usage 独立集合（R3/P5：日粒度历史，_id 复合键天然防同日重复）
  const usage = Object.entries(s.state.usages ?? {}).map(([address, u]) => ({
    _id: { address, date: u.date ?? null },
    minutes: u.minutes ?? 0,
  }))

  const skills = (s.skillsIndex.entries ?? []).map((e) => ({ _id: e.name ?? e.id ?? null, ...e }))
  const skill_installs = Object.entries(s.installs ?? {}).map(([address, list]) => ({
    _id: address,
    skills: list,
  }))

  return {
    users,
    meta,
    sessions,
    audit,
    usage,
    skills,
    skill_installs,
  }
}

/** 逐域应有行数（runMigration 在事务内以此为校验基线） */
export function expectedCounts(collections) {
  return Object.fromEntries(Object.entries(collections).map(([name, docs]) => [name, docs.length]))
}
