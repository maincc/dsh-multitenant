/**
 * vitest globalSetup：为真库测试群保证有一个【可用副本集】
 * （storage-design §8 M3：mongo 测试不依赖"人肉起 27018"）。
 *
 * 策略（按优先级）：
 *   1. 专用副本集 27018（dsh-rs）活着 → 直接复用，teardown 绝不碰它
 *   2. 否则找 mongod 二进制 → 临时副本集（随机端口 + tmp dbpath +
 *      单成员 initiate + 等上 PRIMARY），teardown 杀掉并删数据目录
 *   3. 都没有 → 导出死地址占位，各文件既有的优雅跳过（available=false）兜底
 *
 * 各测试文件通过 process.env.DSH_TEST_MONGO（基 URI，含 replicaSet 参数）
 * 拼自己的隔离库（dsh_m1_test / dsh_m22_test / …），互不串库。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'

const LIVE_RS = 'mongodb://127.0.0.1:27018/?replicaSet=dsh-rs'
const MONGOD_CANDIDATES = ['/usr/local/bin/mongod', '/opt/homebrew/bin/mongod', '/usr/bin/mongod']

async function probe(uri) {
  const c = new MongoClient(uri, { serverSelectionTimeoutMS: 800 })
  try {
    await c.connect()
    await c.db('admin').command({ ping: 1 })
    return true
  } catch {
    return false
  } finally {
    await c.close().catch(() => {})
  }
}

async function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(p, '127.0.0.1')
  })
}

async function findPort() {
  for (let p = 27019; p <= 27029; p++) {
    if (await portFree(p)) return p
  }
  return null
}

export async function setup() {
  // vitest 1.6：globalSetup 的 {env} 返回值【不会】注入 worker（2.x 才有），
  // 但 setup 在 worker fork 前于主进程执行——直接写主进程 env 即被子进程继承。
  process.env.DSH_TEST_MONGO = LIVE_RS
  // ── 测试存储护盾 ──
  // env 是 config.js 三级优先里的最高层：在 worker 继承前钉死"json + 无库名
  // 基 URI"，仓库 config.json 从此可以写 provider=mongodb（本地平台启动
  // 免 env）而不把几百个按文件形态断言的用例带偏（2026-10-13 实证：不设护
  // 盾时 config 写 mongodb 直接爆 15 用例）。真库用例各自 new MongoStore
  // 显式传库名（dsh_test 系），与本盾互不干扰、永不写 dsh_prod。
  process.env.DSH_STORAGE_PROVIDER = 'json'
  process.env.MONGODB_URI = LIVE_RS
  // 1) 复用人工起的专用实例（本会话反复使用的那台；绝不回收）
  if (await probe(LIVE_RS)) {
    return
  }

  // 2) 自起临时副本集
  const bin = MONGOD_CANDIDATES.find((p) => existsSync(p))
  if (!bin) {
    process.env.VITEST_MONGO_NOTE = 'no mongod binary — mongo 真库用例将优雅跳过'
    process.env.DSH_TEST_MONGO = 'mongodb://127.0.0.1:1/?replicaSet=none'
    return
  }
  const port = await findPort()
  if (!port) return { env: { DSH_TEST_MONGO: 'mongodb://127.0.0.1:1/?replicaSet=none' } }
  const dbpath = mkdtempSync(join(tmpdir(), 'dsh-mongo-test-'))

  const proc = spawn(bin, ['--replSet', 'dsh-test-rs', '--port', String(port), '--dbpath', dbpath, '--bind_ip', '127.0.0.1'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  // 记下句柄供 teardown 回收（vitest 的 globalSetup 只在主进程跑一次，模块级足够）
  spawned = { proc, dbpath, port }
  let stderrTail = ''
  proc.stderr.on('data', (b) => {
    stderrTail = (stderrTail + b.toString()).slice(-2000)
  })

  const rsUri = `mongodb://127.0.0.1:${port}/?replicaSet=dsh-test-rs`
  try {
    // initiate（direct 连法，副本集未成形时唯一通路）
    const direct = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 15000 })
    await direct.connect()
    await direct.db('admin').command({ replSetInitiate: { _id: 'dsh-test-rs', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } })
    await direct.close()

    // 等 PRIMARY 可选（新实例选举完成）
    const deadline = Date.now() + 20000
    let up = false
    while (!up && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400))
      up = await probe(rsUri)
    }
    if (!up) throw new Error(`临时副本集未在 20s 内选出 PRIMARY。stderr 尾部：${stderrTail}`)
    process.env.DSH_TEST_MONGO = rsUri
    return
  } catch (err) {
    proc.kill('SIGKILL')
    try {
      rmSync(dbpath, { recursive: true, force: true })
    } catch {}
    process.env.VITEST_MONGO_NOTE = `临时 mongod 启动失败（优雅跳过）：${err.message}`
    process.env.DSH_TEST_MONGO = 'mongodb://127.0.0.1:1/?replicaSet=none'
    return
  }
}

let spawned = null

export async function teardown() {
  // 只回收【自己起的】临时实例；复用的 27018 永不触碰
  if (!spawned) return
  const { proc, dbpath } = spawned
  spawned = null
  proc.kill('SIGKILL')
  await new Promise((r) => {
    proc.once('exit', r)
    setTimeout(r, 3000)
  }).catch(() => {})
  try {
    rmSync(dbpath, { recursive: true, force: true })
  } catch {}
}
