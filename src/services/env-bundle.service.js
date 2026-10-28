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
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
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
    const dir = join(this.baseDir, safe)
    const norm = normalize(dir)
    if (!norm.startsWith(normalize(this.baseDir))) throw new Error('bundle-path-escape')
    return norm
  }

  async #volumeRun(volume, script, payload, { readOnly, bindOut, bindOutRo } = {}) {
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
      const scan = scanBundle(dir, manifest)
      return { files: manifest, bytes: r.bytes, scan }
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
    if (!existsSync(tar)) {
      throw new Error('bundle-missing')
    }
    const exp = [...expectedFiles].sort((a, b) => a.p.localeCompare(b.p))
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
    return this.#volumeRun(
      swtcVolumeName(normalizeAddress(destAddress)),
      'env-install.mjs',
      { dryRun, expect: files.map((f) => f.p).sort() },
      { bindOutRo: this.bundleDir(id) },
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

  removeBundle(id) {
    rmSync(this.bundleDir(id), { recursive: true, force: true })
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
