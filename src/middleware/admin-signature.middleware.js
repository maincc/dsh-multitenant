/**
 * 管理端破坏性操作的"每次操作重新签名"守卫（P0 加固）。
 *
 * ## 为什么要加这层
 *
 * 管理侧的 `admin_session` 是一个 **12 小时有效的 bearer token**：
 * `requireAdmin` 只做 `sha256(token)` 查表 + 过期判断，不验签。而租户网关会把
 * 浏览器带来的 cookie 原样转发进租户容器（`path=/` 的 cookie 不按端口隔离，
 * `SameSite` 也不判端口），于是"管理员访问过的那个租户"能拿到这串 token ——
 * 拿到它的人就继承了管理员登录时那次签名的成果，自己不用签任何名，
 * 12 小时内可随意重放（实测：仅凭 cookie 可 promote/force-stop 成功）。
 *
 * 钱包侧（`tenant-config.configure` / skill 安装 / `/connect`）本来就有正确的
 * 样板：**每次数据操作当场签一个新的 nonce**，用完即毁、5 分钟过期，所以被
 * 拦截也没有价值。这里把那套样板搬到管理侧的破坏性操作上。
 *
 * `admin_session` 的设计（避免管理员每点一下都弹钱包）保持不变，只是给
 * **会改变平台状态**的操作再加一道当场签名。纯读取接口不要求，日常查看
 * 不会被弹窗打断。
 *
 * ## 签名内容由服务端推导，且真正参与签名
 *
 * 让前端传"我要签什么"是不可接受的（前端可被篡改）。这里的做法：
 *   ① 挑战接口收到 (operation, payload) → 服务端推导 `binding` → **签的就是
 *      `${nonce}|${binding}`**，并把这个串原样回给前端（钱包弹窗里能看到内容）
 *   ② 执行接口重新推导 binding，从自己的挑战记录里取回当时的 binding，
 *      断言两者一致后才验签
 *
 * 于是"签了 A 却执行 B"不可能成功：nonce 是为 binding A 专发的，执行 B 时
 * 推导出的 binding B ≠ A → 直接拒绝；而且 nonce 已被消费，没有第二次机会。
 */

import { tenantConfigService } from '../services/tenant-config.service.js'

/** 允许签名的操作名（白名单；未知操作一律拒绝，不做兜底） */
export const ADMIN_SIGNED_OPERATIONS = Object.freeze([
  'promote',
  'force-stop',
  'remove',
  'delete-volume',
  'dsh/apply',
  'dsh/prune-images',
])

/** 待执行的管理操作挑战（地址 → 记录）。与 tenantConfigService 的挑战池同样是一次性 */
const pending = new Map()
/** 与 tenantConfigService 的挑战 TTL 保持一致（5 分钟） */
const TTL_MS = 5 * 60 * 1000

function prunePending() {
  const now = Date.now()
  for (const [addr, rec] of pending) {
    if (rec.expiresAt < now) pending.delete(addr)
  }
}

/**
 * 从操作名与入参推导"这次操作到底改什么"的规范化描述。
 *
 * 必须覆盖所有会改变行为的入参，否则"签了 apply 却传入不同 address"这类偷换
 * 就会漏过去。未知操作/缺目标返回 null（调用方按拒绝处理）。
 *
 * @param {string} operation
 * @param {object} payload 请求体（URL 里的目标地址须由调用方并入 payload.address）
 * @returns {string|null}
 */
export function buildBinding(operation, payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const addr = typeof p.address === 'string' ? p.address.toLowerCase() : ''
  switch (operation) {
    case 'promote':
    case 'force-stop':
    case 'delete-volume':
      return addr ? `${operation}:address=${addr}` : null
    case 'remove':
      // keepVolume 会改变"数据卷是否保留"这一破坏性语义，必须签进去
      return addr ? `remove:address=${addr}:keepVolume=${p.keepVolume === true ? '1' : '0'}` : null
    case 'dsh/apply': {
      // 必须把"钉到哪个镜像"也签进去：否则一个针对 latest 的签名可以被改成
      // 装任意本地镜像（越权通道）。image 为空 = 平台默认，binding 保持不变，
      // 这样现有调用方（不传 image）的签名内容完全不受影响。
      const img = p.image ? String(p.image).trim().toLowerCase() : ''
      const suffix = img ? `|image=${img}` : ''
      if (p.all === true) return `dsh/apply:all=1${suffix}`
      return addr ? `dsh/apply:address=${addr}${suffix}` : null
    }
    case 'dsh/prune-images': {
      // 必须把"删哪几个镜像"签进去：否则一个针对 A 的签名可以被改成删 B。
      // 规范化（短 ID + 去重 + 排序）保证同一组镜像的 binding 稳定可比对。
      // 注意空列表也是合法签名目标（即"不删任何东西"），不会退化成"删全部"。
      const ids = Array.isArray(p.ids) ? p.ids : []
      const norm = [
        ...new Set(
          ids
            .map((s) =>
              String(s)
                .replace(/^sha256:/, '')
                .slice(0, 12)
                .toLowerCase(),
            )
            .filter(Boolean),
        ),
      ].sort()
      return `dsh/prune-images:ids=${norm.join(',')}`
    }
    default:
      return null
  }
}

