#!/usr/bin/env node
/**
 * JSON 文件 → 本地 MongoDB 迁移【预览】脚本（2026-10-10）
 *
 * 定位：storage-design §6 迁移器的手工演练——
 *   - 源【只读】：state.json / data/** 一行都不改，不删不移；
 *   - 服务端代码零改动；目标只写专属库（库名白名单 dsh*），绝不碰实例上其他库；
 *   - 目标库非空时必须 --fresh 显式授权 drop，防误伤；
 *   - --dry-run 只出报告不写库。
 *
 * 映射按 docs/storage-design.md §4 的 12 集合 schema。
 * 事务不适用本脚本（副本集才有；一次性导入无并发读者，standalone 可跑）。
 *
 * 用法：
 *   node scripts/migrate-to-mongo.mjs [--uri mongodb://127.0.0.1:27017] [--db dsh] [--dry-run] [--fresh]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Node 18 兼容：全局 crypto 在 18.x 未默认导出，mongodb 驱动调用时
// ReferenceError（本机 nvm 默认 18.20.8 实测踩中；20+/24 无此问题）。
// 驱动必须【动态导入】——确保补齐生效后才加载。
if (!globalThis.crypto) {
  const { webcrypto } = await import('node:crypto')
  globalThis.crypto = webcrypto
}
const { MongoClient } = await import('mongodb')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt
}
const URI = argVal('--uri', 'mongodb://127.0.0.1:27017')
const DB = argVal('--db', 'dsh')
const DRY = args.includes('--dry-run')
const FRESH = args.includes('--fresh')

// —— 护栏：只允许写"我们的"库，防止手滑 drop 别人的数据库
if (!/^dsh(_[a-z0-9]+)*$/.test(DB)) {
  console.error(`!! 拒绝：目标库名 "${DB}" 不在白名单（dsh / dsh_xxx）——本脚本只服务迁移预览`)
  process.exit(1)
}

const readJson = (rel) => {
  const p = join(ROOT, rel)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`!! 源文件解析失败 ${rel}: ${e.message}`)
    process.exit(1)
  }
}
const readNdjson = (rel) => {
  const p = join(ROOT, rel)
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

// —— 源数据
const state = readJson('state.json') ?? {}
const sessions = readJson('data/config/sessions.json') ?? {}
const userSessions = readJson('data/config/user-sessions.json') ?? {}
const adminCfg = readJson('data/config/admin.json') ?? { addresses: [], history: [] }
const cwtRegistry = readJson('data/cwt/registry.json') ?? {}
const cwtApplications = readJson('data/cwt/applications.json') ?? []
const cwtRecords = readNdjson('data/cwt/records.log')
const opsLog = readNdjson('data/logs/operations.log')
const skillsIndex = readJson('data/skills/index.json') ?? { entries: [] }
const installs = readJson('data/installs.json') ?? {}
const dshImage = readJson('data/dsh-image.json') ?? { current: null, history: [] }

// —— 12 集合构建（schema 见 storage-design §4.1）
const users = Object.entries(state.swtcUsers ?? {}).map(([addr, u]) => {
  const reg = cwtRegistry[addr]
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
    pinnedImage: u.pinnedImage ?? null,
    // 反范式冗余（审批事务里同步维护）：豁免判定热字段
    cwtVerifiedAt: reg && reg.status === 'approved' ? (reg.approvedAt ?? null) : null,
    profile: readJson(`data/users/${addr}.json`) ?? null, // 本机可能整个目录都没有
  }
})

const meta = [
  { _id: 'ports', nextPort: state.nextPort ?? 31000, availablePorts: state.availablePorts ?? [] },
  { _id: 'cleanup', ...(state.cleanupPolicy ?? {}) },
  { _id: 'admin', ...adminCfg },
  { _id: 'dsh_image', current: dshImage.current ?? null, history: dshImage.history ?? [] },
] // schema 文档在写入阶段最后生成（含本次迁移统计）

// 【9 集合方案】admin_sessions 与 user_sessions 同构合并（scope 区分）
// ⚠️ expiresAt/at 一律转 BSON Date：TTL 监控器只认 Date（number 静默不回收，
// 本机 70s 探针实证）；与 src/services/migration.js 的真迁移器保持一致。
const toDate = (ms) => new Date(Number(ms) || 0)
const sessDocs = [
  ...Object.entries(sessions).map(([hash, v]) => ({ ...v, _id: hash, scope: 'admin', expiresAt: toDate(v.expiresAt) })),
  ...Object.entries(userSessions).map(([hash, v]) => ({ ...v, _id: hash, scope: 'user', expiresAt: toDate(v.expiresAt) })),
]
// 审计两流合一：时间统一 at（Date，ttl_90d 生效前提），kind 区分（字段原样保留）
const auditDocs = [
  ...cwtRecords.map((r) => ({ ...r, kind: 'cwt', at: toDate(r.at) })),
  ...opsLog.map((r) => ({
    ...r,
    kind: 'ops',
    at: toDate(r.timestamp),
    action: r.operation ?? null,
  })),
]

const cwtRegistryDocs = Object.entries(cwtRegistry).map(([addr, v]) => ({ _id: addr, ...v }))
const cwtAppsDocs = cwtApplications.map(({ id, ...rest }) => ({ _id: id, ...rest }))
const usageDocs = Object.entries(state.usages ?? {}).map(([address, u]) => ({
  _id: { address, date: u.date ?? null },
  minutes: u.minutes ?? 0,
}))
const skillsDocs = (skillsIndex.entries ?? []).map((e) => ({
  _id: e.name ?? e.id,
  ...e,
}))
const installsDocs = Object.entries(installs).map(([address, list]) => ({
  _id: address,
  skills: list,
}))

const plan = {
  users,
  meta,
  sessions: sessDocs,
  cwt_registry: cwtRegistryDocs,
  cwt_applications: cwtAppsDocs,
  audit: auditDocs,
  usage: usageDocs,
  skills: skillsDocs,
  skill_installs: installsDocs,
}

// 索引（设计 §4；ops_log TTL 因保留策略未拍板【裁决点1】暂不建，仅建排序索引）
const indexSpecs = {
  sessions: [
    { key: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 0 },
    { key: { scope: 1, address: 1 }, name: 'by_scope_addr' },
  ],
  cwt_applications: [
    { key: { status: 1 }, name: 'by_status' },
    { key: { 'parsed.address': 1 }, name: 'by_address' },
  ],
  audit: [
    { key: { at: -1 }, name: 'by_time' },
    { key: { kind: 1, address: 1, at: -1 }, name: 'by_kind_addr_time' },
  ],
  users: [{ key: { containerStatus: 1 }, name: 'by_status' }],
}

console.log(`源目录: ${ROOT}`)
console.log(`目标:   ${URI} / db=${DB} ${DRY ? '[DRY-RUN 不写库]' : ''}`)
console.log('—— 集合行数 ——')
let total = 0
for (const [name, docs] of Object.entries(plan)) {
  console.log(`  ${name.padEnd(16)} ${docs.length}`)
  total += docs.length
}
console.log(`  ${'合计'.padEnd(14)} ${total}`)

if (DRY) {
  console.log('dry-run 结束，未连接数据库。')
  process.exit(0)
}

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 })
try {
  await client.connect()
  const db = client.db(DB)
  const existing = await db.listCollections().toArray()
  if (existing.length && !FRESH) {
    console.error(
      `!! 目标库 "${DB}" 已存在 ${existing.length} 个集合。确认覆盖请加 --fresh（仅允许 drop ${DB}）`,
    )
    process.exit(1)
  }
  if (existing.length) {
    console.log(`>> 覆盖模式：drop ${DB} 现有 ${existing.length} 个集合`)
    await db.dropDatabase()
  }
  for (const [name, docs] of Object.entries(plan)) {
    if (docs.length) await db.collection(name).insertMany(docs)
    for (const spec of indexSpecs[name] ?? []) await db.collection(name).createIndex(spec.key, spec)
  }
  await db.collection('meta').insertOne({
    _id: 'schema',
    version: 1,
    migratedAt: Date.now(),
    migratedBy: 'scripts/migrate-to-mongo.mjs',
    sourceStats: Object.fromEntries(
      Object.entries(plan)
        .map(([k, v]) => [k, v.length])
        .filter(([, n]) => n > 0),
    ),
  })
  console.log(`>> 写入完成：db=${DB}，schema_version=1（preview 标记见 meta.schema）`)
  console.log(
    '>> 抽查：',
    JSON.stringify(
      (await db.collection('users').findOne({ _id: users[0]?._id ?? 'x' })) ?? {},
    ).slice(0, 200),
  )
} catch (e) {
  console.error('!! 迁移失败：', e.message)
  process.exit(1)
} finally {
  await client.close()
}
