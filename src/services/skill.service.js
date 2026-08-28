/**
 * 技能市场服务
 *
 * 职责：
 *   - 共享仓库：宿主 data/skills/（技能文件 + index.json 元数据），单一事实来源
 *   - 安装记录：data/installs.json（{ address: [{ name, source, installedAt, contentHash, size }] }）
 *   - 卷操作：复用 tenantConfigService.runScript（辅助容器挂载租户卷执行读/写/删脚本）
 *   - 鉴权：钱包签名挑战-响应（与 tenant-config 同模式，authority 在 routes 层调用）
 *   - 配额/限流：每地址活跃发布上限、每地址每小时安装上限
 *
 * 安全边界：
 *   - 技能名 kebab-case 白名单 + assertSkillName，绝不拼接用户输入进路径
 *   - 写租户卷（install/import/uninstall）必须经过签名鉴权（签名地址 === 目标地址）
 *   - 入仓前 frontmatter 全量校验（validateSkill），非法内容拒绝进入市场
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { tenantConfigService } from './tenant-config.service.js'
import { dataService } from './data.service.js'
import { assertSkillName, rewriteSkillName, validateSkill } from '../utils/skill.js'
import { normalizeAddress } from '../utils/address.js'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from '../utils/errors.js'

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)))

/** 每地址活跃共享技能上限 */
export const MAX_ACTIVE_PUBLISHED = 20
/** 每地址每小时安装上限 */
export const MAX_INSTALLS_PER_HOUR = 10
/** 限流窗口：1 小时 */
const RATE_WINDOW_MS = 60 * 60 * 1000

/** 索引文件名（位于 storeDir 下） */
const INDEX_FILE = 'index.json'

export class SkillService {
  /**
   * @param {object} [opts] 可注入存储路径（测试用）
   * @param {string} [opts.storeDir] 共享仓库根（默认 <data>/skills）
   * @param {string} [opts.installsFile] 安装记录文件（默认 <data>/installs.json）
   */
  constructor({ storeDir, installsFile } = {}) {
    this.storeDir = storeDir ?? join(dataService.dataDir, 'skills')
    this.installsFile = installsFile ?? join(dataService.dataDir, 'installs.json')
    this.installRate = new Map() // address -> { count, windowStart }
    mkdirSync(this.storeDir, { recursive: true })
  }

  // ---------------------------------------------------------------------------
  // 鉴权（挑战-响应，与 tenant-config 同库同流程）
  // ---------------------------------------------------------------------------

  /**
   * 消费挑战 + 验签；通过返回规范化地址，失败抛 ForbiddenError。
   * @param {string} address SWTC 地址
   * @param {{ nonce: string, signature: string, publicKey: string }} auth
   */
  authenticate(address, { nonce, signature, publicKey }) {
    if (!tenantConfigService.consumeChallenge(address, nonce)) {
      throw new ForbiddenError('挑战无效或已过期，请重新获取')
    }
    if (!tenantConfigService.verifySignature(address, nonce, signature, publicKey)) {
      throw new ForbiddenError('签名验证失败：无法确认该地址归您所有')
    }
    return normalizeAddress(address)
  }

  // ---------------------------------------------------------------------------
  // 存储基础
  // ---------------------------------------------------------------------------

  readIndex() {
    const file = join(this.storeDir, INDEX_FILE)
    const data = dataService.readJson(file)
    return Array.isArray(data?.entries) ? data.entries : []
  }

  writeIndex(entries) {
    dataService.writeWithLock(join(this.storeDir, INDEX_FILE), { entries })
  }

  readInstalls() {
    const data = dataService.readJson(this.installsFile)
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }

  writeInstalls(all) {
    dataService.writeWithLock(this.installsFile, all)
  }

  entryBodyPath(name) {
    return join(this.storeDir, name, 'SKILL.md')
  }

  readEntryBody(name) {
    const p = this.entryBodyPath(name)
    if (!existsSync(p)) {
      throw new InternalError(`技能 ${name} 内容文件缺失`)
    }
    return readFileSync(p, 'utf8')
  }