/**
 * 钱包里实际签的字符串。
 *
 * 把操作语义拼进被签内容，而不是只签一个与操作无关的随机 nonce —— 这样钱包
 * 弹窗展示的内容本身就能让管理员看出"正在授权什么"。
 */
export function signedMessage(nonce, binding) {
  return `${nonce}|${binding}`
}

/**
 * 为一次破坏性操作发放一次性挑战。
 *
 * 复用 `tenantConfigService.issueChallenge`（与登录/钱包侧同一套挑战池），
 * 因此天然一次性 + 5 分钟过期；这里额外记下"这次 nonce 绑定的是哪个操作"。
 *
 * @param {string} address 管理员地址（会话地址；挑战池也按它索引）
 * @param {string} operation
 * @param {object} payload
 * @returns {{nonce: string, binding: string, message: string}|null}
 */
export function issueAdminSignatureChallenge(address, operation, payload = {}) {
  const binding = buildBinding(operation, payload)
  if (!binding) return null
  const nonce = tenantConfigService.issueChallenge(address)
  if (!nonce) return null // 挑战池满
  prunePending()
  pending.set(String(address).toLowerCase(), {
    nonce,
    binding,
    expiresAt: Date.now() + TTL_MS,
  })
  return { nonce, binding, message: signedMessage(nonce, binding) }
}

/**
 * 校验破坏性操作的当场签名。
 *
 * 顺序（每步失败都明确拒绝，且 ③ 早于 ④/⑤：nonce 一旦拿来用就作废，
 * 验签失败也不给第二次机会）：
 *   ① 有 admin_session 会话
 *   ② 该操作可签名（白名单 + 目标齐全）
 *   ③ 存在与之匹配的待执行挑战，且**这次请求推导出的 binding 与发放时一致**
 *   ④ nonce 未过期未使用 → 先消费
 *   ⑤ 签名有效，且公钥推导地址 === 会话地址
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} operation
 * @param {object} payload 必须已并入 URL 里的目标地址
 * @returns {boolean} true = 通过；false = 已写出 400/403，调用方直接 return
 */
export function requireAdminSignature(req, res, operation, payload = {}, sessionAddress = null) {
  const deny = (error, code, status = 403) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error, code }))
    return false
  }

  // ① 身份仍要有管理员会话（requireAdmin 已校验过地址在管理员列表里）
  if (!sessionAddress) return deny('需要管理员权限', 'FORBIDDEN')

  // ② 操作可签名
  const binding = buildBinding(operation, payload)
  if (!binding) {
    return deny(`不支持的签名操作或缺少目标：${operation}`, 'SIGNATURE_NOT_APPLICABLE', 400)
  }

  const sig = req.__adminSignature
  if (!sig || !sig.nonce || !sig.signature || !sig.publicKey) {
    return deny('该操作需要钱包签名确认（请对本次操作签名后重试）', 'SIGNATURE_REQUIRED')
  }

  // ③ 挑战必须是为**同一个操作**发放的
  prunePending()
  const rec = pending.get(String(sessionAddress).toLowerCase())
  if (!rec || rec.nonce !== sig.nonce) {
    return deny('签名挑战无效或已过期，请重新签名', 'CHALLENGE_INVALID')
  }
  if (rec.binding !== binding) {
    // 签的是 A、执行的是 B —— 直接拒，且下面会把 nonce 一起作废
    pending.delete(String(sessionAddress).toLowerCase())
    return deny('签名内容与本次操作不一致，已拒绝执行', 'SIGNATURE_MISMATCH')
  }

  // ④ 一次性消费（先作废再验签）
  pending.delete(String(sessionAddress).toLowerCase())
  if (!tenantConfigService.consumeChallenge(sessionAddress, sig.nonce)) {
    return deny('签名挑战无效或已过期，请重新签名', 'CHALLENGE_INVALID')
  }

  // ⑤ 验签 + 地址归属
  const message = signedMessage(sig.nonce, binding)
  if (!tenantConfigService.verifySignature(sessionAddress, message, sig.signature, sig.publicKey)) {
    return deny('签名验证失败：无法确认该操作由您本人授权', 'SIGNATURE_INVALID')
  }

  return true
}

/**
 * 从请求头取出签名材料，挂到 `req.__adminSignature`。
 *
 * 为什么走请求头而不是请求体：破坏性端点里有的（force-stop / remove）**根本不读
 * body**，用请求体就得为验签额外消费一次 request stream，容易和业务解析互相
 * 干扰。请求头无副作用，且与"这是对本次请求的授权"语义一致。
 *
 * 缺任何一个都只是"没带签名"，由 `requireAdminSignature` 统一报 SIGNATURE_REQUIRED。
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function attachAdminSignature(req) {
  const h = req.headers || {}
  const nonce = h['x-admin-nonce']
  const signature = h['x-admin-signature']
  const publicKey = h['x-admin-pubkey']
  if (typeof nonce === 'string' && typeof signature === 'string' && typeof publicKey === 'string') {
    req.__adminSignature = { nonce, signature, publicKey }
  }
}

/** @internal 仅供测试：清空待执行挑战 */
export function _clearPendingForTest() {
  pending.clear()
}
