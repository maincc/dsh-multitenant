#!/usr/bin/env node
/**
 * v1.4 旧版 CWT 数据回填器
 *
 * 用法：把旧版 cwt_registry（对象 {addr:{approvedAt,...}} 或数组 [{address,...}]）
 * 放到 config.credential.legacyFile（默认 data/legacy-cwt.json），然后：
 *
 *   node scripts/import-legacy-cwt.mjs --dry   # 只报命中数，不写台账
 *   node scripts/import-legacy-cwt.mjs         # 实际回填（幂等：已有凭证的地址不覆盖）
 *
 * 回填效果：命中的地址直接获得 CWT 解除凭证（source='legacy'，台账即豁免，
 * 无需再走 DID 领取+CWT 申请；档案侧落卡由用户进用户中心领取时完成）。
 */
import { credentialService } from '../src/services/credential.service.js'

const dry = process.argv.includes('--dry')
await credentialService.init()
if (dry) {
  const { getStore } = await import('../src/services/mongo.store.js')
  let hit = 0
  const backendAddrs = new Set()
  if (process.env.DSH_STORAGE_PROVIDER === 'mongodb' || (await getStore().isConfigured)) {
    const addrs = await getStore()
      .col('credentials')
      .find({}, { projection: { _id: 1 } })
      .toArray()
    addrs.forEach((d) => backendAddrs.add(d._id))
  }
  const legacy = credentialService._legacyAddrs ? credentialService._legacyAddrs() : []
  console.log(
    `[dry] legacy 名单 ${legacy.length} 条；其中已有台账 ${legacy.filter((a) => backendAddrs.has(a)).length} 条`,
  )
  process.exit(0)
}
const r = await credentialService.backfillLegacy()
console.log(
  `[legacy] 名单 ${r.total} 条，本次新签发 CWT 凭证 ${r.created} 条（其余已有凭证，互斥不覆盖）`,
)
process.exit(0)
