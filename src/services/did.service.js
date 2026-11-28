/**
 * L1 DID 档案判定件（v1.4 凭证体系的领取前置探测；hybrid 升级闸门同源复用）
 *
 * "L1 命中"=该用户在 relay 上有公开档案文档：可读回 + 有登记公钥
 * （verificationMethod≥1）+ 有认证方法（authentication 非空——档案是真人在用，
 * 不是随手建的空壳）。只读，永不写。
 *
 * 三防线（§4 验收"mock 三态"）：
 *  - 双试：swtc 族地址查 did:swtc，hex 地址查 did:ethr（EIP-55）——一个地址只属于一族
 *  - 15min 缓存：领取/升级都是低频动作，同一地址窗口内判定结果复用（bust=实探）
 *  - 8s 超时×2 次重试：relay 慢/挂=判定缺席（miss），绝不上抛；但一次超时不足以
 *    说"没档案"——实测 resolve 冷启动 2.7s 级常态，3s 单发预算曾把真档案误判缺席
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { CONFIG, ROOT } from '../config/config.js'

const require = createRequire(import.meta.url)
const D = path.join(ROOT, 'node_modules', '@jccdex', 'did') + path.sep

let _resolvers = null
function getResolvers() {
  if (_resolvers) return _resolvers
  const { SwtcDidResolver, EthrDidResolver } = require(D + 'lib/resolver.js')
  const { IpfsClient } = require('@jccdex/ipfs-rpc-client')
  const client = new IpfsClient({
    baseURL: CONFIG.credential?.relayBaseURL || 'https://ipfsserver.ccda.ooo',
  })
  _resolvers = { swtc: new SwtcDidResolver(client), ethr: new EthrDidResolver(client) }
  return _resolvers
}
export function _resetResolversForTest(r) {
  _resolvers = r ?? null
}
/** 官方口径的 swtc resolver（链上验真/档案解析共用一条读路） */
export function getSwtcResolver() {
  return getResolvers().swtc
}

const CACHE_TTL_MS = 15 * 60 * 1000
// 2.7s 级冷启动是实测常态（ipfsserver resolve 首跳 2663ms），3s 预算会误判"档案不存在"
const TIMEOUT_MS = 8000
const _cache = new Map()

/** 档案形状判定（拿到文档≠命中，空壳不算） */
export function isL1ProfileDoc(doc) {
  if (!doc || typeof doc !== 'object') return false
  const methods = doc.verificationMethod ?? []
  const auth = doc.authentication ?? []
  return methods.length >= 1 && auth.length >= 1
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('resolve timeout')), ms)),
  ])
}

/**
 * 判定地址是否有 L1 档案（升级策略的判定件；缺席=hybrid 转人工）。
 * @param {string} address swtc 地址（j…）或 eth 地址（0x…）
 * @param {object} [opts] resolver/timeoutMs/ttlMs/now 测试注入；bust=跳过缓存实探
 *   （领取是用户主动动作，60s 负缓存窗内也该真探一次，绝不把网络抖动固化成"你没档案"）
 * @returns {Promise<boolean>} 出错/超时=保守 false（重试一次仍败才判缺席，且留日志）
 */
export async function l1ProfileHit(address, opts = {}) {
  if (!address || typeof address !== 'string') return false
  const now = opts.now ?? Date.now()
  if (!opts.bust) {
    const cached = _cache.get(address)
    if (cached && now - cached.at < (opts.ttlMs ?? CACHE_TTL_MS)) return cached.hit
  }
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(address)
  const attempt = async () => {
    const { swtc, ethr } = opts.resolver
      ? { swtc: opts.resolver, ethr: opts.resolver }
      : getResolvers()
    const resolver = isEvm ? ethr : swtc
    const did = isEvm ? `did:ethr:${address}` : `did:swtc:${address}`
    const raw = await withTimeout(resolver.resolve(did), timeoutMs)
    // 库口径：resolve 返回值即文档本体（query-did 时代 didDocument??doc 双兼容）
    const doc = raw?.didDocument ?? raw
    return isL1ProfileDoc(doc)
  }
  try {
    const hit = await attempt()
    _cache.set(address, { hit, at: now })
    return hit
  } catch (e1) {
    // 超时/网络抖 → 立即再试一次（冷启动首跳慢是实测常态，一次失败不足以判"没档案"）
    try {
      const hit = await attempt()
      _cache.set(address, { hit, at: now })
      return hit
    } catch (e2) {
      console.warn(
        `[l1-probe] ${address.slice(0, 12)}… 两次探测失败，保守判缺席: ${String(e2?.message || e2).slice(0, 100)}`,
      )
      // 缺席/失败短缓存 60s 防雷暴；真档案形状不符则按 TTL 缓存（那种状态不会秒变）
      _cache.set(address, { hit: false, at: now - CACHE_TTL_MS + 60000 })
      return false
    }
  }
}

export function _clearL1Cache() {
  _cache.clear()
}
