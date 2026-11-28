/**
 * env-bundle.service — 随行包编排（PR2 管线核心）
 *
 * 职责：把"作者勾选"变成磁盘上的实物与接收者卷里的文件——
 *   inventory/browse：挂源卷只读 helper 探明可带内容（DENY 隐身）
 *   exportBundle：    白名单 items → helper 卷只读+宿主输出目录 → tar+manifest+scan
 *   installBundle：   账本 expected 与宿主 bundle 逐字对（防换包）→ 挂接收者卷 rw 装入
 *   removeBundle：    reject/revoke-GC 的即弃面
 *
 * 通道复用 runVolumeScript（技能安装同款肌肉：IMAGE 容器 + 挂卷 + 只读脚本），
 * 新开的三面 opts（只读卷/宿主目录挂入/断网限额）都已在 docker.service 落好。
 * 纪律：
 *  - **前端灰显不是防线**：export/install 两侧各自硬验白名单根 + DENY 段
 *  - **数据流向诚实**：卷里只有 skills/plugins 前缀可读可写；credentials/
 *    sessions/settings 等连 inventory 都不出现（名字就是情报）
 *  - **完整性**：装包前宿主 bundle 文件与账本 sha256 全比对——账本才是权威
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dockerService } from './docker.service.js'

import { dataService } from './data.service.js'
import { normalizeAddress, swtcVolumeName } from '../utils/address.js'
import { scanBundle } from '../utils/env-scan.js'

// 判例（2026-10 本地真机首测）：曾写 join(ROOT,'src','services') 而 dirname 链
// 到头就是 src/ —— 拼出 src/src/services，挂载文件不存在，inventory 全 500。
// 测试链 mock 了 docker 通道永远抓不到路径拼接错——helper 脚本与本模块同目录，
// 直接取自身所在目录，零二次拼接。
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')

export class EnvBundleService {
  /**
   * 数据根在使用时解析而非构造期：模块图加载（import 链）零副作用——
   * 部分 mock dataService 的测试面里，构造期读 dataDir 会让所有间接
   * 引到本服务的入口在加载瞬间炸（admin-users-cache 实证）。
   */
  get baseDir() {
    if (!dataService.dataDir) throw new Error('env-bundle：dataService.dataDir 不可用')
    return join(dataService.dataDir, 'env-bundles')
  }

  /** 模板 id（=image tag）→ 目录名安全形态（: 与 / 都是路径凶器） */
  bundleDir(id) {
    const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '_')
    // 空形态=域根目录本身：不赌调用顺序，直指要害就 throw（判例 57 L7）
    if (!safe || safe === '.' || safe === '..') throw new Error('bundleDir：空模板 id 拒绝解析')
    const dir = join(this.baseDir, safe)
    const norm = normalize(dir)
    if (!norm.startsWith(normalize(this.baseDir))) throw new Error('bundle-path-escape')
    return norm
  }

  async #volumeRun(volume, script, payload, { readOnly, bindOut, bindOutRo, bindBlobs } = {}) {
    const out = await dockerService.runVolumeScript(
      volume,
      join(SCRIPTS_DIR, script),
      script,
      payload === undefined ? [] : [b64(payload)],
      {
        readOnly,
        noNetwork: true,
        memory: '256m',
        bindHostDir: bindOut || bindOutRo,
        bindHostDirRo: !!bindOutRo,
        bindBlobs,
      },
    )
    let json
    try {
      json = JSON.parse(String(out).trim())
    } catch {
      throw new Error(`${script} 输出不可解析（helper 异常）`)
    }
    if (json && json.error) throw new Error(`${script}: ${json.error}`)
    return json
  }

  /** 可带内容清单：技能实物 + 插件目录 + 卷一级目录统计（DENY 隐身） */
  async inventory(address) {
    return this.#volumeRun(
      swtcVolumeName(normalizeAddress(address)),
      'env-inventory.mjs',
      undefined,
      {
        readOnly: true,
      },
    )
  }

  /** 浏览器式选择器的分层列表 */
  async browse(address, dir) {
    return this.#volumeRun(
      swtcVolumeName(normalizeAddress(address)),
      'env-browse.mjs',
      { dir },
      {
        readOnly: true,
      },
    )
  }

  /**
   * 导出随行包：items=[{root:'skills'|'plugins',name}]（workspace 顶层走
   * scrubKeep 进清洗层，不经这里）。产物 bundle.tar.gz + manifest.json 落宿主
   * 目录，顺手跑检测库——扫描结论随账本入册（审核面的底稿）。
   * @returns {{files:[{p,size,sha256}],bytes:number,scan:object}}
   */
  async exportBundle(address, id, items) {
    const dir = this.bundleDir(id)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    try {
      const r = await this.#volumeRun(
        swtcVolumeName(normalizeAddress(address)),
        'env-export.mjs',
        { items },
        { readOnly: true, bindOut: dir },
      )
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
      // 判例 56 内容寻址去重：多用户带同一插件=盘上一份字节（名=sha256 即地址）。
      // 收编后 tar 出局；扫描改在装配出的真身暂存区跑——此前拿包目录扫平铺文件，
      // 恒 scanned:0（审计假绿，判例 56 同案收案）。
      this.#ingestCas(dir)
      const stage = this.#stageBundleById(dir, manifest)
      try {
        const scan = scanBundle(stage, manifest)
        return { files: manifest, bytes: r.bytes, scan }
      } finally {
        rmSync(stage, { recursive: true, force: true })
      }
    } catch (err) {
      rmSync(dir, { recursive: true, force: true }) // 半包不留
      throw err
    }
  }

  /**
   * 账本↔tar 实体核验：解包临时目录后**逐文件对字节数+sha256**——账本是权威。
   *
   * 判例（2026-10 用户管理端首点"重跑检测"抓出）：旧实现按"宿主平铺文件"
   * 核验，可定格导出的产物本就是一个 bundle.tar.gz（文件在包内），于是
   * 永远报"缺文件"。路由测试把本方法整个 mock 掉，路径形态错配只有真机
   * 才暴露——mock 绿≠真机通再添一例。
   */
  async verifyBundle(id, expectedFiles) {
    const dir = this.bundleDir(id)
    const tar = join(dir, 'bundle.tar.gz')
    const exp = [...expectedFiles].sort((a, b) => a.p.localeCompare(b.p))
    if (!existsSync(tar)) {
      if (!existsSync(dir)) throw new Error('bundle-missing')
      // CAS 形态（判例 56）：字节块名=内容哈希，逐块存在+尺寸+哈希三重核验——
      // 去重不降防：盘上那份坏了，两个引用它的账都验不过。
      for (const f of exp) {
        if (!f.sha256) throw new Error('bundle-missing')
        let buf
        try {
          buf = readFileSync(this.blobPath(f.sha256))
        } catch {
          throw new Error(`bundle-integrity:缺字节块 ${f.p}`)
        }
        if (buf.length !== f.size) throw new Error(`bundle-integrity:大小不符 ${f.p}`)
        if (createHash('sha256').update(buf).digest('hex') !== f.sha256)
          throw new Error(`bundle-integrity:哈希不符 ${f.p}`)
      }
      return exp.map((f) => f.p)
    }
    const tmp = join(
      this.baseDir,
      `.verify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    )
    mkdirSync(tmp, { recursive: true })
    try {
      execFileSync('tar', ['-xzf', tar, '-C', tmp], { stdio: 'pipe' })
      for (const f of exp) {
        let buf
        try {
          buf = readFileSync(join(tmp, f.p))
        } catch {
          throw new Error(`bundle-integrity:缺文件 ${f.p}`)
        }
        if (buf.length !== f.size) throw new Error(`bundle-integrity:大小不符 ${f.p}`)
        // 哈希在场才核（导出环节记 sha256；老数据无 sha 时尺寸核验兜底）
        if (f.sha256) {
          const got = createHash('sha256').update(buf).digest('hex')
          if (got !== f.sha256) throw new Error(`bundle-integrity:哈希不符 ${f.p}`)
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    return exp.map((f) => f.p) // install 侧按账本清单核验 tar 解出物
  }

  /**
   * 装入接收者卷。dryRun=冲突预览（确认弹层数据源）；真装=账本核验后写入。
   * @param {string} destAddress 接收者
   * @param {string} id 模板（=tag）
   * @param {{dryRun:boolean}} opts
   */
  async installBundle(destAddress, id, files, { dryRun = false } = {}) {
    await this.verifyBundle(id, files)
    const hasTar = existsSync(join(this.bundleDir(id), 'bundle.tar.gz'))
    const plan = hasTar ? undefined : files.map((f) => ({ p: f.p, sha: f.sha256 }))
    return this.#volumeRun(
      swtcVolumeName(normalizeAddress(destAddress)),
      'env-install.mjs',
      { dryRun, expect: files.map((f) => f.p).sort(), plan },
      hasTar ? { bindOutRo: this.bundleDir(id) } : { bindBlobs: this.blobRoot },
    )
  }

  /**
   * 分发面的包+技能合一落点（admin/user 两路 apply 共用）：
   * 镜像先行、包后行；卷不存在=如实跳过（-v 隐式建空卷是孤儿卷污染源，
   * 宁可包没装也不能造孤儿）；技能=按名走平台官方安装管线（拿仓库当前版）。
   */
  async applyBundleTo(destAddress, doc, { dryRun = false } = {}) {
    const out = {
      bundleApplied: false,
      conflicts: [],
      skillsInstalled: [],
      skillsFailed: [],
      skillsPlanned: [],
      notices: [],
    }
    if (doc.bundle && doc.bundle.files && doc.bundle.files.length) {
      const vol = swtcVolumeName(normalizeAddress(destAddress))
      const vols = await dockerService.listVolumes()
      if (!vols.includes(vol)) {
        out.notices.push('接收者卷不存在（容器未激活）：随行包未装——激活后重新 apply 随时可补')
      } else {
        const r = await this.installBundle(destAddress, doc._id, doc.bundle.files, { dryRun })
        out.conflicts = r.conflicts || []
        if (!dryRun) out.bundleApplied = true
      }
    }
    const skills = (doc.include && doc.include.skills) || []
    if (skills.length) {
      if (dryRun) {
        out.skillsPlanned = skills
      } else {
        // 动态装载：编排层不静态 import skill.service——它的顶层单例会拖依赖链
        // 进所有 admin 模块图（部分 mock 的测试面直接炸构造）。随行是低频路径，
        // 用时再引，图干净。
        const { skillService } = await import('./skill.service.js')
        for (const n of skills) {
          try {
            await skillService.install(destAddress, n)
            out.skillsInstalled.push(n)
          } catch (err) {
            out.skillsFailed.push({
              name: n,
              error: String((err && err.message) || err).slice(0, 120),
            })
          }
        }
      }
    }
    return out
  }

  /**
   * 删护内容探针（判例 55）：逐文件比对卷内实物与包 manifest 的 sha256，
   * 走 inventory/install 同款只读 helper 通道——主容器停着也能查。
   * 返回 {name:bool}；null=查不了（卷不存在/helper 失败）——**查不了 caller 不许代删**。
   */
  async probePluginContent(destAddress, expectByPlugin) {
    const vol = swtcVolumeName(normalizeAddress(destAddress))
    try {
      const vols = await dockerService.listVolumes()
      if (!vols.includes(vol)) return null
      const r = await this.#volumeRun(
        vol,
        'env-probe-plugins.mjs',
        { expect: expectByPlugin },
        { readOnly: true },
      )
      // 信封面（判例 57 L6）：裸 {名:bool} 与 #volumeRun 的 json.error 错误通道同键空间——
      // 插件名恰为 error 且过核时会把整探误判异常。checked 信封隔开两个键空间。
      return r && typeof r === 'object' ? (r.checked ?? null) : null
    } catch {
      return null
    }
  }

  async removeBundle(id) {
    rmSync(this.bundleDir(id), { recursive: true, force: true })
    // 被引用之物不可删（判例 56）：字节块归全平台引用账共享——退场只退本包引用，
    // 随后拆账即销（扫无引用者清）；拆卷必销账同款纪律，只是方向反过来。
    return this.sweepBlobs()
  }

  /**
   * 无账引用清扫：以 environments 账本为唯一权威，字节块没人点名才删。
   * 查账失败=本轮不清扫（宁可留孤儿占几 KB，不在看不见账的时候删东西）。
   */
  /** 残渣自扫（判例 57 补）：崩在暂存期的 .ingest-/.stage- 点目录永无人管——
   *  每次 ingest/sweep 顺路清掉一小时前的陈旧暂存（进行中的绝不碰） */
  #pruneStaleStaging() {
    if (!existsSync(this.baseDir)) return 0
    let gone = 0
    for (const name of readdirSync(this.baseDir)) {
      if (!name.startsWith('.stage-') && !name.startsWith('.ingest-')) continue
      const p = join(this.baseDir, name)
      try {
        if (Date.now() - statSync(p).mtimeMs < 60 * 60 * 1000) continue
        rmSync(p, { recursive: true, force: true })
        gone++
      } catch {}
    }
    return gone
  }

  async sweepBlobs() {
    this.#pruneStaleStaging()
    let docs
    try {
      docs = await dataService.listEnvironments()
    } catch {
      return { deleted: 0, kept: 0, note: '查账失败：本轮不清扫' }
    }
    if (!Array.isArray(docs)) return { deleted: 0, kept: 0, note: '账形不正：本轮不清扫' }
    const refs = new Set()
    for (const d of docs) for (const f of d?.bundle?.files || []) if (f?.sha256) refs.add(f.sha256)
    let deleted = 0
    let kept = 0
    let young = 0
    const root = this.blobRoot
    if (!existsSync(root)) return { deleted, kept }
    if (!refs.size) {
      // "空账"不是"查清"（判例 57 H1）：json 轨 readJson 吞 ENOENT/坏档为 null、
      // provider 翻转后新库为空……任何看不见账的时刻都"如实报空"。零引用而库有实物
      // =疑似查账盲区——停手不删。查不了≠没了，删除面同款教义。
      let anyBlob = false
      try {
        anyBlob = readdirSync(root).some((seg) => {
          try {
            return readdirSync(join(root, seg)).length > 0
          } catch {
            return false
          }
        })
      } catch {
        anyBlob = true
      }
      return anyBlob
        ? { deleted, kept, note: '账面零引用而库中有实物——疑查账盲区，本轮不清扫' }
        : { deleted, kept }
    }
    for (const seg of readdirSync(root)) {
      const sub = join(root, seg)
      let st
      try {
        st = statSync(sub)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      for (const rest of readdirSync(sub)) {
        if (refs.has(seg + rest)) {
          kept++
          continue
        }
        const bp = join(sub, rest)
        try {
          // 在途窗口宽限（判例 57 M4）：ingest→putEnvironment 之间块已落库、账未挂上；
          // 15 分钟内新块一律不碰——别人的导出失败清理/驳回不许绞杀在途导出。
          if (Date.now() - statSync(bp).mtimeMs < 15 * 60 * 1000) {
            young++
            continue
          }
          rmSync(bp, { force: true })
          deleted++
        } catch {}
      }
    }
    return { deleted, kept, young }
  }

  /** 存量收编：所有还带 tar 的包目录逐个进 CAS；无 manifest 的旧形态跳过（不动tar）。 */
  migrateCas() {
    const migrated = []
    if (!existsSync(this.baseDir)) return migrated
    for (const name of readdirSync(this.baseDir)) {
      if (name.startsWith('.')) continue
      const dir = join(this.baseDir, name)
      if (!existsSync(join(dir, 'bundle.tar.gz')) || !existsSync(join(dir, 'manifest.json')))
        continue
      try {
        this.#ingestCas(dir)
        migrated.push(name)
      } catch (err) {
        // 单个旧包坏了不拦路：tar 原样留（verify/install 走 tar 老路），如实点名
        console.warn(`[env-bundle] 收编跳过 ${name}: ${err.message}`)
      }
    }
    return migrated
  }

  /** tar 形态收编进 CAS：逐文件哈希自证后 rename 入库；名已在=去重命中，弃本地拷贝。 */
  #ingestCas(dir) {
    const tar = join(dir, 'bundle.tar.gz')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    this.#pruneStaleStaging()
    const staging = join(
      this.baseDir,
      `.ingest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    )
    mkdirSync(staging, { recursive: true })
    try {
      execFileSync('tar', ['-xzf', tar, '-C', staging], { stdio: 'pipe' })
      for (const f of manifest) {
        if (!f?.p || !f?.sha256) throw new Error('ingest:清单缺 sha256——旧包保留 tar 形态')
        const src = join(staging, f.p)
        const buf = readFileSync(src)
        if (createHash('sha256').update(buf).digest('hex') !== f.sha256)
          throw new Error(`ingest:字节与指纹不符 ${f.p}`)
        const dest = this.blobPath(f.sha256)
        mkdirSync(dirname(dest), { recursive: true })
        if (existsSync(dest)) rmSync(src, { force: true })
        else renameSync(src, dest)
      }
      rmSync(tar, { force: true })
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
    return manifest
  }

  blobPath(sha256) {
    // 地址即内容：只认 64 位 hex——账本被写脏（含 '../' 之类）也出不了库区
    if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error('bad-sha')
    return join(this.blobRoot, String(sha256).slice(0, 2), String(sha256).slice(2))
  }

  get blobRoot() {
    if (!dataService.dataDir) throw new Error('env-bundle：dataService.dataDir 不可用')
    return join(dataService.dataDir, 'env-blobs')
  }

  /** 把账本清单装配成平铺暂存目录（tar 或 CAS 两形态通吃）——扫描/核验的"实物现场"。 */
  #stageBundleById(dir, files) {
    const tmp = join(
      this.baseDir,
      `.stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    )
    mkdirSync(tmp, { recursive: true })
    const tar = join(dir, 'bundle.tar.gz')
    try {
      if (existsSync(tar)) {
        execFileSync('tar', ['-xzf', tar, '-C', tmp], { stdio: 'pipe' })
        return tmp
      }
      for (const f of files || []) {
        if (!f?.p || !f?.sha256) throw new Error('bundle-missing')
        const rel = normalize(String(f.p))
        if (!rel || rel.startsWith('/') || rel.split(sep).includes('..'))
          throw new Error(`bundle-integrity:路径不正 ${f.p}`) // 装配面也设闸：账脏=不出装
        const src = this.blobPath(f.sha256)
        if (!existsSync(src)) throw new Error(`bundle-integrity:缺字节块 ${f.p}`)
        const dst = join(tmp, rel)
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
      }
      return tmp
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true })
      throw e
    }
  }

  /** 重跑检测正解（判例 56 收假绿案）：装配真身后扫描——scanned 从此数得着。 */
  scanOnStage(id, files) {
    const stage = this.#stageBundleById(this.bundleDir(id), files)
    try {
      return scanBundle(stage, files)
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  }

  bundleBytes(id) {
    try {
      return JSON.parse(readFileSync(join(this.bundleDir(id), 'manifest.json'), 'utf8')).reduce(
        (a, f) => a + f.size,
        0,
      )
    } catch {
      return 0
    }
  }
}

export const envBundleService = new EnvBundleService()