  writeEntryBody(name, text) {
    const dir = join(this.storeDir, name)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'SKILL.md')
    const tmp = `${file}.tmp.${process.pid}`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  }

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------

  /** 市场公开列表（仅 active，按名排序；可带 address 标记"已安装"） */
  async list({ address } = {}) {
    const entries = this.readIndex()
      .filter((e) => e.status === 'active')
      .sort((a, b) => a.name.localeCompare(b.name))
    const mine = new Set()
    if (address && isValidAddressLike(address)) {
      const installs = this.readInstalls()
      ;(installs[normalizeAddress(address)] || []).forEach((r) => mine.add(r.name))
    }
    return entries.map((e) => this.toPublic(e, mine.has(e.name)))
  }

  /** 技能详情（含全文，供安装前预览） */
  async detail(name) {
    const entry = this.getActiveEntry(name)
    return { ...this.toPublic(entry), body: this.readEntryBody(name) }
  }

  /** 下载/导出（active 技能），返回 { fileName, body, contentHash } */
  async download(name) {
    const entry = this.getActiveEntry(name)
    return {
      fileName: `${name}.md`,
      body: this.readEntryBody(name),
      contentHash: entry.contentHash,
    }
  }

  /**
   * 列出签名者容器内可共享的技能（自写 + 导入都在自己卷里）。
   * 只读操作，失败时返回 []（不给用户中心造成阻塞）。
   */
  async listContainerSkills(address) {
    try {
      const out = await tenantConfigService.runScript(address, 'list-skills.mjs', [])
      const parsed = JSON.parse(out)
      return Array.isArray(parsed?.names) ? parsed.names : []
    } catch {
      return []
    }
  }

  /** 我的发布 + 我的安装（个人视图，读取宿主侧数据，无需签名/卷访问） */
  async mineView(address) {
    address = normalizeAddress(address)
    const entries = this.readIndex()
    const published = entries.filter((e) => e.sharer === address).map((e) => this.toPublic(e))
    const installs = this.readInstalls()[address] || []
    const installed = installs.map((rec) => {
      const entry = entries.find((e) => e.name === rec.name)
      const hasUpdate =
        Boolean(entry) && entry.status === 'active' && entry.contentHash !== rec.contentHash
      return {
        name: rec.name,
        source: rec.source,
        installedAt: rec.installedAt,
        contentHash: rec.contentHash,
        size: rec.size,
        hasUpdate,
        status: entry?.status ?? 'removed',
        description: entry?.description ?? '',
        whenToUse: entry?.whenToUse ?? '',
        hasResources: Boolean(entry?.hasResources),
      }
    })
    return { published, installed }
  }

  /** 我的发布 + 我的安装 + 容器内可共享列表（共享弹窗用，需签名） */
  async mine(address) {
    const view = await this.mineView(address)
    const inContainer = await this.listContainerSkills(address)
    return { ...view, inContainer }
  }

  /** 管理视图：全部条目 + 安装数 */
  async adminList() {
    const entries = this.readIndex()
    const installs = this.readInstalls()
    const countByName = {}
    for (const list of Object.values(installs)) {
      for (const r of list) countByName[r.name] = (countByName[r.name] || 0) + 1
    }
    return entries
      .sort((a, b) => (a.sharedAt < b.sharedAt ? 1 : -1))
      .map((e) => ({
        ...this.toPublic(e),
        sharer: e.sharer,
        status: e.status,
        sharedAt: e.sharedAt,
        installCount: countByName[e.name] || 0,
      }))
  }

  // ---------------------------------------------------------------------------
  // 发布 / 下架
  // ---------------------------------------------------------------------------

  /**
   * 发布：从发布者卷提取技能 → 校验 frontmatter → 入仓。
   * 命名规则（产品要求）：
   *   - 共享名的唯一性：与任一 active 条目撞名即拒绝（提示改名后再共享）；
   *   - 例外：同发布者原样重发自己的技能（无 renameTo）= 覆盖更新；
   *   - renameTo：发布时改名，frontmatter name 会同步重写（共享副本自洽），
   *     改名后的名字同样要求唯一。
   * 注：导入的 skill 已写入发布者自己卷，与自写技能同样可发布（无区别对待）。
   */
  async publish(address, skillName, { renameTo } = {}) {
    address = normalizeAddress(address)
    const sourceName = assertSkillName(skillName)
    const shareName =
      renameTo !== undefined && renameTo !== null && String(renameTo).trim() !== ''
        ? assertSkillName(String(renameTo).trim())
        : sourceName

    const entries = this.readIndex()
    const existing = entries.find((e) => e.name === shareName && e.status === 'active')
    if (existing) {
      const isOwnUpdate = existing.sharer === address && shareName === sourceName
      if (!isOwnUpdate) {
        throw new ConflictError(`技能名 "${shareName}" 已被共享，共享名必须唯一，请改名后再共享`)
      }
    }
    const activeBySharer = entries.filter(
      (e) => e.sharer === address && e.status === 'active',
    ).length
    if (activeBySharer >= MAX_ACTIVE_PUBLISHED) {
      throw new BadRequestError(`每个地址最多共享 ${MAX_ACTIVE_PUBLISHED} 个技能`)
    }

    // 1) 从发布者卷提取（源名）
    const out = await tenantConfigService.runScript(address, 'extract-skill.mjs', [sourceName])
    let parsed
    try {
      parsed = JSON.parse(out)
    } catch {
      throw new InternalError('技能提取返回无法解析')
    }
    if (!parsed?.ok) {
      if (parsed?.reason === 'not-found') {
        throw new NotFoundError(
          `容器内未找到技能 ${sourceName}（/${sourceName}/SKILL.md 或 ${sourceName}.md）`,
        )
      }
      throw new BadRequestError(`技能 ${sourceName} 无法提取（${parsed?.reason ?? '未知原因'}）`)
    }

    // 2) 换名则重写 frontmatter name（共享副本自洽），再整体校验
    const text = Buffer.from(parsed.bodyBase64, 'base64').toString('utf8')
    let finalText = text
    if (shareName !== sourceName) {
      try {
        finalText = rewriteSkillName(text, shareName)
      } catch (err) {
        throw new BadRequestError(`共享名重命名失败: ${err.message}`)
      }
    }
    let valid
    try {
      valid = validateSkill({ text: finalText, expectedName: shareName })
    } catch (err) {
      throw new BadRequestError(`技能 frontmatter 非法: ${err.message}`)
    }

    // 3) 入仓
    this.writeEntryBody(shareName, finalText)
    const now = new Date().toISOString()
    const entry = {
      name: shareName,
      description: valid.description,
      whenToUse: valid.whenToUse,
      hasResources: Boolean(parsed.hasResources),
      disableModelInvocation: valid.disableModelInvocation,
      userInvocable: valid.userInvocable,
      sharer: address,
      sharedAt: now,
      contentHash: valid.sha256,
      bodyBytes: valid.bodyBytes,
      status: 'active',
    }
    const idx = entries.findIndex((e) => e.name === shareName)
    if (idx === -1) entries.push(entry)
    else entries[idx] = entry
    this.writeIndex(entries)
    return this.toPublic(entry)
  }

  /** 取消共享（作者本人）或下架（admin） */
  async unpublish(operator, skillName, { admin = false } = {}) {
    const name = assertSkillName(skillName)
    const entries = this.readIndex()
    const entry = entries.find((e) => e.name === name)
    if (!entry) throw new NotFoundError(`技能 ${name} 不存在`)
    if (!admin && entry.sharer !== normalizeAddress(operator)) {
      throw new ForbiddenError('只能取消自己共享的技能（管理员可下架任意技能）')
    }
    if (entry.status !== 'removed') {
      entry.status = 'removed'
      this.writeIndex(entries)
    }
    return this.toPublic(entry)
  }

  // ---------------------------------------------------------------------------
  // 安装 / 导入 / 卸载
  // ---------------------------------------------------------------------------

  /** 市场安装：把共享仓技能写入目标地址自己的卷 */
  async install(address, skillName) {
    address = normalizeAddress(address)
    const name = assertSkillName(skillName)
    this.checkInstallRate(address)
    const entry = this.getActiveEntry(name)
    const text = this.readEntryBody(name)
    const b64 = Buffer.from(text, 'utf8').toString('base64')
    await tenantConfigService.runScript(address, 'install-skill.mjs', [name, b64])
    this.recordInstall(address, name, entry.contentHash, entry.bodyBytes, 'market')
    return this.toPublic(entry, true)
  }

  /** 本地导入：写入自己的卷（不入共享仓），记 source='import' */
  async importSkill(address, skillName, content) {
    address = normalizeAddress(address)
    const name = assertSkillName(skillName)
    if (typeof content !== 'string' || !content.trim()) {
      throw new BadRequestError('技能内容为空')
    }
    let valid
    try {
      valid = validateSkill({ text: content, expectedName: name })
    } catch (err) {
      throw new BadRequestError(`技能 frontmatter 非法: ${err.message}`)
    }
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    await tenantConfigService.runScript(address, 'install-skill.mjs', [name, b64])
    this.recordInstall(address, name, valid.sha256, valid.bodyBytes, 'import')
    return {
      ok: true,
      name,
      description: valid.description,
      whenToUse: valid.whenToUse,
      bodyBytes: valid.bodyBytes,
      disableModelInvocation: valid.disableModelInvocation,
    }
  }

  /** 卸载：从自己卷删除技能文件 */
  async uninstall(address, skillName) {
    address = normalizeAddress(address)
    const name = assertSkillName(skillName)
    await tenantConfigService.runScript(address, 'remove-skill.mjs', [name])
    this.removeInstallRecord(address, name)
    return { ok: true, name, removed: true }
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  toPublic(entry, installed = false) {
    return {
      name: entry.name,
      description: entry.description,
      whenToUse: entry.whenToUse ?? '',
      hasResources: Boolean(entry.hasResources),
      disableModelInvocation: Boolean(entry.disableModelInvocation),
      sharer: entry.sharer,
      sharedAt: entry.sharedAt,
      contentHash: entry.contentHash,
      bodyBytes: entry.bodyBytes,
      installed,
    }
  }

  getActiveEntry(name) {
    const entry = this.readIndex().find((e) => e.name === name)
    if (!entry || entry.status !== 'active') {
      throw new NotFoundError(`技能 ${name} 不存在或已下架`)
    }
    return entry
  }

  recordInstall(address, name, contentHash, size, source) {
    const all = this.readInstalls()
    const list = all[address] || (all[address] = [])
    const rec = { name, source, installedAt: new Date().toISOString(), contentHash, size }
    const idx = list.findIndex((r) => r.name === name)
    if (idx === -1) list.push(rec)
    else list[idx] = rec
    this.writeInstalls(all)
  }

  removeInstallRecord(address, name) {
    const all = this.readInstalls()
    const list = all[address]
    if (Array.isArray(list)) {
      const filtered = list.filter((r) => r.name !== name)
      if (filtered.length !== list.length) {
        if (filtered.length === 0) delete all[address]
        else all[address] = filtered
        this.writeInstalls(all)
      }
    }
  }

  checkInstallRate(address) {
    const now = Date.now()
    const rec = this.installRate.get(address)
    if (!rec || now - rec.windowStart >= RATE_WINDOW_MS) {
      this.installRate.set(address, { count: 1, windowStart: now })
      return
    }
    if (rec.count >= MAX_INSTALLS_PER_HOUR) {
      throw new BadRequestError(
        `安装过于频繁，请稍后再试（每地址每小时最多 ${MAX_INSTALLS_PER_HOUR} 次）`,
      )
    }
    rec.count += 1
  }
}

function isValidAddressLike(addr) {
  return typeof addr === 'string' && /^j[1-9A-HJ-NP-Za-km-zl]{29,34}$/i.test(addr)
}

export const skillService = new SkillService()
