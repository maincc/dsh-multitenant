process.env.DSH_STORAGE_PROVIDER = 'mongodb'
const { credentialService, _mintVCForTest, _isPlatformMintedForTest } = await import('./src/services/credential.service.js')
await credentialService.init()
const A = 'jroleexpaaa00000000000000000000000'
const cases = [
  ['did', [], 'member'],
  ['cwt', [], 'cwt'],
  ['cwt', ['admin'], 'admin'],
]
for (const [kind, roles, expectSlug] of cases) {
  const vc = await _mintVCForTest(kind, A, roles)
  const frag = vc.id.split('#')[1]
  const ok = await _isPlatformMintedForTest(vc, A)
  const isRight = frag.startsWith(`dsh-${expectSlug}-`)
  console.log(`${expectSlug.padEnd(7)} | ${frag.slice(0, 58)}… | 验签=${ok ? 'PASS' : 'FAIL'} | 段=${isRight ? '对' : '错'}`)
  if (!ok || !isRight) process.exit(1)
}
console.log('三档角色 id 全部真签真验通过')
