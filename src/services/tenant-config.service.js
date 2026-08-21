/**
 * 租户密钥配置服务
 *
 * 身份验证：钱包签名挑战-响应
 *   1. POST config-challenge 领取一次性 nonce（5 分钟有效，用完即焚）
 *   2. 前端让 CCDAO 插件对 nonce 签名（swtc_signMessage）+ 取公钥（swtc_getPublicKey）
 *   3. 服务端用 @swtc/keypairs 验签，且公钥推导出的 SWTC 地址必须等于声称地址
 *   全部通过才允许写入该租户的数据卷凭据文件（.credentials.yaml）。
 *
 * 绕过了 DSH 配置平面的 loopback-only 限制，同时保留真实认证：
 *   - 不是"网段信任"（放开 loopback 会让局域网任何人可改配置）
 *   - 而是"钱包签名认证"（能签出对应地址的签名 = 持有该地址私钥）
 *
 * 安全边界：
 *   - key 只写入租户卷（容器内 0600），服务端/日志绝不落盘或回显
 *   - GET 状态只回 configured/absent，永不返回 key 内容
 *   - DSH credentials-local 热加载该文件（chokidar 监听，约 100ms 生效）
 */

import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypairs } from '@swtc/keypairs'
import { CONFIG } from '../config/config.js'
import { normalizeAddress, swtcVolumeName } from '../utils/address.js'
import { ForbiddenError, BadRequestError, InternalError } from '../utils/errors.js'

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)))
const MERGE_SCRIPT = join(ROOT, 'src', 'services', 'merge-credentials.mjs')
const IMAGE = process.env.DSH_TENANT_IMAGE || CONFIG.docker.image

/** 容器内凭据文件路径（DSH 的 $DSH_HOME/.credentials.yaml） */
const CREDENTIALS_FILE = '/dsh-home/.credentials.yaml'
/** 写入的凭据引用名（DSH llm-deepseek 默认从 DEEPSEEK_API_KEY 解析密钥） */
const CREDENTIAL_KEY = 'DEEPSEEK_API_KEY'
/** 挑战有效期：5 分钟 */
const CHALLENGE_TTL_MS = 5 * 60 * 1000
/** API Key 长度上限（防止超大 payload） */
const MAX_KEY_LENGTH = 4096

/** 一次性挑战：address -> { nonce, expiresAt }（进程内存，重启即失效，可接受） */
const challenges = new Map()

/** 封装 execFile 为 Promise */
function sh(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout ?? '')
        err.stderr = String(stderr ?? '')
        reject(err)
      } else {
        resolvePromise(String(stdout ?? '').trim())
      }
    })
  })
}

export class TenantConfigService {
  /**
   * 发放一次性挑战
   * @param {string} address SWTC 地址
   * @returns {string} nonce（hex）
   */
  issueChallenge(address) {
    const nonce = randomBytes(32).toString('hex')
    challenges.set(normalizeAddress(address), {
      nonce,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    })
    return nonce
  }

  /** 消费挑战（一次性；不存在/不匹配/过期都失败） */
  consumeChallenge(address, nonce) {
    const rec = challenges.get(normalizeAddress(address))
    if (!rec || rec.nonce !== nonce || rec.expiresAt < Date.now()) return false
    challenges.delete(normalizeAddress(address))
    return true
  }

  /**
   * 验签：nonce 的签名有效，且公钥推导出的地址 === 声称地址。
   * 与 CCDAO 插件同库同流程（Keypairs.sign(messageHex, privateKey)）。
   */
  verifySignature(address, nonce, signature, publicKey) {
    try {
      if (typeof signature !== 'string' || typeof publicKey !== 'string') return false
      if (!Keypairs.verify(nonce, signature, publicKey)) return false
      const derived = normalizeAddress(Keypairs.deriveAddress(publicKey))
      return derived === normalizeAddress(address)
    } catch {
      return false
    }
  }

  /**
   * 在租户镜像的辅助容器内执行凭据合并（借助数据卷挂载，不依赖宿主卷路径）
   * @param {string} address SWTC 地址（决定写哪个租户卷）
   * @param {string} action get | set | del
   * @param {string} [value] set 时的值
   */
  async runMerge(address, action, value) {
    const volume = swtcVolumeName(address)
    const args = [
      'run',
      '--rm',
      '-v',
      `${volume}:/dsh-home`,
      '-v',
      `${MERGE_SCRIPT}:/merge.mjs:ro`,
      IMAGE,
      'node',
      '/merge.mjs',
      action,
      CREDENTIALS_FILE,
      CREDENTIAL_KEY,
    ]
    if (value !== undefined) args.push(value)
    try {
      const out = await sh('docker', args)
      return out
    } catch (err) {
      throw new InternalError(
        `写入租户凭据失败（volume=${volume}）: ${err.message} ${err.stderr ?? ''}`,
      )
    }
  }

  /** 查询配置状态（只回 configured/absent，不回显 key） */
  async getStatus(address) {
    const out = await this.runMerge(address, 'get')
    return out === 'configured'
  }

  /** 写入（或覆盖）API Key */
  async setKey(address, apiKey) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new BadRequestError('API Key 不能为空')
    }
    if (apiKey.length > MAX_KEY_LENGTH) {
      throw new BadRequestError('API Key 长度超出限制')
    }
    await this.runMerge(address, 'set', apiKey.trim())
  }

  /** 清除 API Key */
  async clearKey(address) {
    await this.runMerge(address, 'del')
  }

  /**
   * 完整配置流程：验签 + 写 key
   * @throws ForbiddenError 签名/地址不匹配
   */
  async configure(address, { nonce, signature, publicKey, apiKey }) {
    if (!this.consumeChallenge(address, nonce)) {
      throw new ForbiddenError('挑战无效或已过期，请重新获取')
    }
    if (!this.verifySignature(address, nonce, signature, publicKey)) {
      throw new ForbiddenError('签名验证失败：无法确认该地址归您所有')
    }
    await this.setKey(address, apiKey)
  }

  /** 完整清除流程：验签 + 删 key */
  async clear(address, { nonce, signature, publicKey }) {
    if (!this.consumeChallenge(address, nonce)) {
      throw new ForbiddenError('挑战无效或已过期，请重新获取')
    }
    if (!this.verifySignature(address, nonce, signature, publicKey)) {
      throw new ForbiddenError('签名验证失败：无法确认该地址归您所有')
    }
    await this.clearKey(address)
  }
}

export const tenantConfigService = new TenantConfigService()
