/**
 * 存量补铸基础卡（did-vc-runbook 步骤3 收尾件 / 上线序列第 3 拍）
 * 给 registry 里没有 vc 的存量用户逐张补铸 tier=1 并上架。
 * 默认 dry-run 只列名单；--yes 才真正铸造+写架（写架=公开可见，跑它=授权）。
 * 用法：node scripts/vc-backfill.mjs [--yes]
 * 串行纪律：货架单文档，逐张入队（shelf 队列内部串行，这里再逐张 await 保日志可读）。
 */
import { CONFIG } from '../src/config/config.js'
import { userService } from '../src/services/user.service.js'
import { getIssuerIdentity, isIssuerEnabled } from '../src/services/issuer.service.js'

const DO_IT = process.argv.includes('--yes')
if (!isIssuerEnabled()) {
  console.error('[backfill] 签发未开业（缺钥/钥不可用），先放置 issuer.key')
  process.exit(1)
}
await userService.init().catch((e) => console.warn('[backfill] init 水合跳过：', e.message))
const id = getIssuerIdentity()
const users = userService.state.swtcUsers ?? {}
const targets = Object.entries(users).filter(([, u]) => !u?.vc)
console.log(`[backfill] 实例=${CONFIG.shelf.rpcBaseURL} 平台=${id.shelfDid}`)
console.log(`[backfill] 总用户=${Object.keys(users).length} 无卡=${targets.length}`)
for (const [a] of targets.slice(0, 5)) console.log('  待铸:', a)
if (targets.length > 5) console.log(`  …共 ${targets.length}`)
if (!DO_IT) {
  console.log('[backfill] dry-run 结束。执行加 --yes（真写货架，先上后落库）')
  process.exit(0)
}
const { issueAndShelf } = await import('../src/services/vc.service.js')
let ok = 0
let shelved = 0
for (const [address] of targets) {
  try {
    const { vc, onShelf } = await issueAndShelf(address, 1)
    const u = userService.state.swtcUsers?.[address]
    if (u) {
      u.vc = { jti: vc.id, vcTier: 1, onShelf, mintedAt: Date.now(), ldvc: vc }
      await userService._saveState()
    }
    ok++
    if (onShelf) shelved++
    process.stdout.write(`\r[backfill] ${ok}/${targets.length}（在架 ${shelved}）`)
  } catch (e) {
    console.warn(`\n[backfill] ${address} 失败（可重跑自愈）: ${e.message}`)
  }
}
console.log(
  `\n[backfill] 完成：${ok}/${targets.length}，快照确认 ${shelved}，未确认部分由 reconcile/重跑兜底`,
)
